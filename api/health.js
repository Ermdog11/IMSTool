// GET /api/health — open problems for the in-app banner (credit outage,
// scheduled jobs failing repeatedly). See api/_health.js.
var S = require('./_supabase');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (S.isConfigured()) {
    try { await S.requireUser(req); } catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
  }
  try { return res.status(200).json({ problems: await require('./_health').problems() }); }
  catch (e) { return res.status(200).json({ problems: [] }); }
};

// Per-newsroom: this request runs as the signed-in person's newsroom (_site.js).
module.exports = require('./_site').wrap(module.exports);
