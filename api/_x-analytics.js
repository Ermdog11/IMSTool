// X / Twitter analytics for the newsroom's own account (e.g. @terrapins247),
// read through the X API credential the news scanner already uses
// (site_settings.x_bearer_token, pay-per-use, ~$0.005 per post read).
//
// Cost control: every tweet is read from X exactly once, about MATURE_HOURS
// after it was posted (so its numbers have mostly settled), then kept in Vercel
// Blob for 30 days. The Analytics card, the Coverage Desk memo, the question
// box and Draft social all read that stored copy, so viewing them costs
// nothing. A refresh only asks X for tweets newer than the last one stored.
// ~20 tweets/day ≈ $3/month; the first refresh backfills up to 30 days once.
//
// Metrics are X's public_metrics (impressions, likes, reposts, replies,
// quotes, bookmarks). Link clicks and profile visits need the account owner
// to sign in to X (OAuth user context) and aren't available this way.

var { get, put } = require('@vercel/blob');
var Store = require('./_analytics-store');
var Settings = require('./_settings-store');

var API = 'https://api.x.com/2';
var KEEP_DAYS = 30;
var MATURE_HOURS = 6;
var MIN_REFRESH_MS = 3 * 60 * 60 * 1000;
var MAX_PAGES = 6; // 600 tweets per refresh at most
var TZ = 'America/New_York';

function blobPath(siteId) { return 'x-analytics/' + siteId + '.json'; }

