// Supabase server-side client + auth helpers.
//
// Env vars (set in Vercel -> Project -> Settings -> Environment Variables):
//   SUPABASE_URL                 - the project URL, e.g. https://abcd.supabase.co   (not secret)
//   SUPABASE_ANON_KEY            - the anon/public key                              (not secret)
//   SUPABASE_SERVICE_ROLE_KEY    - the service_role key                             (SECRET - server only)
//
// The service-role client bypasses Row Level Security, so it is only ever used
// from API functions (never shipped to the browser). Browser code uses the anon
// key + the signed-in user's JWT.

var SUPABASE_URL = process.env.SUPABASE_URL || '';
var SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
var ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

var _admin = null;

// Lazy so a missing env var doesn't crash unrelated endpoints at import time.
function admin() {
  if (_admin) return _admin;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error('Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing)');
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
  var siteSlug = opts.siteSlug || 'insidemdsports';
  var token = bearerToken(req);
  if (!token) { var e = new Error('Not signed in'); e.status = 401; throw e; }

  var sb = admin();
  var got = await sb.auth.getUser(token);
  if (got.error || !got.data || !got.data.user) {
    var e2 = new Error('Session invalid or expired'); e2.status = 401; throw e2;
  }
  var user = got.data.user;

  var siteRes = await sb.from('sites').select('id, slug, name').eq('slug', siteSlug).single();
  if (siteRes.error || !siteRes.data) { var e3 = new Error('Unknown site'); e3.status = 400; throw e3; }
  var site = siteRes.data;

  var memRes = await sb.from('memberships')
    .select('id, role, byline')
    .eq('site_id', site.id).eq('user_id', user.id).single();
  if (memRes.error || !memRes.data) {
    var e4 = new Error('No access to this newsroom'); e4.status = 403; throw e4;
  }

  return { user: user, membership: memRes.data, site: site, supabase: sb };
}

// Convenience: require a specific role (or higher). publisher > editor > writer.
var RANK = { writer: 1, editor: 2, publisher: 3 };
async function requireRole(req, minRole, opts) {
  var ctx = await requireUser(req, opts);
  if ((RANK[ctx.membership.role] || 0) < (RANK[minRole] || 99)) {
    var e = new Error('Requires ' + minRole + ' access'); e.status = 403; throw e;
  }
  return ctx;
}

module.exports = {
  admin: admin,
  isConfigured: isConfigured,
  bearerToken: bearerToken,
  requireUser: requireUser,
  requireRole: requireRole
};
