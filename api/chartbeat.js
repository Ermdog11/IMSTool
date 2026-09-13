// /api/chartbeat — GET: live concurrents + top pages right now, for the
// Audience Analytics view. Reads the site's stored Chartbeat connection
// (api/analytics-connections.js), decrypts the API key, and calls
// Chartbeat's real-time API directly (docs.chartbeat.com/cbp/api/real-time-apis):
//   GET https://api.chartbeat.com/live/quickstats/v4/?host=<host>
//   GET https://api.chartbeat.com/live/toppages/v3/?host=<host>
// both authenticated via the X-CB-AK header (current API; the older
// apikey-as-query-param form is deprecated).
//
// Chartbeat's exact response shape isn't pinned down from documentation
// alone (no sandbox key to verify against) — parsing below reads the field
// names Chartbeat's own docs and client libraries use, with a couple of
// reasonable fallbacks, and surfaces the raw response on a shape mismatch so
// it's fixable in one glance the first time a real key runs through it.

var S = require('./_supabase');
var Store = require('./_analytics-store');

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
// names, checking the top level, a "data" wrapper, and a data object keyed
// by host (some Chartbeat endpoints nest per-domain when scoped that way).
function extractVisits(quick, host) {
  var names = ['visits', 'people', 'concurrents', 'visitors'];
  var candidates = [quick, quick.data, quick.data && host && quick.data[host]];
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
  if (quick.data && typeof quick.data === 'object') {
    parts.push('data: ' + Object.keys(quick.data).join(','));
  }
  return parts.join(' | ');
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
    return {
      path: p.path || p.page || p.url || '',
      title: p.title || p.headline || '',
      visits: (typeof p.visits === 'number' ? p.visits : null)
        || stats.visits || stats.people || stats.visitors || 0
    };
  }).filter(function(p) {
    return !NON_ARTICLE_TITLE.test(p.title) && !NON_ARTICLE_TITLE.test(p.path);
  }).sort(function(a, b) { return b.visits - a.visits; }).slice(0, 15);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!S.isConfigured()) return res.status(503).json({ error: 'Login not configured' });

  var ctx;
  try { ctx = await S.requireUser(req); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message }); }

  try {
    var conn = await Store.getConnection(ctx.supabase, ctx.site.id, 'chartbeat');
    if (!conn || !conn.apiKey || !conn.host) {
      return res.status(400).json({ error: 'Chartbeat not connected yet.' });
    }

    var results = await Promise.allSettled([
      cbGet('/live/quickstats/v4/', conn.apiKey, conn.host),
      cbGet('/live/toppages/v3/', conn.apiKey, conn.host)
    ]);
    var quickRes = results[0], pagesRes = results[1];
    if (quickRes.status === 'rejected' && pagesRes.status === 'rejected') {
      return res.status(502).json({ error: quickRes.reason.message });
    }

    var quick = quickRes.status === 'fulfilled' ? quickRes.value : {};
    var pagesData = pagesRes.status === 'fulfilled' ? pagesRes.value : {};
    var pages = pickTopPages(pagesData);

    // Chartbeat's quickstats "current site-wide concurrents" field name isn't
    // pinned down from a live response yet. If none of the known names match,
    // fall back to summing the (already-verified-working) per-page counts
    // rather than showing a misleading 0, and flag it so the real field name
    // can be added here once seen.
    var visits = extractVisits(quick, conn.host);

    var warnings = [
      quickRes.status === 'rejected' ? 'quickstats: ' + quickRes.reason.message : null,
      pagesRes.status === 'rejected' ? 'toppages: ' + pagesRes.reason.message : null
    ];
    if (visits === null && quickRes.status === 'fulfilled') {
      visits = pages.reduce(function(sum, p) { return sum + (p.visits || 0); }, 0);
      warnings.push('quickstats: unrecognized shape (' + describeShape(quick) + '), using sum of top pages as an estimate');
    }

    return res.status(200).json({
      host: conn.host,
      visits: visits || 0,
      pages: pages,
      fetchedAt: new Date().toISOString(),
      warnings: warnings.filter(Boolean)
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
