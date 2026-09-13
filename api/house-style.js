// /api/house-style — the shared house style guide, persisted server-side so
// it's the same for every browser AND for anything server-side (the
// breaking-news auto-draft) that needs to write in it. Used to live only in
// each browser's localStorage.
//
//   GET             -> { guide: string|null }  (public — matches api/copyedit.js's
//                       already-open access; the editor page must always be able to read it)
//   POST { guide }  -> save it (publisher or editor only)

var S = require('./_supabase');
var Store = require('./_settings-store');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!S.isConfigured()) return res.status(200).json({ guide: null });

  if (req.method === 'GET') {
    try {
      var sb = S.admin();
      var guide = await Store.getHouseStyle(sb);
      return res.status(200).json({ guide: guide });
    } catch (e) {
      return res.status(200).json({ guide: null });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });

  var ctx;
  try { ctx = await S.requireRole(req, 'editor'); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message }); }

  var guide = String((req.body && req.body.guide) || '').slice(0, 20000);
  try {
    await Store.saveHouseStyle(ctx.supabase, guide);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
