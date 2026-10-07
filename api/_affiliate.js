// Affiliate revenue share (Jeff, 2026-10-06: "could we have the ad code run
// through our affiliate code and pay them a percentage?" — then "Yes" to
// starting with affiliate links).
//
// CoPublisher AI holds the affiliate accounts (Fanatics, ticket sellers,
// sportsbooks where legal...). Each program is set up once on /affiliates:
//   - domains: links to these sites get tagged (fanatics.com, seatgeek.com)
//   - urlTemplate: the network's tracking link, with {url} for the page the
//     reader wanted (deep link) and {site} for the newsroom, used as the
//     network's sub-ID so its reports split earnings by newsroom
//   - boxHtml (optional): a ready-made box ("Shop Terps gear") with {link},
//     placed in articles like an ad slot
//   - share: the percent of earnings paid to the newsroom
//
// In the Content Editor, links in an article to a program's domains are
// rewritten to /api/go (our redirect), which counts the click by newsroom,
// program and article and sends the reader on through the tracking link.
// Earnings come from each network's report (entered monthly on /affiliates);
// the payout report multiplies them by each newsroom's share.
//
// Stored in Vercel Blob: affiliate/config.json (programs, earnings) and
// affiliate/clicks-YYYY-MM.json (counts). Click counting is read-modify-write,
// so two clicks in the same instant can count as one; the networks' own
// numbers are what pay out.

var { get, put } = require('./_site-blob');
var CONFIG = 'affiliate/config.json';

async function readJson(path, fallback) {
  try {
    var r = await get(path, { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200) return fallback;
    return await new Response(r.stream).json();
  } catch (e) { return fallback; }
}
async function writeJson(path, data) {
  await put(path, JSON.stringify(data), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
}

async function loadConfig() {
  var c = await readJson(CONFIG, null) || {};
  return { programs: c.programs || [], earnings: c.earnings || [], updatedAt: c.updatedAt || null };
}
async function saveConfig(c) { c.updatedAt = new Date().toISOString(); await writeJson(CONFIG, c); }

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; } }
function matches(program, url) {
  var h = hostOf(url);
  return !!h && (program.domains || []).some(function (d) { d = String(d || '').toLowerCase().replace(/^www\./, ''); return d && (h === d || h.slice(-(d.length + 1)) === '.' + d); });
}
function programFor(config, url) {
  return (config.programs || []).filter(function (p) { return p.active !== false && matches(p, url); })[0] || null;
}

// The network link for one click.
function destination(program, url, site) {
  var t = String(program.urlTemplate || '');
  if (!t) return url;
  return t.replace(/\{url\}/g, encodeURIComponent(url || program.home || '')).replace(/\{site\}/g, encodeURIComponent(site || ''));
}

function month(d) { return (d || new Date()).toISOString().slice(0, 7); }

async function logClick(site, programId, article) {
  var path = 'affiliate/clicks-' + month() + '.json';
  var c = await readJson(path, null) || { total: 0, bySite: {}, byArticle: {} };
  var k = site + '|' + programId;
  c.total = (c.total || 0) + 1;
  c.bySite[k] = (c.bySite[k] || 0) + 1;
  if (article) {
    var a = site + '|' + String(article).slice(0, 80);
    c.byArticle[a] = (c.byArticle[a] || 0) + 1;
  }
  await writeJson(path, c);
}

async function clicks(m) { return await readJson('affiliate/clicks-' + m + '.json', null) || { total: 0, bySite: {}, byArticle: {} }; }

// Earnings entered for a month -> what each newsroom is owed.
function payouts(config, m) {
  var progs = {}; (config.programs || []).forEach(function (p) { progs[p.id] = p; });
  return (config.earnings || []).filter(function (e) { return e.month === m; }).map(function (e) {
    var p = progs[e.program] || {};
    var share = typeof e.share === 'number' ? e.share : Number(p.share || 0);
    return { month: e.month, program: e.program, programName: p.name || e.program, site: e.site, earnings: Number(e.amount) || 0, share: share, payout: Math.round((Number(e.amount) || 0) * share) / 100 };
  });
}

module.exports = { loadConfig: loadConfig, saveConfig: saveConfig, programFor: programFor, matches: matches, destination: destination, logClick: logClick, clicks: clicks, payouts: payouts, month: month, hostOf: hostOf };
