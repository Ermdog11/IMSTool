// /api/go — the affiliate redirect (see _affiliate.js). Public: readers
// click these from published articles.
//
//   GET ?p=<program id>&s=<newsroom>&a=<article>&u=<page the link pointed to>
//   -> counts the click, then 302 to the program's tracking link.
//
// Only sends readers to a page on the program's own domains, so it can't be
// used as an open redirect.

var Aff = require('./_affiliate');

module.exports = async function handler(req, res) {
  var q = req.query || {};
  var site = String(q.s || '').slice(0, 60).replace(/[^a-z0-9_-]/gi, '');
  var article = String(q.a || '').slice(0, 80);
  var url = String(q.u || '');
  res.setHeader('Cache-Control', 'no-store');
  try {
    var config = await Aff.loadConfig();
    var p = (config.programs || []).filter(function (x) { return x.id === q.p && x.active !== false; })[0];
    if (!p) return res.status(404).send('Link not found');
    if (url && !Aff.matches(p, url)) url = '';
    var dest = Aff.destination(p, url || p.home || '', site);
    if (!/^https?:\/\//i.test(dest)) return res.status(404).send('Link not found');
    try { await Aff.logClick(site || 'unknown', p.id, article); } catch (e) { console.error('Affiliate click log failed:', e.message); }
    res.setHeader('Location', dest);
    return res.status(302).send('');
  } catch (e) {
    // Never strand a reader: fall back to the page they clicked when it's safe.
    console.error('Affiliate redirect error:', e.message);
    if (/^https?:\/\//i.test(url)) { res.setHeader('Location', url); return res.status(302).send(''); }
    return res.status(500).send('Something went wrong');
  }
};
