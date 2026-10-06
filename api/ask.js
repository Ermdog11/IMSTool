// POST /api/ask { question } — the Home screen's "Ask CoPublisher" box (Jeff,
// 2026-10-06: "a window to ask a question like is there anything on the
// calendar or how are we doing this week"). Answers from the newsroom's own
// data: the calendar and hot spots, the latest news scan, drafts in progress,
// audience analytics (for roles that can see them), our coverage and the
// roster (api/_writer.js context), plus knowledge-base and web search.
//
// GET -> { suggestions: [...] } (fixed starters; no AI call).

var S = require('./_supabase');
var W = require('./_writer');

// Home's sample questions, a new set each day (api/_daily-questions.js); the
// core ones (weight 4) come up most days.
var SUGGESTIONS = [
  { q: 'What should we publish today?', weight: 4 },
  { q: 'What\'s working for us right now?', weight: 4 },
  { q: 'How did this week go?', weight: 4 },
  { q: 'Is there anything on the calendar this week?', weight: 4 },
  'What drafts are waiting on an edit?',
  'When is our next hot spot?',
  'What did we miss in the news today?',
  'What\'s the biggest story on our beat right now?',
  'Which story should we push on social today?',
  'Who should we be following up with this week?',
  'What should we plan for this weekend?',
  'How does this week compare with last week?'
];

function when(t) {
  return new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

async function latestStories() {
  try {
    var latest = await require('./_latest-scan').load();
    if (!latest || !latest.response) return '';
    var text = (latest.response.content || []).map(function (b) { return b.type === 'text' ? b.text : ''; }).join('\n').replace(/```json|```/g, '');
    var a = text.indexOf('['), b = text.lastIndexOf(']');
    if (a === -1 || b === -1) return '';
    var list = JSON.parse(text.slice(a, b + 1)).filter(function (x) { return !x.republished; })
      .sort(function (x, y) { return (y.rating || 0) - (x.rating || 0); }).slice(0, 15);
    return 'Scanned ' + when(latest.at) + ':\n' + list.map(function (x) { return '- [' + x.rating + '] ' + x.headline + ' (' + (x.source || '') + (x.time ? ', ' + x.time : '') + ')'; }).join('\n');
  } catch (e) { return ''; }
}

async function hotSpots() {
  try {
    var data = await require('./_calendar').load();
    return (data.events || []).filter(function (e) { return e.kind === 'heat' && Date.parse(e.start) > Date.now(); })
      .sort(function (x, y) { return Date.parse(x.start) - Date.parse(y.start); }).slice(0, 6)
      .map(function (e) { return '- ' + when(e.start) + ': ' + (e.title || 'hot spot'); }).join('\n');
  } catch (e) { return ''; }
}

async function draftsInProgress(ctx) {
  try {
    var Drafts = require('./_drafts');
    var idx = await Drafts.loadIndex();
    var list = (idx || []).filter(function (d) { return d.status !== 'published' && (!ctx || !ctx.user || Drafts.canSee(ctx, d)); })
      .sort(function (x, y) { return String(y.updatedAt || '').localeCompare(String(x.updatedAt || '')); }).slice(0, 15);
    return list.map(function (d) { return '- "' + (d.headline || '(no headline)') + '" by ' + (d.writerName || '?') + ', ' + (d.status || 'draft') + ', updated ' + (d.updatedAt ? when(d.updatedAt) : '?'); }).join('\n');
  } catch (e) { return ''; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  var ctx = null;
  if (S.isConfigured()) {
    try { ctx = await S.requireUser(req); }
    catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
  }
  if (req.method === 'GET') return res.status(200).json({ suggestions: require('./_daily-questions').pick(SUGGESTIONS, 4, 'home') });
  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY.' });

  var question = String((req.body && req.body.question) || '').trim().slice(0, 1000);
  if (!question) return res.status(200).json({ error: 'Ask something first.' });

  try {
    var sb = S.isConfigured() ? S.admin() : null;
    var Access = require('./_access');
    var canAnalytics = !ctx || await Access.allowed(ctx, 'mon_analytics');
    var got = await Promise.all([
      W.context(question),
      latestStories(),
      hotSpots(),
      draftsInProgress(ctx),
      canAnalytics && sb && ctx ? require('./_analytics-context').gatherContexts(sb, ctx.site.id, 'all').catch(function () { return []; }) : Promise.resolve([]),
      require('./_beat').getBeat(sb).catch(function () { return {}; })
    ]);
    var beat = got[5] || {};
    var sys = 'You are CoPublisher, the newsroom assistant for ' + (beat.outletName || 'the outlet') + (beat.coverage ? ', which covers ' + beat.coverage : '') + '. ' +
      'Someone on the team asked you a question on the app\'s Home screen. Answer it from the newsroom data below (calendar, hot spots, the latest news scan, drafts, audience analytics, our coverage, the roster), searching our knowledge base or the web only when the data doesn\'t cover it. ' +
      'Never invent numbers, dates or events. If the data doesn\'t answer it, say so plainly and say what would (e.g. "connect Chartbeat under Analytics"). ' +
      'Keep it short and easy to read on a phone: a one-sentence bottom line in **bold**, then at most 4 short "- " bullets, and a "**Do next:**" line only if there is a clear action. Under 150 words. Blank lines between parts.\n\n' +
      W.rules() +
      '\n\nNEWSROOM DATA:\n' + got[0] +
      '\n\nHOT SPOTS (best times to publish this week, from our own numbers):\n' + (got[2] || '(none ahead)') +
      '\n\nLATEST NEWS SCAN (rating 1-5):\n' + (got[1] || '(no scan stored)') +
      '\n\nDRAFTS IN PROGRESS:\n' + (got[3] || '(none)') +
      '\n\nAUDIENCE ANALYTICS:\n' + (got[4] && got[4].length ? JSON.stringify(got[4]).slice(0, 30000) : (canAnalytics ? '(no analytics sources connected yet)' : '(this person\'s role can\'t see analytics)'));
    var loop = await W.runAgenticLoop(key, sys, question, [W.KB_SEARCH_TOOL, W.webSearchTool(2)], null, 4, 1500);
    if (loop.error) return res.status(200).json({ error: 'Claude error: ' + (loop.error.message || JSON.stringify(loop.error)) });
    var answer = (loop.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('\n').trim();
    if (!answer) return res.status(200).json({ error: 'No answer came back. Try asking another way.' });
    return res.status(200).json({ answer: answer });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

// Per-newsroom: this request runs as the signed-in person's newsroom (_site.js).
module.exports = require('./_site').wrap(module.exports);
