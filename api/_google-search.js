// Google Programmable Search (Custom Search JSON API), site-restricted mode
// — a second, complementary real search alongside Brave (api/_web-search.js)
// and the ~70 curated RSS/News queries. Google killed "search the entire
// web" for any new Programmable Search Engine, so this can only search a
// fixed list of sites the publisher picks — but that's still a live search
// against those sites' current content, not a pre-written RSS query, and it
// catches things Brave's index ranks differently or misses. The site list
// itself is configured in Google's own Programmable Search Engine console
// (programmablesearchengine.google.com), not here — this only holds the two
// credentials needed to query it (api/_settings-store.js).
//
// Deliberately opt-in per caller (scan.js's `googleSearch` flag), only set
// by rolling-digest.js's 3x/day cron, never the client-side "Scan now"
// button / 30-min auto-scan — the free tier is 100 queries/day, and 3
// queries x 3 runs/day stays comfortably inside that.
//
// Mirrors _web-search.js's two fixes learned from the Brave bug (2026-09-20:
// "keeps sending the same articles"): a date window that actually matches
// the 3x/day cadence (not the wider default), and cross-run "already sent"
// suppression via Blob — see that file's header for the full story.

var QUERIES = [
  'Maryland Terrapins football news',
  'Maryland Terrapins basketball news',
  'Maryland Terrapins recruiting commitment transfer portal'
];

// Same evergreen-hub shapes _web-search.js filters — a site-restricted
// search can still return a team's own hub/roster/schedule page instead of
// an article if the publisher's curated list includes broad sports sites.
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

async function runOne(query, apiKey, engineId) {
  var url = 'https://www.googleapis.com/customsearch/v1?key=' + encodeURIComponent(apiKey) +
    '&cx=' + encodeURIComponent(engineId) + '&q=' + encodeURIComponent(query) +
    '&num=10&dateRestrict=d1&sort=date'; // past 1 day — matches the 3x/day cron cadence
  var r = await fetch(url);
  var d = await r.json();
  if (d.error) throw new Error('Google Search: ' + (d.error.message || JSON.stringify(d.error)));
  return (d.items || [])
    .filter(function(item) { return item.link && !looksLikeHubPage(item.link); })
    .map(function(item) {
      return {
        title: item.title || '',
        url: item.link || '',
        source: (item.displayLink || '').replace(/^www\./, ''),
        snippet: (item.snippet || '').slice(0, 320),
        age: 0 // Custom Search doesn't give a reliable published time; dateRestrict already bounds this to the last day
      };
    });
}

var SEEN_BLOB_KEY = 'google-search-seen.json';
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
// failing (e.g. quota exhausted mid-run) doesn't lose the others.
async function searchNews(apiKey, engineId) {
  var now = Date.now();
  var seenBefore = await loadSeen();
  Object.keys(seenBefore).forEach(function(u) {
    if (now - seenBefore[u] > SEEN_TTL_MS) delete seenBefore[u];
  });

  var seenThisRun = {};
  var results = [];
  var warnings = [];
  var suppressed = 0;
  // Concurrent, not one-at-a-time (2026-09-21) — independent HTTP calls with
  // nothing for one query to wait on from another; only affects speed.
  var settled = await Promise.allSettled(QUERIES.map(function(q) { return runOne(q, apiKey, engineId); }));
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
