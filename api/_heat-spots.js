// Heat spots: the five best times to publish this week, in order, from the
// newsroom's own past numbers (Jeff, 2026-10-06: "an option for heat spots on
// the calendar - the five best times to publish that week, in order, based on
// previous data ... a few sentences in coverage desk and auto added to the
// calendar with a reminder option").
//
// What it reads (last 4 weeks, Eastern time):
//   - site readers: the Chartbeat snapshots (api/analytics-snapshot.js, every
//     3 hours), by day of week and hour. Hours between readings are filled in
//     from the neighbors, and each day/hour is blended with the overall
//     hour-of-day curve so one odd night doesn't decide it.
//   - social: interactions on posts sent through Buffer and on the X
//     account's own tweets, by day and hour, relative to the average post.
// Site readers decide when they're connected; social engagement only nudges
// a slot (about +/-15%), each post capped at 3x average so one viral post
// can't make an hour, and an hour with below-typical site readers is never
// picked. With only social connected, social decides.
//
// The five come from the rest of this week (now through Sunday), 6 AM to
// 11 PM, at most two a day and at least three hours apart, ranked #1-#5.
// They go on the calendar as kind 'heat' (see _calendar.js setHeatSpots),
// refreshed by the Monday cron (api/heat-spots.js) or "Refresh" on the
// Calendar tab. Best-effort: missing data means fewer or no spots, never an
// error that stops the memo.

var Store = require('./_analytics-store');
var TZ = 'America/New_York';
var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
var LOOKBACK_DAYS = 28;
var FIRST_HOUR = 6, LAST_HOUR = 23;

function parts(ms) {
  var p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' })
    .formatToParts(new Date(ms)).reduce(function (o, x) { o[x.type] = x.value; return o; }, {});
  return { dow: DAYS.indexOf(p.weekday), hour: +p.hour % 24, ymd: p.year + '-' + p.month + '-' + p.day };
}

function mean(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null; }

// Average by hour (0-23) with gaps filled from the nearest readings on each
// side (the snapshots come every 3 hours).
function hourCurve(samples) {
  var by = {};
  samples.forEach(function (s) { (by[s.hour] = by[s.hour] || []).push(s.v); });
  var known = Object.keys(by).map(Number).sort(function (a, b) { return a - b; });
  if (!known.length) return null;
  var avg = {}; known.forEach(function (h) { avg[h] = mean(by[h]); });
  var out = [];
  for (var h = 0; h < 24; h++) {
    if (avg[h] != null) { out[h] = avg[h]; continue; }
    var prev = null, next = null;
    for (var d = 1; d < 24 && (prev == null || next == null); d++) {
      if (prev == null && avg[(h - d + 24) % 24] != null) prev = { h: d, v: avg[(h - d + 24) % 24] };
      if (next == null && avg[(h + d) % 24] != null) next = { h: d, v: avg[(h + d) % 24] };
    }
    out[h] = prev && next ? prev.v + (next.v - prev.v) * prev.h / (prev.h + next.h) : (prev || next).v;
  }
  return out;
}

// samples: [{ dow, hour, v }] -> score(dow, hour) relative to the overall
// average (1 = typical), or null when there's nothing to go on.
function model(samples, minCell) {
  if (samples.length < 8) return null;
  var overall = mean(samples.map(function (s) { return s.v; }));
  if (!overall) return null;
  var curve = hourCurve(samples);
  var dayAvg = {};
  DAYS.forEach(function (_, d) { var v = samples.filter(function (s) { return s.dow === d; }).map(function (s) { return s.v; }); dayAvg[d] = v.length >= 3 ? mean(v) / overall : 1; });
  var cell = {};
  samples.forEach(function (s) { var k = s.dow + '|' + s.hour; (cell[k] = cell[k] || []).push(s.v); });
  return function (dow, hour) {
    var general = (curve[hour] / overall) * dayAvg[dow];
    var c = cell[dow + '|' + hour];
    // A day/hour with few readings leans on the general curve: its own
    // average counts in proportion to how many readings it has (n / (n + 3)).
    if (c && c.length >= (minCell || 2)) { var w = c.length / (c.length + 3); return (1 - w) * general + w * (mean(c) / overall); }
    return general;
  };
}

async function siteSamples(sb, siteId) {
  try {
    var conn = await Store.getConnection(sb, siteId, 'chartbeat');
    if (!conn) return [];
    var snaps = await Store.listSnapshots(sb, siteId, 'chartbeat', new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString());
    return snaps.filter(function (s) { return s.metrics && typeof s.metrics.visits === 'number'; })
      .map(function (s) { var p = parts(Date.parse(s.captured_at)); return { dow: p.dow, hour: p.hour, v: s.metrics.visits }; });
  } catch (e) { console.error('heat-spots: site data failed:', e.message); return []; }
}

