// /api/layout — each person's own arrangement of the cards on a page (Jeff,
// 2026-10-06: "make the tools on here customizable, so they can move them up
// or down or remove" them, for Gameplan and Home). Per person, per newsroom,
// in Blob (layouts/<user id>.json through _site-blob, so other newsrooms'
// files stay separate).
//
//   GET                                   -> { layouts: { <page>: { order: [ids], hidden: [ids] } } }
//   POST { page, order: [ids], hidden: [ids] } -> saves that page's layout
//   POST { page, reset: true }            -> back to the default layout
//
// Best-effort like feed-prefs: the page keeps a local copy and works without
// this. Spends no credits, sends no email.

var S = require('./_supabase');
var blob = require('./_site-blob');

var PAGES = ['home', 'xos'];

function pathFor(uid) { return 'layouts/' + String(uid).replace(/[^a-zA-Z0-9-]/g, '') + '.json'; }

async function load(uid) {
  try {
    var r = await blob.get(pathFor(uid), { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200) return {};
    var d = await new Response(r.stream).json();
    return d && typeof d === 'object' ? d : {};
  } catch (e) { return {}; }
}

function ids(a) { return (Array.isArray(a) ? a : []).map(function (x) { return String(x).replace(/[^a-z0-9_-]/gi, '').slice(0, 40); }).filter(Boolean).slice(0, 40); }

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!S.isConfigured()) return res.status(200).json({ layouts: {}, local: true });
  var ctx;
  try { ctx = await S.requireUser(req); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
  var uid = ctx.user.id;

  if (req.method === 'GET') return res.status(200).json({ layouts: await load(uid) });
  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });

  var body = req.body || {};
  var page = String(body.page || '');
  if (PAGES.indexOf(page) === -1) return res.status(400).json({ error: 'Unknown page' });
  var all = await load(uid);
  if (body.reset) delete all[page];
  else all[page] = { order: ids(body.order), hidden: ids(body.hidden), at: new Date().toISOString() };
  await blob.put(pathFor(uid), JSON.stringify(all), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
  return res.status(200).json({ ok: true, layouts: all });
};

// Per-newsroom: this request runs as the signed-in person's newsroom (_site.js).
module.exports = require('./_site').wrap(module.exports);
