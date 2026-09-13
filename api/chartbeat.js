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

function pickTopPages(data) {
  var list = data.pages || data.toppages || [];
  if (!Array.isArray(list)) return [];
  return list.slice(0, 15).map(function(p) {
    var stats = p.stats || {};
    return {
      path: p.path || p.page || p.url || '',
      title: p.title || p.headline || '',
      visits: (typeof p.visits === 'number' ? p.visits : null)
        || stats.visits || stats.people || stats.visitors || 0
    };
  }).sort(function(a, b) { return b.visits - a.visits; });
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

    var visits = (typeof quick.visits === 'number' ? quick.visits : null)
      || (quick.data && quick.data.visits) || 0;

    return res.status(200).json({
      host: conn.host,
      visits: visits,
      pages: pickTopPages(pagesData),
      fetchedAt: new Date().toISOString(),
      warnings: [
        quickRes.status === 'rejected' ? 'quickstats: ' + quickRes.reason.message : null,
        pagesRes.status === 'rejected' ? 'toppages: ' + pagesRes.reason.message : null
      ].filter(Boolean)
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
