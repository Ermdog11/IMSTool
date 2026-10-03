// Yesterday's numbers (Eastern day) for the morning Coverage Desk memo:
// site traffic from the Chartbeat snapshots (api/analytics-snapshot.js, every
// 3h) and social from Buffer. Best-effort like the other analytics helpers:
// a source that isn't connected or fails is left out with a note, never
// thrown, so the memo still goes out.
//
// The site numbers are built from snapshot readings (8 a day), so "readers"
// here means people on the page at those moments, summed — a good ranking
// of what pulled readers, not an exact pageview count.

var Store = require('./_analytics-store');
var BufferApi = require('./_buffer');
var XA = require('./_x-analytics');
var GSC = require('./_gsc');

var TZ = 'America/New_York';

// UTC instant of midnight Eastern, `daysAgo` days back from today.
function etMidnight(daysAgo) {
  var now = new Date();
  var ymd = now.toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
  var guess = new Date(ymd + 'T00:00:00Z');
  var offsetMs = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' })) - new Date(guess.toLocaleString('en-US', { timeZone: TZ }));
  return new Date(guess.getTime() + offsetMs - daysAgo * 86400000);
}

function etLabel(iso, opts) { return new Date(iso).toLocaleString('en-US', Object.assign({ timeZone: TZ }, opts)); }

function urlPath(u) { try { return new URL(u).pathname.replace(/\/+$/, ''); } catch (e) { return ''; } }

async function siteYesterday(sb, siteId, start, end) {
  var conn = await Store.getConnection(sb, siteId, 'chartbeat');
  if (!conn || !conn.apiKey) return null;
  var weekAgo = new Date(start.getTime() - 7 * 86400000);
  var snaps = await Store.listSnapshots(sb, siteId, 'chartbeat', weekAgo.toISOString());
  var yday = snaps.filter(function (s) { var t = new Date(s.captured_at); return t >= start && t < end; });
  var prior = snaps.filter(function (s) { return new Date(s.captured_at) < start; });
  if (!yday.length) return { note: 'No Chartbeat readings were captured yesterday.' };

  function avgVisits(list) {
    var v = list.map(function (s) { return s.metrics && s.metrics.visits; }).filter(function (x) { return typeof x === 'number'; });
    return v.length ? Math.round(v.reduce(function (a, b) { return a + b; }, 0) / v.length) : null;
  }
  var peak = yday.reduce(function (best, s) { var v = (s.metrics && s.metrics.visits) || 0; return v > best.visits ? { visits: v, at: s.captured_at } : best; }, { visits: 0, at: null });

  var pages = {};
  yday.forEach(function (s) {
    ((s.metrics && s.metrics.pages) || []).forEach(function (p) {
      var k = p.path || p.title; if (!k) return;
      if (!pages[k]) pages[k] = { title: p.title || p.path, path: p.path || '', readers: 0, readings: 0 };
      pages[k].readers += p.visits || 0; pages[k].readings++;
      if (p.sources) {
        pages[k].fromSearch = (pages[k].fromSearch || 0) + (p.sources.search || 0);
        pages[k].fromSocial = (pages[k].fromSocial || 0) + (p.sources.social || 0);
      }
    });
  });
  var avg = avgVisits(yday), priorAvg = avgVisits(prior);
  // Where readers came from: share by source yesterday vs the prior week.
  function shares(list) {
    var tot = {}, all = 0;
    list.forEach(function (s) { var src = s.metrics && s.metrics.sources; if (src) Object.keys(src).forEach(function (k) { tot[k] = (tot[k] || 0) + src[k]; all += src[k]; }); });
    if (!all) return null;
    var out = {}; Object.keys(tot).forEach(function (k) { out[k] = Math.round(tot[k] / all * 1000) / 10; }); return out;
  }
  var srcY = shares(yday), srcP = shares(prior);
  var sources = srcY ? Object.keys(srcY).map(function (k) { return { source: k, sharePct: srcY[k], priorWeekSharePct: srcP && srcP[k] != null ? srcP[k] : null }; })
    .sort(function (a, b) { return b.sharePct - a.sharePct; }) : null;
  return {
    readings: yday.length,
    avgReaders: avg,
    priorWeekAvgReaders: priorAvg,
    changeVsWeekPct: (avg != null && priorAvg) ? Math.round((avg - priorAvg) / priorAvg * 100) : null,
    peak: peak.at ? { readers: peak.visits, at: etLabel(peak.at, { hour: 'numeric', minute: '2-digit' }) } : null,
    trafficSources: sources,
    topStories: Object.keys(pages).map(function (k) { return pages[k]; })
      .sort(function (a, b) { return b.readers - a.readers; }).slice(0, 8)
  };
}

