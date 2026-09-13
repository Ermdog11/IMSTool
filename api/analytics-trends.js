// /api/analytics-trends — GET: turns the snapshot history (analytics_snapshots,
// piled up by api/analytics-snapshot.js's cron) into actual patterns — best
// time/day to publish, and which stories keep pulling readers over time —
// instead of only ever showing a single "right now" reading. First cut of
// the cross-source "what's working" synthesis layer described in
// FEATURES.md; today it only has Chartbeat data to work with, but the
// snapshot table is source-agnostic so Parse.ly/GA4/Meta feed the same
// computation once they're connected.
//
// Hardcoded to America/New_York for hour/day-of-week bucketing — this is a
// single-tenant Maryland-focused tool (see _supabase.js's default siteSlug),
// not worth a per-site timezone setting yet.

var S = require('./_supabase');
var Store = require('./_analytics-store');

var TIMEZONE = 'America/New_York';
var MIN_SNAPSHOTS = 8;   // ~1 day at the cron's 3-hour cadence
var LOOKBACK_DAYS = 30;

function localHour(iso) {
  return parseInt(new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hour: 'numeric', hour12: false }).format(new Date(iso)), 10) % 24;
}

function localDayName(iso) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, weekday: 'long' }).format(new Date(iso));
}

function bucketBy(snapshots, keyFn) {
  var buckets = {};
  snapshots.forEach(function(s) {
    var visits = (s.metrics && typeof s.metrics.visits === 'number') ? s.metrics.visits : 0;
    var key = keyFn(s.captured_at);
    if (!buckets[key]) buckets[key] = { sum: 0, count: 0 };
    buckets[key].sum += visits;
    buckets[key].count += 1;
  });
  return buckets;
}

function bestBucket(buckets) {
  var best = null;
  Object.keys(buckets).forEach(function(key) {
    var b = buckets[key];
    var avg = b.sum / b.count;
    if (!best || avg > best.avg) best = { key: key, avg: avg, count: b.count };
  });
  return best;
}

function topRecurringPages(snapshots) {
  var totals = {};
  snapshots.forEach(function(s) {
    var pages = (s.metrics && s.metrics.pages) || [];
    pages.forEach(function(p) {
      var key = p.title || p.path;
      if (!key) return;
      if (!totals[key]) totals[key] = { title: p.title, path: p.path, totalVisits: 0, appearances: 0 };
      totals[key].totalVisits += (p.visits || 0);
      totals[key].appearances += 1;
    });
  });
  return Object.keys(totals).map(function(k) { return totals[k]; })
    .sort(function(a, b) { return b.totalVisits - a.totalVisits; })
    .slice(0, 5);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!S.isConfigured()) return res.status(503).json({ error: 'Login not configured' });

  var ctx;
  try { ctx = await S.requireUser(req); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message }); }

  try {
    var since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
    var snapshots = await Store.listSnapshots(ctx.supabase, ctx.site.id, 'chartbeat', since);

    if (snapshots.length < MIN_SNAPSHOTS) {
      return res.status(200).json({
        enough: false,
        count: snapshots.length,
        needed: MIN_SNAPSHOTS
      });
    }

    var byHour = bucketBy(snapshots, localHour);
    var byDay = bucketBy(snapshots, localDayName);
    var bestHour = bestBucket(byHour);
    var bestDay = bestBucket(byDay);

    return res.status(200).json({
      enough: true,
      count: snapshots.length,
      windowDays: LOOKBACK_DAYS,
      bestHour: bestHour ? { hour: parseInt(bestHour.key, 10), avgVisits: Math.round(bestHour.avg), sampleSize: bestHour.count } : null,
      bestDay: bestDay ? { day: bestDay.key, avgVisits: Math.round(bestDay.avg), sampleSize: bestDay.count } : null,
      topRecurringPages: topRecurringPages(snapshots)
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
