// What every tool that writes content gets to know (Jeff, 2026-10-06: "Any
// tool that is creating written content necessarily [needs] access to the
// knowledge base", after an AI draft still had Julian Reese and Derik Queen
// as current players, two years after they left).
//
// One place for it, so a new writing tool can't ship without it:
//   - context(topic): today's date, our own coverage of the topic from the
//     knowledge base, the current roster and staff (Roster watch), recent
//     roster and staff changes, the beat's people and the calendar
//     (groundingText in _breaking-draft.js; no AI calls, each part
//     best-effort)
//   - RULES: the model's memory is out of date; no person, stat or past
//     event that isn't in the material, the context or its research
//   - KB_SEARCH_TOOL + searchKnowledgeBase: full-text search of the whole
//     archive, any date (our own tool, answered here)
//   - WEB_SEARCH_TOOL: current facts from the open web (Anthropic-run)
//   - runAgenticLoop / writeGrounded: call Claude, answer its knowledge-base
//     searches, until it calls the final tool (forced on the last round)

var KB_SEARCH_TOOL = {
  name: 'search_knowledge_base',
  description: 'Full-text search over this newsroom\'s own past published and submitted articles (any date). Use it for background on a person or topic, to check what we have already reported (consistency, no contradictions), and for real internal links. Not for breaking news or this season\'s stats: use web_search for those.',
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Search terms: a name, topic or event.' } },
    required: ['query']
  }
};

function webSearchTool(maxUses) { return { type: 'web_search_20250305', name: 'web_search', max_uses: maxUses || 3 }; }

function today() {
  return new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

// The rules every writer gets, worded for any newsroom (no team names).
function rules() {
  return 'FACTS (these override anything you remember):\n' +
    '- Today is ' + today() + '. Your own memory of rosters, coaching staffs, recruits and seasons is out of date: players have graduated, transferred or turned pro since you were trained.\n' +
    '- Use only facts from the material you are given, the CONTEXT (our knowledge base, current roster and staff, roster changes, beat people, calendar) and what your research tools find. Do not invent quotes, statistics, details or background.\n' +
    '- Never name a player, coach or staff member, and never describe a past season, game or result, unless it appears in that material, context or research. Never call anyone a current or returning player unless the material, the current roster or a search result from this season says so; anyone listed as departed in the roster changes is gone. When unsure, leave it out (and list it in factsToCheck when the tool has one).\n' +
    '- Our own past coverage (the knowledge base, related-article lists) is a record of what was true WHEN IT WAS PUBLISHED. Check every item\'s date: anything from before this season describes the past, not the present. A player an old story calls "returning" may have left since. Never present an old story\'s facts as current, and never link an old story as if it were today\'s news.\n' +
    '- Research before writing when it would help: search_knowledge_base for our own past coverage of a person or topic (any date); web_search, when available, for current facts. Trust only results from this season for anything about who is on the team now.';
}

async function context(topic) {
  try { return await require('./_breaking-draft').groundingText(topic); }
  catch (e) { return 'TODAY: ' + today(); }
}

async function searchKnowledgeBase(query, excludeDraftId) {
  query = (query || '').toString().trim().slice(0, 200);
  if (!query) return { error: 'Empty query.' };
  try {
    var S = require('./_supabase');
    if (!S.isConfigured()) return { error: 'Knowledge base not connected.' };
    var sb = S.admin();
    var siteId = await require('./_site').siteId(sb);
    var got = await sb.from('content_items')
      .select('headline, body, url, published_at, draft_id')
      .eq('site_id', siteId)
      .textSearch('fts', query, { type: 'websearch', config: 'english' })
      .order('created_at', { ascending: false })
      .limit(5);
    if (got.error) return { error: got.error.message };
    var rows = (got.data || []).filter(function (r) { return !excludeDraftId || r.draft_id !== excludeDraftId; });
    if (!rows.length) return { results: [], note: 'No matching past coverage found; this may be new ground for the site.' };
    return {
      results: rows.map(function (r) {
        return {
          headline: r.headline || '(untitled)',
          excerpt: (r.body || '').replace(/\s+/g, ' ').trim().slice(0, 400),
          url: r.url || null,
          publishedAt: r.published_at || null
        };
      })
    };
  } catch (e) {
    return { error: e.message };
  }
}

// Keeps calling Claude, answering our own search_knowledge_base calls
// (web_search resolves server-side inline), until Claude calls
// `finalToolName` or answers in plain text. Bounded so it can't loop forever.
async function runAgenticLoop(key, systemPrompt, userContent, tools, finalToolName, maxRounds, maxTokens) {
  var messages = [{ role: 'user', content: userContent }];
  var lastContent = [];
  for (var round = 0; round < (maxRounds || 4); round++) {
    var cr = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: maxTokens || 8000, system: systemPrompt, tools: tools, messages: messages })
    });
    var cd = await cr.json();
    if (cd.error) return { error: cd.error, messages: messages };

    var content = cd.content || [];
    lastContent = content;
    var finalUse = finalToolName && content.filter(function (b) { return b.type === 'tool_use' && b.name === finalToolName; }).pop();
    if (finalUse) return { input: finalUse.input, content: content, messages: messages };

    var kbUses = content.filter(function (b) { return b.type === 'tool_use' && b.name === 'search_knowledge_base'; });
    if (!kbUses.length) return { content: content, messages: messages.concat([{ role: 'assistant', content: content }]) };

    var kbResults = await Promise.all(kbUses.map(function (u) { return searchKnowledgeBase(u.input && u.input.query); }));
    messages.push({ role: 'assistant', content: content });
    messages.push({
      role: 'user',
      content: kbUses.map(function (u, i) { return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(kbResults[i]) }; })
    });
  }
  return { content: lastContent, messages: messages };
}

