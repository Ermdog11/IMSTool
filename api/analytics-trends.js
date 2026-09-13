// /api/analytics-trends — GET: turns the snapshot history (analytics_snapshots,
// piled up by api/analytics-snapshot.js's cron) into actual patterns — best
// time/day to publish, and which stories keep pulling readers over time —
// instead of only ever showing a single "right now" reading. First cut of
// the cross-source "what's working" synthesis layer described in
// FEATURES.md; today Chartbeat and Facebook can feed it, more sources slot
// into the same computation (api/_trends.js) as they're connected.
//
// ?source=chartbeat|meta returns just that source's trends; the default
// (no param, or source=all) returns every connected source's trends plus a
// simple combined view.

var S = require('./_supabase');
var Store = require('./_analytics-store');
var Trends = require('./_trends');

var MIN_SNAPSHOTS = 8;   // ~1 day at the cron's 3-hour cadence
var LOOKBACK_DAYS = 30;
var SOURCES = ['chartbeat', 'meta'];

async function trendsFor(sb, siteId, source) {
  var since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  var snapshots = await Store.listSnapshots(sb, siteId, source, since);
  if (snapshots.length < MIN_SNAPSHOTS) {
    return { source: source, enough: false, count: snapshots.length, needed: MIN_SNAPSHOTS };
  }
  var t = Trends.computeTrends(source, snapshots);
  t.enough = true;
  t.windowDays = LOOKBACK_DAYS;
  return t;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!S.isConfigured()) return res.status(503).json({ error: 'Login not configured' });

  var ctx;
  try { ctx = await S.requireUser(req); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message }); }

  var requested = (req.query && req.query.source) || 'all';

  try {
    if (requested !== 'all') {
      if (SOURCES.indexOf(requested) === -1) return res.status(400).json({ error: 'Unknown source.' });
      var single = await trendsFor(ctx.supabase, ctx.site.id, requested);
      return res.status(200).json(single);
    }

    var connections = await Store.listConnections(ctx.supabase, ctx.site.id);
    var connectedSources = SOURCES.filter(function(s) { return connections.some(function(c) { return c.source === s; }); });
    if (!connectedSources.length) return res.status(200).json({ enough: false, count: 0, needed: MIN_SNAPSHOTS, bySource: [] });

    var bySource = [];
    for (var i = 0; i < connectedSources.length; i++) {
      bySource.push(await trendsFor(ctx.supabase, ctx.site.id, connectedSources[i]));
    }

    return res.status(200).json({ enough: bySource.some(function(t) { return t.enough; }), bySource: bySource });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
