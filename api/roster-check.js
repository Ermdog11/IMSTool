// Roster Watch checker: catches silent changes on official pages (a transfer,
// a dismissal, a new assistant, a general manager's name coming off the front
// office page) that often precede, or never get, a published news story.
//
// Two separate checks, each on its own cron (see vercel.json):
//   /api/roster-check?scope=teams       each team's player roster, plus its
//                                       coaches and staff page
//   /api/roster-check?scope=department  the athletic department staff
//                                       directory (college) or the front
//                                       office page (pro)
// No scope (the in-app "Check now" button) runs both.
//
// Which pages are watched comes from the newsroom's beat profile
// (beat.rosterWatch, set in /setup), so this works for any team. The reading,
// comparing and snapshot logic is in api/_roster.js. This file runs the
// checks, logs each change to Supabase for the in-app history, and sends one
// email and one push per scope when something changed.
var Roster = require('./_roster');
var RosterStore = require('./_roster-store');
var Beat = require('./_beat');
var SB = require('./_supabase');
var { sendMail } = require('./_mailer');
var { sendPush } = require('./_push');

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function who(p) { return esc(p.name) + (p.title ? ' <span style="color:#6b7280">(' + esc(p.title) + ')</span>' : ''); }
function star(key) { return key ? '<b style="color:#b45309">★ KEY ROLE</b> ' : ''; }

// A change is "key" when the person's title is one a reporter would break
// news on (head coach, GM, athletic director, coordinator, president).
function eventsFor(result) {
  var ev = [];
  result.removed.forEach(function (p) { ev.push({ name: p.name, type: 'removed', detail: p.title || '', key: Roster.isKeyRole(p.title), person: p }); });
  result.added.forEach(function (p) { ev.push({ name: p.name, type: 'added', detail: p.title || '', key: Roster.isKeyRole(p.title), person: p }); });
  result.retitled.forEach(function (c) {
    ev.push({ name: c.name, type: 'title_changed', detail: c.from + ' → ' + c.to, key: Roster.isKeyRole(c.from) || Roster.isKeyRole(c.to), change: c });
  });
  return ev.sort(function (a, b) { return (b.key ? 1 : 0) - (a.key ? 1 : 0); });
}

function sectionHtml(target, events) {
  var html = '<h3 style="margin:16px 0 6px">' + esc(target.label) + ' <a href="' + esc(target.url) + '" style="font-size:12px;font-weight:400">page ↗</a></h3>';
  events.forEach(function (e) {
    if (e.type === 'removed') html += '<p style="color:#b91c1c;margin:4px 0">' + star(e.key) + '<b>Off the page:</b> ' + who(e.person) + '</p>';
    else if (e.type === 'added') html += '<p style="color:#15803d;margin:4px 0">' + star(e.key) + '<b>Added:</b> ' + who(e.person) + '</p>';
    else html += '<p style="color:#1d4ed8;margin:4px 0">' + star(e.key) + '<b>Title change:</b> ' + esc(e.name) + ' — ' + esc(e.change.from) + ' → ' + esc(e.change.to) + '</p>';
  });
  return html;
}
function pushLine(target, events) {
  return target.label + ' — ' + events.slice(0, 4).map(function (e) {
    return (e.key ? '★ ' : '') + (e.type === 'removed' ? 'Off: ' : e.type === 'added' ? 'Added: ' : 'New title: ') + e.name + (e.detail && e.type !== 'title_changed' ? ' (' + e.detail + ')' : '');
  }).join(' | ') + (events.length > 4 ? ' +' + (events.length - 4) + ' more' : '');
}

module.exports = async function handler(req, res) {
  var who;
  try { who = await SB.requireUserOrCron(req, res); }
  catch (authErr) { return res.status(authErr.status || 401).json({ error: authErr.message || 'Not signed in' }); }
  // Vercel Cron can deliver a run twice; only the first sends (see _cron-once.js).
  if (who && who.cron && !(await require('./_cron-once').claim('roster-check-' + String((req.query && req.query.scope) || 'all'), require('./_cron-once').today()))) {
    return res.status(200).json({ skipped: 'duplicate cron delivery' });
  }

  var scope = String((req.query && req.query.scope) || 'all');
  var beat = await Beat.getBeat(SB.isConfigured() ? SB.admin() : null);
  var targets = Roster.watchTargets(beat).filter(function (t) { return scope === 'all' || t.scope === scope; });
  var short = Beat.nick(beat);

  // Pages are independent, so check them side by side (a 400-person staff
  // directory can take a couple of minutes to read on the day it changes).
  var results = await Promise.all(targets.map(function (t) { return Roster.checkTarget(t, beat); }));

  var report = [], changedByScope = { teams: [], department: [] };
  for (var i = 0; i < targets.length; i++) {
    var t = targets[i], r = results[i];
    var entry = { page: t.label, kind: t.kind, status: r.status };
    ['count', 'found', 'error', 'wouldRemove'].forEach(function (k) { if (r[k] !== undefined) entry[k] = r[k]; });
    if (r.status === 'changed') {
      var events = eventsFor(r);
      entry.added = r.added.map(function (p) { return p.name; });
      entry.removed = r.removed.map(function (p) { return p.name; });
      entry.titleChanges = r.retitled.map(function (c) { return c.name + ': ' + c.from + ' → ' + c.to; });
      entry.stored = await RosterStore.recordEvents(t.slug, t.label, t.kind, events, new Date().toISOString());
      changedByScope[t.scope].push({ target: t, events: events });
    }
    report.push(entry);
  }

  var deptLabel = Roster.departmentLabel(beat.team.level);
  var deptTitle = deptLabel.replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); });
  var mailers = [
    { list: changedByScope.teams, subject: '🔄 ' + short + ' Roster Change Detected', pushTitle: '🔄 Roster Change Detected', tag: 'roster-change',
      intro: 'A change was just detected on an official team page. It could be a transfer, a dismissal, an injury designation, a new addition, or a coach or staffer coming or going. Worth checking before it\'s reported elsewhere:' },
    { list: changedByScope.department, subject: '🏛️ ' + short + ' ' + deptTitle + ' Change Detected', pushTitle: '🏛️ ' + deptTitle + ' Change Detected', tag: 'department-change',
      intro: 'A change was just detected on the ' + deptLabel.toLowerCase() + ' page. A name coming off the page, a new name, or a new title can be the first public sign of a hire or a departure. Confirm it before you report it:' }
  ];
  for (var m = 0; m < mailers.length; m++) {
    var cfg = mailers[m];
    if (!cfg.list.length) continue;
    var hasKey = cfg.list.some(function (c) { return c.events.some(function (e) { return e.key; }); });
    try {
      await sendMail({
        alertType: 'roster_change',
        subject: (hasKey ? '★ ' : '') + cfg.subject,
        html: '<div style="font-family:Arial,sans-serif;max-width:600px"><p>' + cfg.intro + '</p>' +
          cfg.list.map(function (c) { return sectionHtml(c.target, c.events); }).join('') + '</div>'
      });
    } catch (e) { report.push({ mailError: e.message }); }
    try {
      report.push({ push: await sendPush({
        title: (hasKey ? '★ ' : '') + cfg.pushTitle,
        body: cfg.list.map(function (c) { return pushLine(c.target, c.events); }).join(' \n ').slice(0, 200),
        url: 'https://ims-tool.vercel.app/roster', tag: cfg.tag
      }) });
    } catch (e) { report.push({ pushError: e.message }); }
  }

  return res.status(200).json({
    scope: scope, checked: targets.length,
    changesFound: changedByScope.teams.length + changedByScope.department.length, report: report
  });
};
