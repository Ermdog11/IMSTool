// GET /api/me — the current user's context for the app to gate on.
//
// Responses:
//   { configured:false }                          login not switched on (no env vars) -> app runs open
//   { configured:true, authenticated:false }      no / invalid token -> client redirects to /login
//   { configured:true, authenticated:true, user, role, byline, site }
//
// Bootstrap: the FIRST person to sign in, when the seed site has zero members,
// is made its publisher. After that, only a publisher can add people (via
// /api/team).

var S = require('./_supabase');

var SITE_SLUG = 'insidemdsports';

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

  // Resolve the site
  var siteRes = await sb.from('sites').select('id, slug, name').eq('slug', SITE_SLUG).single();
  if (siteRes.error || !siteRes.data) {
    return res.status(500).json({ configured: true, authenticated: true, error: 'Site row missing — run db/schema.sql' });
  }
  var site = siteRes.data;

  // Make sure a profile row exists (the auth trigger normally handles this;
  // this is a belt-and-braces fallback).
  await sb.from('profiles').upsert({
    id: authUser.id,
    email: authUser.email,
    full_name: (authUser.user_metadata && (authUser.user_metadata.full_name || authUser.user_metadata.name)) || null
  }, { onConflict: 'id', ignoreDuplicates: true });

  // Existing membership?
  var memRes = await sb.from('memberships')
    .select('id, role, byline').eq('site_id', site.id).eq('user_id', authUser.id).maybeSingle();
  var membership = memRes.data || null;

  if (!membership) {
    // Bootstrap: first user on an empty site becomes publisher.
    var countRes = await sb.from('memberships')
      .select('id', { count: 'exact', head: true }).eq('site_id', site.id);
    var memberCount = countRes.count || 0;

    if (memberCount === 0) {
      var ins = await sb.from('memberships').insert({
        user_id: authUser.id, site_id: site.id, role: 'publisher',
        byline: (authUser.user_metadata && authUser.user_metadata.full_name) || null
      }).select('id, role, byline').single();
      if (!ins.error) membership = ins.data;
    } else {
      // Was this email invited?
      var invRes = await sb.from('invites')
        .select('id, role, byline').eq('site_id', site.id).eq('email', authUser.email).is('accepted_at', null).maybeSingle();
      if (invRes.data) {
        var ins2 = await sb.from('memberships').insert({
          user_id: authUser.id, site_id: site.id, role: invRes.data.role, byline: invRes.data.byline || null
        }).select('id, role, byline').single();
        if (!ins2.error) {
          membership = ins2.data;
          await sb.from('invites').update({ accepted_at: new Date().toISOString() }).eq('id', invRes.data.id);
        }
      }
    }
  }

  if (!membership) {
    return res.status(200).json({
      configured: true, authenticated: true, role: null,
      user: { id: authUser.id, email: authUser.email },
      pending: true,
      message: 'Your account exists but has not been added to the newsroom yet. Ask the publisher to invite ' + authUser.email + '.'
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
    byline: membership.byline || null,
    site: { id: site.id, slug: site.slug, name: site.name }
  });
};
