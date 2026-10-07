// /api/analytics-strategy — the cross-channel content and social strategy
// read (see _analytics-strategy.js).
//   GET                 -> the latest saved read (anyone who can see Analytics)
//   GET  (cron, daily)  -> runs it for the site and saves it
//   POST { refresh }    -> runs it now (publisher and editors; one Claude call)

var S = require('./_supabase');
var Strategy = require('./_analytics-strategy');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!S.isConfigured()) return res.status(503).json({ error: 'Login not configured' });
  var ctx;
  try { ctx = await S.requireUserOrCron(req, res); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message || 'Not signed in' }); }
  try {
    if (ctx && (ctx.cron || ctx.internal)) {
      var sb = S.admin();
      var site = await sb.from('sites').select('id').eq('slug', require('./_site').slug()).single();
      if (!site.data) return res.status(200).json({ skipped: 'no site' });
      var r = await Strategy.run(sb, site.data.id);
      return res.status(200).json({ ok: true, ready: r.ready, sources: r.sources || [] });
    }
    if (!(await require('./_access').allowed(ctx, 'mon_analytics'))) return require('./_access').deny(res);
    if (req.method === 'POST') {
      var role = ctx.membership && ctx.membership.role;
      if (role && role !== 'publisher' && role !== 'editor') return res.status(403).json({ error: 'Editors and publishers can refresh the strategy.' });
      return res.status(200).json(await Strategy.run(ctx.supabase, ctx.site.id));
    }
    return res.status(200).json(await Strategy.latest(ctx.supabase, ctx.site.id));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

// Per-newsroom: this request runs as the signed-in person's newsroom (_site.js).
module.exports = require('./_site').wrap(module.exports);
