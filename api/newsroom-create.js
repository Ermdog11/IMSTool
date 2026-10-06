// POST /api/newsroom-create { name } — a signed-in person with no invite
// starts a newsroom of their own and becomes its publisher, then goes
// straight into the setup wizard (/setup), which saves to that newsroom.
// Multi-newsroom, 2026-10-06 (Jeff: "We need to do this").
//
// Spends no Claude credits and sends no email. One person can start at most
// MAX_OWNED newsrooms, so a stray double-tap can't make a pile of them.

var S = require('./_supabase');
var Site = require('./_site');

var MAX_OWNED = 3;

function slugify(name) {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'newsroom';
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!S.isConfigured()) return res.status(503).json({ error: 'Login not configured' });

  var token = S.bearerToken(req);
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  var sb = S.admin();
  var got = await sb.auth.getUser(token);
  if (got.error || !got.data || !got.data.user) return res.status(401).json({ error: 'Session invalid or expired' });
  var user = got.data.user;

  var body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  var name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (name.length < 2) return res.status(400).json({ error: 'Give your newsroom a name' });

  var owned = await sb.from('memberships').select('id', { count: 'exact', head: true })
    .eq('user_id', user.id).eq('role', 'publisher');
  if ((owned.count || 0) >= MAX_OWNED) return res.status(400).json({ error: 'You already run ' + MAX_OWNED + ' newsrooms' });

  // A unique slug; never the InsideMDSports one.
  var base = slugify(name), slug = base, site = null;
  for (var n = 1; n <= 20 && !site; n++) {
    if (slug !== Site.DEFAULT) {
      var ins = await sb.from('sites').insert({ slug: slug, name: name }).select('id, slug, name').single();
      if (!ins.error) { site = ins.data; break; }
      if (!/duplicate|unique/i.test(ins.error.message || '')) return res.status(500).json({ error: ins.error.message });
    }
    slug = base + '-' + (n + 1);
  }
  if (!site) return res.status(500).json({ error: 'Could not pick a newsroom address; try another name' });

  await sb.from('profiles').upsert({
    id: user.id, email: user.email,
    full_name: (user.user_metadata && (user.user_metadata.full_name || user.user_metadata.name)) || null
  }, { onConflict: 'id', ignoreDuplicates: true });

  var mem = await sb.from('memberships').insert({
    user_id: user.id, site_id: site.id, role: 'publisher',
    byline: (user.user_metadata && user.user_metadata.full_name) || null
  }).select('id').single();
  if (mem.error) {
    await sb.from('sites').delete().eq('id', site.id);
    return res.status(500).json({ error: mem.error.message });
  }

  return res.status(200).json({ ok: true, site: site, next: '/setup' });
};

// Per-newsroom: this request runs as the signed-in person's newsroom (_site.js).
module.exports = require('./_site').wrap(module.exports);