async function socialYesterday(sb, siteId, start, end) {
  var conn = await Store.getConnection(sb, siteId, 'buffer');
  if (!conn || !conn.apiKey || !conn.organizationId) return null;
  var channels = await BufferApi.getChannels(conn.apiKey, conn.organizationId);
  var chName = {}; channels.forEach(function (c) { chName[c.id] = c.name; });
  function shape(p) {
    var m = BufferApi.metricsMap(p.metrics);
    var links = (String(p.text || '').match(/https?:\/\/[^\s)]+/g) || []);
    return {
      channel: chName[p.channelId] || p.channelService, service: p.channelService,
      text: String(p.text || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      sentAt: etLabel(p.sentAt || p.dueAt, { weekday: 'short', hour: 'numeric', minute: '2-digit' }),
      links: links, metrics: m, interactions: BufferApi.engagementOf(m), measured: !!(p.metrics && p.metrics.length)
    };
  }
  // Buffer refreshes metrics about once a day, so yesterday's posts may not
  // have numbers yet at memo time; the last 7 days' measured posts fill in.
  var yday = (await BufferApi.getSentPosts(conn.apiKey, conn.organizationId, start.toISOString(), end.toISOString())).map(shape);
  var week = (await BufferApi.getSentPosts(conn.apiKey, conn.organizationId, new Date(start.getTime() - 6 * 86400000).toISOString(), end.toISOString())).map(shape);
  var byChannel = {};
  yday.forEach(function (p) { var k = p.channel || p.service; byChannel[k] = byChannel[k] || { posts: 0, interactions: 0 }; byChannel[k].posts++; byChannel[k].interactions += p.interactions; });
  var measuredWeek = week.filter(function (p) { return p.measured; });
  return {
    postsYesterday: yday.length,
    measuredYesterday: yday.filter(function (p) { return p.measured; }).length,
    byChannel: byChannel,
    yesterdayPosts: yday.slice(0, 15),
    topPostsLast7Days: measuredWeek.sort(function (a, b) { return b.interactions - a.interactions; }).slice(0, 5),
    note: 'Buffer updates post metrics about once a day, so posts from late yesterday may not have numbers yet.'
  };
}

// Yesterday's tweets from the newsroom's own X account (stored copy,
// refreshed first). Tweets from the last few hours of yesterday may not have
// matured into the store yet; the note says so.
async function xYesterday(sb, siteId, start, end) {
  var conn = await Store.getConnection(sb, siteId, 'x');
  if (!conn || !conn.userId) return null;
  var store, refreshError = null;
  try { store = await XA.refresh(sb, siteId); } catch (e) { refreshError = e.message; store = await XA.readStore(siteId); }
  if (!store) return { note: refreshError || 'No X data stored yet.' };
  var tweets = XA.between(store, start.getTime(), end.getTime());
  var tot = { tweets: tweets.length, impressions: 0, interactions: 0 };
  tweets.forEach(function (t) { tot.impressions += t.impressions; tot.interactions += t.interactions; });
  var sm = XA.summary(store);
  return {
    handle: conn.handle, totals: tot,
    avgImpressionsPerTweetLast7Days: sm.last7.avgImpressionsPerTweet,
    topTweets: tweets.sort(function (a, b) { return b.impressions - a.impressions; }).slice(0, 5),
    note: 'Each tweet is read about ' + XA.MATURE_HOURS + ' hours after posting, so the last few hours of yesterday may not be counted yet.' + (refreshError ? ' (Refresh failed: ' + refreshError + ')' : '')
  };
}

// For each of yesterday's top site stories, how many of yesterday's social
// posts linked to it — "did well on the site but we barely pushed it".
function crossLink(site, social) {
  if (!site || !site.topStories || !social || !social.yesterdayPosts) return;
  site.topStories.forEach(function (st) {
    var path = (st.path || '').replace(/\/+$/, '');
    st.socialPostsYesterday = path ? social.yesterdayPosts.filter(function (p) {
      return p.links.some(function (l) { var lp = urlPath(l); return lp && (lp === path || lp.indexOf(path) !== -1 || path.indexOf(lp) !== -1); });
    }).length : null;
  });
}

async function gatherYesterday(sb, siteId) {
  var start = etMidnight(1), end = etMidnight(0);
  var out = { day: etLabel(start.toISOString(), { weekday: 'long', month: 'long', day: 'numeric' }), site: null, social: null, x: null, search: null, errors: [] };
  try { out.site = await siteYesterday(sb, siteId, start, end); } catch (e) { out.errors.push('Site: ' + e.message); }
  try { out.social = await socialYesterday(sb, siteId, start, end); } catch (e) { out.errors.push('Social: ' + e.message); }
  try { out.x = await xYesterday(sb, siteId, start, end); } catch (e) { out.errors.push('X: ' + e.message); }
  try {
    var gconn = await Store.getConnection(sb, siteId, 'gsc');
    if (gconn && gconn.siteUrl) out.search = await GSC.fetchYesterday(gconn.siteUrl, gconn.pathPrefix);
  } catch (e) { out.errors.push('Search Console: ' + e.message); }
  crossLink(out.site, out.social);
  return out;
}

module.exports = { gatherYesterday: gatherYesterday, etMidnight: etMidnight };
