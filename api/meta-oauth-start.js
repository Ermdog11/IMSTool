// /api/meta-oauth-start — GET: kicks off the Facebook Page connect flow.
// Hit via a plain browser navigation (not authFetch — an OAuth redirect
// can't carry a fetch's custom headers), so the caller's session token
// rides in ?access_token= instead (api/_supabase.js's requireUser already
// accepts that form). Redirects straight to Facebook's OAuth dialog.

var S = require('./_supabase');
var Meta = require('./_meta');

module.exports = async function handler(req, res) {
  if (!S.isConfigured()) return res.status(503).send('Login not configured');
  if (!Meta.isConfigured()) {
    return res.status(503).send('Meta app not set up yet (META_APP_ID / META_APP_SECRET) — tell Claude to finish Facebook/Instagram setup.');
  }

  var ctx;
  try { ctx = await S.requireRole(req, 'publisher'); }
  catch (e) { return res.status(e.status || 401).send(e.message); }

  var state = Meta.signState({ siteId: ctx.site.id, userId: ctx.user.id, ts: Date.now() });
  res.redirect(302, Meta.authUrl(state));
};
