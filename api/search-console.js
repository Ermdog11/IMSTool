// /api/search-console — GET: Google Search Console for the connected
// property, last 28 days vs the 28 before (api/_gsc.js).
//   ?setup=1 -> { configured, serviceAccountEmail, sites } for the connect step.

var S = require('./_supabase');
var Store = require('./_analytics-store');
var GSC = require('./_gsc');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!S.isConfigured()) return res.status(503).json({ error: 'Login not configured' });

  var ctx;
  try { ctx = await S.requireUser(req); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
  if (!(await require('./_access').allowed(ctx, 'mon_analytics'))) return require('./_access').deny(res);

  try {
    if (req.query && req.query.setup) {
      if (!GSC.isConfigured()) return res.status(200).json({ configured: false });
      var sites = [], err = null;
      try { sites = await GSC.listSites(); } catch (e) { err = e.message; }
      return res.status(200).json({ configured: true, serviceAccountEmail: GSC.serviceAccountEmail(), sites: sites, error: err });
    }
    var conn = await Store.getConnection(ctx.supabase, ctx.site.id, 'gsc');
    if (!conn || !conn.siteUrl) return res.status(400).json({ error: 'Search Console not connected yet.' });
    var summary;
    try { summary = await GSC.fetchSummary(conn.siteUrl, conn.pathPrefix); }
    catch (e) { return res.status(502).json({ error: e.message }); }
    return res.status(200).json(Object.assign({ siteUrl: conn.siteUrl, pathPrefix: conn.pathPrefix || '' }, summary));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
