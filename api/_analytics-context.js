// Shared "what do we actually know about this site's audience right now"
// gatherer — one live reading + recent trend computation per connected
// source. Used by both api/analytics-question.js (a user's specific
// question) and api/analytics-snapshot.js (the standing overall summary
// generated on the cron), so the two are always looking at the same data.

var Store = require('./_analytics-store');
var Chartbeat = require('./_chartbeat');
var Meta = require('./_meta');
var Trends = require('./_trends');

var LOOKBACK_DAYS = 30;
var MIN_SNAPSHOTS = 8;   // matches api/analytics-trends.js's threshold

async function trendsOrPending(sb, siteId, source) {
  var since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  var snapshots = await Store.listSnapshots(sb, siteId, source, since);
  if (snapshots.length < MIN_SNAPSHOTS) return { trendsPending: { count: snapshots.length, needed: MIN_SNAPSHOTS } };
  return { trends: Trends.computeTrends(source, snapshots) };
}

async function chartbeatContext(sb, siteId) {
  var conn = await Store.getConnection(sb, siteId, 'chartbeat');
  if (!conn || !conn.apiKey || !conn.host) return null;
  var out = { source: 'chartbeat', host: conn.host };
  try { out.liveNow = await Chartbeat.fetchLive(conn.apiKey, conn.host); }
  catch (e) { out.liveError = e.message; }
  Object.assign(out, await trendsOrPending(sb, siteId, 'chartbeat'));
  return out;
}

async function metaContext(sb, siteId) {
  var conn = await Store.getConnection(sb, siteId, 'meta');
  if (!conn || !conn.pageAccessToken || !conn.pageId) return null;
  var out = { source: 'meta', pageName: conn.pageName };
  try { out.last28Days = await Meta.getPageInsights(conn.pageId, conn.pageAccessToken); }
  catch (e) { out.liveError = e.message; }
  Object.assign(out, await trendsOrPending(sb, siteId, 'meta'));
  return out;
}

// scope: 'all' | 'chartbeat' | 'meta'. Returns an array of whichever
// requested sources are actually connected — never throws for a source
// that isn't connected, just omits it.
async function gatherContexts(sb, siteId, scope) {
  var contexts = [];
  if (scope === 'all' || scope === 'chartbeat') {
    var cb = await chartbeatContext(sb, siteId);
    if (cb) contexts.push(cb);
  }
  if (scope === 'all' || scope === 'meta') {
    var mt = await metaContext(sb, siteId);
    if (mt) contexts.push(mt);
  }
  return contexts;
}

module.exports = { gatherContexts: gatherContexts };
