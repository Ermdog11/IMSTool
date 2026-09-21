// Copydesk: takes a staff writer's draft and returns it rewritten in the site's house
// style, preserving the writer's voice (via their style profile), with helpful context
// added (flagged for verification) and internal links to related published articles.
//
// mode 'edit' (default): full rewrite in house style + voice, links inserted.
// mode 'keep':           prose returned verbatim; everything else comes back as suggestions.
// mode 'links':          prose returned verbatim, like 'keep' — but hotlinks ARE inserted directly
//                         (nothing else is: no added context, no rewriting).
//
// Output is collected via a forced tool call (structured output) rather than asking the
// model to emit raw JSON in text — the article body is quote- and newline-heavy and the
// raw-JSON approach broke on ~every other draft.

var BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

// Recent InsideMDSports / 247 Maryland articles, for internal linking. Same scrape the
// news monitor uses for its own-outlet blocklist — the landing page loads server-side.
async function relatedArticleIndex() {
  var fresh = [];
  try {
    var c = new AbortController();
    var t = setTimeout(function () { c.abort(); }, 12000);
    var resp = await fetch('https://247sports.com/college/maryland/', {
      headers: { 'User-Agent': BROWSER_UA },
      signal: c.signal
    }).finally(function () { clearTimeout(t); });
    var html = await resp.text();

    var seen = {};
    var re = /\/college\/maryland\/(?:article|longformarticle)\/([a-z0-9-]+)-(\d{6,})/g;
    var m;
    while ((m = re.exec(html)) !== null) {
      var slug = m[1];
      var url = 'https://247sports.com/college/maryland/article/' + slug + '-' + m[2] + '/';
      if (seen[slug]) continue;
      seen[slug] = 1;
      fresh.push({ url: url, headline: slug.replace(/-/g, ' ').replace(/\b\w/g, function (x) { return x.toUpperCase(); }) });
      if (fresh.length >= 30) break;
    }
  } catch (e) { /* fall through to cache */ }

  // The 247 landing page intermittently 406s bot traffic -> zero links that run.
  // Persist the last good scrape to Blob and fall back to it when a scrape is empty.
  try {
    var blob = require('@vercel/blob');
    if (fresh.length >= 5) {
      blob.put('copydesk-related-index.json', JSON.stringify(fresh), {
        access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json'
      }).catch(function () {});
      return fresh;
    }
    var cached = await blob.get('copydesk-related-index.json', { access: 'private', useCache: false }).catch(function () { return null; });
    if (cached && cached.statusCode === 200) {
      var arr = await new Response(cached.stream).json();
      if (Array.isArray(arr) && arr.length) return arr;
    }
  } catch (e) { /* no blob — just use whatever we scraped */ }
  return fresh;
}

// 3 related YouTube videos for a search query. Best-effort — returns [] on any
// failure (no key, quota, network) so the edit result is unaffected.
async function suggestVideos(query) {
  var ytKey = process.env.YOUTUBE_API_KEY;
  query = (query || '').toString().trim();
  if (!ytKey || query.length < 3) return [];
  // Keep the search on the Maryland beat — a bare "outside linebacker" query pulls
  // NFL clips and memes.
  if (!/\b(maryland|terp|terrapin)/i.test(query)) query += ' Maryland Terrapins';
  try {
    var c = new AbortController();
    var t = setTimeout(function () { c.abort(); }, 8000);
    var u = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=3&order=relevance&safeSearch=none' +
      '&q=' + encodeURIComponent(query) + '&key=' + ytKey;
    var data = await fetch(u, { signal: c.signal }).then(function (r) { return r.json(); }).finally(function () { clearTimeout(t); });
    if (data.error || !data.items) return [];
    return data.items.filter(function (i) { return i.id && i.id.videoId; }).map(function (i) {
      var sn = i.snippet || {};
      return {
        title: (sn.title || '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"'),
        channel: sn.channelTitle || '',
        url: 'https://www.youtube.com/watch?v=' + i.id.videoId,
        embed: '<iframe width="560" height="315" src="https://www.youtube.com/embed/' + i.id.videoId + '" frameborder="0" allowfullscreen></iframe>',
        thumbnail: (sn.thumbnails && sn.thumbnails.medium && sn.thumbnails.medium.url) || ''
      };
    });
  } catch (e) { return []; }
}

