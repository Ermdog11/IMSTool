// /api/affiliate — affiliate programs, clicks and payouts (see _affiliate.js).
//
//   GET ?for=editor   (any signed-in member) -> { site, programs:[{id,name,domains,boxHtml,first,every,max}] }
//   GET ?month=YYYY-MM (admin) -> { programs, earnings, clicks, payouts, month }
//   POST (admin) { action:'programs', programs:[...] }
//                { action:'earning', month, program, site, amount }
//                { action:'delete-earning', index }
//
// Admin = the CoPublisher AI operators: emails in PLATFORM_ADMIN_EMAILS, or,
// while that isn't set (one newsroom today), that newsroom's publisher.

var S = require('./_supabase');
var Aff = require('./_affiliate');

function isAdmin(ctx) {
  if (!ctx || ctx.cron || ctx.internal || ctx.open) return !S.isConfigured();
  var list = String(process.env.PLATFORM_ADMIN_EMAILS || '').toLowerCase().split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  var email = String((ctx.user && ctx.user.email) || '').toLowerCase();
  if (list.length) return list.indexOf(email) !== -1;
  return !!(ctx.membership && ctx.membership.role === 'publisher');
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  var ctx;
  try { ctx = await S.requireUserOrCron(req, res); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message || 'Not signed in' }); }
  try {
    var config = await Aff.loadConfig();
    var site = (ctx && ctx.site && ctx.site.slug) || require('./_site').slug();
    if (req.method === 'GET' && req.query && req.query.for === 'editor') {
      return res.status(200).json({
        site: site,
        programs: config.programs.filter(function (p) { return p.active !== false; }).map(function (p) {
          return { id: p.id, name: p.name, domains: p.domains || [], boxHtml: p.boxHtml || '', first: p.first || 4, every: p.every || 0, max: p.max || 1, home: p.home || '' };
        })
      });
    }
    if (!isAdmin(ctx)) return res.status(403).json({ error: 'Affiliate programs are managed by CoPublisher AI.' });
    if (req.method === 'GET') {
      var m = /^\d{4}-\d{2}$/.test((req.query && req.query.month) || '') ? req.query.month : Aff.month();
      return res.status(200).json({ month: m, site: site, programs: config.programs, earnings: config.earnings, clicks: await Aff.clicks(m), payouts: Aff.payouts(config, m) });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });
    var b = req.body || {};
    if (b.action === 'programs') {
      config.programs = (b.programs || []).slice(0, 50).map(function (p) {
        return {
          id: String(p.id || p.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || ('p' + Date.now().toString(36)),
          name: String(p.name || '').slice(0, 80), active: p.active !== false,
          domains: (Array.isArray(p.domains) ? p.domains : String(p.domains || '').split(/[\s,]+/)).map(function (d) { return Aff.hostOf(/^https?:/.test(d) ? d : 'https://' + d); }).filter(Boolean).slice(0, 20),
          urlTemplate: String(p.urlTemplate || '').slice(0, 1000), home: String(p.home || '').slice(0, 500),
          boxHtml: String(p.boxHtml || '').slice(0, 5000),
          first: Math.max(1, +p.first || 4), every: Math.max(0, +p.every || 0), max: Math.max(1, Math.min(5, +p.max || 1)),
          share: Math.max(0, Math.min(100, Number(p.share) || 0)), notes: String(p.notes || '').slice(0, 500)
        };
      });
      await Aff.saveConfig(config);
      return res.status(200).json({ ok: true, programs: config.programs });
    }
    if (b.action === 'earning') {
      if (!/^\d{4}-\d{2}$/.test(b.month || '') || !b.program || !b.site || isNaN(Number(b.amount))) return res.status(400).json({ error: 'Month, program, newsroom and amount are required.' });
      config.earnings.push({ month: b.month, program: String(b.program), site: String(b.site).slice(0, 60), amount: Math.round(Number(b.amount) * 100) / 100, enteredAt: new Date().toISOString(), enteredBy: (ctx.user && ctx.user.email) || null });
      await Aff.saveConfig(config);
      return res.status(200).json({ ok: true });
    }
    if (b.action === 'delete-earning') {
      var i = +b.index;
      if (!(i >= 0 && i < config.earnings.length)) return res.status(400).json({ error: 'Not found' });
      config.earnings.splice(i, 1);
      await Aff.saveConfig(config);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

// Per-newsroom: this request runs as the signed-in person's newsroom (_site.js).
module.exports = require('./_site').wrap(module.exports);
