// Roster diff checker: catches silent roster changes (transfer, dismissal,
// season-ending injury, walk-on promotion) that often precede — or never get —
// a published news story. Runs on its own cron (3x/week), independent of the
// news scan. Compares each configured team's roster page against the last
// snapshot (persisted in Vercel Blob, since serverless functions don't keep
// state between cold starts), emails the editor when the list changes, and
// logs the change to Supabase so the in-app Roster Watch view has a history.
//
// Built against Sidearm Sports' roster templates, which power the large
// majority of college athletics sites — a team's roster URL is normally
// just https://<site>/sports/<sport-slug>/roster. Adding a school/sport is
// a one-line config addition, not new code, so this generalizes past Maryland.
var Roster = require('./_roster');
var RosterStore = require('./_roster-store');
var { sendMail } = require('./_mailer');
var { sendPush } = require('./_push');

module.exports = async function handler(req, res) {
  var report = [];
  var emailSections = [];
  var pushLines = [];

  for (var i = 0; i < Roster.ROSTERS.length; i++) {
    var cfg = Roster.ROSTERS[i];
    try {
      var pageRes = await fetch(cfg.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36' }
      });
      if (!pageRes.ok) { report.push({ team: cfg.label, status: 'fetch-failed:' + pageRes.status }); continue; }
      var html = await pageRes.text();
      var players = Roster.extractPlayers(html);
      if (players.length < Roster.MIN_SANE_ROSTER) {
        report.push({ team: cfg.label, status: 'parse-failed', found: players.length });
        continue;
      }

      var prev = await Roster.getSnapshot(cfg.slug);
      var newNames = players.map(function(p) { return p.name; });
      var checkedAt = new Date().toISOString();

      if (!prev || !prev.players || !prev.players.length) {
        await Roster.saveSnapshot(cfg.slug, { players: players, checkedAt: checkedAt });
        report.push({ team: cfg.label, status: 'baseline-created', count: newNames.length });
        continue;
      }

      var oldNames = prev.players.map(function(p) { return p.name; });
      var added = newNames.filter(function(n) { return oldNames.indexOf(n) === -1; });
      var removed = oldNames.filter(function(n) { return newNames.indexOf(n) === -1; });

      await Roster.saveSnapshot(cfg.slug, { players: players, checkedAt: checkedAt });

      if (added.length || removed.length) {
        var storeResult = await RosterStore.recordChanges(cfg.slug, cfg.label, added, removed, checkedAt);
        report.push({ team: cfg.label, status: 'changed', added: added, removed: removed, stored: storeResult });
        var html2 = '<h3 style="margin:16px 0 6px">' + cfg.label + '</h3>';
        if (removed.length) html2 += '<p style="color:#b91c1c;margin:4px 0"><b>Off the roster:</b> ' + removed.join(', ') + '</p>';
        if (added.length) html2 += '<p style="color:#15803d;margin:4px 0"><b>Added to roster:</b> ' + added.join(', ') + '</p>';
        emailSections.push(html2);
        var bits = [];
        if (removed.length) bits.push('Off: ' + removed.join(', '));
        if (added.length) bits.push('Added: ' + added.join(', '));
        pushLines.push(cfg.label + ' — ' + bits.join(' | '));
      } else {
        report.push({ team: cfg.label, status: 'no-change', count: newNames.length });
      }
    } catch (e) {
      report.push({ team: cfg.label, status: 'error', error: e.message });
    }
  }

  if (emailSections.length) {
    try {
      await sendMail({
        subject: '🔄 Terps Roster Change Detected',
        html: '<div style="font-family:Arial,sans-serif;max-width:600px">' +
          '<p>A roster change was just detected — could be a transfer, dismissal, injury designation, or new addition. Worth checking if it\'s newsworthy before it\'s reported elsewhere:</p>' +
          emailSections.join('') +
          '</div>'
      });
    } catch (e) {
      report.push({ mailError: e.message });
    }
    try {
      var pushResult = await sendPush({
        title: '🔄 Roster Change Detected',
        body: pushLines.join(' \n ').slice(0, 200),
        url: 'https://ims-tool.vercel.app/',
        tag: 'roster-change'
      });
      report.push({ push: pushResult });
    } catch (e) {
      report.push({ pushError: e.message });
    }
  }

  return res.status(200).json({ checked: Roster.ROSTERS.length, changesFound: emailSections.length, report: report });
};
