// Daily sample questions (Jeff, 2026-10-06: "make sure the sample questions
// change each day but cycle the most important ones more often, like what
// should we publish, what is working, how was this week").
//
// pick(list, n, salt): n questions for today (Eastern), different every day,
// the same all day for everyone. Each entry is a string or { q, weight };
// a weight-4 question shows up about four times as often as a weight-1 one.
// No AI calls.

function today() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); }

// Small seeded random number generator (mulberry32), seeded from the day.
function rng(seedText) {
  var h = 2166136261;
  for (var i = 0; i < seedText.length; i++) { h ^= seedText.charCodeAt(i); h = Math.imul(h, 16777619); }
  var a = h >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    var t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(list, n, salt, day) {
  var pool = (list || []).map(function (x) { return typeof x === 'string' ? { q: x, weight: 1 } : { q: x.q, weight: x.weight || 1 }; });
  var rand = rng((day || today()) + '|' + (salt || ''));
  var out = [];
  while (out.length < n && pool.length) {
    var total = pool.reduce(function (s, x) { return s + x.weight; }, 0);
    var r = rand() * total, i = 0;
    for (; i < pool.length - 1; i++) { r -= pool[i].weight; if (r < 0) break; }
    out.push(pool[i].q);
    pool.splice(i, 1);
  }
  return out;
}

module.exports = { pick: pick, today: today };
