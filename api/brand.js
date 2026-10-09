// /api/brand — the newsroom's logo and colors (Jeff, 2026-10-09: "Make app
// customizable with users logo and/or colors"). Shown in place of the
// built-in "IMS" box and blue on every page (public/_auth.js applyBrand).
//
//   GET                                      -> { brand }   (any member)
//   POST { logo, accent, header } (publisher) -> { ok, brand }
//        logo:   a data: URL (PNG, JPEG or WebP, resized in the browser, max
//                200 KB) or '' to go back to the initials
//        accent: '#rrggbb' buttons, links and the active tab, or '' for blue
//        header: '#rrggbb' the top bar, or '' for navy
//
// Saved in the newsroom profile (site_settings.profile.brand). /api/me sends
// it with everything else, so pages don't need a second call. No credits.

var S = require('./_supabase');
var Store = require('./_settings-store');

var MAX_LOGO = 200 * 1024;
function hex(v) { v = String(v || '').trim().toLowerCase(); return /^#[0-9a-f]{6}$/.test(v) ? v : ''; }
function clean(b) {
  b = b || {};
  var logo = String(b.logo || '');
  if (logo && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(logo)) logo = '';
  return { logo: logo, accent: hex(b.accent), header: hex(b.header) };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!S.isConfigured()) {
    if (req.method === 'GET') return res.status(200).json({ brand: null, local: true });
    return res.status(400).json({ error: 'Turn on sign-in first: logo and colors are saved per newsroom.' });
  }
  var ctx;
  try { ctx = await S.requireUser(req); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message }); }

  if (req.method === 'GET') {
    var p = await Store.getProfile(ctx.supabase);
    return res.status(200).json({ brand: p.brand || null });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });
  if (ctx.membership.role !== 'publisher') return res.status(403).json({ error: 'Only the publisher can change the newsroom\'s logo and colors.' });

  var body = req.body || {};
  if (String(body.logo || '').length > MAX_LOGO * 1.4) return res.status(413).json({ error: 'That logo is too big. Try a smaller image.' });
  var brand = clean(body);
  if (body.logo && !brand.logo) return res.status(400).json({ error: 'Use a PNG, JPG or WebP image for the logo.' });
  brand.updatedAt = new Date().toISOString();
  await Store.saveProfile(ctx.supabase, { brand: brand });
  return res.status(200).json({ ok: true, brand: brand });
};

module.exports = Object.assign(require('./_site').wrap(module.exports), { clean: clean });
