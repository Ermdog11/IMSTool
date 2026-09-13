// Shared Chartbeat fetch + parse logic, used by both the live Insights
// endpoint (api/chartbeat.js), the snapshot cron (api/analytics-snapshot.js),
// and the question box (api/analytics-question.js) so they never drift out
// of sync on how a response is read.
//
// Real-time API (docs.chartbeat.com/cbp/api/real-time-apis):
//   GET https://api.chartbeat.com/live/quickstats/v4/?host=<host>
//   GET https://api.chartbeat.com/live/toppages/v3/?host=<host>
// both authenticated via the X-CB-AK header (current API; the older
// apikey-as-query-param form is deprecated).

var BASE = 'https://api.chartbeat.com';

async function cbGet(path, apiKey, host) {
  var url = BASE + path + '?host=' + encodeURIComponent(host);
  var r = await fetch(url, { headers: { 'X-CB-AK': apiKey } });
  var text = await r.text();
  var data;
  try { data = JSON.parse(text); } catch (e) { data = null; }
  if (!r.ok) {
    var msg = (data && (data.error || data.message)) || text.slice(0, 200) || ('HTTP ' + r.status);
    throw new Error('Chartbeat ' + path + ': ' + msg);
  }
  return data || {};
}

// Looks for a current-concurrents count under any of Chartbeat's known field
// names, checking the top level, a "data" wrapper, the "metrics"/"stats"
// objects nested inside it (confirmed present on maryland-terrapins'
// account — data: {stats, metrics, host_metadata}), and a data object keyed
// by host (some Chartbeat endpoints nest per-domain when scoped that way).
function extractVisits(quick, host) {
  var names = ['visits', 'people', 'concurrents', 'visitors'];
  var data = quick.data;
  var candidates = [
    quick,
    data,
    data && data.metrics,
    data && data.stats,
    data && host && data[host]
  ];
  for (var i = 0; i < candidates.length; i++) {
    var obj = candidates[i];
    if (!obj || typeof obj !== 'object') continue;
    for (var j = 0; j < names.length; j++) {
      if (typeof obj[names[j]] === 'number') return obj[names[j]];
    }
  }
  return null;
}

function describeShape(quick) {
  var parts = ['top-level: ' + Object.keys(quick).join(',')];
  var data = quick.data;
  if (data && typeof data === 'object') {
    parts.push('data: ' + Object.keys(data).join(','));
    ['metrics', 'stats', 'host_metadata'].forEach(function(k) {
      if (data[k] && typeof data[k] === 'object') {
        parts.push('data.' + k + ': ' + Object.keys(data[k]).join(','));
      }
    });
  }
  return parts.join(' | ');
}

// Only scalars — skips nested objects/arrays so this can't dump something
// huge or weird into a metrics list meant to just be "the numbers Chartbeat
// gave us, whatever they're called."
function scalarFields(obj) {
  var out = {};
  if (!obj || typeof obj !== 'object') return out;
  Object.keys(obj).forEach(function(k) {
    var v = obj[k];
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') out[k] = v;
  });
  return out;
}

// Pulls every scalar Chartbeat handed back for site-wide quickstats — not
// just "visits" — so engaged time, new/returning, traffic-source breakdown
// etc. all surface once seen, without needing to guess their field names in
// advance (the same shape-discovery approach that got "visits" itself
// working: see describeShape's warning path in fetchLive below).
function extractMetrics(quick) {
  var data = quick.data;
  return Object.assign(
    {},
    scalarFields(quick),
    scalarFields(data),
    scalarFields(data && data.metrics),
    scalarFields(data && data.stats)
  );
}

// Chartbeat tracks the whole site, message boards and off-topic forums
// included — not just articles. Drop anything that reads like a board/thread
// rather than a story (same blunt title-pattern approach api/scan.js uses to
// drop non-news pages).
var NON_ARTICLE_TITLE = /\bmessage board\b|\boff[- ]topic\b|\bthread\b|\bforum\b/i;

function pickTopPages(data) {
  var list = data.pages || data.toppages || [];
  if (!Array.isArray(list)) return [];
  return list.map(function(p) {
    var stats = p.stats || {};
    var visits = (typeof p.visits === 'number' ? p.visits : null)
      || stats.visits || stats.people || stats.visitors || 0;
    // Whatever else Chartbeat reports per page (engaged time, avg time,
    // recirc, etc.) beyond the visits count already pulled out above.
    var extra = scalarFields(stats);
    delete extra.visits; delete extra.people; delete extra.visitors;
    return {
      path: p.path || p.page || p.url || '',
      title: p.title || p.headline || '',
      visits: visits,
      extra: extra
    };
  }).filter(function(p) {
    return !NON_ARTICLE_TITLE.test(p.title) && !NON_ARTICLE_TITLE.test(p.path);
  }).sort(function(a, b) { return b.visits - a.visits; }).slice(0, 15);
}

// Fetches + parses both endpoints for one connection. Returns
// { visits, pages, metrics, warnings } — never throws (a single endpoint
// failing still returns whatever the other one had), except when both fail.
async function fetchLive(apiKey, host) {
  var results = await Promise.allSettled([
    cbGet('/live/quickstats/v4/', apiKey, host),
    cbGet('/live/toppages/v3/', apiKey, host)
  ]);
  var quickRes = results[0], pagesRes = results[1];
  if (quickRes.status === 'rejected' && pagesRes.status === 'rejected') {
    throw new Error(quickRes.reason.message);
  }

  var quick = quickRes.status === 'fulfilled' ? quickRes.value : {};
  var pagesData = pagesRes.status === 'fulfilled' ? pagesRes.value : {};
  var pages = pickTopPages(pagesData);

  var visits = extractVisits(quick, host);
  var warnings = [
    quickRes.status === 'rejected' ? 'quickstats: ' + quickRes.reason.message : null,
    pagesRes.status === 'rejected' ? 'toppages: ' + pagesRes.reason.message : null
  ];
  if (visits === null && quickRes.status === 'fulfilled') {
    visits = pages.reduce(function(sum, p) { return sum + (p.visits || 0); }, 0);
    warnings.push('quickstats: unrecognized shape (' + describeShape(quick) + '), using sum of top pages as an estimate');
  }

  var metrics = quickRes.status === 'fulfilled' ? extractMetrics(quick) : {};

  return { visits: visits || 0, pages: pages, metrics: metrics, warnings: warnings.filter(Boolean) };
}

module.exports = { fetchLive: fetchLive };
