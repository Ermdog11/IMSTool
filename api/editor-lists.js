// /api/editor-lists — the Content Editor's promos and writers (voice
// profiles), saved for the whole newsroom (Jeff, 2026-10-07: move them off
// "This browser" so they follow everyone everywhere). They used to live only
// in the browser they were set up in; editor.html still keeps a local copy
// for speed and uploads it here the first time if the newsroom has none.
//
//   GET                         -> { promos: [...] | null, writers: [...] | null }
//                                  (null = never saved for this newsroom)
//   POST { promos: [...] }      -> replace the promos (anyone who can open the Inserts tab)
//   POST { writers: [...] }     -> replace the writers (anyone who can open the Writers tab)
//
// Per newsroom in Blob (editor/promos.json, editor/writers.json via
// _site-blob). No credits spent, no email sent.

var S = require('./_supabase');
var blob = require('./_site-blob');

var FILES = { promos: 'editor/promos.json', writers: 'editor/writers.json' };
var TAB = { promos: 'tab_inserts', writers: 'tab_writers' };
var MAX_BYTES = 2 * 1024 * 1024;

async function load(kind) {
  try {
    var r = await blob.get(FILES[kind], { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200) return null;
    var d = await new Response(r.stream).json();
    return Array.isArray(d) ? d : null;
  } catch (e) { return null; }
}

function str(v, n) { return String(v == null ? '' : v).slice(0, n); }
function cleanPromos(list) {
  return list.slice(0, 50).map(function (p) {
    return { id: str(p.id, 40), name: str(p.name, 120), tier: ['free', 'vip', 'both'].indexOf(p.tier) !== -1 ? p.tier : 'both', placement: str(p.placement, 20) || 'end', html: str(p.html, 50000) };
  });
}
function cleanWriters(list) {
  return list.slice(0, 100).map(function (w) {
    return { name: str(w.name, 120), samples: str(w.samples, 200000), urls: str(w.urls, 20000), profile: str(w.profile, 50000) };
  }).filter(function (w) { return w.name.trim(); });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!S.isConfigured()) return res.status(200).json({ promos: null, writers: null, local: true });
  var ctx;
  try { ctx = await S.requireUser(req); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message }); }

  if (req.method === 'GET') {
    var got = await Promise.all([load('promos'), load('writers')]);
    return res.status(200).json({ promos: got[0], writers: got[1] });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });

  var body = req.body || {};
  var kind = Array.isArray(body.promos) ? 'promos' : Array.isArray(body.writers) ? 'writers' : null;
  if (!kind) return res.status(400).json({ error: 'Send promos or writers.' });
  if (!(await require('./_access').allowed(ctx, TAB[kind]))) return res.status(403).json({ error: 'Your role can\'t change the newsroom\'s ' + kind + '.' });
  var list = kind === 'promos' ? cleanPromos(body.promos) : cleanWriters(body.writers);
  var json = JSON.stringify(list);
  if (json.length > MAX_BYTES) return res.status(413).json({ error: 'That\'s too much text to save. Trim some writer samples.' });
  await blob.put(FILES[kind], json, { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
  return res.status(200).json({ ok: true, count: list.length });
};

// Per-newsroom: this request runs as the signed-in person's newsroom (_site.js).
module.exports = require('./_site').wrap(module.exports);
