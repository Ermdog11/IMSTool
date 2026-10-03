// Shared Buffer fetch + parse logic: per-post social performance for posts
// the newsroom sent through Buffer. Used by the Analytics page
// (api/buffer.js), the connect step (api/analytics-connections.js, which
// checks the key and picks the organization) and the question box / overall
// summary (api/_analytics-context.js), so they read Buffer the same way.
//
// Buffer's GraphQL API (https://api.buffer.com, "Authorization: Bearer <key>"):
//   account { organizations { id name } }
//   channels(input: { organizationId })                  -> [Channel]
//   posts(input: { organizationId, filter, sort }, first, after)
//                                                         -> Relay edges { node { ... metrics { type value unit } } }
//   aggregatedPostMetrics(input: { organizationId, startDateTime, endDateTime, channelIds })
//                                                         -> { metrics, metricsUpdatedAt }
// Each customer pastes a personal API key from their own Buffer account
// (Settings -> API), same as Chartbeat. Buffer marks post metrics as
// experimental and refreshes them about once a day, so treat the numbers as
// day-old and expect field changes; errors here are surfaced, never thrown
// past the callers' own boundaries.

var ENDPOINT = 'https://api.buffer.com';
var LOOKBACK_DAYS = 30;
var MAX_POSTS = 300; // 3 pages of 100

async function gql(apiKey, query, variables) {
  var c = new AbortController(); var t = setTimeout(function () { c.abort(); }, 20000);
  var r;
  try {
    r = await fetch(ENDPOINT, {
      method: 'POST', signal: c.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({ query: query, variables: variables || {} })
    });
  } finally { clearTimeout(t); }
  var text = await r.text();
  var d; try { d = JSON.parse(text); } catch (e) { d = null; }
  if (r.status === 401 || (d && d.errors && d.errors.some(function (e) { return e.extensions && e.extensions.code === 'UNAUTHENTICATED'; }))) {
    throw new Error('Buffer rejected the API key. Create a new one under Settings -> API in Buffer and reconnect.');
  }
  if (!d) throw new Error('Buffer: HTTP ' + r.status + ' ' + text.slice(0, 200));
  if (d.errors && d.errors.length && !d.data) throw new Error('Buffer: ' + d.errors.map(function (e) { return e.message; }).join('; '));
  return d.data || {};
}

async function getOrganizations(apiKey) {
  var d = await gql(apiKey, 'query { account { organizations { id name } } }');
  return (d.account && d.account.organizations) || [];
}

async function getChannels(apiKey, organizationId) {
  var d = await gql(apiKey,
    'query($o: OrganizationId!) { channels(input: { organizationId: $o }) { id name displayName service isDisconnected } }',
    { o: organizationId });
  return (d.channels || []).map(function (ch) {
    return { id: ch.id, name: ch.displayName || ch.name, service: ch.service, disconnected: !!ch.isDisconnected };
  });
}

function metricsMap(list) {
  var out = {};
  (list || []).forEach(function (m) { if (m && m.type) out[m.type] = m.value; });
  return out;
}

// Total interactions on a post: the cross-network counts Buffer normalizes.
function engagementOf(m) {
  return (m.reactions || 0) + (m.comments || 0) + (m.shares || 0) + (m.reposts || 0) + (m.clicks || 0) + (m.saves || 0) + (m.quotes || 0);
}

async function getSentPosts(apiKey, organizationId, sinceIso, untilIso) {
  var q = 'query($o: OrganizationId!, $since: DateTime, $until: DateTime, $after: String) {' +
    ' posts(first: 100, after: $after, input: { organizationId: $o, filter: { status: [sent], dueAt: { start: $since, end: $until } }, sort: [{ field: dueAt, direction: desc }] }) {' +
    '  edges { node { id text sentAt dueAt externalLink channelId channelService metricsUpdatedAt metrics { type value unit } } }' +
    '  pageInfo { endCursor hasNextPage } } }';
  var posts = [], after = null;
  while (posts.length < MAX_POSTS) {
    var d = await gql(apiKey, q, { o: organizationId, since: sinceIso, until: untilIso || null, after: after });
    var res = d.posts || {};
    (res.edges || []).forEach(function (e) { if (e && e.node) posts.push(e.node); });
    if (!res.pageInfo || !res.pageInfo.hasNextPage || !res.pageInfo.endCursor) break;
    after = res.pageInfo.endCursor;
  }
  return posts;
}

async function getAggregate(apiKey, organizationId, startIso, endIso, channelIds) {
  var d = await gql(apiKey,
    'query($o: OrganizationId!, $s: DateTime!, $e: DateTime!, $c: [ChannelId!]) { aggregatedPostMetrics(input: { organizationId: $o, startDateTime: $s, endDateTime: $e, channelIds: $c }) { metrics { type value unit } metricsUpdatedAt } }',
    { o: organizationId, s: startIso, e: endIso, c: channelIds || null });
  var a = d.aggregatedPostMetrics || {};
  return { metrics: metricsMap(a.metrics), metricsUpdatedAt: a.metricsUpdatedAt || null };
}