async function socialSamples(sb, siteId) {
  var out = [];
  var since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  try {
    var conn = await Store.getConnection(sb, siteId, 'buffer');
    if (conn && conn.apiKey && conn.organizationId) {
      var B = require('./_buffer');
      var posts = await B.getSentPosts(conn.apiKey, conn.organizationId, since, new Date().toISOString());
      var list = posts.filter(function (p) { return p.metrics && p.metrics.length; })
        .map(function (p) { return { at: Date.parse(p.sentAt || p.dueAt), v: B.engagementOf(B.metricsMap(p.metrics)) }; });
      out = out.concat(relative(list));
    }
  } catch (e) { console.error('heat-spots: Buffer failed:', e.message); }
  try {
    var x = await Store.getConnection(sb, siteId, 'x');
    if (x && x.userId) {
      var store = await require('./_x-analytics').readStore(siteId);
      var tweets = ((store && store.tweets) || []).filter(function (t) { return Date.parse(t.createdAt) >= Date.parse(since); })
        .map(function (t) { var m = t.m || {}; return { at: Date.parse(t.createdAt), v: m.impression_count || ((m.like_count || 0) + (m.retweet_count || 0) + (m.reply_count || 0)) }; });
      out = out.concat(relative(tweets));
    }
  } catch (e) { console.error('heat-spots: X failed:', e.message); }
  return out;
}

// Each source on its own scale (X impressions dwarf Buffer interactions):
// every post as a multiple of that source's average.
function relative(list) {
  list = list.filter(function (p) { return p.at && typeof p.v === 'number'; });
  var avg = mean(list.map(function (p) { return p.v; }));
  if (!avg) return [];
  // Capped at 3x the average: one viral post shouldn't make its hour a
  // "heat spot" (Jeff, 2026-10-06, on a 7 AM spot from a single +2133% post).
  return list.map(function (p) { var q = parts(p.at); return { dow: q.dow, hour: q.hour, v: Math.min(p.v / avg, 3) }; });
}

function hourLabel(h) { return (h % 12 || 12) + (h < 12 ? ' AM' : ' PM'); }
function pct(x) {
  if (x >= 2) return (Math.round(x * 10) / 10) + 'x typical';
  var p = Math.round((x - 1) * 100); return p === 0 ? 'about typical' : (p > 0 ? p + '% above' : -p + '% below') + ' typical';
}

// The week's slots still ahead: [{ ms, ymd, dow, hour }] from the next whole
// hour through Sunday 11 PM.
function slotsAhead(nowMs) {
  var out = [], start = Math.ceil((nowMs + 1) / 3600000) * 3600000;
  var startDow = parts(nowMs).dow, today = parts(nowMs).ymd;
  var daysLeft = startDow === 0 ? 1 : 8 - startDow; // through Sunday
  for (var ms = start; ms < nowMs + daysLeft * 86400000; ms += 3600000) {
    var p = parts(ms);
    if (p.dow === 1 && p.ymd !== today) break; // rolled into next week
    if (p.hour < FIRST_HOUR || p.hour > LAST_HOUR) continue;
    out.push({ ms: ms, ymd: p.ymd, dow: p.dow, hour: p.hour });
  }
  return out;
}

// -> { spots: [{ rank, date, time, day, label, score, why }], basis, note }
async function compute(sb, siteId, nowMs) {
  nowMs = nowMs || Date.now();
  var site = await siteSamples(sb, siteId), social = await socialSamples(sb, siteId);
  var siteM = model(site, 2), socM = model(social, 2);
  if (!siteM && !socM) return { spots: [], basis: null, note: 'Not enough history yet: heat spots need about two days of Chartbeat readings or a few weeks of Buffer/X posts.' };
  var scored = slotsAhead(nowMs).map(function (s) {
    var a = siteM ? siteM(s.dow, s.hour) : null, b = socM ? socM(s.dow, s.hour) : null;
    // With site readers known, they decide; social nudges by at most about
    // +/-15% (and never rescues an hour when site readers are below typical).
    var score = a != null ? a * (b != null ? Math.pow(Math.max(0.7, Math.min(1.5, b)), 0.35) : 1) : (b || 0);
    return Object.assign({}, s, { site: a, social: b, score: score, ok: a != null ? a >= 1 : (b || 0) >= 1 });
  }).sort(function (x, y) { return y.score - x.score; });
  var picked = [];
  scored.forEach(function (s) {
    if (picked.length >= 5 || !s.ok) return;
    var sameDay = picked.filter(function (p) { return p.ymd === s.ymd; });
    if (sameDay.length >= 2 || sameDay.some(function (p) { return Math.abs(p.hour - s.hour) < 3; })) return;
    picked.push(s);
  });
  var spots = picked.map(function (s, i) {
    var why = [];
    if (s.site != null) why.push('site readers at ' + hourLabel(s.hour) + ' on ' + DAYS[s.dow] + 's run ' + pct(s.site));
    if (s.social != null && (s.site == null || s.social >= 1.1) && Math.abs(s.social - 1) >= 0.1) why.push('posts sent then get ' + pct(s.social).replace(' typical', ' the usual engagement').replace('x the usual', 'x the usual'));
    return {
      rank: i + 1, date: s.ymd, time: (s.hour < 10 ? '0' : '') + s.hour + ':00', day: DAYS[s.dow], label: DAYS[s.dow] + ' ' + hourLabel(s.hour),
      score: Math.round(s.score * 100) / 100,
      why: why.length ? why.join('; ').replace(/^./, function (c) { return c.toUpperCase(); }) + '.' : ''
    };
  });
  return {
    spots: spots,
    basis: [siteM ? site.length + ' Chartbeat readings' : null, socM ? social.length + ' social posts' : null].filter(Boolean).join(' and ') + ' from the last 4 weeks',
    note: null
  };
}

module.exports = { compute: compute, model: model, hourCurve: hourCurve, slotsAhead: slotsAhead, parts: parts };
