// /api/buffer — GET: the last 30 days of social performance for posts sent
// through Buffer (totals, per channel, top posts, best time to post), for the
// Audience Analytics view. Reads the site's stored Buffer connection
// (api/analytics-connections.js) and calls Buffer through api/_buffer.js.

var S = require('./_supabase');
var Store = require('./_analytics-store');
var Buffer_ = require('./_buffer');
var exampleCache = {}; // per warm instance, 1h

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
    // ?examples=1: just the best recent posts per platform, for Draft social.
    if (req.query && req.query.examples) {
      var key = ctx.site.id + ':' + conn.organizationId;
      if (!exampleCache[key] || Date.now() - exampleCache[key].at > 60 * 60 * 1000) {
        try { exampleCache[key] = { at: Date.now(), examples: await Buffer_.topExamples(conn.apiKey, conn.organizationId) }; }
        catch (e) { return res.status(502).json({ error: e.message }); }
      }
      return res.status(200).json({ examples: exampleCache[key].examples });
    }
    var summary;
    try { summary = await Buffer_.fetchSummary(conn.apiKey, conn.organizationId); }
    catch (e) { return res.status(502).json({ error: e.message }); }
    return res.status(200).json(Object.assign({ organizationName: conn.organizationName || '', fetchedAt: new Date().toISOString() }, summary));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

// Per-newsroom: this request runs as the signed-in person's newsroom (_site.js).
module.exports = require('./_site').wrap(module.exports);
