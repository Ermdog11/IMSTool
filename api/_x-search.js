// X (Twitter) recent-search API — catches viral/breaking beat conversation
// (a rival player's headline-worthy quote, a recruiting bombshell) that never
// shows up in an RSS feed or a news-site's own coverage, because it started
// and often stays purely social. This is the fast, "catch it now" source;
// Brave Search (_web-search.js) is the slower, background-context one.
//
// Jeff confirmed (2026-09-15) he wants this on the same ~30-min cadence as
// the client-side auto-scan, run from its OWN dedicated cron (api/x-scan.js)
// rather than tied to whether a browser tab happens to be open — a fixed
// clock keeps the metered cost predictable. X moved to pay-per-use pricing
// in Feb 2026 ($0.005/post read); min_faves/min_retweets filters below exist
// specifically to keep read volume (and cost) down by skipping low-engagement
// noise, not just relevance.
//
// NOT YET VERIFIED against a real Bearer Token — built and syntax-checked
// only. Query operator availability (-is:retweet, lang:, min_faves) under the
// pay-per-use plan hasn't been confirmed; if a query 400s, the operator list
// may need trimming.

var QUERIES = [
  '"Maryland Terrapins" (football OR Terps) -is:retweet lang:en min_faves:20',
  '"Maryland Terrapins" (basketball OR Terps) -is:retweet lang:en min_faves:20',
  '"Maryland Terrapins" (recruiting OR commit OR "transfer portal") -is:retweet lang:en min_faves:10'
];

function hoursAgo(iso) {
  var t = new Date(iso).getTime();
  if (!t) return 0;
  return Math.max(0, (Date.now() - t) / 3600000);
}

async function runOne(query, bearerToken) {
  var url = 'https://api.x.com/2/tweets/search/recent?query=' + encodeURIComponent(query) +
    '&max_results=10&tweet.fields=created_at,public_metrics&expansions=author_id&user.fields=username,name';
  var r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + bearerToken } });
  var d = await r.json();
  if (!r.ok) throw new Error('X search: ' + (d && (d.detail || d.title || JSON.stringify(d)) || ('HTTP ' + r.status)));

  var users = {};
  ((d.includes && d.includes.users) || []).forEach(function(u) { users[u.id] = u; });

  var tweets = d.data || [];
  return tweets.map(function(t) {
    var user = users[t.author_id] || {};
    var handle = user.username || 'unknown';
    return {
      title: (t.text || '').slice(0, 140).replace(/\s+/g, ' ').trim(),
      url: 'https://x.com/' + handle + '/status/' + t.id,
      source: '@' + handle,
      snippet: (t.text || '').slice(0, 320),
      age: hoursAgo(t.created_at)
    };
  });
}

// Runs all the standing queries, deduped by URL. Best-effort per query — one
// failing (rate limit, bad operator, quota) doesn't lose the others.
async function searchX(bearerToken) {
  var seen = {};
  var results = [];
  var warnings = [];
  for (var i = 0; i < QUERIES.length; i++) {
    try {
      var items = await runOne(QUERIES[i], bearerToken);
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

module.exports = { searchX: searchX, QUERIES: QUERIES };
