// /api/analytics-question — POST: the "question box" from FEATURES.md
// ("what's been working best for us this month?") — answers from real
// audience data, not general knowledge. Uses api/_analytics-context.js to
// gather whatever's actually connected (a live reading + recent snapshot
// trends per source) and has Claude answer strictly from that JSON, either
// scoped to one source or across everything connected.

var S = require('./_supabase');
var Context = require('./_analytics-context');

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
  var scope = (body.source === 'chartbeat' || body.source === 'meta' || body.source === 'buffer' || body.source === 'x' || body.source === 'gsc') ? body.source : 'all';
  if (!question) return res.status(200).json({ error: 'Ask something first.' });

  try {
    var contexts = await Context.gatherContexts(ctx.supabase, ctx.site.id, scope);
    if (!contexts.length) {
      return res.status(200).json({ answer: 'Nothing\'s connected yet for ' + (scope === 'all' ? 'any source' : scope) + ' — connect it above first.' });
    }

    var beat = await require('./_beat').getBeat(ctx.supabase);
    var sys = 'You are an audience-analytics analyst for ' + beat.outletName + ', covering ' + beat.coverage + '. ' +
      'Answer the editor\'s question using ONLY the JSON data below — never invent numbers, trends, or claims beyond it. ' +
      'If the data doesn\'t cover what they asked, say so plainly instead of guessing. Be specific and cite real numbers ' +
      'from the data when you have them. Keep it short and easy to scan on a phone (Jeff, 2026-10-03: one big paragraph was too much text): ' +
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
