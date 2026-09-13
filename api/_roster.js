// Shared roster-watch config + snapshot storage (Vercel Blob), used by both
// api/roster-check.js (the cron that detects changes) and api/roster-view.js
// (the in-app view showing each team's current roster + history).

var { get, put } = require('@vercel/blob');

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

// Normalizes a snapshot's player list to [{name,jersey}] — earlier snapshots
// stored plain name strings, before jersey numbers were kept.
function normalizePlayers(players) {
  return (players || []).map(function(p) {
    return (typeof p === 'string') ? { name: p, jersey: '' } : { name: p.name, jersey: p.jersey || '' };
  });
}

async function getSnapshot(slug) {
  try {
    var result = await get('roster-snapshots/' + slug + '.json', { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200) return null;
    var snap = await new Response(result.stream).json();
    if (!snap || !snap.players) return null;
    return { players: normalizePlayers(snap.players), checkedAt: snap.checkedAt || null };
  } catch (e) { return null; }
}

async function saveSnapshot(slug, snapshot) {
  await put('roster-snapshots/' + slug + '.json', JSON.stringify(snapshot), {
    access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json'
  });
}

module.exports = {
  ROSTERS: ROSTERS,
  MIN_SANE_ROSTER: MIN_SANE_ROSTER,
  extractPlayers: extractPlayers,
  getSnapshot: getSnapshot,
  saveSnapshot: saveSnapshot
};
