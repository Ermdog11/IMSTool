// /api/scrape-session — manage the publisher's logged-in session for a
// paywalled outlet, used by the style-drift scraper to read full articles.
//
//   GET                                  -> { connected, updatedAt }  (any member — status only, never the cookie)
//   POST { source, cookie }              -> connect/replace (publisher only)
//   POST { source, action:'disconnect' } -> remove (publisher only)
//
// `source` is currently only '247sports'. The cookie is whatever the
// browser's Network tab shows as the Cookie request header on a signed-in
// request to that site — a one-time copy/paste, not a username/password, and
// not stored anywhere the app would ever automate a login with it.

var S = require('./_supabase');
var Crypto = require('./_crypto');
var Store = require('./_scrape-store');

var SOURCES = ['247sports'];

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!S.isConfigured()) return res.status(503).json({ error: 'Login not configured' });

  var ctx;
  try { ctx = await S.requireUser(req); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
  var sb = ctx.supabase, siteId = ctx.site.id;

  if (req.method === 'GET') {
    try {
      var out = await Store.status(sb, siteId, '247sports');
      return res.status(200).json(out);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });

  if (ctx.membership.role !== 'publisher') {
    return res.status(403).json({ error: 'Only the publisher can manage the scrape session.' });
  }

  var body = req.body || {};
  var source = SOURCES.indexOf(body.source) !== -1 ? body.source : '247sports';

  if (body.action === 'disconnect') {
    try {
      await Store.deleteCookie(sb, siteId, source);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  var cookie = String(body.cookie || '').trim();
  if (cookie.length < 20 || cookie.indexOf('=') === -1) {
    return res.status(400).json({ error: 'That doesn\'t look like a cookie header value — copy the whole "Cookie" request header from your browser\'s Network tab.' });
  }
  if (!Crypto.isConfigured()) {
    return res.status(503).json({ error: 'Encryption key not set up yet (ANALYTICS_ENCRYPTION_KEY) — tell Claude to walk through generating one.' });
  }

  try {
    await Store.saveCookie(sb, siteId, source, cookie, ctx.user.id);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
