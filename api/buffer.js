// /api/buffer — GET: the last 30 days of social performance for posts sent
// through Buffer (totals, per channel, top posts, best time to post), for the
// Audience Analytics view. Reads the site's stored Buffer connection
// (api/analytics-connections.js) and calls Buffer through api/_buffer.js.

var S = require('./_supabase');
var Store = require('./_analytics-store');
var Buffer_ = require('./_buffer');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!S.isConfigured()) return res.status(503).json({ error: 'Login not configured' });

  var ctx;
  try { ctx = await S.requireUser(req); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message }); }

  try {
    var conn = await Store.getConnection(ctx.supabase, ctx.site.id, 'buffer');
    if (!conn || !conn.apiKey || !conn.organizationId) return res.status(400).json({ error: 'Buffer not connected yet.' });
    var summary;
    try { summary = await Buffer_.fetchSummary(conn.apiKey, conn.organizationId); }
    catch (e) { return res.status(502).json({ error: e.message }); }
    return res.status(200).json(Object.assign({ organizationName: conn.organizationName || '', fetchedAt: new Date().toISOString() }, summary));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
