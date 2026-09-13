// /api/facebook — GET: live Page reach/engagement for the Audience
// Analytics view. Reads the site's stored Meta connection
// (api/analytics-connections.js / meta-oauth-callback.js), and calls the
// Graph API directly (fetch/parse logic in api/_meta.js).

var S = require('./_supabase');
var Store = require('./_analytics-store');
var Meta = require('./_meta');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!S.isConfigured()) return res.status(503).json({ error: 'Login not configured' });

  var ctx;
  try { ctx = await S.requireUser(req); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message }); }

  try {
    var conn = await Store.getConnection(ctx.supabase, ctx.site.id, 'meta');
    if (!conn || !conn.pageAccessToken || !conn.pageId) {
      return res.status(400).json({ error: 'Facebook not connected yet.' });
    }

    var metrics;
    try { metrics = await Meta.getPageInsights(conn.pageId, conn.pageAccessToken); }
    catch (e) { return res.status(502).json({ error: e.message }); }

    return res.status(200).json({
      pageName: conn.pageName,
      hasInstagram: !!conn.igBusinessAccountId,
      metrics: metrics,
      fetchedAt: new Date().toISOString()
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
