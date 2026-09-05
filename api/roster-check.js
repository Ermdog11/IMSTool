// Roster diff checker: catches silent roster changes (transfer, dismissal,
// season-ending injury, walk-on promotion) that often precede — or never get —
// a published news story. Runs on its own cron (3x/week), independent of the
// news scan. Compares each configured team's roster page against the last
// snapshot (persisted in Vercel Blob, since serverless functions don't keep
// state between cold starts) and emails the editor when the list changes.
//
// Built against Sidearm Sports' roster templates, which power the large
// majority of college athletics sites — a team's roster URL is normally
// just https://<site>/sports/<sport-slug>/roster. Adding a school/sport is
// a one-line config addition, not new code, so this generalizes past Maryland.
var { get, put } = require('@vercel/blob');
var { sendMail } = require('./_mailer');
var { sendPush } = require('./_push');

var ROSTERS = [
  { label: 'Maryland Football', slug: 'umd-football', url: 'https://umterps.com/sports/football/roster' },
  { label: 'Maryland Men\'s Basketball', slug: 'umd-mbb', url: 'https://umterps.com/sports/mens-basketball/roster' },
  { label: 'Maryland Women\'s Basketball', slug: 'umd-wbb', url: 'https://umterps.com/sports/womens-basketball/roster' },
  { label: 'Maryland Men\'s Lacrosse', slug: 'umd-mlax', url: 'https://umterps.com/sports/mens-lacrosse/roster' },
  { label: 'Maryland Women\'s Lacrosse', slug: 'umd-wlax', url: 'https://umterps.com/sports/womens-lacrosse/roster' }
];

// A roster this small is almost certainly a broken parse, not a real team —
// guards against overwriting a good snapshot with garbage from a template change.
var MIN_SANE_ROSTER = 10;

function extractPlayers(html) {
  // Sidearm "Next Gen" template (s-person-card) — name + jersey number both
  // land in one aria-label, e.g. 'DeJuan Williams jersey number 0 full bio'.
  var nextGen = html.match(/aria-label="([^"]+?) jersey number (\d+) full bio"/g) || [];
  if (nextGen.length >= MIN_SANE_ROSTER) {
    var seen = {};
    nextGen.forEach(function(m) {
      var mm = m.match(/aria-label="([^"]+?) jersey number (\d+) full bio"/);
      if (mm) seen[mm[1].trim()] = mm[2];
    });
    return Object.keys(seen).sort().map(function(name) { return { name: name, jersey: seen[name] }; });
  }
  // Fallback: Sidearm "classic" template — name/number in separate tagged spans.
  var classic = html.match(/<span[^>]*class="[^"]*sidearm-roster-player-name[^"]*"[^>]*>[\s\S]*?<\/span>/g) || [];
  if (classic.length >= MIN_SANE_ROSTER) {
    var names = classic.map(function(c) {
      return c.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }).filter(Boolean);
    return names.sort().map(function(name) { return { name: name, jersey: '' }; });
  }
  return [];
}

async function getPreviousSnapshot(slug) {
  try {
    var result = await get('roster-snapshots/' + slug + '.json', { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200) return null;
    return await new Response(result.stream).json();
  } catch (e) { return null; }
}

async function saveSnapshot(slug, snapshot) {
  await put('roster-snapshots/' + slug + '.json', JSON.stringify(snapshot), {
    access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json'
  });
}

module.exports = async function handler(req, res) {
  var report = [];
  var emailSections = [];
  var pushLines = [];

  for (var i = 0; i < ROSTERS.length; i++) {
    var cfg = ROSTERS[i];
    try {
      var pageRes = await fetch(cfg.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36' }
      });
      if (!pageRes.ok) { report.push({ team: cfg.label, status: 'fetch-failed:' + pageRes.status }); continue; }
      var html = await pageRes.text();
      var players = extractPlayers(html);
      if (players.length < MIN_SANE_ROSTER) {
        report.push({ team: cfg.label, status: 'parse-failed', found: players.length });
        continue;
      }

      var prev = await getPreviousSnapshot(cfg.slug);
      var newNames = players.map(function(p) { return p.name; });

      if (!prev || !prev.players) {
        await saveSnapshot(cfg.slug, { players: newNames, checkedAt: new Date().toISOString() });
        report.push({ team: cfg.label, status: 'baseline-created', count: newNames.length });
        continue;
      }

      var oldNames = prev.players;
      var added = newNames.filter(function(n) { return oldNames.indexOf(n) === -1; });
      var removed = oldNames.filter(function(n) { return newNames.indexOf(n) === -1; });

      await saveSnapshot(cfg.slug, { players: newNames, checkedAt: new Date().toISOString() });

      if (added.length || removed.length) {
        report.push({ team: cfg.label, status: 'changed', added: added, removed: removed });
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

  return res.status(200).json({ checked: ROSTERS.length, changesFound: emailSections.length, report: report });
};
