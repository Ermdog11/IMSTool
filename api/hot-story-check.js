// /api/hot-story-check — cron (every 15 min): watches live top pages for
// any story crossing a "hot" concurrent-readers threshold, and alerts
// (email + push) the first time each story crosses it, with a cooldown so
// an ongoing hot story doesn't re-alert every cycle.
//
// Real-time per-article detection needs real-time per-article data —
// Chartbeat is the only connected source that has it today. Facebook's
// Page Insights (api/_meta.js) are rolling 28-day site-wide totals, not
// per-post or real-time, so there's nothing to watch there yet; it slots
// in here once post-level Facebook/Instagram insights are wired up.

var S = require('./_supabase');
var Store = require('./_analytics-store');
var Chartbeat = require('./_chartbeat');
var HotState = require('./_hot-story');
var Mailer = require('./_mailer');
var Push = require('./_push');

var HOT_THRESHOLD = parseInt(process.env.HOT_STORY_THRESHOLD || '5', 10);
var COOLDOWN_MS = 3 * 60 * 60 * 1000; // don't re-alert the same story for 3h

function pageUrl(path, host) {
  if (!path) return 'https://' + host;
  if (/^https?:\/\//i.test(path)) return path;
  if (path.indexOf(host) === 0) return 'https://' + path;
  return 'https://' + host + (path.charAt(0) === '/' ? '' : '/') + path;
}

module.exports = async function handler(req, res) {
  if (!S.isConfigured()) return res.status(503).json({ error: 'Login not configured' });
  var sb = S.admin();
  var report = [];

  var sitesRes = await sb.from('sites').select('id, slug');
  if (sitesRes.error) return res.status(500).json({ error: sitesRes.error.message });

  var state = await HotState.loadState();
  var stateChanged = false;

  for (var i = 0; i < (sitesRes.data || []).length; i++) {
    var site = sitesRes.data[i];
    try {
      var conn = await Store.getConnection(sb, site.id, 'chartbeat');
      if (!conn || !conn.apiKey || !conn.host) { report.push({ site: site.slug, status: 'not-connected' }); continue; }

      var live = await Chartbeat.fetchLive(conn.apiKey, conn.host);
      var hot = live.pages.filter(function(p) { return p.visits >= HOT_THRESHOLD; });
      if (!hot.length) { report.push({ site: site.slug, status: 'none-hot' }); continue; }

      var siteState = state[site.slug] || {};
      var toAlert = hot.filter(function(p) {
        var key = p.path || p.title;
        var last = siteState[key];
        return !last || (Date.now() - new Date(last).getTime()) > COOLDOWN_MS;
      });
      if (!toAlert.length) { report.push({ site: site.slug, status: 'hot-but-already-alerted', count: hot.length }); continue; }

      var recipients = await S.recipientsFor('hot_story', site.slug);
      if (recipients.length) {
        var html = '<div style="font-family:Arial,sans-serif;max-width:600px">' +
          '<p>' + toAlert.length + ' stor' + (toAlert.length === 1 ? 'y is' : 'ies are') + ' running hot right now on ' + conn.host + ':</p>' +
          toAlert.map(function(p) {
            return '<p style="margin:10px 0"><a href="' + pageUrl(p.path, conn.host) + '"><b>' + (p.title || p.path) + '</b></a><br>' +
              '<span style="color:#666">' + p.visits + ' reading right now</span></p>';
          }).join('') + '</div>';
        await Mailer.sendMail({ to: recipients, subject: '🔥 Story running hot on ' + conn.host, html: html });
      }

      try {
        await Push.sendPush({
          title: '🔥 Story running hot',
          body: toAlert.map(function(p) { return (p.title || p.path) + ' — ' + p.visits + ' reading now'; }).join(' | ').slice(0, 200),
          url: pageUrl(toAlert[0].path, conn.host),
          tag: 'hot-story'
        });
      } catch (e) { /* push is best-effort, never blocks the email alert */ }

      toAlert.forEach(function(p) { siteState[p.path || p.title] = new Date().toISOString(); });
      state[site.slug] = siteState;
      stateChanged = true;

      report.push({ site: site.slug, status: 'alerted', count: toAlert.length, recipients: recipients.length });
    } catch (e) {
      report.push({ site: site.slug, status: 'error', error: e.message });
    }
  }

  if (stateChanged) await HotState.saveState(state);
  return res.status(200).json({ report: report });
};
