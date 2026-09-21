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
//
// Storyline-aware pass (2026-09-21, Jeff: X should fuel recognizing developing
// stories, tracking what we're already covering while still catching other
// new ones). The 3 QUERIES below stay as the broad "catch anything new" net.
// x-scan.js separately figures out what's an active storyline (recent
// breaking drafts) and passes it in here as `storylineTopics` — each one gets
// its OWN targeted query at a lower engagement bar than the broad queries,
// since a real update on a story we're already tracking matters even at
// modest engagement, not just viral. Results from these are tagged
// `followUp` so scan.js's rating pass knows it's a development on an active
// story, not a fresh unrelated mention.
//
// Watched-accounts pass (2026-09-21, Jeff: "the other people covering
// Maryland" — rival/fellow beat reporters). Publisher picks specific X
// accounts in Settings (up to 15, api/x-watch-handles.js); each gets its own
// from:<handle> query, no engagement floor at all — unlike a random account,
// a publisher-curated beat source's routine post matters even with zero
// likes, same as any RSS feed we trust enough to include. Tagged
// `watchedAccount:true` so scan.js's rating prompt treats the account itself
// as already-vetted-credible, not an unknown to weigh.

var QUERIES = [
  '"Maryland Terrapins" (football OR Terps) -is:retweet lang:en min_faves:20',
  '"Maryland Terrapins" (basketball OR Terps) -is:retweet lang:en min_faves:20',
  '"Maryland Terrapins" (recruiting OR commit OR "transfer portal") -is:retweet lang:en min_faves:10'
];

// Lower bar than the broad QUERIES above — we already know this storyline
// matters (it's an active/breaking story we're covering), so a real update
// is worth catching even without viral-level engagement.
var STORYLINE_MIN_FAVES = 5;

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

// Runs the standing broad queries, one targeted query per active storyline,
// and one query per watched account — ALL concurrently (2026-09-21: these
// used to run one at a time in a serial loop, which meaningfully added to
// scan time once storyline + up to 15 watched-account queries stacked on
// top of the original 3 — up to 21 sequential round-trips. They're
// independent HTTP calls with nothing for one to wait on from another, so
// there's no quality tradeoff in firing them together, only speed).
// Deduped by URL, in the same broad -> storyline -> watched priority order
// as before so a story appearing in multiple passes still gets the most
// specific tag (a broad-query hit that's ALSO an active storyline still
// resolves to `followUp`, not silently plain). Best-effort per query — one
// failing (rate limit, bad operator, quota) doesn't lose the others.
// `storylineTopics`: up to 3 { label, query } objects from x-scan.js (label =
// short human name for the storyline, query = an X-search-ready fragment).
// `watchHandles`: up to 15 plain handles (no @), from api/x-watch-handles.js.
async function searchX(bearerToken, storylineTopics, watchHandles) {
  var topics = (storylineTopics || []).filter(function(t) { return t && t.query; }).slice(0, 3);
  var handles = (watchHandles || []).filter(Boolean).slice(0, 15).map(function(h) { return String(h).replace(/^@/, ''); });

  var broadP = Promise.allSettled(QUERIES.map(function(q) { return runOne(q, bearerToken); }));
  var storyP = Promise.allSettled(topics.map(function(t) {
    return runOne(t.query + ' -is:retweet lang:en min_faves:' + STORYLINE_MIN_FAVES, bearerToken);
  }));
  var handleP = Promise.allSettled(handles.map(function(h) { return runOne('from:' + h + ' -is:retweet', bearerToken); }));

  var settled = await Promise.all([broadP, storyP, handleP]);
  var broadSettled = settled[0], storySettled = settled[1], handleSettled = settled[2];

  var seen = {};
  var results = [];
  var warnings = [];

  broadSettled.forEach(function(r) {
    if (r.status !== 'fulfilled') { warnings.push(r.reason.message); return; }
    r.value.forEach(function(item) {
      if (!item.url || seen[item.url]) return;
      seen[item.url] = 1;
      results.push(item);
    });
  });

  storySettled.forEach(function(r, i) {
    if (r.status !== 'fulfilled') { warnings.push('storyline "' + topics[i].label + '": ' + r.reason.message); return; }
    r.value.forEach(function(item) {
      if (!item.url || seen[item.url]) return;
      seen[item.url] = 1;
      item.followUp = topics[i].label;
      results.push(item);
    });
  });

  handleSettled.forEach(function(r, i) {
    if (r.status !== 'fulfilled') { warnings.push('watched account "@' + handles[i] + '": ' + r.reason.message); return; }
    r.value.forEach(function(item) {
      if (!item.url || seen[item.url]) return;
      seen[item.url] = 1;
      item.watchedAccount = true;
      results.push(item);
    });
  });

  return { results: results, warnings: warnings };
}

module.exports = { searchX: searchX, QUERIES: QUERIES, STORYLINE_MIN_FAVES: STORYLINE_MIN_FAVES };
