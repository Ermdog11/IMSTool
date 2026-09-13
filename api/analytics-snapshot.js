// /api/analytics-snapshot — cron: captures a point-in-time reading from each
// connected analytics source and stores it (analytics_snapshots), so the
// Trends view (api/analytics-trends.js) has a real time series to compute
// publish-time/day patterns and recurring top performers from, instead of
// only ever showing "right now" (what api/chartbeat.js's live call does).
//
// Runs across every site (today just the one — insidemdsports), every
// connected source (today just chartbeat; parsely/ga4/meta slot in here
// once they're wired, each contributing their own metrics shape).

var S = require('./_supabase');
var Store = require('./_analytics-store');
var Chartbeat = require('./_chartbeat');

module.exports = async function handler(req, res) {
  if (!S.isConfigured()) return res.status(503).json({ error: 'Login not configured' });
  var sb = S.admin();
  var report = [];

  var sitesRes = await sb.from('sites').select('id, slug');
  if (sitesRes.error) return res.status(500).json({ error: sitesRes.error.message });

  for (var i = 0; i < (sitesRes.data || []).length; i++) {
    var site = sitesRes.data[i];
    try {
      var conn = await Store.getConnection(sb, site.id, 'chartbeat');
      if (!conn || !conn.apiKey || !conn.host) {
        report.push({ site: site.slug, source: 'chartbeat', status: 'not-connected' });
        continue;
      }
      var live = await Chartbeat.fetchLive(conn.apiKey, conn.host);
      await Store.saveSnapshot(sb, site.id, 'chartbeat', {
        visits: live.visits,
        pages: live.pages.map(function(p) { return { path: p.path, title: p.title, visits: p.visits }; })
      });
      report.push({ site: site.slug, source: 'chartbeat', status: 'captured', visits: live.visits, pages: live.pages.length });
    } catch (e) {
      report.push({ site: site.slug, source: 'chartbeat', status: 'error', error: e.message });
    }
  }

  return res.status(200).json({ report: report });
};
