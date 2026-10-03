// Shared trend math over analytics_snapshots history — used by
// api/analytics-trends.js (the Trends card) and api/analytics-question.js
// (the question box), so both compute publish-time patterns and recurring
// top performers the same way.
//
// Hardcoded to America/New_York for hour/day-of-week bucketing — this is a
// single-tenant Maryland-focused tool (see _supabase.js's default siteSlug),
// not worth a per-site timezone setting yet.

var TIMEZONE = 'America/New_York';

function localHour(iso) {
  return parseInt(new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hour: 'numeric', hour12: false }).format(new Date(iso)), 10) % 24;
}

function localDayName(iso) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, weekday: 'long' }).format(new Date(iso));
}

// visitsOf: (snapshot) -> number, since "visits" lives at a different path
// per source (chartbeat: metrics.visits; meta: metrics.page_engaged_users).
function bucketBy(snapshots, keyFn, visitsOf) {
  var buckets = {};
  snapshots.forEach(function(s) {
    var visits = visitsOf(s);
    var key = keyFn(s.captured_at);
    if (!buckets[key]) buckets[key] = { sum: 0, count: 0 };
    buckets[key].sum += (typeof visits === 'number' ? visits : 0);
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

// Chartbeat's real-time concurrents genuinely vary hour to hour, so
// hour/day bucketing means something. Meta's Page Insights (as fetched
// today) are rolling 28-day totals — snapshotting them every 3h barely
// moves the number, so a same-day "best hour" would be noise dressed up as
// a pattern. Each source declares whether that computation is meaningful
// for it, and callers should say so plainly rather than showing a bogus
// answer.
var TIME_OF_DAY_MEANINGFUL = { chartbeat: true, meta: false };

function visitsForSource(source) {
  if (source === 'chartbeat') return function(s) { return s.metrics && s.metrics.visits; };
  if (source === 'meta') return function(s) { return s.metrics && (s.metrics.page_engaged_users || s.metrics.page_impressions); };
  return function() { return null; };
}

// The raw material for the Trends charts: average readers per hour of day
// and per day of week (Eastern; null where there's no snapshot yet), plus
// every reading from the last 7 days in time order.
var DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
function chartSeries(snapshots, visitsOf) {
  function avg(b) { return b ? { avg: Math.round(b.sum / b.count), samples: b.count } : null; }
  var byHour = bucketBy(snapshots, localHour, visitsOf);
  var byDay = bucketBy(snapshots, localDayName, visitsOf);
  var weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return {
    sources: sourceShares(snapshots, weekAgo),
    hourly: Array.from({ length: 24 }, function(_, h) { return Object.assign({ hour: h }, avg(byHour[h]) || { avg: null, samples: 0 }); }),
    daily: DAY_ORDER.map(function(d) { return Object.assign({ day: d }, avg(byDay[d]) || { avg: null, samples: 0 }); }),
    recent: snapshots.filter(function(s) { return new Date(s.captured_at).getTime() >= weekAgo; })
      .map(function(s) { var v = visitsOf(s); return { at: s.captured_at, visits: typeof v === 'number' ? v : null }; })
      .filter(function(p) { return p.visits != null; })
  };
}

// Share of readers by traffic source (search, social, …) across the
// snapshots since `sinceMs`, compared with the 7 days before that. Null when
// no snapshot has source data yet (older snapshots didn't record it).
function sumSources(list) {
  var tot = {}, all = 0;
  list.forEach(function(s) {
    var src = s.metrics && s.metrics.sources;
    if (!src) return;
    Object.keys(src).forEach(function(k) { tot[k] = (tot[k] || 0) + (src[k] || 0); all += src[k] || 0; });
  });
  return all ? { tot: tot, all: all } : null;
}
function sourceShares(snapshots, sinceMs) {
  var cur = sumSources(snapshots.filter(function(s) { return new Date(s.captured_at).getTime() >= sinceMs; }));
  if (!cur) return null;
  var prev = sumSources(snapshots.filter(function(s) { var t = new Date(s.captured_at).getTime(); return t < sinceMs && t >= sinceMs - 7 * 86400000; }));
  return Object.keys(cur.tot).map(function(k) {
    var share = Math.round(cur.tot[k] / cur.all * 1000) / 10;
    var prevShare = prev && prev.tot[k] != null ? Math.round(prev.tot[k] / prev.all * 1000) / 10 : null;
    return { source: k, sharePct: share, previousSharePct: prevShare };
  }).sort(function(a, b) { return b.sharePct - a.sharePct; });
}

function computeTrends(source, snapshots) {
  var visitsOf = visitsForSource(source);
  var out = { source: source, count: snapshots.length, timeOfDayMeaningful: !!TIME_OF_DAY_MEANINGFUL[source] };
  if (out.timeOfDayMeaningful) {
    var byHour = bucketBy(snapshots, localHour, visitsOf);
    var byDay = bucketBy(snapshots, localDayName, visitsOf);
    var bestHour = bestBucket(byHour);
    var bestDay = bestBucket(byDay);
    out.bestHour = bestHour ? { hour: parseInt(bestHour.key, 10), avg: Math.round(bestHour.avg), sampleSize: bestHour.count } : null;
    out.bestDay = bestDay ? { day: bestDay.key, avg: Math.round(bestDay.avg), sampleSize: bestDay.count } : null;
  }
  if (source === 'chartbeat') out.topRecurringPages = topRecurringPages(snapshots);
  if (out.timeOfDayMeaningful) out.series = chartSeries(snapshots, visitsOf);
  return out;
}

module.exports = {
  localHour: localHour,
  localDayName: localDayName,
  bucketBy: bucketBy,
  bestBucket: bestBucket,
  topRecurringPages: topRecurringPages,
  computeTrends: computeTrends,
  TIME_OF_DAY_MEANINGFUL: TIME_OF_DAY_MEANINGFUL
};
