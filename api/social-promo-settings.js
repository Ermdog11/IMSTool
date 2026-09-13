// /api/social-promo-settings — the on/off switch for the Bluesky promo bot.
//   GET               -> { enabled, configured } (any member can view)
//   POST { enabled }  -> set it (publisher only — this controls the brand's
//                        own account auto-posting, not just a personal pref)
// Off by default: the bot (api/social-promo-check.js) checks this before
// posting anything, so nothing goes out until a publisher explicitly enables it.

var S = require('./_supabase');
var Bluesky = require('./_bluesky');
var State = require('./_social-promo-state');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!S.isConfigured()) return res.status(503).json({ error: 'Login not configured' });

  var ctx;
  try { ctx = await S.requireUser(req); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message }); }

  if (req.method === 'GET') {
    var enabled = await State.isEnabled(ctx.site.slug);
    return res.status(200).json({ enabled: enabled, configured: Bluesky.isConfigured() });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });
  if (ctx.membership.role !== 'publisher') {
    return res.status(403).json({ error: 'Only the publisher can turn the promo bot on or off.' });
  }

  var body = req.body || {};
  await State.setEnabled(ctx.site.slug, !!body.enabled);
  return res.status(200).json({ ok: true, enabled: !!body.enabled });
};