// Anthropic-executed server tool — Claude runs its own searches and the
// results come back inline in the same response, no extra round trip on
// our end. docs.claude.com/en/docs/agents-and-tools/tool-use/web-search-tool
var WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 };

// Our OWN tool (client-side, not Anthropic-executed) — full-text search over
// this newsroom's own past coverage (2026-09-21, Jeff: give the Content
// Editor "access to search... with the knowledge base added"). The
// ingestion side has been live since 2026-09-11 (every draft save/submit/
// edit upserts a content_items row, api/_knowledge.js) but nothing has
// queried it back out until now. Distinct from web_search: this is for "have
// we already covered this" / consistency / a real internal-link target
// beyond the front-page scrape's ~30 recent items, not current/breaking facts.
var KB_SEARCH_TOOL = {
  name: 'search_knowledge_base',
  description: 'Full-text search over InsideMDSports\' own past published/submitted articles. Use to check whether this site already reported something (for consistency, avoiding contradictions, or finding a real internal link beyond the recent-articles list already given to you) — NOT for current facts or breaking news, use web_search for that.',
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Search terms — a name, topic, or event.' } },
    required: ['query']
  }
};

// Unlike web_search this is OUR tool, so a call to it must be answered with a
// tool_result before Claude can continue — best-effort throughout, same
// fails-open philosophy as every other Supabase read in this codebase: no
// connection or no rows just means "nothing found," never a hard error that
// blocks the edit.
async function searchKnowledgeBase(query, excludeDraftId) {
  query = (query || '').toString().trim().slice(0, 200);
  if (!query) return { error: 'Empty query.' };
  try {
    var S = require('./_supabase');
    if (!S.isConfigured()) return { error: 'Knowledge base not connected.' };
    var sb = S.admin();
    var siteId = await require('./_chat-store').resolveSiteId(sb);
    var got = await sb.from('content_items')
      .select('headline, body, url, published_at, draft_id')
      .eq('site_id', siteId)
      .textSearch('fts', query, { type: 'websearch', config: 'english' })
      .order('created_at', { ascending: false })
      .limit(5);
    if (got.error) return { error: got.error.message };
    var rows = (got.data || []).filter(function (r) { return !excludeDraftId || r.draft_id !== excludeDraftId; });
    if (!rows.length) return { results: [], note: 'No matching past coverage found — this may be new ground for the site.' };
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

// Shared agentic loop: keeps calling Claude, resolving our own
// search_knowledge_base tool calls (web_search resolves server-side inline,
// nothing for us to do there) and feeding results back, until Claude calls
// `finalToolName` or gives up and answers in plain text. Bounded so a model
// that won't stop searching can't loop forever / run up cost.
async function runAgenticLoop(key, systemPrompt, userContent, tools, finalToolName, maxRounds) {
  var messages = [{ role: 'user', content: userContent }];
  var lastContent = [];
  for (var round = 0; round < (maxRounds || 4); round++) {
    var cr = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 8000, system: systemPrompt, tools: tools, messages: messages })
    });
    var cd = await cr.json();
    if (cd.error) return { error: cd.error };

    var content = cd.content || [];
    lastContent = content;
    var finalUse = content.filter(function (b) { return b.type === 'tool_use' && b.name === finalToolName; }).pop();
    if (finalUse) return { input: finalUse.input, content: content };

    var kbUses = content.filter(function (b) { return b.type === 'tool_use' && b.name === 'search_knowledge_base'; });
    if (!kbUses.length) return { content: content }; // no client tool call, no final call — done, caller salvages from text

    var kbResults = await Promise.all(kbUses.map(function (u) { return searchKnowledgeBase(u.input && u.input.query); }));
    messages.push({ role: 'assistant', content: content });
    messages.push({
      role: 'user',
      content: kbUses.map(function (u, i) { return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(kbResults[i]) }; })
    });
  }
  return { content: lastContent };
}

