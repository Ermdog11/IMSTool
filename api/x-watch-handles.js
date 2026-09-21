// /api/x-watch-handles — specific X/Twitter accounts to check every run
// (e.g. rival/fellow beat reporters covering the same team), additive to
// api/_x-search.js's broad + storyline queries, not a replacement for them.
//
//   GET                    -> { handles: string[] }        (any member)
//   POST { handles: [] }   -> replaces the list (any member), capped server-side

var S = require('./_supabase');
var Store = require('./_settings-store');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!S.isConfigured()) return res.status(503).json({ error: 'Login not configured' });

  var ctx;
  try { ctx = await S.requireUser(req); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message }); }

  if (req.method === 'GET') {
    var handles = await Store.getXWatchHandles(ctx.supabase);
    return res.status(200).json({ handles: handles });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });

  try {
    var saved = await Store.saveXWatchHandles(ctx.supabase, (req.body || {}).handles);
    return res.status(200).json({ ok: true, handles: saved.handles });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