// A grounded write that must end in `tool` (forced-tool structured output):
// context + rules in front, knowledge-base search and (optionally) web search
// available, then a forced call to `tool` if Claude didn't get there itself.
// opts: { key, system, topic, content (string or blocks), tool, web (max web
// searches, 0 = none), rounds, maxTokens }. Returns the tool input or throws.
async function writeGrounded(opts) {
  var ctx = await context(opts.topic || '');
  var system = (opts.system || '') + '\n\n' + rules();
  var blocks = typeof opts.content === 'string' ? [{ type: 'text', text: opts.content }] : (opts.content || []).slice();
  blocks.push({ type: 'text', text: '\n\nCONTEXT (from our knowledge base and records; trust it over your memory):\n' + ctx });
  var tools = [KB_SEARCH_TOOL].concat(opts.web ? [webSearchTool(opts.web)] : [], [opts.tool]);
  var got = await runAgenticLoop(opts.key, system, blocks, tools, opts.tool.name, opts.rounds || 4, opts.maxTokens);
  if (got.input) return got.input;
  if (got.error) throw new Error('Claude error: ' + (got.error.message || JSON.stringify(got.error)));
  // It answered in text (or ran out of rounds): one forced call to finish.
  var messages = (got.messages || [{ role: 'user', content: blocks }]).slice();
  if (messages[messages.length - 1].role === 'assistant') messages.push({ role: 'user', content: 'Now call ' + opts.tool.name + ' with the finished result.' });
  var r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': opts.key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: opts.maxTokens || 8000, system: system, tools: [KB_SEARCH_TOOL, opts.tool], tool_choice: { type: 'tool', name: opts.tool.name }, messages: messages })
  });
  var d = await r.json();
  if (d.error) throw new Error('Claude error: ' + (d.error.message || JSON.stringify(d.error)));
  var tu = (d.content || []).filter(function (b) { return b.type === 'tool_use' && b.name === opts.tool.name; })[0];
  if (!tu) throw new Error('No usable result returned');
  return tu.input;
}

module.exports = {
  KB_SEARCH_TOOL: KB_SEARCH_TOOL, webSearchTool: webSearchTool, rules: rules, context: context, today: today,
  searchKnowledgeBase: searchKnowledgeBase, runAgenticLoop: runAgenticLoop, writeGrounded: writeGrounded
};
