// Google Search Console, shared fetch/parse for the Analytics card
// (api/search-console.js), the connect step (api/analytics-connections.js),
// the question box / overall summary (api/_analytics-context.js) and the
// morning Coverage Desk (api/_yesterday-analytics.js).
//
// Auth: one Google service account for the whole app, its JSON key in the
// GOOGLE_SERVICE_ACCOUNT_JSON env var. Each newsroom adds that account's email
// as a user (Restricted is enough) on its own Search Console property, then
// picks the property under Analytics -> Connections. Nothing secret is stored
// per newsroom. Token: a self-signed RS256 JWT exchanged at Google's token
// endpoint (no SDK), cached until shortly before it expires.
//
// Data notes: Search Console finalizes data 2-3 days late. dataState:"all"
// includes fresh, still-changing numbers (used for "yesterday" in the memo and
// marked as preliminary). Discover and Google News report clicks/impressions
// but no queries.

var crypto = require('crypto');

var SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
var API = 'https://searchconsole.googleapis.com/webmasters/v3';
var TZ = 'America/Los_Angeles'; // Search Console reports days in Pacific time

var tokenCache = null;

function serviceAccount() {
  var raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    var j = JSON.parse(raw);
    if (!j.client_email || !j.private_key) return null;
    return { email: j.client_email, key: j.private_key.replace(/\\n/g, '\n') };
  } catch (e) { return null; }
}

function isConfigured() { return !!serviceAccount(); }
function serviceAccountEmail() { var sa = serviceAccount(); return sa ? sa.email : null; }

function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }

