// GET /api/source-health — every news source's status for Analytics → Source
// health (dead / failing / silent / ok, last story, automatic fixes). Its own
// permission, mon_source_health (Jeff, 2026-10-07: writers can have it
// without the rest of Analytics).
// See api/_source-health.js.
var S = require('./_supabase');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (S.isConfigured()) {
    var ctx;
    try { ctx = await S.requireUser(req); } catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
    if (!(await require('./_access').allowed(ctx, 'mon_source_health'))) return require('./_access').deny(res);
  }
  try { return res.status(200).json({ sources: await require('./_source-health').table() }); }
  catch (e) { return res.status(500).json({ error: e.message }); }
};

// Per-newsroom: this request runs as the signed-in person's newsroom (_site.js).
module.exports = require('./_site').wrap(module.exports);