async function readStore(siteId) {
  try {
    var r = await get(blobPath(siteId), { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200) return null;
    return await new Response(r.stream).json();
  } catch (e) { return null; }
}

async function writeStore(siteId, data) {
  await put(blobPath(siteId), JSON.stringify(data), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
}

async function xGet(path, bearer) {
  var r = await fetch(API + path, { headers: { Authorization: 'Bearer ' + bearer } });
  var d = await r.json().catch(function () { return null; });
  if (!r.ok) throw new Error('X: ' + ((d && (d.detail || d.title)) || ('HTTP ' + r.status)));
  return d || {};
}

async function lookupUser(bearer, handle) {
  handle = String(handle || '').replace(/^@/, '').trim();
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new Error('That doesn\'t look like an X handle.');
  var d = await xGet('/users/by/username/' + encodeURIComponent(handle) + '?user.fields=public_metrics', bearer);
  if (!d.data) throw new Error('X has no account @' + handle + '.');
  return { id: d.data.id, username: d.data.username, followers: d.data.public_metrics && d.data.public_metrics.followers_count };
}

function interactions(m) {
  return (m.like_count || 0) + (m.retweet_count || 0) + (m.reply_count || 0) + (m.quote_count || 0) + (m.bookmark_count || 0);
}

// Pull tweets that have matured since the last refresh and add them to the
// stored copy. Throttled to once per MIN_REFRESH_MS unless force.
async function refresh(sb, siteId, opts) {
  opts = opts || {};
  var conn = await Store.getConnection(sb, siteId, 'x');
  if (!conn || !conn.userId) return null;
  var store = (await readStore(siteId)) || { tweets: [] };
  if (store.userId && store.userId !== conn.userId) store = { tweets: [] }; // handle changed
  if (!opts.force && store.refreshedAt && Date.now() - new Date(store.refreshedAt).getTime() < MIN_REFRESH_MS) return store;

  var creds = await Settings.getXSearch(sb);
  if (!creds) throw new Error('The X connection (Settings → X / Twitter search) isn\'t set up, and X analytics reads through it.');

  var endIso = new Date(Date.now() - MATURE_HOURS * 3600000).toISOString().replace(/\.\d+Z$/, 'Z');
  // Resume after the newest stored tweet; first run backfills KEEP_DAYS.
  var startIso = store.newestAt || new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().replace(/\.\d+Z$/, 'Z');
  var have = {}; store.tweets.forEach(function (t) { have[t.id] = true; });
  var added = 0, token = null, pages = 0;
  if (new Date(startIso) < new Date(endIso)) {
    do {
      var q = '/users/' + conn.userId + '/tweets?max_results=100&exclude=retweets,replies&tweet.fields=created_at,public_metrics' +
        '&start_time=' + encodeURIComponent(startIso) + '&end_time=' + encodeURIComponent(endIso) + (token ? '&pagination_token=' + encodeURIComponent(token) : '');
      var d = await xGet(q, creds.bearerToken);
      (d.data || []).forEach(function (t) {
        if (have[t.id]) return;
        have[t.id] = true; added++;
        store.tweets.push({ id: t.id, text: t.text || '', createdAt: t.created_at, m: t.public_metrics || {}, readAt: new Date().toISOString() });
      });
      token = d.meta && d.meta.next_token;
      pages++;
    } while (token && pages < MAX_PAGES);
    store.newestAt = endIso;
  }
  var cutoff = Date.now() - KEEP_DAYS * 86400000;
  store.tweets = store.tweets.filter(function (t) { return new Date(t.createdAt).getTime() >= cutoff; })
    .sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
  store.userId = conn.userId; store.handle = conn.username || conn.handle;
  store.refreshedAt = new Date().toISOString();
  store.lastAdded = added;
  await writeStore(siteId, store);
  return store;
}

function shapeTweet(t, handle) {
  return {
    text: String(t.text || '').replace(/\s+/g, ' ').trim().slice(0, 240),
    url: 'https://x.com/' + (handle || 'i') + '/status/' + t.id,
    createdAt: t.createdAt,
    impressions: t.m.impression_count || 0,
    likes: t.m.like_count || 0, reposts: t.m.retweet_count || 0, replies: t.m.reply_count || 0,
    quotes: t.m.quote_count || 0, bookmarks: t.m.bookmark_count || 0,
    interactions: interactions(t.m)
  };
}

function windowSummary(store, days) {
  var since = Date.now() - days * 86400000;
  var list = store.tweets.filter(function (t) { return new Date(t.createdAt).getTime() >= since; }).map(function (t) { return shapeTweet(t, store.handle); });
  var tot = { tweets: list.length, impressions: 0, likes: 0, reposts: 0, replies: 0, quotes: 0, bookmarks: 0, interactions: 0 };
  list.forEach(function (t) { ['impressions', 'likes', 'reposts', 'replies', 'quotes', 'bookmarks', 'interactions'].forEach(function (k) { tot[k] += t[k]; }); });
  tot.engagementRatePct = tot.impressions ? Math.round(tot.interactions / tot.impressions * 1000) / 10 : null;
  function best(keyFn) {
    var b = {};
    list.forEach(function (t) { var k = keyFn(new Date(t.createdAt)); b[k] = b[k] || { sum: 0, n: 0 }; b[k].sum += t.impressions || t.interactions; b[k].n++; });
    var top = null;
    Object.keys(b).forEach(function (k) { if (b[k].n >= 3 && (!top || b[k].sum / b[k].n > top.avg)) top = { key: k, avg: Math.round(b[k].sum / b[k].n), tweets: b[k].n }; });
    return top;
  }
  var enough = list.length >= 15;
  return {
    days: days, totals: tot,
    avgImpressionsPerTweet: list.length ? Math.round(tot.impressions / list.length) : null,
    topTweets: list.slice().sort(function (a, b) { return (b.impressions - a.impressions) || (b.interactions - a.interactions); }).slice(0, 5),
    bestDay: enough ? best(function (d) { return d.toLocaleString('en-US', { timeZone: TZ, weekday: 'long' }); }) : null,
    bestHour: enough ? best(function (d) { return d.toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: true }); }) : null
  };
}

// Both views the card shows: last 7 days and last 30 days.
function summary(store) {
  return {
    handle: store.handle, refreshedAt: store.refreshedAt, oldestStored: store.tweets.length ? store.tweets[store.tweets.length - 1].createdAt : null,
    matureHours: MATURE_HOURS,
    last7: windowSummary(store, 7), last30: windowSummary(store, 30)
  };
}

function between(store, startMs, endMs) {
  return store.tweets.filter(function (t) { var x = new Date(t.createdAt).getTime(); return x >= startMs && x < endMs; })
    .map(function (t) { return shapeTweet(t, store.handle); });
}

// Best 3 recent tweets, as style examples for Draft social.
function topExamples(store) {
  return store.tweets.map(function (t) { return shapeTweet(t, store.handle); })
    .sort(function (a, b) { return (b.impressions - a.impressions) || (b.interactions - a.interactions); }).slice(0, 3)
    .map(function (t) { return { text: t.text, interactions: t.interactions, impressions: t.impressions }; });
}

module.exports = { lookupUser: lookupUser, refresh: refresh, readStore: readStore, summary: summary, between: between, topExamples: topExamples, MATURE_HOURS: MATURE_HOURS };
