// Who is hot on the beat right now (2026-10-05, Jeff: YouTube "should also
// focus somewhat on the hotter terms at the moment, like Mike Locksley right
// now"). Read from the newsroom's latest shared scan (_latest-scan.js), so it
// costs nothing extra: each current person on the beat profile (roster,
// commits, coaches, key figures) scores the rating of every story from the
// last 48 hours that names them, rated 3 or higher. Coaches and key figures
// also match by last name ("Locksley"). Best-effort: no stored scan, or no
// one above the bar, returns [].

var Latest = require('./_latest-scan.js');

function clean(n) { return String(n || '').replace(/\s*\(.*?\)\s*/g, '').trim(); }

async function hotPeople(beat, max) {
  try {
    var latest = await Latest.load();
    var text = latest && latest.response && (latest.response.content || []).map(function(b) { return b.type === 'text' ? b.text : ''; }).join('');
    if (!text) return [];
    var items = JSON.parse((text.match(/\[[\s\S]*\]/) || ['[]'])[0]);

    var people = [];
    function add(name, lastNameToo) {
      name = clean(name);
      if (!name || name.indexOf(' ') === -1) return;
      if (people.some(function(p) { return p.name === name; })) return;
      var parts = name.toLowerCase().split(/\s+/);
      var last = parts[parts.length - 1];
      people.push({ name: name, full: name.toLowerCase(), last: lastNameToo && last.length >= 5 ? last : null, score: 0 });
    }
    (beat.keyFigures || []).forEach(function(n) { add(n, true); });
    beat.watch.forEach(function(g) {
      if (g.alumni || Number(g.rating || 3) <= 1) return;
      var coaches = /coach|staff/i.test(g.label || '');
      g.names.forEach(function(n) { add(n, coaches); });
    });

    var stories = 0;
    items.forEach(function(it) {
      var rating = Number(it.rating || 0);
      if (rating < 3 || it.irrelevant || it.republished) return;
      if (it.ageHours != null && it.ageHours > 48) return;
      stories++;
      var t = ((it.headline || '') + ' ' + (it.summary || '')).toLowerCase();
      people.forEach(function(p) {
        if (t.indexOf(p.full) !== -1 || (p.last && new RegExp('\\b' + p.last.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(t))) p.score += rating;
      });
    });
    if (!stories) return [];
    // At least two solid stories' worth (e.g. a 3 and a 4) to count as hot.
    return people.filter(function(p) { return p.score >= 7; })
      .sort(function(a, b) { return b.score - a.score; })
      .slice(0, max || 3)
      .map(function(p) { return { name: p.name, score: p.score }; });
  } catch (e) { return []; }
}

module.exports = { hotPeople: hotPeople };
