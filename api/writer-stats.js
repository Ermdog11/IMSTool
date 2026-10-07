// /api/writer-stats — the writer leaderboard (see _writer-stats.js).
//   GET ?days=7|30|90[&refresh=1] -> { at, days, sources, notes, writers:[...] }
// The publisher always sees it. Anyone else only when the publisher turned
// "Writer leaderboard" on for their role (mon_leaderboard, off by default);
// otherwise this answers 404, so the leaderboard doesn't even look like it
// exists (Jeff: "publisher gets to decide if others on staff see it, or even
// that it exists").

var S = require('./_supabase');
var Access = require('./_access');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!S.isConfigured()) return res.status(503).json({ error: 'Login not configured' });
  var ctx;
  try { ctx = await S.requireUser(req); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
  if (!(await Access.allowed(ctx, 'mon_leaderboard'))) return res.status(404).json({ error: 'Not found' });
  try {
    var days = [7, 30, 90].indexOf(+req.query.days) !== -1 ? +req.query.days : 30;
    return res.status(200).json(await require('./_writer-stats').get(ctx.supabase, ctx.site.id, days, req.query.refresh === '1'));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

// Per-newsroom: this request runs as the signed-in person's newsroom (_site.js).
module.exports = require('./_site').wrap(module.exports);
