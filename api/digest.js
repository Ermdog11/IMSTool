var mailer = require('./_mailer.js');

const buildDigestEmailHTML = (alerts, date, beat) => {
  beat = beat || {};
  var esc = function (x) { return String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
  var team = (beat.team && ((beat.team.nicknames || [])[0] || beat.team.short || beat.team.name)) || '';
  const groups = {
    'Recruiting': alerts.filter(a => a.category === 'recruiting'),
    'Football': alerts.filter(a => a.sport === 'football' && a.category !== 'recruiting'),
    'Basketball': alerts.filter(a => ['basketball','mens-basketball','womens-basketball'].includes(a.sport||'') && a.category !== 'recruiting'),
    'Other sports': alerts.filter(a => !['football','basketball','mens-basketball','womens-basketball'].includes(a.sport||'') && !['recruiting','alumni','social','podcast'].includes(a.category)),
    'Alumni': alerts.filter(a => a.category === 'alumni'),
    'Social & podcasts': alerts.filter(a => ['social','podcast'].includes(a.category))
  };

  var sectionsHTML = '';
  for (var title in groups) {
    var items = groups[title];
    if (!items.length) continue;
    sectionsHTML += '<div style="margin-bottom:20px;">';
    sectionsHTML += '<div style="font-size:12px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;border-bottom:2px solid #2563eb;padding-bottom:5px;">' + title + '</div>';
    items.forEach(function(item) {
      sectionsHTML += '<div style="padding:10px 0;border-bottom:1px solid #e8e6e1;">';
      // Headlines open the story (Jeff, 2026-10-09: "these headlines should be
      // clickable in nightly digest"), plus a "Read it" link by the source.
      var link = /^https?:\/\//i.test(item.url || '') ? item.url : '';
      sectionsHTML += '<div style="font-size:14px;font-weight:600;color:#1a1a1a;margin-bottom:4px;">' +
        (link ? '<a href="' + esc(link) + '" style="color:#1a1a1a;text-decoration:none;">' + esc(item.headline) + '</a>' : esc(item.headline)) + '</div>';
      if (item.summary) sectionsHTML += '<div style="font-size:12px;color:#555;line-height:1.5;">' + item.summary + '</div>';
      sectionsHTML += '<div style="font-size:11px;color:#888;margin-top:4px;">' + esc(item.source) + ' &middot; ' + esc(item.time) +
        (link ? ' &middot; <a href="' + esc(link) + '" style="color:#2563eb;font-weight:600;text-decoration:none;">Read it &rsaquo;</a>' : '') + '</div>';
      sectionsHTML += require('./_story-ratings').emailLinks(item);
      sectionsHTML += '</div>';
    });
    sectionsHTML += '</div>';
  }

  return '<!DOCTYPE html><html><head></head><body style="font-family:-apple-system,sans-serif;background:#f7f6f3;margin:0;padding:20px;">' +
    '<div style="max-width:600px;margin:0 auto;background:white;border-radius:10px;overflow:hidden;">' +
    '<div style="background:#0f1b2d;padding:16px 20px;">' +
    '<div style="color:white;font-size:16px;font-weight:700;">' + esc(beat.outletName || 'CoPublisher') + '</div>' +
    '<div style="color:rgba(255,255,255,0.8);font-size:12px;">Nightly digest &mdash; ' + date + '</div>' +
    '</div>' +
    '<div style="padding:20px 24px;">' +
    '<p style="font-size:13px;color:#555;margin-bottom:20px;">' + (alerts.length ? 'Here\'s everything that happened on the ' + esc(team ? team + ' ' : '') + 'beat today: ' + alerts.length + ' stor' + (alerts.length === 1 ? 'y' : 'ies') + ' across all sources.' : 'Nothing new on the ' + esc(team ? team + ' ' : '') + 'beat today.') + '</p>' +
    sectionsHTML +
    '</div>' +
    '<div style="background:#1a1a1a;padding:12px 20px;text-align:center;">' +
    '<a href="https://ims-tool.vercel.app/alerts" style="color:#ffd520;font-size:12px;font-weight:600;text-decoration:none;">Open CoPublisher &rarr;</a>' +
    '</div></div></body></html>';
};

// The nightly digest comes at each person's own time (Jeff, 2026-10-07: "get
// rid of 8 PM, let them set time"; _alert-schedule.js timesOf, default 8 PM
// in their zone). The cron runs hourly and emails whoever's time it is; with
// nobody due it stops before the scan. A signed-in "send now" goes to everyone.
module.exports = async function handler(req, res) {
  var who;
  try { who = await require('./_supabase').requireUserOrCron(req, res); }
  catch (authErr) { return res.status(authErr.status || 401).json({ error: authErr.message || 'Not signed in' }); }
  var ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY.' });
  }

  var to;
  if (who && (who.cron || who.internal)) {
    var Sched = require('./_alert-schedule');
    var all = await Sched.load(), nowMs = Date.now();
    to = (await mailer.baseRecipients('digest_nightly')).filter(function (e) {
      return Sched.dueNow(all[String(e).toLowerCase()] || {}, 'digest_nightly', nowMs);
    });
    if (!to.length) return res.status(200).json({ skipped: 'no one\'s nightly digest is due this hour' });
    var Once = require('./_cron-once');
    if (who.cron && !(await Once.claim('digest-h' + new Date(nowMs).toISOString().slice(11, 13), Once.today()))) {
      return res.status(200).json({ skipped: 'duplicate cron delivery' });
    }
  }

  try {
    // Reuse the working scan pipeline instead of the retired web_search approach
    var scanHandler = require('./scan.js');
    var scanResult = await new Promise(function(resolve, reject) {
      var fakeRes = {
        status: function() { return this; },
        json: function(d) { resolve(d); return this; }
      };
      scanHandler({ body: {} }, fakeRes).catch(reject);
    });

    if (scanResult.error) throw new Error('Scan failed: ' + scanResult.error);
    var text = (scanResult.content || []).map(function(b) { return b.type === 'text' ? b.text : ''; }).join('\n');
    var match = text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON from scan');

    // The day's stories: the last 24 hours.
    var alerts = JSON.parse(match[0]).filter(function(a) { return !a.republished && !(a.ageHours != null && a.ageHours > 24); });
    var date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
    var S = require('./_supabase');
    var beat = await require('./_beat').getBeat(S.isConfigured() ? S.admin() : null).catch(function () { return {}; });

    var mail = await mailer.sendMail({
      to: to,
      alertType: 'digest_nightly',
      subject: (beat.outletName || 'CoPublisher') + ' nightly digest — ' + date,
      html: buildDigestEmailHTML(alerts, date, beat)
    });

    return res.status(200).json({ success: true, count: alerts.length, date: date, mail: mail });
  } catch (error) {
    console.error('Digest error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

// Per-newsroom: this request runs as the signed-in person's newsroom (_site.js).
module.exports = require('./_site').wrap(module.exports);
