// Copydesk: takes a staff writer's draft and returns it rewritten in the site's house
// style, preserving the writer's voice (via their style profile), with helpful context
// added (flagged for verification) and internal links to related published articles.
//
// mode 'edit' (default): full rewrite in house style + voice, links inserted.
// mode 'keep':           prose returned verbatim; everything else comes back as suggestions.
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

module.exports = async function handler(req, res) {
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY.' });

  var body = req.body || {};
  var draft = (body.draft || '').toString().trim();
  if (draft.length < 40) return res.status(200).json({ error: 'Paste a draft to edit.' });

  var styleGuide = (body.styleGuide || '').toString().slice(0, 12000);
  var writerProfile = (body.writerProfile || '').toString().slice(0, 6000);
  var writerName = (body.writerName || 'the writer').toString().slice(0, 80);
  var wantHeadline = body.headline !== false;
  var mode = body.mode === 'keep' ? 'keep' : 'edit';

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
    ? '- Do NOT change the text or insert links. Put internal-link ideas in relatedSuggestions: 2-5 of the related articles below that genuinely relate, each with the phrase in the draft it would sit near. Do not force it.\n'
    : '- Insert Markdown links to related InsideMDSports articles from the list below where a phrase genuinely relates to that article. Link 2-5 where natural; do not force links or link the same article twice. Leave relatedSuggestions empty.\n';

  var user;
  if (mode === 'keep') {
    user =
      'The writer wants their copy left ALONE. Do NOT rewrite it. Review it and return suggestions they can choose to apply. Call the submit_copyedit tool with:\n' +
      '- "edited": the writer\'s draft returned essentially verbatim, as Markdown. ONLY unambiguous typo / misspelling / obvious punctuation-slip fixes are allowed. No style changes, no restructuring, no word swaps, no tightening, no added or removed sentences.\n' +
      '- Do NOT invent quotes, statistics, dates, scores, or outcomes.\n' +
      '- TRUST THE WRITER ON FACTS by default — a professional beat reporter.\n' +
      factsRule + linkRule +
      '- "notes": briefly, what a full house-style edit WOULD change (a few bullets), so they can decide.\n' +
      '- "addedContext": context a general reader might need that the draft assumes, as standalone suggested sentences — NOT inserted. Prefix "[VERIFY]" on any you are unsure of.\n' +
      (wantHeadline ? '- "headlines": three publishable options (Straight news / Punchy / SEO), each accurate, house-style, under ~90 chars, different angles.\n' : '- Leave "headlines" empty.\n') +
      '\nRELATED ARTICLES:\n' + (relatedList || '(none available this run)') + '\n\nDRAFT:\n' + draft;
  } else {
    user =
      'Edit the draft below and call the submit_copyedit tool.\n' +
      '- Rewrite it in the house style above, but KEEP ' + writerName + '\'s voice and structural habits. You are polishing them, not replacing them.\n' +
      '- Fix grammar, AP style, attribution, flabby sentences, cliches, and structure.\n' +
      '- Where the draft assumes context a general reader lacks, ADD a brief clause or sentence. Prefix ONLY context YOU added with "[VERIFY]" when unsure. Never attach [VERIFY] to something the writer already wrote.\n' +
      '- Do NOT invent quotes, statistics, dates, scores, or outcomes.\n' +
      '- TRUST THE WRITER ON FACTS by default. Do not build a checklist out of routine facts they stated confidently.\n' +
      factsRule + linkRule +
      '- "edited": the full edited article as Markdown, with the internal links in place.\n' +
      '- "notes": short bullets on what you changed and why.\n' +
      '- "addedContext": each clause/sentence of context you added, with its [VERIFY] flag if applicable.\n' +
      (wantHeadline ? '- "headlines": three publishable options (Straight news / Punchy / SEO), each accurate, house-style, under ~90 chars, different angles.\n' : '- Leave "headlines" empty.\n') +
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
        videoKeywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'The 3-6 most important search terms FROM THIS ARTICLE for finding related videos — the specific player and coach names, the school/opponent, and the topic (e.g. "commitment", "depth chart", "spring game"). Real terms that appear in the piece, most specific first. Used to suggest videos the writer could embed.'
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
      required: ['edited', 'notes', 'addedContext', 'factsToCheck', 'videoKeywords', 'seo']
    }
  };

  try {
    var cr = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        system: sys,
        tools: [tool],
        tool_choice: { type: 'tool', name: 'submit_copyedit' },
        messages: [{ role: 'user', content: user }]
      })
    });
    var cd = await cr.json();
    if (cd.error) return res.status(200).json({ error: 'Claude error: ' + JSON.stringify(cd.error) });

    var toolUse = (cd.content || []).filter(function (b) { return b.type === 'tool_use' && b.name === 'submit_copyedit'; })[0];
    var parsed = toolUse && toolUse.input;

    // Fallback: some responses still land as text JSON — salvage it.
    if (!parsed) {
      var txt = (cd.content || []).map(function (i) { return i.type === 'text' ? i.text : ''; }).join('\n');
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
    parsed.mode = mode;

    // Suggest 3 related YouTube videos the writer could embed, searched on the
    // article's own key terms. (v1: a general Terps-scoped search. Future:
    // restrict to the publisher's own video library.)
    var vkw = Array.isArray(parsed.videoKeywords) ? parsed.videoKeywords : [];
    parsed.videoSuggestions = await suggestVideos(vkw.slice(0, 6).join(' '));
    delete parsed.videoKeywords;

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
