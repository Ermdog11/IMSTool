// Writes a short, publish-ready breaking-news article FROM a rated scan
// alert (headline/summary/source/time) — not editing an existing draft, like
// copyedit.js does, but drafting one from scratch off just those facts.
// Reuses copyedit.js's related-articles scrape for hotlinks so a story
// pointed to from here is never invented.
//
// Used by api/rolling-digest.js the moment a rating-5 story shows up in a
// scan — the whole point is a writer opens the Content Editor to a draft
// that's already 80% done instead of a blank page.

var relatedArticleIndex = require('./copyedit.js').relatedArticleIndex;

var TOOL = {
  name: 'submit_breaking_draft',
  description: 'Return a short breaking-news article drafted from the given facts.',
  input_schema: {
    type: 'object',
    properties: {
      headline: { type: 'string', description: 'Publishable, accurate, under 90 characters.' },
      edited: { type: 'string', description: 'The article as Markdown, 150-300 words, AP style.' },
      notes: { type: 'array', items: { type: 'string' } },
      factsToCheck: {
        type: 'array', items: { type: 'string' },
        description: 'Anything not explicitly given in the source facts that a human must verify before this publishes — this is a fast breaking draft, err on the side of flagging.'
      }
    },
    required: ['headline', 'edited', 'notes', 'factsToCheck']
  }
};

async function generateBreakingDraft(alert, styleGuide) {
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Missing ANTHROPIC_API_KEY');

  var related = await relatedArticleIndex();
  var relatedList = related.map(function(r, i) { return (i + 1) + '. ' + r.headline + '  ->  ' + r.url; }).join('\n');

  var facts =
    'HEADLINE: ' + (alert.headline || '') + '\n' +
    'SUMMARY: ' + (alert.summary || '(none given)') + '\n' +
    'SOURCE: ' + (alert.source || 'unknown') + '\n' +
    'REPORTED: ' + (alert.time || 'unknown') + '\n' +
    'CATEGORY: ' + (alert.category || '') + (alert.url ? '\nSOURCE URL: ' + alert.url : '');

  var sys =
    'You are the copy chief for InsideMDSports, a Maryland Terrapins sports site. A breaking story just ' +
    "hit the scanner. Write a short, clean breaking-news article in the house style below, that a writer can review and send in minutes " +
    "— not the full feature, just the facts reported so far, tightly written.\n\n" +
    '=== HOUSE STYLE GUIDE (write in this voice, not generic wire-copy) ===\n' +
    (styleGuide || '(No house style guide set yet — apply standard clean sports-news style: AP style, active voice, tight sentences, attribute claims, no cliches.)') + '\n\n' +
    '- Use ONLY the facts given below. Do NOT invent quotes, statistics, additional details, or context beyond what is stated.\n' +
    '- Where the source is thin (e.g. just a headline and a source name), keep the piece short rather than padding it with guesses.\n' +
    '- Insert Markdown links to related InsideMDSports coverage from the list below where a phrase genuinely connects — do not force it, and never invent a URL not in the list.\n' +
    '- factsToCheck should flag anything a human needs to verify or add before this goes out (this is a fast draft off a single source, so lean toward flagging, not toward confidence).\n';

  var user = facts + '\n\nRELATED ARTICLES (for internal links):\n' + (relatedList || '(none available this run)');

  var r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6', max_tokens: 2000, system: sys,
      tools: [TOOL], tool_choice: { type: 'tool', name: 'submit_breaking_draft' },
      messages: [{ role: 'user', content: user }]
    })
  });
  var d = await r.json();
  if (d.error) throw new Error('Claude error: ' + JSON.stringify(d.error));

  var toolUse = (d.content || []).filter(function(b) { return b.type === 'tool_use' && b.name === 'submit_breaking_draft'; })[0];
  var parsed = toolUse && toolUse.input;
  if (!parsed || typeof parsed.edited !== 'string') throw new Error('No usable draft returned');

  parsed.notes = parsed.notes || [];
  parsed.factsToCheck = parsed.factsToCheck || [];
  parsed.relatedIndex = related.map(function(r2) { return { url: r2.url, headline: r2.headline }; });
  return parsed;
}

module.exports = { generateBreakingDraft: generateBreakingDraft };
