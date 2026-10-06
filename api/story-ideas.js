// Story ideas feedback (Story backlog tab). "Fewer like this" on an idea card
// records that idea here, newsroom-wide, so the next "Generate ideas" batch is
// told to avoid similar topics and angles. Also hands the page the beat's
// names so the idea prompt isn't written for one team.
//
//   GET                         -> { disliked:[{title, angle, at}], beat:{outletName, coverage, short} }
//   POST {dislike:{title,angle}} -> { ok:true }
//   POST {action:'ombudsman', alerts} -> { ideas } (the Ombudsman's five, on demand)
//
// Small Vercel Blob list per site (story-ideas-feedback.json), newest first,
// capped at 60. Best-effort like the other Blob state.
var { get, put } = require('@vercel/blob');
var S = require('./_supabase.js');
var Beat = require('./_beat.js');

var PATH = 'story-ideas-feedback.json';
var SITE = 'insidemdsports';

async function loadAll() {
  try {
    var r = await get(PATH, { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200) return {};
    var d = await new Response(r.stream).json();
    return (d && typeof d === 'object') ? d : {};
  } catch (e) { return {}; }
}

module.exports = async function handler(req, res) {
  try { await S.requireUserOrCron(req, res); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message || 'Not signed in' }); }
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method === 'GET') {
      var all = await loadAll();
      var b = await Beat.getBeat(S.isConfigured() ? S.admin() : null);
      return res.status(200).json({
        disliked: (all[SITE] || []).slice(0, 40),
        beat: { outletName: b.outletName, coverage: b.coverage, short: b.team.short },
        // The Ombudsman's latest five (from the last update email), for the Story backlog tab.
        ombudsman: await require('./_ombudsman.js').latest().catch(function () { return null; })
      });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });
    // "💡 Get 5 ideas now" on the Story backlog tab: run the Ombudsman on
    // demand (one Claude call) from the latest scan the page has.
    if (req.body && req.body.action === 'ombudsman') {
      var alerts = Array.isArray(req.body.alerts) ? req.body.alerts.slice(0, 40).map(function (a) {
        return { headline: String(a.headline || '').slice(0, 300), summary: String(a.summary || '').slice(0, 400), rating: +a.rating || 0, source: String(a.source || '').slice(0, 60) };
      }) : [];
      var ideas = await require('./_ombudsman.js').suggest(alerts, { slot: 'on demand' });
      return res.status(200).json({ ideas: ideas });
    }
    var d = (req.body && req.body.dislike) || {};
    var title = String(d.title || '').trim().slice(0, 300);
    if (!title) return res.status(400).json({ error: 'dislike.title required' });
    var all2 = await loadAll();
    var list = Array.isArray(all2[SITE]) ? all2[SITE] : [];
    list.unshift({ title: title, angle: String(d.angle || '').trim().slice(0, 500), at: new Date().toISOString() });
    all2[SITE] = list.slice(0, 60);
    await put(PATH, JSON.stringify(all2), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
