// Editor story ratings: the newsroom rates stories 1-5 and the scanner learns
// from it (2026-10-03, Jeff: "give an option for them to rate it ... and have
// it learn from their ratings").
//
// Ratings come from the News Monitor cards (signed-in POST) and from one-tap
// links in the emails (signed with CRON_SECRET, so they can't be forged and
// don't need a login). They live in one Blob list (newest 600).
//
// promptNote() turns them into a block for scan.js's per-run prompt:
//   - recent corrections ("you rated X a 5, our editor said 2"), so similar
//     stories get rated the way the newsroom would;
//   - per-source tendencies when an outlet is consistently rated higher or
//     lower than the AI rated it.

var crypto = require('crypto');
var KEY = 'story-ratings.json';
var KEEP = 600;
var BASE = 'https://ims-tool.vercel.app';

function secret() { return process.env.CRON_SECRET || process.env.ANALYTICS_ENCRYPTION_KEY || 'dev-only-secret'; }
function b64url(s) { return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64url(s) { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(); }
function sign(payload) { return crypto.createHmac('sha256', secret()).update(payload).digest('hex').slice(0, 24); }

function token(story) {
  var p = b64url(JSON.stringify({
    h: String(story.headline || story.title || '').slice(0, 160), s: String(story.source || '').slice(0, 80),
    u: String(story.url || '').slice(0, 300), a: Number(story.rating) || null
  }));
  return p + '.' + sign(p);
}
function readToken(t) {
  var parts = String(t || '').split('.');
  if (parts.length !== 2 || sign(parts[0]) !== parts[1]) return null;
  try { var o = JSON.parse(unb64url(parts[0])); return { headline: o.h, source: o.s, url: o.u, ai: o.a }; } catch (e) { return null; }
}

// "Rate it: 1 2 3 4 5" for an email. Each link records that rating in one tap.
function emailLinks(story) {
  var t = token(story);
  return '<div style="font-size:11px;color:#888;margin-top:5px">Rate it for us: ' + [1, 2, 3, 4, 5].map(function (n) {
    return '<a href="' + BASE + '/api/story-ratings?t=' + t + '&r=' + n + '" style="display:inline-block;min-width:18px;text-align:center;padding:1px 5px;margin-right:3px;border:1px solid #d6dbe4;border-radius:4px;color:#2563eb;text-decoration:none;font-weight:700">' + n + '</a>';
  }).join('') + '</div>';
}

async function load() {
  try {
    var got = await require('./_site-blob').get(KEY, { access: 'private', useCache: false });
    if (got && got.statusCode === 200) return await new Response(got.stream).json();
  } catch (e) {}
  return [];
}
async function save(list) {
  await require('./_site-blob').put(KEY, JSON.stringify(list.slice(0, KEEP)), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
}

function keyOf(r) { return (r.url || '').split('?')[0] || String(r.headline || '').toLowerCase(); }

// One rating per story per rater; a new rating replaces the old one.
async function add(rec) {
  var r = Number(rec.rating);
  if (!(r >= 1 && r <= 5)) throw new Error('Rating must be 1 to 5.');
  if (!rec.headline && !rec.url) throw new Error('Missing story.');
  var list = await load();
  var row = { headline: String(rec.headline || '').slice(0, 200), source: String(rec.source || '').slice(0, 80), url: String(rec.url || '').slice(0, 400),
    ai: Number(rec.ai) || null, editor: r, by: String(rec.by || 'editor').slice(0, 80), at: Date.now() };
  var k = keyOf(row);
  list = list.filter(function (x) { return !(keyOf(x) === k && x.by === row.by); });
  list.unshift(row);
  await save(list);
  return row;
}

// Latest editor rating per story, for the cards.
async function byStory() {
  var out = {};
  (await load()).forEach(function (r) { var k = keyOf(r); if (!out[k]) out[k] = r.editor; });
  return out;
}

async function promptNote() {
  var list = await load();
  if (!list.length) return '';
  var cutoff = Date.now() - 90 * 86400000;
  list = list.filter(function (r) { return r.at > cutoff; });
  var out = [];

  var corrections = list.filter(function (r) { return r.ai && r.editor !== r.ai; }).slice(0, 40);
  if (corrections.length) {
    out.push('HOW OUR EDITORS RATE STORIES (their corrections to your recent ratings, newest first). Rate similar stories the way they did:\n' +
      corrections.map(function (r) { return '- [' + r.source + '] ' + r.headline + ': you said ' + r.ai + ', our editor said ' + r.editor; }).join('\n'));
  }
  var agreed = list.filter(function (r) { return r.ai && r.editor === r.ai; }).length;
  if (agreed >= 5) out.push('(Editors agreed with your rating on ' + agreed + ' other recent stories.)');

  // Per-source tendency: at least 3 rated stories, average gap of 0.75+.
  var bySrc = {};
  list.forEach(function (r) { if (!r.ai || !r.source) return; (bySrc[r.source] = bySrc[r.source] || []).push(r.editor - r.ai); });
  var tend = Object.keys(bySrc).map(function (s) {
    var d = bySrc[s]; var avg = d.reduce(function (a, b) { return a + b; }, 0) / d.length;
    return { s: s, n: d.length, avg: avg };
  }).filter(function (x) { return x.n >= 3 && Math.abs(x.avg) >= 0.75; });
  if (tend.length) {
    out.push('SOURCE TENDENCIES from our editors\' ratings:\n' + tend.map(function (x) {
      return '- ' + x.s + ': editors rate its stories about ' + Math.abs(x.avg).toFixed(1) + ' point' + (Math.abs(x.avg) >= 1.5 ? 's' : '') + ' ' + (x.avg < 0 ? 'LOWER' : 'HIGHER') + ' than you do (' + x.n + ' stories). Adjust accordingly.';
    }).join('\n'));
  }
  return out.length ? '\n\n' + out.join('\n\n') : '';
}

module.exports = { token: token, readToken: readToken, emailLinks: emailLinks, add: add, load: load, byStory: byStory, promptNote: promptNote, keyOf: keyOf };
