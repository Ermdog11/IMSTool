// Extra fact-check (Jeff, 2026-10-06: "checkbox for 'Extra fact-check'
// should be available where needed").
//
// A deeper pass than Copydesk's own "questions to resolve" (which only flags
// things it has a reason to doubt): this pulls out every checkable claim in
// the article (names, positions, schools, stats, scores, dates, records,
// star ratings, quotes' speakers) and checks each one with live web search
// and the newsroom's own past coverage. Opinion and analysis are skipped.
// Each claim comes back confirmed / conflict / unverified with the source.
//
// Costs more than a plain edit (several searches per article), so it's an
// opt-in checkbox: Copydesk's "Add with this edit" row, From social, and a
// button on any open draft (emailed-in drafts included). Used by
// api/fact-check.js.

var B = require('./_beat.js');

var TOOL = {
  name: 'submit_fact_check',
  description: 'Report every checkable factual claim in the article and whether reliable sources confirm it.',
  input_schema: {
    type: 'object',
    properties: {
      claims: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            claim: { type: 'string', description: 'The claim as the article states it, short.' },
            status: { type: 'string', enum: ['confirmed', 'conflict', 'unverified'] },
            detail: { type: 'string', description: 'confirmed: what confirms it. conflict: what the sources say instead. unverified: why it could not be checked. One sentence.' },
            source: { type: 'string', description: 'Outlet or page name of the best source, or empty.' },
            url: { type: 'string', description: 'URL of that source, or empty.' }
          },
          required: ['claim', 'status', 'detail', 'source', 'url']
        }
      },
      summary: { type: 'string', description: 'One sentence: how the article holds up.' }
    },
    required: ['claims', 'summary']
  }
};

function plain(article) {
  return String(article || '')
    .replace(/<\/(p|div|h\d|li|blockquote)>/gi, '\n\n').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, 14000);
}

// article: Markdown, HTML or plain text. Returns { claims, summary } or throws.
async function factCheck(article, headline, sb) {
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Missing ANTHROPIC_API_KEY.');
  var text = plain(article);
  if (text.length < 40) throw new Error('No article text to check.');
  var beat = await B.getBeat(sb || null);
  var CE = require('./copyedit.js');
  var today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  var system = 'You fact-check sports articles for ' + beat.outletName + ', which covers ' + beat.coverage + ', before they publish. Today is ' + today + '.';
  var user =
    'Fact-check this article.\n\n' +
    '1. List every checkable factual claim: names and their spelling, positions, schools and hometowns, class years, star ratings and rankings, stats, scores, records, dates, transactions (commits, transfers, hires), and who said a quote. Skip the writer\'s opinions, predictions and analysis.\n' +
    '2. Check each one. Use web_search for current facts (prefer official athletics sites, the recruiting services, ESPN, AP, major outlets) and search_knowledge_base for what this outlet already reported. Group related claims into one search where you can; you have a limited number of searches, so spend them on the claims most likely to be wrong or most damaging if wrong.\n' +
    '3. Mark each claim confirmed (a reliable source agrees), conflict (a reliable source says something different: say what), or unverified (nothing found either way). Never mark something confirmed from memory alone.\n' +
    '4. Call submit_fact_check with every claim, conflicts first.\n\n' +
    (headline ? 'HEADLINE: ' + headline + '\n\n' : '') + 'ARTICLE:\n' + text;

  var tools = [Object.assign({}, CE.WEB_SEARCH_TOOL, { max_uses: 8 }), CE.KB_SEARCH_TOOL, TOOL];
  var messages = [{ role: 'user', content: user.toWellFormed() }];
  for (var round = 0; round < 6; round++) {
    var r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 6000, system: system, tools: tools, messages: messages })
    });
    var d = await r.json();
    if (d.error) throw new Error('Claude error: ' + (d.error.message || JSON.stringify(d.error)));
    var content = d.content || [];
    var done = content.filter(function (b) { return b.type === 'tool_use' && b.name === TOOL.name; })[0];
    if (done) {
      var claims = (done.input.claims || []).slice(0, 40);
      var order = { conflict: 0, unverified: 1, confirmed: 2 };
      claims.sort(function (a, b) { return (order[a.status] || 0) - (order[b.status] || 0); });
      return { claims: claims, summary: done.input.summary || '', checkedAt: new Date().toISOString() };
    }
    messages.push({ role: 'assistant', content: content });
    var kb = content.filter(function (b) { return b.type === 'tool_use' && b.name === 'search_knowledge_base'; });
    if (kb.length) {
      var results = await Promise.all(kb.map(function (u) { return CE.searchKnowledgeBase(u.input && u.input.query); }));
      messages.push({ role: 'user', content: kb.map(function (u, i) { return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(results[i]) }; }) });
    } else if (d.stop_reason !== 'pause_turn') {
      // It answered in text without the tool: ask for the tool call.
      messages.push({ role: 'user', content: 'Now call submit_fact_check with your results.' });
    }
  }
  throw new Error('The fact-check did not finish. Try again.');
}

// "Verify before publishing" lines for a draft's factsToCheck.
function toFactsToCheck(result) {
  return (result.claims || []).filter(function (c) { return c.status === 'conflict'; }).map(function (c) {
    return 'Fact-check conflict: ' + c.claim + (c.detail ? ' (' + c.detail + ')' : '');
  });
}

module.exports = { factCheck: factCheck, toFactsToCheck: toFactsToCheck };
