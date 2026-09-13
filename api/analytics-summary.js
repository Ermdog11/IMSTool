// /api/analytics-summary — GET: the standing cross-source "what's happening
// across your audience" note shown at the top of the Trends card. Reads the
// latest cached value instead of calling Claude live — it's regenerated on
// the same cron as the snapshots (api/analytics-snapshot.js), every 3h.

var S = require('./_supabase');
var Store = require('./_analytics-store');

var LOOKBACK_HOURS = 48; // plenty of margin over the 3h cron cadence

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!S.isConfigured()) return res.status(503).json({ error: 'Login not configured' });

  var ctx;
  try { ctx = await S.requireUser(req); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message }); }

  try {
    var since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
    var rows = await Store.listSnapshots(ctx.supabase, ctx.site.id, 'summary', since);
    if (!rows.length) return res.status(200).json({ ready: false });

    var latest = rows[rows.length - 1];
    return res.status(200).json({
      ready: true,
      text: latest.metrics && latest.metrics.text,
      generatedAt: latest.captured_at
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
