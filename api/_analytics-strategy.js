// Holistic content and social strategy (Jeff, 2026-10-06: "I want all of the
// analytics to be studied and compared and analyzed so the app can provide
// holistic data and suggestions as it relates to content/social media
// strategy and overlap").
//
// The 3-hourly Overall summary (analytics-snapshot.js) reads each source's
// current numbers. This goes further, once a day: it lines the sources up
// against each other and against what we published, to answer
//   - what each channel is for: site, Google search, X, Facebook/Instagram
//     (Buffer, Meta), YouTube; who it reaches and what wins there
//   - overlap: topics and stories that win on several channels at once
//     (the audience follows them everywhere) vs. ones that win on only one
//   - gaps: a story that pulled site readers but was never posted to
//     social; Google searches with demand and no story of ours; a video
//     that did well with no story behind it, or a big story with no video
//   - timing per channel, and formats (Shorts vs long video, threads, etc.)
//   - concrete moves for this week, each tied to the numbers
// Inputs: every connected source (_analytics-context.js gatherContexts,
// YouTube included), 30 days of site top pages from the Chartbeat
// snapshots, and our own headlines from the knowledge base. One Claude call
// (forced tool use); saved as an analytics snapshot of source 'strategy'.

var Store = require('./_analytics-store');
var Context = require('./_analytics-context');
var Beat = require('./_beat');

var TOOL = {
  name: 'submit_strategy',
  description: 'The cross-channel content and social strategy read.',
  input_schema: {
    type: 'object',
    properties: {
      overview: { type: 'string', description: '3-5 plain sentences: the big picture across every channel, with the key numbers.' },
      channels: {
        type: 'array', description: 'One per connected channel.',
        items: { type: 'object', properties: {
          channel: { type: 'string' },
          role: { type: 'string', description: 'What this channel does for us and who it reaches, in one sentence.' },
          wins: { type: 'string', description: 'What kind of story or post wins here, with the evidence.' },
          bestTime: { type: 'string', description: 'Best day/time to publish or post here, if the data shows one; else empty.' }
        }, required: ['channel', 'role', 'wins', 'bestTime'] }
      },
      overlap: {
        type: 'array', description: 'Topics/stories that won on two or more channels, and ones that only won on one.',
        items: { type: 'object', properties: {
          topic: { type: 'string' },
          channels: { type: 'array', items: { type: 'string' } },
          read: { type: 'string', description: 'What it tells us (e.g. the audience follows this everywhere / only search cares).' }
        }, required: ['topic', 'channels', 'read'] }
      },
      gaps: {
        type: 'array', description: 'Missed connections between channels.',
        items: { type: 'object', properties: {
          gap: { type: 'string', description: 'e.g. "Top site story never posted to X", "Search demand with no story", "Big story, no video".' },
          evidence: { type: 'string' },
          action: { type: 'string' }
        }, required: ['gap', 'evidence', 'action'] }
      },
      actions: {
        type: 'array', minItems: 3, maxItems: 6, description: 'The moves for this week, most valuable first.',
        items: { type: 'object', properties: {
          title: { type: 'string', description: 'Imperative, under 14 words.' },
          why: { type: 'string', description: 'The numbers behind it.' },
          channels: { type: 'array', items: { type: 'string' } }
        }, required: ['title', 'why', 'channels'] }
      }
    },
    required: ['overview', 'channels', 'overlap', 'gaps', 'actions']
  }
};

// 30 days of Chartbeat top pages, summed per story.
async function siteTopPages(sb, siteId) {
  try {
    var snaps = await Store.listSnapshots(sb, siteId, 'chartbeat', new Date(Date.now() - 30 * 86400000).toISOString());
    var by = {};
    snaps.forEach(function (s) {
      ((s.metrics && s.metrics.pages) || []).forEach(function (p) {
        var k = p.title || p.path; if (!k) return;
        var e = by[k] = by[k] || { title: p.title, path: p.path, readers: 0, readings: 0, peak: 0, fromSearch: 0, fromSocial: 0 };
        e.readers += p.visits || 0; e.readings++; e.peak = Math.max(e.peak, p.visits || 0);
        if (p.sources) { e.fromSearch += p.sources.search || 0; e.fromSocial += p.sources.social || 0; }
      });
    });
    return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return b.readers - a.readers; }).slice(0, 25);
  } catch (e) { return []; }
}

async function ourHeadlines(sb, siteId) {
  try {
    var q = await sb.from('content_items').select('headline, writer_name, created_at, url').eq('site_id', siteId)
      .gte('created_at', new Date(Date.now() - 30 * 86400000).toISOString()).order('created_at', { ascending: false }).limit(120);
    return (q.data || []).filter(function (r) { return r.headline && !/^AI\b/.test(r.writer_name || ''); })
      .map(function (r) { return String(r.created_at).slice(0, 10) + ' ' + r.headline; });
  } catch (e) { return []; }
}

async function run(sb, siteId) {
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Missing ANTHROPIC_API_KEY.');
  var contexts = await Context.gatherContexts(sb, siteId, 'all');
  if (!contexts.length) return { ready: false, note: 'Connect at least one analytics source first.' };
  var beat = await Beat.getBeat(sb);
  var pages = await siteTopPages(sb, siteId), heads = await ourHeadlines(sb, siteId);
  var data = JSON.stringify({ sources: contexts, siteTopPagesLast30Days: pages }).slice(0, 90000);
  var prompt = 'You are the audience and social strategy lead for ' + beat.outletName + ', which covers ' + beat.coverage + '. ' +
    'Study ALL of the analytics below together, not one source at a time: compare channels, find where the same topics and stories win across channels (overlap) and where they don\'t, and find the missed connections between channels (gaps). ' +
    'Then give the strategy: what each channel is for, what wins where, when to post where, and the most valuable moves for this week. ' +
    'Every claim must point to a number in the data. Never invent numbers. If a source is missing or thin, work with what is there and say so briefly in the overview.\n\n' +
    'OUR STORIES, LAST 30 DAYS (date, headline):\n' + (heads.join('\n') || '(none in the knowledge base)') + '\n\n' +
    'ANALYTICS (JSON):\n' + data + '\n\nCall submit_strategy.';
  var r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 4000, tools: [TOOL], tool_choice: { type: 'tool', name: TOOL.name }, messages: [{ role: 'user', content: prompt.toWellFormed() }] })
  });
  var d = await r.json();
  if (d.error) throw new Error('Strategy: ' + (d.error.message || JSON.stringify(d.error)));
  var out = ((d.content || []).filter(function (b) { return b.type === 'tool_use'; })[0] || {}).input || {};
  var result = {
    overview: String(out.overview || ''), channels: out.channels || [], overlap: out.overlap || [], gaps: out.gaps || [], actions: out.actions || [],
    sources: contexts.map(function (c) { return c.source; })
  };
  await Store.saveSnapshot(sb, siteId, 'strategy', result);
  return Object.assign({ ready: true, generatedAt: new Date().toISOString() }, result);
}

async function latest(sb, siteId) {
  var rows = await Store.listSnapshots(sb, siteId, 'strategy', new Date(Date.now() - 8 * 86400000).toISOString());
  if (!rows.length) return { ready: false };
  var l = rows[rows.length - 1];
  return Object.assign({ ready: true, generatedAt: l.captured_at }, l.metrics || {});
}

module.exports = { run: run, latest: latest };
