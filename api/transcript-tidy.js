// /api/transcript-tidy: where a transcript's paragraphs should break (Jeff,
// 2026-10-06: "the writing in the transcription tool has very poor logic.
// Can it have the same logic as the content editor?"). Paragraphs used to be
// cut every 3-4 sentences by count, often mid-thought. Claude reads the
// numbered sentences and returns only the sentence numbers that should start
// a new paragraph (a new question, a new topic, a new speaker). It never
// returns or rewrites text, so every quote stays word for word.
//   POST { sentences: [{ s: speaker|null, t: text }] } -> { breaks: [indexes] }
// Same access as Transcribe (tab_transcribe). Fails open without Supabase.
var S = require('./_supabase');

var CHUNK = 300;
var TOOL = {
  name: 'paragraph_breaks',
  description: 'The sentence numbers that start a new paragraph.',
  input_schema: { type: 'object', properties: { starts: { type: 'array', items: { type: 'integer' }, description: 'Numbers of the sentences that begin a new paragraph, in order.' } }, required: ['starts'] }
};

async function chunkBreaks(key, list, offset) {
  var lines = list.map(function (x, i) { return '[' + (offset + i) + ']' + (x.s != null ? ' (' + x.s + ')' : '') + ' ' + String(x.t || '').slice(0, 600); }).join('\n');
  var r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6', max_tokens: 1500, tools: [TOOL], tool_choice: { type: 'tool', name: TOOL.name },
      messages: [{ role: 'user', content: ('Below are the numbered sentences of a transcript (a press conference, interview or podcast), with the speaker in parentheses when known. Split it into paragraphs the way a good newspaper editor would lay out a Q&A or a quote sheet:\n' +
        '- Start a new paragraph when the speaker changes, when a new question is asked, or when the speaker moves to a new subject.\n' +
        '- Keep a single thought together, including a short answer and its follow-up sentence. Never split in the middle of an idea.\n' +
        '- Paragraphs are usually 2-5 sentences; never more than 7.\n' +
        '- Do not change any text. Return only the numbers of the sentences that start a paragraph (include ' + offset + ').\n\n' + lines + '\n\nCall paragraph_breaks.').toWellFormed() }]
    })
  });
  var d = await r.json();
  if (d.error) throw new Error(d.error.message || 'Claude error');
  var t = ((d.content || []).filter(function (b) { return b.type === 'tool_use'; })[0] || {}).input || {};
  var starts = (t.starts || []).filter(function (n) { return Number.isInteger(n) && n >= offset && n < offset + list.length; });
  // Nothing usable (or one huge paragraph): treat as failed, use the fallback.
  if (!starts.length || (list.length > 12 && starts.length < list.length / 12)) return null;
  return starts;
}

module.exports = async function handler(req, res) {
  if (S.isConfigured()) {
    try {
      var ctx = await S.requireUser(req);
      if (!(await require('./_access').allowed(ctx, 'tab_transcribe'))) return res.status(403).json({ error: 'Your publisher has turned Transcribe off for your role.' });
    } catch (e) { return res.status(e.status || 401).json({ error: e.message || 'Not signed in' }); }
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(503).json({ error: 'Missing ANTHROPIC_API_KEY' });
  var sents = ((req.body && req.body.sentences) || []).slice(0, 4000);
  if (!sents.length) return res.status(200).json({ breaks: [] });
  try {
    var jobs = [];
    for (var i = 0; i < sents.length; i += CHUNK) jobs.push({ list: sents.slice(i, i + CHUNK), offset: i });
    var out = [];
    for (var j = 0; j < jobs.length; j += 4) {
      var got = await Promise.all(jobs.slice(j, j + 4).map(function (job) { return chunkBreaks(key, job.list, job.offset).catch(function () { return null; }); }));
      got.forEach(function (g, k) {
        var job = jobs[j + k];
        // A chunk that failed falls back to a break every 4 sentences.
        if (!g) { for (var n = job.offset; n < job.offset + job.list.length; n += 4) out.push(n); } else out = out.concat(g);
      });
    }
    // A new speaker always starts a paragraph.
    sents.forEach(function (x, n) { if (n === 0 || (x.s != null && sents[n - 1].s !== x.s)) out.push(n); });
    out = Array.from(new Set(out)).sort(function (a, b) { return a - b; });
    return res.status(200).json({ breaks: out });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

// Per-newsroom: this request runs as the signed-in person's newsroom (_site.js).
module.exports = require('./_site').wrap(module.exports);
