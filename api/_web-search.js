// Brave Search API — a real, open-ended web search for the news scanner,
// alongside its ~70 curated RSS queries. An RSS query only catches a story
// if someone already wrote that exact query in advance; this catches
// whatever a live search turns up instead.
//
// (Started as Google Programmable Search, but Google killed "search the
// entire web" for that product — it can only search a fixed site list now,
// not the open web. Brave Search API still does real whole-web search.)
//
// Not free (Brave dropped its free tier) — metered, ~$4-5/1000 queries after
// an initial $5 credit. Deliberately opt-in per caller (scan.js's
// `webSearch` flag), only set by rolling-digest.js's 3x/day cron, never the
// client-side "Scan now" button / 30-min auto-scan, to keep the bill small
// (3 queries x 3 runs/day ≈ 270/month ≈ $1-2/month at this volume).
//
// Fixed 2026-09-20 (Jeff: "keeps sending the same articles — Payton Jones
// committing a week ago, a bunch of status Maryland Terrapins pages"). Three
// compounding bugs, all from these queries being broad, static head-terms
// with no per-item real date:
//   1. freshness=pw (past week) let a single big story dominate every run of
//      the cron for up to 7 days straight — this ran 3x/day, so "past day"
//      is the freshness that actually matches the cadence.
//   2. Broad head-terms ("Maryland Terrapins football news") are exactly
//      what evergreen team-hub/roster/schedule pages (ESPN, CBS, Yahoo, Sports
//      Reference, Wikipedia team pages) rank for — they're not news, they're
//      always "fresh" by crawl date, and Brave doesn't distinguish. Filtered
//      out by known hub URL shapes below.
//   3. No memory between runs, so the same URL could resurface in every one
//      of the 3 daily digests. Now persisted to Blob and suppressed for 4
//      days after first appearing (best-effort — a Blob hiccup just means we
//      fall back to no cross-run suppression that run, never a hard failure).

var QUERIES = [
  'Maryland Terrapins football news',
  'Maryland Terrapins basketball news',
  'Maryland Terrapins recruiting commitment transfer portal'
];

// Known evergreen team-hub / roster / schedule / reference pages — not news
// articles, but broad head-term queries rank them highly regardless of how
// old the actual news on the page is.
var HUB_URL_PATTERNS = [
  /espn\.com\/(?:college-football|mens-college-basketball|womens-college-basketball)\/team\//i,
  /cbssports\.com\/(?:college-football|college-basketball)\/teams\//i,
  /sports\.yahoo\.com\/(?:ncaaf|ncaab)\/teams\//i,
  /si\.com\/college\/maryland\/?$/i,
  /sports-reference\.com/i,
  /en\.wikipedia\.org\/wiki\//i,
  /umterps\.com\/?$/i,
  /umterps\.com\/sports\/[a-z-]+\/(?:roster|schedule)\/?$/i,
  /247sports\.com\/college\/maryland\/?$/i,
  /on3\.com\/teams\//i,
  /rivals\.com\/team\//i,
  /(?:^|\/)(?:teams|team)\/maryland-terrapins\/?$/i
];

function looksLikeHubPage(url) {
  return HUB_URL_PATTERNS.some(function(re) { return re.test(url); });
}

function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

async function runOne(query, apiKey) {
  var url = 'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(query) +
    '&count=10&freshness=pd'; // past day — matches the 3x/day cron cadence (was pw, see note above)
  var r = await fetch(url, {
    headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': apiKey }
  });
  var d = await r.json();
  if (!r.ok) throw new Error('Brave Search: ' + (d && (d.error && d.error.message || JSON.stringify(d)) || ('HTTP ' + r.status)));
  var items = (d.web && d.web.results) || [];
  return items
    .filter(function(item) { return item.url && !looksLikeHubPage(item.url); })
    .map(function(item) {
      return {
        title: item.title || '',
        url: item.url || '',
        source: hostnameOf(item.url || ''),
        snippet: (item.description || '').replace(/<\/?strong>/g, '').slice(0, 320),
        age: 0 // freshness=pd already bounds this to the last day; no reliable per-item timestamp
      };
    });
}

var SEEN_BLOB_KEY = 'web-search-seen.json';
var SEEN_TTL_MS = 4 * 24 * 60 * 60 * 1000; // 4 days — long enough to span a slow weekend, short enough to let a story resurface if it genuinely develops further

// Cross-run "already sent" memory so the same URL doesn't reappear in every
// digest for days. Best-effort: any Blob failure just skips suppression for
// this run rather than failing the search.
async function loadSeen() {
  try {
    var blob = require('@vercel/blob');
    var got = await blob.get(SEEN_BLOB_KEY, { access: 'private', useCache: false }).catch(function() { return null; });
    if (!got || got.statusCode !== 200) return {};
    var map = await new Response(got.stream).json();
    return (map && typeof map === 'object') ? map : {};
  } catch (e) { return {}; }
}
async function saveSeen(map) {
  try {
    var blob = require('@vercel/blob');
    await blob.put(SEEN_BLOB_KEY, JSON.stringify(map), {
      access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json'
    });
  } catch (e) { /* best-effort — losing this just means suppression resets */ }
}

// Runs all the standing queries, deduped by URL within this run AND against
// URLs already surfaced in a recent prior run. Best-effort per query — one
// failing (e.g. quota/credit exhausted mid-run) doesn't lose the others.
async function searchNews(apiKey) {
  var now = Date.now();
  var seenBefore = await loadSeen();
  // Prune stale entries so the map doesn't grow forever.
  Object.keys(seenBefore).forEach(function(u) {
    if (now - seenBefore[u] > SEEN_TTL_MS) delete seenBefore[u];
  });

  var seenThisRun = {};
  var results = [];
  var warnings = [];
  var suppressed = 0;
  // Concurrent, not one-at-a-time (2026-09-21) — independent HTTP calls with
  // nothing for one query to wait on from another; only affects speed.
  var settled = await Promise.allSettled(QUERIES.map(function(q) { return runOne(q, apiKey); }));
  settled.forEach(function(r) {
    if (r.status !== 'fulfilled') { warnings.push(r.reason.message); return; }
    r.value.forEach(function(item) {
      if (!item.url || seenThisRun[item.url]) return;
      seenThisRun[item.url] = 1;
      if (seenBefore[item.url]) { suppressed++; return; }
      results.push(item);
    });
  });

  Object.keys(seenThisRun).forEach(function(u) { seenBefore[u] = seenBefore[u] || now; });
  await saveSeen(seenBefore);

  if (suppressed) warnings.push(suppressed + ' result(s) suppressed as already sent in the last 4 days');
  return { results: results, warnings: warnings };
}

module.exports = { searchNews: searchNews, QUERIES: QUERIES };