// Conversational follow-up on a piece — either a raw draft still being
// written (stage:'draft', asked from the Copydesk compose box before it's
// been through Copydesk at all) or an already-edited article (the default,
// asked from the result view). The writer/editor asks for a change ("make
// the second graf punchier", "cut the last line") or a question that may
// need current information ("what's Malik Washington's rushing total this
// season?", "any injury news since this was written?") — Claude can search
// the web before answering. Same idea as talking to Claude about a draft,
// but grounded when the question calls for it.
async function handleRefine(res, key, body) {
  var current = (body.refine.current || '').toString().slice(0, 24000);
  var instruction = (body.refine.instruction || '').toString().slice(0, 2000).trim();
  var styleGuide = (body.styleGuide || '').toString().slice(0, 12000);
  var writerName = (body.writerName || 'the writer').toString().slice(0, 80);
  var history = Array.isArray(body.refine.history) ? body.refine.history.slice(-6) : [];
  var isDraftStage = body.refine.stage === 'draft';
  if (!instruction) return res.status(200).json({ error: 'Say what you want changed or ask a question.' });

  var sys = 'You are the copy chief for InsideMDSports, a Maryland Terrapins sports site, working with a writer or editor on ' +
    (isDraftStage ? 'a draft still being written — it may be rough, partial, or even empty so far.' : 'a piece that has already been through a first edit.') +
    (styleGuide ? ('\n\nHOUSE STYLE:\n' + styleGuide) : '');

  var convo = history.map(function (h) { return (h.role === 'user' ? 'EDITOR: ' : 'YOU: ') + h.text; }).join('\n');
  var user =
    (isDraftStage ? 'CURRENT DRAFT (Markdown, may be partial or empty):\n' : 'CURRENT ARTICLE (Markdown):\n') + (current || '(nothing written yet)') + '\n\n' +
    (convo ? 'EARLIER IN THIS CONVERSATION:\n' + convo + '\n\n' : '') +
    'THE EDITOR NOW SAYS:\n' + instruction + '\n\n' +
    'Decide first: is this a CHANGE request or a QUESTION (including "what do you know about X" / background lookups)?\n' +
    'If answering well needs current information you\'re not sure of — a stat line, an injury update, a roster/depth-chart move, this week\'s news, a score — use the web_search tool first. Prefer reputable sports sources (247Sports, ESPN, official Maryland Athletics) and note in the reply when something came from a live search vs. what you already knew. Skip searching for stable facts, or when the article itself already has what you need.\n' +
    'If the question is about whether/how InsideMDSports has covered something before (a prior story, an earlier stance, internal consistency), use search_knowledge_base instead — that is our own archive, not the open web.\n' +
    'If it is a CHANGE: set "changed":true, make ONLY that change (plus anything it directly requires) keeping ' + writerName + '\'s voice and house style, put the FULL updated article in "edited", and a one-line "reply" saying what you did.\n' +
    'If it is a QUESTION: set "changed":false and do NOT fill in "edited" at all (leave it out / empty — do not re-type the article, it wastes time). Answer fully in "reply".\n' +
    'Never invent quotes, stats, or facts when making a change — including a person\'s job title, position, or role (e.g. calling a player a "coach", or guessing which position they play). If a change would require a fact you do not have and can\'t find, say so in "reply" and set "changed":false.\n' +
    'Always finish by calling the respond tool with your final answer — never leave it as plain text, even after searching.';

  var tool = {
    name: 'respond',
    description: 'Return a reply to the editor, and the updated article only if you changed it.',
    input_schema: {
      type: 'object',
      properties: {
        changed: { type: 'boolean', description: 'true only if you are returning a modified article in "edited".' },
        edited: { type: 'string', description: 'Omit or leave empty for a question. Only include this, with the FULL article, when changed is true.' },
        reply: { type: 'string', description: 'One to three sentences: what you changed, or the answer to their question.' }
      },
      required: ['changed', 'reply']
    }
  };

  try {
    // No forced tool_choice — Claude needs the freedom to call web_search
    // (Anthropic-executed, resolves inline) and/or search_knowledge_base
    // (ours — runAgenticLoop answers it and continues the conversation)
    // zero or more times before its final respond call.
    var loopResult = await runAgenticLoop(key, sys, user, [WEB_SEARCH_TOOL, KB_SEARCH_TOOL, tool], 'respond', 4);
    if (loopResult.error) return res.status(200).json({ error: 'Claude error: ' + JSON.stringify(loopResult.error) });

    var content = loopResult.content || [];
    var out = loopResult.input;

    // Claude searched but, contrary to instructions, answered in plain text
    // instead of calling respond — salvage the text rather than erroring.
    if (!out) {
      var txt = content.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('\n').trim();
      if (txt) out = { changed: false, reply: txt };
    }
    if (!out || typeof out.reply !== 'string') return res.status(200).json({ error: 'No usable response — try rephrasing.' });

    var sources = [];
    var seenUrls = {};
    content.forEach(function (b) {
      if (b.type === 'text' && Array.isArray(b.citations)) {
        b.citations.forEach(function (c) {
          if (c.url && !seenUrls[c.url]) { seenUrls[c.url] = 1; sources.push({ url: c.url, title: c.title || c.url }); }
        });
      }
    });

    var changed = !!out.changed && typeof out.edited === 'string' && out.edited.trim().length > 0;
    return res.status(200).json({ edited: changed ? out.edited : current, reply: out.reply || '', changed: changed, sources: sources });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

module.exports = async function handler(req, res) {
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY.' });

  var body = req.body || {};

  if (body.refine) return handleRefine(res, key, body);

  var draft = (body.draft || '').toString().trim();
  if (draft.length < 40) return res.status(200).json({ error: 'Paste a draft to edit.' });

  var styleGuide = (body.styleGuide || '').toString().slice(0, 12000);
  var writerProfile = (body.writerProfile || '').toString().slice(0, 6000);
  var writerName = (body.writerName || 'the writer').toString().slice(0, 80);
  var HL_STYLES = {
    mixed:     'THREE options, one of each voice: (1) Straight news — clear, factual, names the subject; (2) Punchy — sharper, more voice, still accurate, no clickbait; (3) SEO-first — leads with the terms a reader would search (name + Maryland + topic).',
    straight:  'THREE straight-news headlines — clear, factual, each names the subject. Vary the angle and what leads.',
    punchy:    'THREE punchy headlines — sharper, more voice and rhythm, still fully accurate. No clickbait, no fake stakes.',
    curiosity: 'THREE curiosity / mystery headlines — open a genuine information gap that makes a reader want to click. The gap MUST be real and the article MUST pay it off; never imply something the piece does not deliver, never mislead.',
    fun:       'THREE fun / playful headlines — wordplay, lightness, a wink. Still clear about who and what the story is about.',
    seo:       'THREE SEO-first headlines — lead with the key search terms (player/coach name + Maryland + the topic). Aim under 60 characters.'
  };
  var headlineStyle = (body.headline === false || body.headlineStyle === 'none') ? 'none'
    : (HL_STYLES[body.headlineStyle] ? body.headlineStyle
      : (body.headlineStyle == null && body.headline === false ? 'none' : 'mixed'));
  var wantHeadline = headlineStyle !== 'none';
  var headlineInstruction = wantHeadline
    ? '- "headlines": ' + HL_STYLES[headlineStyle] + ' Every one publishable, accurate, in house style, and under ~90 characters. They must be genuinely different from each other, not the same headline reworded. Set each item\'s "label" to a 1-3 word tag for that option.\n'
    : '- Leave "headlines" empty.\n';
  var mode = (body.mode === 'keep' || body.mode === 'links') ? body.mode : 'edit';

  var related = await relatedArticleIndex();
  var relatedList = related.map(function (r, i) { return (i + 1) + '. ' + r.headline + '  ->  ' + r.url; }).join('\n');

  var sys =
    'You are the copy chief for InsideMDSports, a Maryland Terrapins sports site. You edit staff drafts to publish-ready quality.\n\n' +
    '=== HOUSE STYLE GUIDE ===\n' + (styleGuide || '(No house style guide provided — apply standard clean sports-news style: AP style, active voice, tight sentences, attribute claims, no cliches.)') +
    (writerProfile ? ('\n\n=== THIS WRITER\'S STYLE PROFILE (' + writerName + ') — preserve this voice ===\n' + writerProfile) : '');

  var factsRule =
    '- factsToCheck is a SHORT list. Add an item ONLY when you have a specific reason to believe something the writer wrote is likely wrong or misleading to readers — an internal contradiction, a date / number / name that does not look right, a claim that overstates or misrepresents what actually happened — OR a spot where the draft trails off or is missing a word or number it needs. Phrase each one as a question the editor can quickly answer. If a claim is just something you cannot personally confirm but have no real reason to doubt, leave it out. A clean draft should produce zero or one item, not five.\n' +
    '- Attribution questions are for objective claims of fact only (scores, injuries, quotes, statistics, transactions). Do NOT flag the writer\'s own opinion, analysis, or subjective read — that\'s their voice.\n';

  var linkRule = mode === 'keep'
    ? '- Do NOT change the text or insert links. Put internal-link ideas in relatedSuggestions: 2-5 of the related articles below that genuinely relate, each with the phrase in the draft it would sit near. Do not force it. If the RELATED ARTICLES list below has nothing strong, try search_knowledge_base for older coverage on the same person/topic before giving up on a suggestion.\n'
    : '- Insert Markdown links to related InsideMDSports articles from the list below. Aim for 2-4 links unless the list genuinely has nothing connected to this story (a recruiting story links to other recruiting coverage; a game story to the preview or a player feature; a coaching story to earlier staff news). Attach each link to a real phrase, do not link the same article twice, and do not invent URLs — use only the list, or a search_knowledge_base result that has a real (non-null) url — a knowledge-base hit with no url is still useful for context/consistency but is never a link target. Leave relatedSuggestions empty.\n';

  var researchRule =
    '- You have two research tools. search_knowledge_base checks InsideMDSports\' OWN past coverage — use it to avoid contradicting or flatly re-explaining something already reported, and to find a stronger internal link than the recent-articles list below when it falls short. web_search checks the open web for CURRENT facts you are not sure of (a stat, an injury status, a score) — do not invent instead of checking when a quick search would settle it. Use either zero or more times before calling submit_copyedit; do not mention "I searched" in the output, just use what you found.\n';

  var user;
  if (mode === 'links') {
    user =
      'The writer wants their copy left completely ALONE — the ONLY change you make is inserting internal hotlinks. Do NOT rewrite, tighten, restructure, or add context. Call the submit_copyedit tool with:\n' +
      '- "edited": the writer\'s draft returned essentially verbatim, as Markdown, with hotlinks inserted per the rule below. ONLY unambiguous typo / misspelling / obvious punctuation-slip fixes are otherwise allowed. No style changes, no restructuring, no word swaps, no tightening, no added or removed sentences, no added context.\n' +
      '- Do NOT invent quotes, statistics, dates, scores, or outcomes.\n' +
      '- TRUST THE WRITER ON FACTS by default — a professional beat reporter.\n' +
      factsRule + linkRule + researchRule +
      '- "notes": leave empty — nothing was edited besides hotlinks.\n' +
      '- "addedContext": leave empty — nothing was added.\n' +
      headlineInstruction +
      '\nRELATED ARTICLES:\n' + (relatedList || '(none available this run)') + '\n\nDRAFT:\n' + draft;
  } else if (mode === 'keep') {
    user =
      'The writer wants their copy left ALONE. Do NOT rewrite it. Review it and return suggestions they can choose to apply. Call the submit_copyedit tool with:\n' +
      '- "edited": the writer\'s draft returned essentially verbatim, as Markdown. ONLY unambiguous typo / misspelling / obvious punctuation-slip fixes are allowed. No style changes, no restructuring, no word swaps, no tightening, no added or removed sentences.\n' +
      '- Do NOT invent quotes, statistics, dates, scores, or outcomes.\n' +
      '- Do NOT invent or guess a person\'s job title, position, or role (e.g. calling a player a "coach", or guessing which position they play) when adding context — if you are not certain, either leave it out or prefix it "[VERIFY]".\n' +
      '- TRUST THE WRITER ON FACTS by default — a professional beat reporter.\n' +
      factsRule + linkRule + researchRule +
      '- "notes": briefly, what a full house-style edit WOULD change (a few bullets), so they can decide.\n' +
      '- "addedContext": context a general reader might need that the draft assumes, as standalone suggested sentences — NOT inserted. Prefix "[VERIFY]" on any you are unsure of.\n' +
      headlineInstruction +
      '\nRELATED ARTICLES:\n' + (relatedList || '(none available this run)') + '\n\nDRAFT:\n' + draft;
  } else {
    user =
      'Edit the draft below and call the submit_copyedit tool.\n' +
      '- Rewrite it in the house style above, but KEEP ' + writerName + '\'s voice and structural habits. You are polishing them, not replacing them.\n' +
      '- Fix grammar, AP style, attribution, flabby sentences, cliches, and structure.\n' +
      '- Vary paragraph rhythm: a one-sentence paragraph is fine on its own, but never stack two or more of them back to back. If the draft has a run of one-liners, combine some or add a sentence so at least every other paragraph runs 2-4 sentences.\n' +
      '- Where the draft assumes context a general reader lacks, ADD a brief clause or sentence. Prefix ONLY context YOU added with "[VERIFY]" when unsure. Never attach [VERIFY] to something the writer already wrote.\n' +
      '- Do NOT invent quotes, statistics, dates, scores, or outcomes.\n' +
      '- Do NOT invent or guess a person\'s job title, position, or role (e.g. calling a player a "coach", or guessing which position they play) when adding context — if you are not certain, either leave it out or prefix it "[VERIFY]".\n' +
      '- TRUST THE WRITER ON FACTS by default. Do not build a checklist out of routine facts they stated confidently.\n' +
      factsRule + linkRule + researchRule +
      '- "edited": the full edited article as Markdown, with the internal links in place.\n' +
      '- "notes": short bullets on what you changed and why.\n' +
      '- "addedContext": each clause/sentence of context you added, with its [VERIFY] flag if applicable.\n' +
      headlineInstruction +
      '\nRELATED ARTICLES (for internal links):\n' + (relatedList || '(none available this run)') + '\n\nDRAFT:\n' + draft;
  }

  var tool = {
    name: 'submit_copyedit',
    description: 'Return the copyedited draft and review notes.',
    input_schema: {
      type: 'object',
      properties: {
        edited: { type: 'string', description: 'The article as Markdown.' },
        notes: { type: 'array', items: { type: 'string' } },
        addedContext: { type: 'array', items: { type: 'string' } },
        factsToCheck: { type: 'array', items: { type: 'string' } },
        headlines: {
          type: 'array',
          items: {
            type: 'object',
            properties: { label: { type: 'string' }, text: { type: 'string' } },
            required: ['label', 'text']
          }
        },
        relatedSuggestions: {
          type: 'array',
          items: {
            type: 'object',
            properties: { phrase: { type: 'string' }, headline: { type: 'string' }, url: { type: 'string' } },
            required: ['phrase', 'url']
          }
        },
        seo: {
          type: 'object',
          description: 'Search-optimisation help for this article.',
          properties: {
            metaDescription: { type: 'string', description: '150-160 chars, leads with the key terms, reads like a sentence, no clickbait.' },
            slug: { type: 'string', description: 'URL slug: lowercase, hyphenated, 3-6 words, the key names + topic. No stop words.' },
            primaryKeyword: { type: 'string', description: 'The single phrase a reader would search to find this story.' },
            secondaryKeywords: { type: 'array', items: { type: 'string' }, description: '3-5 related search phrases the piece also covers.' },
            schemaType: { type: 'string', description: 'Best schema.org type: usually "NewsArticle"; "SportsEvent" for a game preview/recap.' },
            checks: { type: 'array', items: { type: 'string' }, description: 'Quick SEO fixes for THIS draft only if they apply — e.g. "The primary keyword isn\'t in the first sentence", "Headline runs over 60 characters", "No subheads in a 900-word piece". Empty if the draft is already fine.' }
          },
          required: ['metaDescription', 'slug', 'primaryKeyword', 'secondaryKeywords', 'schemaType', 'checks']
        }
      },
      required: ['edited', 'notes', 'addedContext', 'factsToCheck', 'seo']
    }
  };

  try {
    // No forced tool_choice (2026-09-21) — used to force submit_copyedit
    // immediately, which left no room for Claude to search first. Now gives
    // it web_search + search_knowledge_base to use zero or more times before
    // the final submit_copyedit call; runAgenticLoop answers our own
    // search_knowledge_base calls and continues the conversation
    // (web_search resolves inline, nothing for us to do there).
    var loopResult = await runAgenticLoop(key, sys, user, [WEB_SEARCH_TOOL, KB_SEARCH_TOOL, tool], 'submit_copyedit', 4);
    if (loopResult.error) return res.status(200).json({ error: 'Claude error: ' + JSON.stringify(loopResult.error) });

    var parsed = loopResult.input;

    // Fallback: some responses still land as text JSON — salvage it.
    if (!parsed) {
      var txt = (loopResult.content || []).map(function (i) { return i.type === 'text' ? i.text : ''; }).join('\n');
      var s = txt.indexOf('{'), e = txt.lastIndexOf('}');
      if (s !== -1 && e !== -1) { try { parsed = JSON.parse(txt.slice(s, e + 1)); } catch (x) {} }
    }
    if (!parsed || typeof parsed.edited !== 'string') {
      return res.status(200).json({ error: 'The editor did not return a usable result. Try again.' });
    }

    parsed.notes = parsed.notes || [];
    parsed.addedContext = parsed.addedContext || [];
    parsed.factsToCheck = parsed.factsToCheck || [];
    if (!wantHeadline) delete parsed.headlines;
    parsed.relatedCount = related.length;
    // So the editor can show a hover preview on each inserted hotlink without
    // an extra round-trip — the model only ever links to something in this list.
    parsed.relatedIndex = related.map(function(r) { return { url: r.url, headline: r.headline }; });
    parsed.mode = mode;

    // YouTube video suggestions are DISABLED for now (the shared YouTube API quota
    // is consumed by the news scanner). suggestVideos() + the videoKeywords schema
    // field are kept for when this is revived as a per-publisher video library.
    delete parsed.videoKeywords;
    parsed.videoSuggestions = [];

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// Reused by the Coverage Desk agent.
module.exports.relatedArticleIndex = relatedArticleIndex;
