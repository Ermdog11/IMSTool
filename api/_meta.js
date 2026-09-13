// Shared Meta (Facebook Page) Graph API helpers — OAuth exchange, page
// lookup, and live Page Insights. Used by api/meta-oauth-start.js,
// api/meta-oauth-callback.js, and api/facebook.js.
//
// Env vars (set in Vercel -> Project -> Settings -> Environment Variables):
//   META_APP_ID       - from developers.facebook.com, the app's App ID (not secret)
//   META_APP_SECRET   - the app's App Secret (SECRET - server only)
// Reuses ANALYTICS_ENCRYPTION_KEY (already set up for Chartbeat/Parse.ly) to
// sign the OAuth state param — no new secret needed for that part.
//
// Scope is deliberately narrow: just the signed-in user's own Page(s) and
// their linked Instagram Business account, never ad accounts or other
// people's Pages. In Meta's Development Mode (no App Review submitted),
// these permissions work fully — indefinitely — for anyone with a role
// (admin/developer/tester) on the app itself. That's the expected setup
// here: Jeff is both the app's owner and the Page's owner, so no App
// Review is needed unless this is ever opened up to other publishers.

var crypto = require('crypto');

var GRAPH_VERSION = 'v25.0'; // bump if Meta deprecates this version — developers.facebook.com/docs/graph-api/changelog/versions
var GRAPH = 'https://graph.facebook.com/' + GRAPH_VERSION;
var OAUTH_DIALOG = 'https://www.facebook.com/' + GRAPH_VERSION + '/dialog/oauth';

var SCOPES = 'pages_show_list,pages_read_engagement,read_insights,instagram_basic';

function redirectUri() {
  return (process.env.META_REDIRECT_BASE || 'https://ims-tool.vercel.app') + '/api/meta-oauth-callback';
}

function isConfigured() {
  return !!(process.env.META_APP_ID && process.env.META_APP_SECRET);
}

function authUrl(state) {
  var params = new URLSearchParams({
    client_id: process.env.META_APP_ID || '',
    redirect_uri: redirectUri(),
    scope: SCOPES,
    response_type: 'code',
    state: state
  });
  return OAUTH_DIALOG + '?' + params.toString();
}

async function graphGet(path, params) {
  var url = GRAPH + path + '?' + new URLSearchParams(params || {}).toString();
  var r = await fetch(url);
  var data = await r.json().catch(function() { return {}; });
  if (!r.ok || data.error) {
    throw new Error((data.error && data.error.message) || ('Meta API error: HTTP ' + r.status));
  }
  return data;
}

function exchangeCode(code) {
  return graphGet('/oauth/access_token', {
    client_id: process.env.META_APP_ID || '',
    client_secret: process.env.META_APP_SECRET || '',
    redirect_uri: redirectUri(),
    code: code
  });
}

function exchangeLongLived(shortLivedToken) {
  return graphGet('/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: process.env.META_APP_ID || '',
    client_secret: process.env.META_APP_SECRET || '',
    fb_exchange_token: shortLivedToken
  });
}

// Pages the authorizing user manages, each with its own page access token
// (effectively non-expiring, tied to the long-lived user token it came from).
async function getPages(userAccessToken) {
  var data = await graphGet('/me/accounts', { access_token: userAccessToken, fields: 'id,name,access_token' });
  return data.data || [];
}

async function getInstagramBusinessAccount(pageId, pageAccessToken) {
  try {
    var data = await graphGet('/' + pageId, { fields: 'instagram_business_account', access_token: pageAccessToken });
    return (data.instagram_business_account && data.instagram_business_account.id) || null;
  } catch (e) { return null; }
}

// Page-level reach/engagement over the trailing 28 days — the simplest
// metric set that's stayed stable across Graph API versions. Not pinned
// down against a live response yet (same situation Chartbeat started in) —
// returns the raw metric names/values as-is so a shape mismatch is visible
// rather than silently dropped.
async function getPageInsights(pageId, pageAccessToken) {
  var data = await graphGet('/' + pageId + '/insights', {
    metric: 'page_impressions,page_engaged_users,page_post_engagements',
    period: 'days_28',
    access_token: pageAccessToken
  });
  var out = {};
  (data.data || []).forEach(function(m) {
    var latest = (m.values && m.values.length) ? m.values[m.values.length - 1].value : null;
    out[m.name] = latest;
  });
  return out;
}

// ---- signed OAuth state -----------------------------------------------
// A plain-navigation redirect (Facebook's dialog, then its callback) can't
// carry our Authorization header, so the site/user this flow belongs to
// rides in a signed, time-limited state param instead.
function signState(payload) {
  var key = process.env.ANALYTICS_ENCRYPTION_KEY || '';
  var body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  var sig = crypto.createHmac('sha256', key).update(body).digest('base64url');
  return body + '.' + sig;
}

function verifyState(state) {
  var key = process.env.ANALYTICS_ENCRYPTION_KEY || '';
  var parts = String(state || '').split('.');
  if (parts.length !== 2) return null;
  var expectedSig = crypto.createHmac('sha256', key).update(parts[0]).digest('base64url');
  var a = Buffer.from(expectedSig), b = Buffer.from(parts[1]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  var payload;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); }
  catch (e) { return null; }
  if (!payload.ts || Date.now() - payload.ts > 10 * 60 * 1000) return null; // 10-minute window
  return payload;
}

module.exports = {
  isConfigured: isConfigured,
  authUrl: authUrl,
  redirectUri: redirectUri,
  exchangeCode: exchangeCode,
  exchangeLongLived: exchangeLongLived,
  getPages: getPages,
  getInstagramBusinessAccount: getInstagramBusinessAccount,
  getPageInsights: getPageInsights,
  signState: signState,
  verifyState: verifyState
};
