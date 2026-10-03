// GET /api/source-health — every news source's status for Settings → Source
// health (dead / failing / silent / ok, last story, automatic fixes).
// See api/_source-health.js.
var S = require('./_supabase');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (S.isConfigured()) {
    try { await S.requireUser(req); } catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
  }
  try { return res.status(200).json({ sources: await require('./_source-health').table() }); }
  catch (e) { return res.status(500).json({ error: e.message }); }
};
