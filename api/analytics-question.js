// /api/analytics-question — POST: the "question box" from FEATURES.md
// ("what's been working best for us this month?") — answers from real
// audience data, not general knowledge. Gathers whatever's actually
// connected (a live reading + recent snapshot trends per source) and has
// Claude answer strictly from that JSON, either scoped to one source or
// across everything connected.

var S = require('./_supabase');
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

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!S.isConfigured()) return res.status(503).json({ error: 'Login not configured' });
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY.' });

  var ctx;
  try { ctx = await S.requireUser(req); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message }); }

  var body = req.body || {};
  var question = (body.question || '').toString().trim().slice(0, 1000);
  var scope = (body.source === 'chartbeat' || body.source === 'meta') ? body.source : 'all';
  if (!question) return res.status(200).json({ error: 'Ask something first.' });

  try {
    var contexts = [];
    if (scope === 'all' || scope === 'chartbeat') {
      var cb = await chartbeatContext(ctx.supabase, ctx.site.id);
      if (cb) contexts.push(cb);
    }
    if (scope === 'all' || scope === 'meta') {
      var mt = await metaContext(ctx.supabase, ctx.site.id);
      if (mt) contexts.push(mt);
    }
    if (!contexts.length) {
      return res.status(200).json({ answer: 'Nothing\'s connected yet for ' + (scope === 'all' ? 'any source' : scope) + ' — connect it above first.' });
    }

    var sys = 'You are an audience-analytics analyst for InsideMDSports, a Maryland Terrapins sports site. ' +
      'Answer the editor\'s question using ONLY the JSON data below — never invent numbers, trends, or claims beyond it. ' +
      'If the data doesn\'t cover what they asked, say so plainly instead of guessing. Be specific and cite real numbers ' +
      'from the data when you have them. Keep it conversational and to the point — a few sentences, not a report. ' +
      'A source with "trendsPending" hasn\'t built up enough history yet for time-based patterns; say so if relevant ' +
      'rather than fabricating a trend. A source with "timeOfDayMeaningful": false in its trends only has rolling ' +
      'multi-day totals, not real-time data, so there\'s no meaningful "best time" for it.\n\n' +
      'DATA:\n' + JSON.stringify(contexts, null, 2);

    var cr = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1000, system: sys, messages: [{ role: 'user', content: question }] })
    });
    var cd = await cr.json();
    if (cd.error) return res.status(200).json({ error: 'Claude error: ' + JSON.stringify(cd.error) });
    var answer = (cd.content || []).filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('\n').trim();
    if (!answer) return res.status(200).json({ error: 'No usable response — try rephrasing.' });

    return res.status(200).json({ answer: answer, sourcesUsed: contexts.map(function(c) { return c.source; }) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
