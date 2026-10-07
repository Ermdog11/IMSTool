// Supabase server-side client + auth helpers.
//
// Env vars (set in Vercel -> Project -> Settings -> Environment Variables):
//   SUPABASE_URL               - the project URL, e.g. https://abcd.supabase.co        (not secret)
//   SUPABASE_PUBLISHABLE_KEY   - the sb_publishable_... key                            (safe in the browser)
//   SUPABASE_SECRET_KEY        - the sb_secret_... key                                 (SECRET - server only)
//
// (These are Supabase's current key format. Legacy anon / service_role JWT keys
// also work if that's what a project shows.) The secret-key client bypasses Row
// Level Security, so it is only ever used from API functions, never shipped to
// the browser. Browser code uses the publishable key + the signed-in user's JWT.

var SUPABASE_URL = process.env.SUPABASE_URL || '';
var SERVICE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
var ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '';

var _admin = null;

// Lazy so a missing env var doesn't crash unrelated endpoints at import time.
function admin() {
  if (_admin) return _admin;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error('Supabase not configured (SUPABASE_URL / SUPABASE_SECRET_KEY missing)');
  }
  var createClient = require('@supabase/supabase-js').createClient;
  _admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  return _admin;
}

function isConfigured() {
  return !!(SUPABASE_URL && SERVICE_KEY && ANON_KEY);
}

// Pull the Bearer token off the request (Authorization header, or ?access_token=).
function bearerToken(req) {
  var h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  var m = /^Bearer\s+(.+)$/i.exec(h);
  if (m) return m[1].trim();
  if (req.query && req.query.access_token) return String(req.query.access_token);
  return null;
}

// Verify the caller's JWT and return { user, membership, site } for the given
// site slug (default: the first / only site). Throws on any failure - callers
// wrap this and return 401.
async function requireUser(req, opts) {
  opts = opts || {};
  var Site = require('./_site');
  var token = bearerToken(req);
  if (!token) { var e = new Error('Not signed in'); e.status = 401; throw e; }

  var sb = admin();
  var got = await sb.auth.getUser(token);
  if (got.error || !got.data || !got.data.user) {
    var e2 = new Error('Session invalid or expired'); e2.status = 401; throw e2;
  }
  var user = got.data.user;

  // Which newsroom (2026-10-06, multi-newsroom): the one asked for (opts, or
  // the page's X-Site header when someone belongs to several), else the
  // person's own newsroom, preferring InsideMDSports for its members so
  // nothing changes for them.
  var wanted = opts.siteSlug || (req.headers && (req.headers['x-site'] || req.headers['X-Site'])) || null;
  var mems = await sb.from('memberships')
    .select('id, role, byline, sites(id, slug, name)').eq('user_id', user.id);
  var list = (mems.data || []).filter(function (m) { return m.sites; });
  var pick = (wanted && list.filter(function (m) { return m.sites.slug === wanted; })[0]) ||
    list.filter(function (m) { return m.sites.slug === Site.DEFAULT; })[0] || list[0];
  if (!pick) {
    if (wanted || mems.error) { var e4 = new Error('No access to this newsroom'); e4.status = 403; throw e4; }
    var e5 = new Error('No access to this newsroom'); e5.status = 403; throw e5;
  }
  var site = pick.sites;
  Site.set(site);
  return { user: user, membership: { id: pick.id, role: pick.role, byline: pick.byline }, site: site, supabase: sb, sites: list.map(function (m) { return { slug: m.sites.slug, name: m.sites.name, role: m.role }; }) };
}

// For the few open routes (Bluesky, podcasts): if a signed-in member is
// calling, run as their newsroom; anyone else gets InsideMDSports' public
// view, as before. Never throws.
async function optionalUser(req) {
  try {
    if (!isConfigured() || !bearerToken(req)) return null;
    return await requireUser(req);
  } catch (e) { return null; }
}

// Convenience: require a specific role (or higher). publisher > editor > writer.
var RANK = { viewer: 0, contributor: 1, writer: 1, editor: 2, publisher: 3 };
async function requireRole(req, minRole, opts) {
  var ctx = await requireUser(req, opts);
  if ((RANK[ctx.membership.role] || 0) < (RANK[minRole] || 99)) {
    var e = new Error('Requires ' + minRole + ' access'); e.status = 403; throw e;
  }
  return ctx;
}

// Which email addresses should receive a given alert type, from the per-user
// alert_prefs (absence of a row falls back to the type's default). Returns []
// when Supabase isn't configured — callers then keep their existing hardcoded
// recipient.
// Breaking-news emails also go to everyone on the digest list (ALERT_EMAIL +
// ALERT_EMAIL_EXTRA),
// so adding someone there is enough to get them every email, without
// inviting them to the team first (Jeff, 2026-10-02).
function withDigestList(alertType, emails) {
  // The digest list (ALERT_EMAIL) is InsideMDSports' own; other newsrooms
  // only email their team.
  if (alertType !== 'breaking' || !require('./_site').isDefault()) return emails;
  var extra = require('./_mailer').digestList();
  var seen = {};
  return emails.concat(extra).filter(function (e) {
    var k = e.toLowerCase();
    if (seen[k]) return false;
    seen[k] = true;
    return true;
  });
}

async function recipientsFor(alertType, siteSlug) {
  return withDigestList(alertType, await teamRecipientsFor(alertType, siteSlug));
}

async function teamRecipientsFor(alertType, siteSlug) {
  if (!isConfigured()) return [];
  try {
    var prefsMod = require('./alert-prefs');
    var sb = admin();
    var site = await sb.from('sites').select('id').eq('slug', siteSlug || require('./_site').slug()).single();
    if (site.error || !site.data) return [];
    var mem = await sb.from('memberships').select('user_id, role, profiles(email)').eq('site_id', site.data.id);
    var prefs = await sb.from('alert_prefs').select('user_id, enabled').eq('site_id', site.data.id).eq('alert_type', alertType);
    var explicit = {};
    (prefs.data || []).forEach(function (p) { explicit[p.user_id] = p.enabled; });
    var out = [];
    (mem.data || []).forEach(function (m) {
      var on = (explicit[m.user_id] !== undefined) ? explicit[m.user_id] : prefsMod.defaultFor(alertType, m.role);
      if (on && m.profiles && m.profiles.email) out.push(m.profiles.email);
    });
    return out;
  } catch (e) { return []; }
}

// Gate for routes that run on a schedule AND/OR from the app:
//  - an in-process call from another handler (no HTTP headers) is trusted;
//  - Vercel Cron sends "Authorization: Bearer $CRON_SECRET";
//  - otherwise the caller must be a signed-in member.
// Fails open like requireUser when Supabase isn't configured.
// Also hooks the response into the health alerts (api/_health.js) so credit
// outages and repeatedly failing scheduled jobs email the publisher.
async function requireUserOrCron(req, res) {
  if (!req || !req.headers) return { internal: true };
  var secret = process.env.CRON_SECRET;
  var auth = req.headers.authorization || req.headers.Authorization || '';
  var isCron = !!(secret && auth === 'Bearer ' + secret);
  try { require('./_health').watch(req, res, isCron); } catch (e) {}
  if (isCron) return { cron: true };
  if (!isConfigured()) return { open: true };
  return requireUser(req);
}

module.exports = {
  requireUserOrCron: requireUserOrCron,
  admin: admin,
  isConfigured: isConfigured,
  bearerToken: bearerToken,
  optionalUser: optionalUser,
  requireUser: requireUser,
  requireRole: requireRole,
  recipientsFor: recipientsFor,
  teamRecipientsFor: teamRecipientsFor
};
