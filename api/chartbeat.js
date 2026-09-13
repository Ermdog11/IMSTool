// /api/chartbeat — GET: live concurrents + top pages right now, for the
// Audience Analytics view. Reads the site's stored Chartbeat connection
// (api/analytics-connections.js), decrypts the API key, and calls
// Chartbeat's real-time API (fetch/parse logic shared with the snapshot
// cron via api/_chartbeat.js, so the two never drift out of sync).

var S = require('./_supabase');
var Store = require('./_analytics-store');
var Chartbeat = require('./_chartbeat');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!S.isConfigured()) return res.status(503).json({ error: 'Login not configured' });

  var ctx;
  try { ctx = await S.requireUser(req); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message }); }

  try {
    var conn = await Store.getConnection(ctx.supabase, ctx.site.id, 'chartbeat');
    if (!conn || !conn.apiKey || !conn.host) {
      return res.status(400).json({ error: 'Chartbeat not connected yet.' });
    }

    var live;
    try { live = await Chartbeat.fetchLive(conn.apiKey, conn.host); }
    catch (e) { return res.status(502).json({ error: e.message }); }

    return res.status(200).json({
      host: conn.host,
      visits: live.visits,
      pages: live.pages,
      fetchedAt: new Date().toISOString(),
      warnings: live.warnings
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
