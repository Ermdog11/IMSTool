// /api/analytics-question — POST: the "question box" from FEATURES.md
// ("what's been working best for us this month?") — answers from real
// audience data, not general knowledge. Uses api/_analytics-context.js to
// gather whatever's actually connected (a live reading + recent snapshot
// trends per source) and has Claude answer strictly from that JSON, either
// scoped to one source or across everything connected.

var S = require('./_supabase');
var Context = require('./_analytics-context');

// Suggested questions (GET): three chips under the question box, changing
// daily (Jeff, 2026-10-03). Two come from an evergreen pool, rotated by the
// date so every day shows a different pair; one or two are written fresh each
// morning from the beat's latest top stories (the shared scan), so they track
// what's happening ("How did our Locksley job-status coverage do on social vs
// the site?"). Cached per day in Blob, so it's one small Claude call a day.
var EVERGREEN = [
  // Questions that ask what the numbers mean or what to do, not what they are:
  // the Analytics tab already shows the numbers (Jeff, 2026-10-06). A new set
  // each day (api/_daily-questions.js); the core ones (weight 4) come up most days.
  { q: 'What should we publish more of, based on what readers want?', weight: 4 },
  { q: 'What\'s working for us right now, and why?', weight: 4 },
  { q: 'How did this week go compared with last week?', weight: 4 },
  'What\'s working on social right now, and why?',
  'Which stories got big traffic but little social promotion?',
  'Which recent stories are worth re-sharing on social today?',
  'What kinds of stories should we stop spending time on?',
  'Which headlines or post styles work best for us, and why?',
  'Where are we losing readers we should be keeping?',
  'What are people searching for that we haven\'t written?',
  'Which platform deserves more of our time this week?',
  'How should we promote our next big story across channels?',
  'What did readers care about this week that we under-covered?',
  'What would grow our audience fastest this month?'
];
var SUGGEST_PATH = 'analytics-question-suggestions-v2.json'; // v2: weighted daily set (2026-10-06)

async function suggestions(sb) {
  var blob = require('./_site-blob');
  var day = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  try {
    var got = await blob.get(SUGGEST_PATH, { access: 'private', useCache: false });
    if (got && got.statusCode === 200) {
      var cached = await new Response(got.stream).json();
      if (cached && cached.day === day && (cached.questions || []).length === 3) return cached;
    }
  } catch (e) { /* regenerate */ }

  var daily = require('./_daily-questions').pick(EVERGREEN, 3, 'analytics', day);
  var pick = daily.slice(0, 2);
  var topical = [];
  try {
    var latest = await require('./_latest-scan').load();
    var text = ((latest && latest.response && latest.response.content) || []).map(function (c) { return c.text || ''; }).join('');
    var stories = JSON.parse(text || '[]').filter(function (a) { return (a.rating || 0) >= 3; })
      .sort(function (a, b) { return (b.rating || 0) - (a.rating || 0); }).slice(0, 8).map(function (a) { return '- ' + a.headline; });
    var beat = await require('./_beat').getBeat(sb);
    if (stories.length && process.env.ANTHROPIC_API_KEY) {
      var tool = { name: 'suggest', description: 'Return the questions.', input_schema: { type: 'object', properties: { questions: { type: 'array', items: { type: 'string' } } }, required: ['questions'] } };
      var r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6', max_tokens: 300, tools: [tool], tool_choice: { type: 'tool', name: 'suggest' },
          messages: [{ role: 'user', content: 'You help the editor of ' + beat.outletName + ' (' + beat.coverage + ') use their audience analytics (site traffic, social posts and engagement, Google search). ' +
            'Write 2 short questions (under 14 words each) the editor could ask their analytics TODAY about the biggest current storylines below, e.g. what readers want next on it, or how to promote it better (ask what to do, not for numbers already on the Analytics tab). ' +
            'Questions only; no facts or numbers in them.\n\nTop current stories:\n' + stories.join('\n') }]
        })
      });
      var d = await r.json();
      var tu = (d.content || []).filter(function (b) { return b.type === 'tool_use'; })[0];
      topical = ((tu && tu.input && tu.input.questions) || []).map(function (q) { return String(q).trim().slice(0, 140); }).filter(Boolean).slice(0, 1);
    }
  } catch (e) { /* evergreen only */ }
  var questions = topical.concat(pick).slice(0, 3);
  if (questions.length < 3) questions.push(daily[2]);
  var out = { day: day, questions: questions };
  try { await blob.put(SUGGEST_PATH, JSON.stringify(out), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' }); } catch (e) {}
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET' && req.query && req.query.suggest) {
    if (S.isConfigured()) {
      try { await S.requireUser(req); } catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
    }
    return res.status(200).json(await suggestions(S.isConfigured() ? S.admin() : null));
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!S.isConfigured()) return res.status(503).json({ error: 'Login not configured' });
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY.' });

  var ctx;
  try { ctx = await S.requireUser(req); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
  if (!(await require('./_access').allowed(ctx, 'mon_analytics'))) return require('./_access').deny(res);

  var body = req.body || {};
  var question = (body.question || '').toString().trim().slice(0, 1000);
  var scope = (body.source === 'chartbeat' || body.source === 'meta' || body.source === 'buffer' || body.source === 'x' || body.source === 'gsc' || body.source === 'youtube') ? body.source : 'all';
  if (!question) return res.status(200).json({ error: 'Ask something first.' });

  try {
    var contexts = await Context.gatherContexts(ctx.supabase, ctx.site.id, scope);
    if (!contexts.length) {
      return res.status(200).json({ answer: 'Nothing\'s connected yet for ' + (scope === 'all' ? 'any source' : scope) + ' — connect it on the Analytics tab (Connections, at the bottom) first.' });
    }

    var beat = await require('./_beat').getBeat(ctx.supabase);
    var sys = 'You are an audience-analytics analyst for ' + beat.outletName + ', covering ' + beat.coverage + '. ' +
      'Answer the editor\'s question using ONLY the JSON data below — never invent numbers, trends, or claims beyond it. ' +
      'If the data doesn\'t cover what they asked, say so plainly instead of guessing. ' +
      'This box lives on Xs and Os, next to the Analytics tab, which already shows every source\'s raw numbers, top posts, best day and hour, and trends, so don\'t recap them (Jeff, 2026-10-06): say what the numbers mean and what to do, citing only the one or two real numbers that make the point. '  +
      'Keep it short and easy to scan on a phone (Jeff, 2026-10-03: one big paragraph was too much text): ' +
      'start with a one-sentence bottom line in **bold**, then at most 3-4 short points as "- " bullets (one per source or idea, ' +
      'one or two sentences each, only the numbers that matter), and end with one "**Do next:**" line if there is a clear action. ' +
      'Under 150 words total. Use blank lines between parts. ' +
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

// Per-newsroom: this request runs as the signed-in person's newsroom (_site.js).
module.exports = require('./_site').wrap(module.exports);