async function accessToken() {
  if (tokenCache && tokenCache.exp > Date.now() + 60000) return tokenCache.token;
  var sa = serviceAccount();
  if (!sa) throw new Error('Search Console isn\'t set up yet (GOOGLE_SERVICE_ACCOUNT_JSON is missing).');
  var now = Math.floor(Date.now() / 1000);
  var head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  var claims = b64url(JSON.stringify({ iss: sa.email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  var signer = crypto.createSign('RSA-SHA256'); signer.update(head + '.' + claims);
  var jwt = head + '.' + claims + '.' + b64url(signer.sign(sa.key));
  var r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + jwt
  });
  var d = await r.json().catch(function () { return {}; });
  if (!r.ok || !d.access_token) throw new Error('Google sign-in for Search Console failed: ' + (d.error_description || d.error || ('HTTP ' + r.status)));
  tokenCache = { token: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

async function gscFetch(path, body) {
  var token = await accessToken();
  var r = await fetch(API + path, {
    method: body ? 'POST' : 'GET',
    headers: Object.assign({ Authorization: 'Bearer ' + token }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  var d = await r.json().catch(function () { return {}; });
  if (!r.ok) {
    var msg = (d.error && d.error.message) || ('HTTP ' + r.status);
    if (r.status === 403) msg = 'Search Console says this account can\'t see that property. Add ' + serviceAccountEmail() + ' as a user on it (Search Console → Settings → Users and permissions). (' + msg + ')';
    throw new Error(msg);
  }
  return d;
}

// Properties the service account has been added to.
async function listSites() {
  var d = await gscFetch('/sites');
  return (d.siteEntry || []).filter(function (s) { return s.permissionLevel !== 'siteUnverifiedUser'; })
    .map(function (s) { return { siteUrl: s.siteUrl, permission: s.permissionLevel }; });
}

function dayStr(daysAgo) {
  return new Date(Date.now() - daysAgo * 86400000).toLocaleDateString('en-CA', { timeZone: TZ });
}

function pathFilter(pathPrefix) {
  return pathPrefix ? [{ filters: [{ dimension: 'page', operator: 'contains', expression: pathPrefix }] }] : undefined;
}

async function query(siteUrl, opts) {
  var body = {
    startDate: opts.start, endDate: opts.end, type: opts.type || 'web',
    dimensions: opts.dimensions || [], rowLimit: opts.rowLimit || 25,
    dataState: opts.fresh ? 'all' : 'final'
  };
  var pf = pathFilter(opts.pathPrefix);
  if (pf) body.dimensionFilterGroups = pf;
  var d = await gscFetch('/sites/' + encodeURIComponent(siteUrl) + '/searchAnalytics/query', body);
  return (d.rows || []).map(function (r) {
    return { keys: r.keys || [], clicks: r.clicks || 0, impressions: r.impressions || 0, ctr: Math.round((r.ctr || 0) * 1000) / 10, position: Math.round((r.position || 0) * 10) / 10 };
  });
}

function totalsOf(rows) {
  var t = rows[0] || { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  return { clicks: t.clicks, impressions: t.impressions, ctrPct: t.ctr, avgPosition: t.position };
}

function pct(a, b) { return b ? Math.round((a - b) / b * 100) : null; }

// Last 28 days vs the 28 before, for web search plus Discover and Google
// News totals; top queries/pages, rising queries and "page 1 opportunities"
// (lots of impressions at position 5-20, low click rate).
async function fetchSummary(siteUrl, pathPrefix) {
  var warnings = [];
  var cur = { start: dayStr(30), end: dayStr(3) }, prev = { start: dayStr(58), end: dayStr(31) };
  function q(o) { return query(siteUrl, Object.assign({ pathPrefix: pathPrefix }, o)).catch(function (e) { warnings.push(e.message); return []; }); }
  var r = await Promise.all([
    q(Object.assign({}, cur)), q(Object.assign({}, prev)),
    q(Object.assign({ dimensions: ['query'], rowLimit: 250 }, cur)), q(Object.assign({ dimensions: ['query'], rowLimit: 250 }, prev)),
    q(Object.assign({ dimensions: ['page'], rowLimit: 10 }, cur)),
    q(Object.assign({ dimensions: ['date'], rowLimit: 60 }, cur)),
    q(Object.assign({ type: 'discover' }, cur)), q(Object.assign({ type: 'googleNews' }, cur))
  ]);
  var web = totalsOf(r[0]), webPrev = totalsOf(r[1]);
  var prevQ = {}; r[3].forEach(function (row) { prevQ[row.keys[0]] = row; });
  var queries = r[2];
  return {
    window: cur, previousWindow: prev,
    web: Object.assign(web, { clicksChangePct: pct(web.clicks, webPrev.clicks), impressionsChangePct: pct(web.impressions, webPrev.impressions) }),
    discover: totalsOf(r[6]), googleNews: totalsOf(r[7]),
    topQueries: queries.slice(0, 10).map(function (x) { return { query: x.keys[0], clicks: x.clicks, impressions: x.impressions, ctrPct: x.ctr, position: x.position }; }),
    risingQueries: queries.filter(function (x) { var p = prevQ[x.keys[0]]; return x.clicks >= 10 && (!p || x.clicks > p.clicks * 1.5); })
      .sort(function (a, b) { return (b.clicks - ((prevQ[b.keys[0]] || {}).clicks || 0)) - (a.clicks - ((prevQ[a.keys[0]] || {}).clicks || 0)); })
      .slice(0, 8).map(function (x) { return { query: x.keys[0], clicks: x.clicks, previousClicks: (prevQ[x.keys[0]] || {}).clicks || 0 }; }),
    opportunities: queries.filter(function (x) { return x.impressions >= 200 && x.position >= 5 && x.position <= 20 && x.ctr < 3; })
      .sort(function (a, b) { return b.impressions - a.impressions; }).slice(0, 8)
      .map(function (x) { return { query: x.query || x.keys[0], impressions: x.impressions, position: x.position, ctrPct: x.ctr }; }),
    topPages: r[4].map(function (x) { return { page: x.keys[0], clicks: x.clicks, impressions: x.impressions, position: x.position }; }),
    daily: r[5].map(function (x) { return { date: x.keys[0], clicks: x.clicks, impressions: x.impressions }; }),
    note: 'Search Console data is final about 3 days after the fact; this window ends ' + cur.end + '.',
    warnings: warnings
  };
}

// Yesterday (Pacific day, as Search Console counts it), preliminary numbers.
async function fetchYesterday(siteUrl, pathPrefix) {
  var day = dayStr(1), base = { start: day, end: day, fresh: true, pathPrefix: pathPrefix };
  var r = await Promise.all([
    query(siteUrl, base),
    query(siteUrl, Object.assign({ dimensions: ['query'], rowLimit: 8 }, base)),
    query(siteUrl, Object.assign({ dimensions: ['page'], rowLimit: 5 }, base)),
    query(siteUrl, Object.assign({ type: 'discover' }, base)).catch(function () { return []; }),
    query(siteUrl, Object.assign({ type: 'googleNews' }, base)).catch(function () { return []; })
  ]);
  return {
    day: day, web: totalsOf(r[0]), discover: totalsOf(r[3]), googleNews: totalsOf(r[4]),
    topQueries: r[1].map(function (x) { return { query: x.keys[0], clicks: x.clicks, impressions: x.impressions, position: x.position }; }),
    topPages: r[2].map(function (x) { return { page: x.keys[0], clicks: x.clicks, impressions: x.impressions }; }),
    note: 'Preliminary: Search Console keeps adjusting a day\'s numbers for about 3 days.'
  };
}

module.exports = { isConfigured: isConfigured, serviceAccountEmail: serviceAccountEmail, listSites: listSites, fetchSummary: fetchSummary, fetchYesterday: fetchYesterday };
