// /api/heat-spots — cron, Monday 6 AM Eastern: works out the week's five best
// times to publish and puts them on the calendar (see _heat-spots.js and
// _calendar.js ensureHeatSpots; stored analytics only, no Claude call). The
// Coverage Desk memo also fills them in if this hasn't run yet. When the
// newsroom chose the AI-assisted calendar, it also adds the next three
// weeks' games (_ai-calendar.js; one Claude web-search call a week).

var S = require('./_supabase');
var Cal = require('./_calendar');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try { await S.requireUserOrCron(req, res); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message || 'Not signed in' }); }
  if (!S.isConfigured()) return res.status(200).json({ skipped: 'login not configured, no analytics to read' });
  try {
    var sb = S.admin();
    var site = await sb.from('sites').select('id').eq('slug', require('./_site').slug()).single();
    if (!site.data) return res.status(200).json({ skipped: 'no site' });
    var out = await Cal.ensureHeatSpots(sb, site.data.id, true);
    var games = [];
    if (Cal.mode(await Cal.load()) === 'ai') {
      try { games = await require('./_ai-calendar').addGames(sb); } catch (e) { console.error('AI calendar games failed (non-fatal):', e.message); }
    }
    console.log('Hot spots:', out.on ? out.spots.length + ' added' : 'off', '|', out.basis || out.note || '', '| games added:', games.length);
    return res.status(200).json({ on: out.on, spots: (out.spots || []).map(function (e) { return { title: e.title, start: e.start, note: e.note }; }), basis: out.basis || null, note: out.note || null, gamesAdded: games.length });
  } catch (e) {
    console.error('Hot spots failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
};

// Per-newsroom: this request runs as the signed-in person's newsroom (_site.js).
module.exports = require('./_site').wrap(module.exports);
