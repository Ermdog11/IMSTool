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

var QUERIES = [
  'Maryland Terrapins football news',
  'Maryland Terrapins basketball news',
  'Maryland Terrapins recruiting commitment transfer portal'
];

function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

async function runOne(query, apiKey) {
  var url = 'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(query) +
    '&count=10&freshness=pw'; // past week — Brave's freshness options are day/week/month/year, no "last 3 days"
  var r = await fetch(url, {
    headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': apiKey }
  });
  var d = await r.json();
  if (!r.ok) throw new Error('Brave Search: ' + (d && (d.error && d.error.message || JSON.stringify(d)) || ('HTTP ' + r.status)));
  var items = (d.web && d.web.results) || [];
  return items.map(function(item) {
    return {
      title: item.title || '',
      url: item.url || '',
      source: hostnameOf(item.url || ''),
      snippet: (item.description || '').replace(/<\/?strong>/g, '').slice(0, 320),
      age: 0 // freshness=pw already bounds this to the last week; no reliable per-item timestamp
    };
  });
}

// Runs all the standing queries, deduped by URL. Best-effort per query — one
// failing (e.g. quota/credit exhausted mid-run) doesn't lose the others.
async function searchNews(apiKey) {
  var seen = {};
  var results = [];
  var warnings = [];
  for (var i = 0; i < QUERIES.length; i++) {
    try {
      var items = await runOne(QUERIES[i], apiKey);
      items.forEach(function(item) {
        if (!item.url || seen[item.url]) return;
        seen[item.url] = 1;
        results.push(item);
      });
    } catch (e) {
      warnings.push(e.message);
    }
  }
  return { results: results, warnings: warnings };
}

module.exports = { searchNews: searchNews, QUERIES: QUERIES };
