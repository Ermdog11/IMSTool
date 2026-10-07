// GET /api/me — the current user's context for the app to gate on.
//
// Responses:
//   { configured:false }                          login not switched on (no env vars) -> app runs open
//   { configured:true, authenticated:false }      no / invalid token -> client redirects to /login
//   { configured:true, authenticated:true, user, role, byline, site }
//
// Bootstrap: the FIRST person to sign in, when the seed site has zero members,
// is made its publisher. After that, people join a newsroom by invite (any
// open invite for their email is accepted here), or start their own via
// /api/newsroom-create (pending:true, canCreate:true).

var S = require('./_supabase');


module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!S.isConfigured()) return res.status(200).json({ configured: false });

  var token = S.bearerToken(req);
  if (!token) return res.status(200).json({ configured: true, authenticated: false });

  var sb;
  try { sb = S.admin(); } catch (e) { return res.status(200).json({ configured: false }); }

  // Verify the JWT
  var got = await sb.auth.getUser(token);
  if (got.error || !got.data || !got.data.user) {
    return res.status(200).json({ configured: true, authenticated: false });
  }
  var authUser = got.data.user;

  var Site = require('./_site');

  // Make sure a profile row exists (the auth trigger normally handles this;
  // this is a belt-and-braces fallback).
  await sb.from('profiles').upsert({
    id: authUser.id,
    email: authUser.email,
    full_name: (authUser.user_metadata && (authUser.user_metadata.full_name || authUser.user_metadata.name)) || null
  }, { onConflict: 'id', ignoreDuplicates: true });

  // Which newsroom (multi-newsroom, 2026-10-06): accept any open invites
  // first, then pick the one the page asked for (X-Site), else
  // InsideMDSports for its members, else the person's only/first newsroom.
  var email = String(authUser.email || '').toLowerCase();
  if (email) {
    var invs = await sb.from('invites').select('id, site_id, email, role, byline').ilike('email', email).is('accepted_at', null);
    var open = (invs.data || []).filter(function (x) { return String(x.email || '').toLowerCase() === email; });
    for (var i = 0; i < open.length; i++) {
      var inv = open[i];
      var have = await sb.from('memberships').select('id').eq('site_id', inv.site_id).eq('user_id', authUser.id).maybeSingle();
      if (!have.data) {
        var insI = await sb.from('memberships').insert({ user_id: authUser.id, site_id: inv.site_id, role: inv.role, byline: inv.byline || null });
        if (insI.error) continue;
      }
      await sb.from('invites').update({ accepted_at: new Date().toISOString() }).eq('id', inv.id);
    }
  }

  var memsRes = await sb.from('memberships').select('id, role, byline, sites(id, slug, name)').eq('user_id', authUser.id);
  var mems = (memsRes.data || []).filter(function (m) { return m.sites; });

  if (!mems.length) {
    // Bootstrap: the first person to sign in, while InsideMDSports has no
    // members, becomes its publisher (the original single-newsroom setup).
    var seed = await sb.from('sites').select('id, slug, name').eq('slug', Site.DEFAULT).maybeSingle();
    if (seed.data) {
      var countRes = await sb.from('memberships').select('id', { count: 'exact', head: true }).eq('site_id', seed.data.id);
      if ((countRes.count || 0) === 0) {
        var ins = await sb.from('memberships').insert({
          user_id: authUser.id, site_id: seed.data.id, role: 'publisher',
          byline: (authUser.user_metadata && authUser.user_metadata.full_name) || null
        }).select('id, role, byline').single();
        if (!ins.error) mems = [Object.assign({}, ins.data, { sites: seed.data })];
      }
    }
  }

  var wanted = req.headers && req.headers['x-site'];
  var pick = (wanted && mems.filter(function (m) { return m.sites.slug === wanted; })[0]) ||
    mems.filter(function (m) { return m.sites.slug === Site.DEFAULT; })[0] || mems[0] || null;
  var membership = pick ? { id: pick.id, role: pick.role, byline: pick.byline } : null;
  var site = pick ? pick.sites : null;
  if (site) Site.set(site);

  if (!membership) {
    return res.status(200).json({
      configured: true, authenticated: true, role: null,
      user: { id: authUser.id, email: authUser.email },
      pending: true,
      // No invite: they can start a newsroom of their own (/api/newsroom-create).
      canCreate: true,
      message: 'Your account isn\'t part of a newsroom yet. Start your own, or ask a publisher to invite ' + authUser.email + '.'
    });
  }

  var profRes = await sb.from('profiles').select('full_name, email').eq('id', authUser.id).single();

  return res.status(200).json({
    configured: true,
    authenticated: true,
    user: {
      id: authUser.id,
      email: (profRes.data && profRes.data.email) || authUser.email,
      full_name: (profRes.data && profRes.data.full_name) || null
    },
    role: membership.role,
    // What this role may use (api/_access.js), so the pages can hide the rest.
    access: require('./_access').resolve(await require('./_settings-store').getProfile(sb).catch(function () { return {}; }), membership.role),
    byline: membership.byline || null,
    site: { id: site.id, slug: site.slug, name: site.name },
    // The basics the pages show in place of InsideMDSports' own wording.
    beat: await require('./_beat').getBeat(sb).then(function (b) {
      return { outletName: b.outletName, teamName: b.team.name, short: b.team.short, excludeSources: b.excludeSources };
    }).catch(function () { return null; }),
    // Every newsroom this person belongs to, for switching (X-Site header).
    sites: mems.map(function (m) { return { slug: m.sites.slug, name: m.sites.name, role: m.role }; })
  });
};

// Per-newsroom: this request runs as the signed-in person's newsroom (_site.js).
module.exports = require('./_site').wrap(module.exports);