function dayStartIso(msAgo) {
  var d = new Date(Date.now() - msAgo);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

// Last 30 days of social performance: totals, per-channel rollups, top posts
// by interactions and by posting hour/day (ET). Per-channel and best-time
// pieces each degrade on their own if Buffer rejects them; warnings say so.
async function fetchSummary(apiKey, organizationId) {
  var warnings = [];
  var startIso = dayStartIso(LOOKBACK_DAYS * 86400000), endIso = dayStartIso(0);
  var channels = await getChannels(apiKey, organizationId);
  var byId = {}; channels.forEach(function (ch) { byId[ch.id] = ch; });

  var totals = null;
  try { totals = await getAggregate(apiKey, organizationId, startIso, endIso, null); }
  catch (e) { warnings.push('Totals: ' + e.message); }

  // One rollup per channel: a single-network filter returns that network's
  // richer metrics (impressions, reach, engagement rate) that a mixed set drops.
  var perChannel = await Promise.all(channels.filter(function (ch) { return !ch.disconnected; }).map(async function (ch) {
    try {
      var a = await getAggregate(apiKey, organizationId, startIso, endIso, [ch.id]);
      return { id: ch.id, name: ch.name, service: ch.service, metrics: a.metrics };
    } catch (e) { warnings.push(ch.name + ': ' + e.message); return null; }
  }));
  perChannel = perChannel.filter(Boolean).sort(function (a, b) { return (b.metrics.postCount || 0) - (a.metrics.postCount || 0); });

  var posts = [];
  try { posts = await getSentPosts(apiKey, organizationId, startIso); }
  catch (e) { warnings.push('Posts: ' + e.message); }
  var scored = posts.map(function (p) {
    var m = metricsMap(p.metrics);
    var ch = byId[p.channelId] || {};
    return {
      text: String(p.text || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      channel: ch.name || p.channelService, service: p.channelService,
      sentAt: p.sentAt || p.dueAt, link: p.externalLink || null,
      metrics: m, engagement: engagementOf(m), hasMetrics: !!(p.metrics && p.metrics.length)
    };
  });
  var withMetrics = scored.filter(function (p) { return p.hasMetrics; });

  // Best posting hour and day (Eastern) by average interactions per post,
  // only once there are enough measured posts to mean anything.
  function bucket(keyFn) {
    var b = {};
    withMetrics.forEach(function (p) {
      if (!p.sentAt) return;
      var k = keyFn(new Date(p.sentAt)); b[k] = b[k] || { sum: 0, n: 0 }; b[k].sum += p.engagement; b[k].n++;
    });
    var best = null;
    Object.keys(b).forEach(function (k) { if (b[k].n >= 3 && (!best || b[k].sum / b[k].n > best.avg)) best = { key: k, avg: Math.round(b[k].sum / b[k].n * 10) / 10, posts: b[k].n }; });
    return best;
  }
  var tz = 'America/New_York';
  var bestHour = withMetrics.length >= 15 ? bucket(function (d) { return d.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: true }); }) : null;
  var bestDay = withMetrics.length >= 15 ? bucket(function (d) { return d.toLocaleString('en-US', { timeZone: tz, weekday: 'long' }); }) : null;

  return {
    windowDays: LOOKBACK_DAYS,
    totals: totals && totals.metrics,
    metricsUpdatedAt: totals && totals.metricsUpdatedAt,
    channels: perChannel,
    postsSent: posts.length,
    postsMeasured: withMetrics.length,
    topPosts: withMetrics.slice().sort(function (a, b) { return b.engagement - a.engagement; }).slice(0, 8)
      .map(function (p) { delete p.hasMetrics; return p; }),
    bestHour: bestHour, bestDay: bestDay,
    warnings: warnings
  };
}

// The newsroom's best-performing recent posts on each platform, as style
// examples for the Draft social button: top 3 per network by interactions
// over the last 30 days, measured posts only.
async function topExamples(apiKey, organizationId) {
  var posts = await getSentPosts(apiKey, organizationId, dayStartIso(LOOKBACK_DAYS * 86400000));
  var byService = {};
  posts.forEach(function (p) {
    if (!p.metrics || !p.metrics.length || !p.text) return;
    var m = metricsMap(p.metrics);
    (byService[p.channelService] = byService[p.channelService] || []).push({ text: String(p.text).trim().slice(0, 600), interactions: engagementOf(m), metrics: m });
  });
  Object.keys(byService).forEach(function (k) {
    byService[k] = byService[k].sort(function (a, b) { return b.interactions - a.interactions; }).slice(0, 3);
  });
  return byService;
}

module.exports = { topExamples: topExamples, getOrganizations: getOrganizations, getChannels: getChannels, getSentPosts: getSentPosts, metricsMap: metricsMap, fetchSummary: fetchSummary, engagementOf: engagementOf };
