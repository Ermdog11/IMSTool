// /api/analytics-snapshot — cron: captures a point-in-time reading from each
// connected analytics source and stores it (analytics_snapshots), so the
// Trends view (api/analytics-trends.js) has a real time series to compute
// publish-time/day patterns and recurring top performers from, instead of
// only ever showing "right now" (what api/chartbeat.js's live call does).
// Also regenerates the standing cross-source Overall summary (read by
// api/analytics-summary.js) each run, so viewing it never waits on a live
// Claude call.
//
// Runs across every site (today just the one — insidemdsports), every
// connected source (today chartbeat + meta; parsely/ga4 slot in here once
// they're wired, each contributing their own metrics shape).

var S = require('./_supabase');
var Store = require('./_analytics-store');
var Chartbeat = require('./_chartbeat');
var Meta = require('./_meta');
var Context = require('./_analytics-context');

async function snapshotChartbeat(sb, site, report) {
  var conn = await Store.getConnection(sb, site.id, 'chartbeat');
  if (!conn || !conn.apiKey || !conn.host) {
    report.push({ site: site.slug, source: 'chartbeat', status: 'not-connected' });
    return;
  }
  var live = await Chartbeat.fetchLive(conn.apiKey, conn.host);
  await Store.saveSnapshot(sb, site.id, 'chartbeat', {
    visits: live.visits,
    pages: live.pages.map(function(p) { return { path: p.path, title: p.title, visits: p.visits }; })
  });
  report.push({ site: site.slug, source: 'chartbeat', status: 'captured', visits: live.visits, pages: live.pages.length });
}

async function snapshotMeta(sb, site, report) {
  var conn = await Store.getConnection(sb, site.id, 'meta');
  if (!conn || !conn.pageAccessToken || !conn.pageId) {
    report.push({ site: site.slug, source: 'meta', status: 'not-connected' });
    return;
  }
  var metrics = await Meta.getPageInsights(conn.pageId, conn.pageAccessToken);
  await Store.saveSnapshot(sb, site.id, 'meta', metrics);
  report.push({ site: site.slug, source: 'meta', status: 'captured' });
}

// Standing "what's happening across your audience right now" note (the
// Trends card's Overall section) — same pooled-context approach as the
// question box, but a fixed prompt instead of a typed-in question, cached
// as its own snapshot "source" so the frontend just reads the latest one
// instead of calling Claude on every page load.
async function generateSummary(sb, site, report) {
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) { report.push({ site: site.slug, source: 'summary', status: 'no-api-key' }); return; }

  var contexts = await Context.gatherContexts(sb, site.id, 'all');
  if (!contexts.length) { report.push({ site: site.slug, source: 'summary', status: 'nothing-connected' }); return; }

  var sys = 'You are an audience-analytics analyst for InsideMDSports, a Maryland Terrapins sports site. ' +
    'Look at the data below and call the submit_overview tool with (1) a short standing overview (3-5 sentences, ' +
    'plain text, no markdown, no heading) of what the data shows right now, and (2) 3-5 specific suggestions the ' +
    'newsroom can act on today or this week: when to publish or post, which story or topic to follow up or promote, ' +
    'which traffic source is under-used, what a strong or weak social post suggests. Each suggestion names the ' +
    'number it is based on. Use ONLY the JSON data given, never invent numbers. If a source has "trendsPending" it ' +
    'hasn\'t built up enough history yet for a pattern; don\'t suggest anything that would need it.\n\n' +
    'DATA:\n' + JSON.stringify(contexts, null, 2);

  var tool = {
    name: 'submit_overview',
    description: 'Return the standing overview and suggestions.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '3-5 sentences, plain text, no markdown.' },
        suggestions: {
          type: 'array', minItems: 1, maxItems: 5,
          items: { type: 'object', properties: {
            title: { type: 'string', description: 'The action, imperative, under 12 words.' },
            why: { type: 'string', description: 'One sentence: the number(s) behind it.' }
          }, required: ['title', 'why'] }
        }
      },
      required: ['summary', 'suggestions']
    }
  };

  var cr = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1200, system: sys, tools: [tool], tool_choice: { type: 'tool', name: 'submit_overview' }, messages: [{ role: 'user', content: 'Write the overview and suggestions.' }] })
  });
  var cd = await cr.json();
  if (cd.error) { report.push({ site: site.slug, source: 'summary', status: 'error', error: JSON.stringify(cd.error) }); return; }
  var out = ((cd.content || []).filter(function(b) { return b.type === 'tool_use'; })[0] || {}).input || {};
  var text = String(out.summary || '').trim();
  if (!text) { report.push({ site: site.slug, source: 'summary', status: 'empty-response' }); return; }
  var suggestions = (out.suggestions || []).filter(function(x) { return x && x.title; }).slice(0, 5)
    .map(function(x) { return { title: String(x.title), why: String(x.why || '') }; });

  await Store.saveSnapshot(sb, site.id, 'summary', { text: text, suggestions: suggestions });
  report.push({ site: site.slug, source: 'summary', status: 'captured' });
}

module.exports = async function handler(req, res) {
  try { await require('./_supabase').requireUserOrCron(req, res); }
  catch (authErr) { return res.status(authErr.status || 401).json({ error: authErr.message || 'Not signed in' }); }
  if (!S.isConfigured()) return res.status(503).json({ error: 'Login not configured' });
  var sb = S.admin();
  var report = [];

  var sitesRes = await sb.from('sites').select('id, slug');
  if (sitesRes.error) return res.status(500).json({ error: sitesRes.error.message });

  for (var i = 0; i < (sitesRes.data || []).length; i++) {
    var site = sitesRes.data[i];
    try { await snapshotChartbeat(sb, site, report); }
    catch (e) { report.push({ site: site.slug, source: 'chartbeat', status: 'error', error: e.message }); }

    try { await snapshotMeta(sb, site, report); }
    catch (e) { report.push({ site: site.slug, source: 'meta', status: 'error', error: e.message }); }

    try { await generateSummary(sb, site, report); }
    catch (e) { report.push({ site: site.slug, source: 'summary', status: 'error', error: e.message }); }
  }

  return res.status(200).json({ report: report });
};
