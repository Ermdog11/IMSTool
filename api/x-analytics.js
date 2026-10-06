// /api/x-analytics — GET: the newsroom's own X account, last 7 and last 30
// days (api/_x-analytics.js). Refreshes the stored tweets first when they're
// more than a few hours old (only newly matured tweets are read from X).
//   ?examples=1 -> just the best recent tweets, for Draft social.

var S = require('./_supabase');
var XA = require('./_x-analytics');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!S.isConfigured()) return res.status(503).json({ error: 'Login not configured' });

  var ctx;
  try { ctx = await S.requireUser(req); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
  if (!(await require('./_access').allowed(ctx, 'mon_analytics'))) return require('./_access').deny(res);

  try {
    var store, warning = null;
    try { store = await XA.refresh(S.admin(), ctx.site.id); }
    catch (e) { warning = e.message; store = await XA.readStore(ctx.site.id); }
    if (!store) return res.status(400).json({ error: warning || 'X analytics not connected yet.' });
    if (req.query && req.query.examples) return res.status(200).json({ examples: XA.topExamples(store) });
    return res.status(200).json(Object.assign(XA.summary(store), { warning: warning }));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
