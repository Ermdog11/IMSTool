// /api/search-settings — Google Programmable Search credentials for the
// news scanner's web-search pass (api/_google-search.js).
//
//   GET                                    -> { connected: bool }  (any member — status only, never the key)
//   POST { apiKey, engineId }              -> connect/replace (publisher or editor)
//   POST { action:'disconnect' }           -> remove (publisher or editor)

var S = require('./_supabase');
var Store = require('./_settings-store');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!S.isConfigured()) return res.status(503).json({ error: 'Login not configured' });

  if (req.method === 'GET') {
    var readCtx;
    try { readCtx = await S.requireUser(req); }
    catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
    try {
      var creds = await Store.getGoogleSearch(readCtx.supabase);
      return res.status(200).json({ connected: !!creds });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });

  var ctx;
  try { ctx = await S.requireRole(req, 'editor'); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message }); }

  var body = req.body || {};
  if (body.action === 'disconnect') {
    try {
      await Store.deleteGoogleSearch(ctx.supabase);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  var apiKey = String(body.apiKey || '').trim();
  var engineId = String(body.engineId || '').trim();
  if (!apiKey || !engineId) return res.status(400).json({ error: 'Need both an API key and a Search Engine ID.' });

  try {
    await Store.saveGoogleSearch(ctx.supabase, apiKey, engineId);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
