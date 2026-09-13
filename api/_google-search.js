// Google Programmable Search (Custom Search JSON API) — a real, open-ended
// web search for the news scanner, alongside its ~70 curated RSS queries.
// An RSS query only catches a story if someone already wrote that exact
// query in advance; this catches whatever a live search turns up instead.
//
// Deliberately opt-in per caller (scan.js's `webSearch` flag), not run on
// every scan: the free tier is 100 queries/day, and the client-side "Scan
// now" button / 30-min auto-scan can fire far more often than that if left
// open. Wire this into the 3x/day server cron (rolling-digest.js) only.

var QUERIES = [
  'Maryland Terrapins football news',
  'Maryland Terrapins basketball news',
  'Maryland Terrapins recruiting commitment transfer portal'
];

async function runOne(query, apiKey, engineId) {
  var url = 'https://www.googleapis.com/customsearch/v1?key=' + encodeURIComponent(apiKey) +
    '&cx=' + encodeURIComponent(engineId) + '&q=' + encodeURIComponent(query) +
    '&num=10&dateRestrict=d3&sort=date';
  var r = await fetch(url);
  var d = await r.json();
  if (d.error) throw new Error('Google Search: ' + (d.error.message || JSON.stringify(d.error)));
  return (d.items || []).map(function(item) {
    return {
      title: item.title || '',
      url: item.link || '',
      source: (item.displayLink || '').replace(/^www\./, ''),
      snippet: (item.snippet || '').slice(0, 320),
      age: 0 // Custom Search doesn't give a reliable published time; dateRestrict already limits to the last 3 days
    };
  });
}

// Runs all the standing queries, deduped by URL. Best-effort per query — one
// failing (e.g. quota exhausted mid-run) doesn't lose the others.
async function searchNews(apiKey, engineId) {
  var seen = {};
  var results = [];
  var warnings = [];
  for (var i = 0; i < QUERIES.length; i++) {
    try {
      var items = await runOne(QUERIES[i], apiKey, engineId);
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
