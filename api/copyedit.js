// Copydesk: takes a staff writer's draft and returns it rewritten in the site's house
// style, preserving the writer's voice (via their style profile), with helpful context
// added (flagged for verification) and internal links to related published articles.

var BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

// Recent InsideMDSports / 247 Maryland articles, for internal linking. Same scrape the
// news monitor uses for its own-outlet blocklist — the landing page loads server-side.
async function relatedArticleIndex() {
  try {
    var c = new AbortController();
    var t = setTimeout(function () { c.abort(); }, 12000);
    var html = await fetch('https://247sports.com/college/maryland/', {
      headers: { 'User-Agent': BROWSER_UA },
      signal: c.signal
    }).then(function (r) { return r.text(); }).finally(function () { clearTimeout(t); });

    var seen = {};
    var out = [];
    // Matches relative or absolute: /college/maryland/article/<slug>-<id>/  (same as scan.js)
    var re = /\/college\/maryland\/(?:article|longformarticle)\/([a-z0-9-]+)-(\d{6,})/g;
    var m;
    while ((m = re.exec(html)) !== null) {
      var slug = m[1];
      var url = 'https://247sports.com/college/maryland/article/' + slug + '-' + m[2] + '/';
      if (seen[slug]) continue;
      seen[slug] = 1;
      out.push({ url: url, headline: slug.replace(/-/g, ' ').replace(/\b\w/g, function (x) { return x.toUpperCase(); }) });
      if (out.length >= 30) break;
    }
    return out;
  } catch (e) {
    return [];
  }
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

  var related = await relatedArticleIndex();
  var relatedList = related.map(function (r, i) { return (i + 1) + '. ' + r.headline + '  ->  ' + r.url; }).join('\n');

  var sys =
    'You are the copy chief for InsideMDSports, a Maryland Terrapins sports site. You edit staff drafts to publish-ready quality.\n\n' +
    '=== HOUSE STYLE GUIDE ===\n' + (styleGuide || '(No house style guide provided — apply standard clean sports-news style: AP style, active voice, tight sentences, attribute claims, no cliches.)') +
    (writerProfile ? ('\n\n=== THIS WRITER\'S STYLE PROFILE (' + writerName + ') — preserve this voice ===\n' + writerProfile) : '');

  var user =
    'Edit the draft below.\n\n' +
    'RULES:\n' +
    '- Rewrite it in the house style above, but KEEP ' + writerName + '\'s voice and structural habits from their profile. You are polishing them, not replacing them.\n' +
    '- Fix grammar, AP style, attribution, flabby sentences, cliches, and structure.\n' +
    '- Where the draft assumes context a general reader lacks (who a person is, why something matters, prior events), ADD a brief clause or sentence of context. Prefix every piece of context you are not 100% certain is factually correct with "[VERIFY]".\n' +
    '- Do NOT invent quotes, statistics, dates, scores, or outcomes. If the draft is missing a fact it needs, note it rather than filling it in.\n' +
    '- Insert Markdown links to related InsideMDSports articles from the list below where a phrase in the piece genuinely relates to that article. Link 2-5 where natural; do not force links or link the same article twice.\n\n' +
    'RELATED ARTICLES (for internal links):\n' + (relatedList || '(none available this run)') + '\n\n' +
    'Return ONLY a JSON object:\n' +
    '{\n' +
    '  "edited": "<the full edited article as Markdown, including the internal links>",\n' +
    '  "notes": ["<short bullet: what you changed and why>", ...],\n' +
    '  "addedContext": ["<each sentence/clause of context you added, with its [VERIFY] flag if applicable>", ...],\n' +
    '  "factsToCheck": ["<anything the draft needs but is missing or unclear>", ...]' +
    (wantHeadline ? ',\n  "headlines": [\n    {"label": "Straight news", "text": "<clear, factual, names the subject>"},\n    {"label": "Punchy", "text": "<sharper, more voice, still accurate — no clickbait>"},\n    {"label": "SEO", "text": "<leads with the key search terms: player/coach name + Maryland + the topic>"}\n  ]' : '') +
    '\n}\n\n' +
    (wantHeadline ? 'All three headlines must be publishable, accurate, house-style, and under ~90 characters. Different angles, not reworded versions of each other.\n\n' : '') +
    'DRAFT:\n' + draft;

  try {
    var cr = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        system: sys,
        messages: [{ role: 'user', content: user }]
      })
    });
    var cd = await cr.json();
    if (cd.error) return res.status(200).json({ error: 'Claude error: ' + JSON.stringify(cd.error) });
    var text = (cd.content || []).map(function (i) { return i.type === 'text' ? i.text : ''; }).join('\n');
    var s = text.indexOf('{');
    var e = text.lastIndexOf('}');
    if (s === -1 || e === -1) return res.status(200).json({ error: 'Editor did not return JSON.', raw: text.slice(0, 400) });
    var parsed = JSON.parse(text.slice(s, e + 1));
    parsed.relatedCount = related.length;
    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
