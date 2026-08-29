// Builds a reusable "style profile" for a staff writer from sample articles.
// Samples can be pasted text (any separators) and/or URLs the tool fetches directly.
// No third-party API — URLs that are bot-blocked or paywalled just get flagged so the
// writer can paste that one instead.

var BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#?[a-z0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function withTimeout(url, opts, ms) {
  var c = new AbortController();
  var t = setTimeout(function () { c.abort(); }, ms || 12000);
  return fetch(url, Object.assign({ headers: { 'User-Agent': BROWSER_UA } }, opts || {}, { signal: c.signal }))
    .finally(function () { clearTimeout(t); });
}

// Fetch a page's readable text. Try direct first; if it's blocked/paywalled/thin,
// retry through r.jina.ai (a free, keyless page reader — not a paid API, but an
// external dependency). Returns '' on total failure.
async function readPage(url) {
  try {
    var r = await withTimeout(url, { headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9' } }, 12000);
    if (r.ok) {
      var txt = stripHtml(await r.text());
      if (txt.length > 1200) return txt;
    }
  } catch (e) { /* fall through to reader */ }
  try {
    var jr = await withTimeout('https://r.jina.ai/' + url, { headers: { 'User-Agent': BROWSER_UA, 'X-Return-Format': 'text' } }, 25000);
    if (jr.ok) {
      var jt = (await jr.text()).replace(/\s+/g, ' ').trim();
      if (jt.length > 400) return jt;
    }
  } catch (e) { /* give up */ }
  return '';
}

var ARTICLE_RE = /https?:\/\/[a-z0-9.]*247sports\.com\/college\/[a-z-]+\/(?:article|longformarticle)\/[a-z0-9-]+-\d{5,}\/?/gi;

// If a URL is an author/section/list page rather than an article, expand it into
// the article links it contains (via the reader, since 247 blocks direct scrapes).
async function expandListPage(url) {
  var html = '';
  try {
    var jr = await withTimeout('https://r.jina.ai/' + url, { headers: { 'User-Agent': BROWSER_UA } }, 25000);
    if (jr.ok) html = await jr.text();
  } catch (e) { return []; }
  var found = html.match(ARTICLE_RE) || [];
  var seen = {}, out = [];
  found.forEach(function (u) {
    u = u.replace(/\/?$/, '/');
    if (!seen[u]) { seen[u] = 1; out.push(u); }
  });
  return out.slice(0, 25);
}

module.exports = async function handler(req, res) {
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY.' });

  var body = req.body || {};
  var writer = (body.writer || 'the writer').toString().slice(0, 80);
  var pasted = (body.samples || '').toString();
  var inputUrls = (Array.isArray(body.urls) ? body.urls : String(body.urls || '').split(/\s+/))
    .map(function (u) { return (u || '').trim(); })
    .filter(function (u) { return /^https?:\/\//i.test(u); })
    .slice(0, 30);

  // Separate direct article URLs from author/section pages that need expanding.
  var articleUrls = [];
  var listPages = [];
  inputUrls.forEach(function (u) {
    if (/\/(?:article|longformarticle)\/[a-z0-9-]+-\d{5,}/i.test(u) || !/247sports\.com/i.test(u)) articleUrls.push(u);
    else listPages.push(u);
  });

  var expandedFrom = 0;
  for (var li = 0; li < listPages.length && articleUrls.length < 20; li++) {
    var more = await expandListPage(listPages[li]);
    expandedFrom += more.length;
    more.forEach(function (m) { if (articleUrls.indexOf(m) === -1) articleUrls.push(m); });
  }
  articleUrls = articleUrls.slice(0, 20); // ~15-20 pieces is plenty; keeps us under the function time limit

  var fetchedUrls = [];
  var failedUrls = [];
  var fetchedText = '';

  if (articleUrls.length) {
    var texts = await Promise.allSettled(articleUrls.map(function (u) { return readPage(u); }));
    texts.forEach(function (r, i) {
      var text = r.status === 'fulfilled' ? r.value : '';
      if (text && text.length > 400) {
        fetchedUrls.push(articleUrls[i]);
        fetchedText += '\n\n--- ' + articleUrls[i] + ' ---\n' + text.slice(0, 7000);
      } else {
        failedUrls.push(articleUrls[i]);
      }
    });
  }

  var corpus = (pasted + '\n\n' + fetchedText).trim().slice(0, 120000);
  if (corpus.length < 500) {
    return res.status(200).json({ error: 'Couldn\'t gather enough sample text. Paste a few full articles directly, or check the URLs.', failedUrls: failedUrls });
  }

  var prompt =
    'You are a newsroom writing coach. Below are several published articles by ' + writer + '. ' +
    'Study them and produce a STYLE PROFILE this writer\'s editor can use to preserve their voice while copy-editing future drafts.\n\n' +
    'Return plain prose (~350-450 words), covering:\n' +
    '1. Voice & tone (formal/conversational, dry/energetic, first person?, use of humor).\n' +
    '2. Sentence structure & rhythm (length, variation, fragments, parenthetical asides).\n' +
    '3. Story structure (how they open, whether they use a nut graf, how they close/kick).\n' +
    '4. Vocabulary & diction (plain vs. ornate, jargon level, favorite constructions).\n' +
    '5. Beat & focus (what subjects/angles they gravitate to; recruiting vs. gameday vs. features).\n' +
    '6. Signature techniques worth PRESERVING.\n' +
    '7. Habits an editor should gently TIGHTEN.\n\n' +
    'Then a line: SIGNATURE PHRASES: 4-6 short verbatim snippets (5-12 words each) that capture their voice.\n\n' +
    'ARTICLES:\n' + corpus;

  try {
    var cr = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] })
    });
    var cd = await cr.json();
    if (cd.error) return res.status(200).json({ error: 'Claude error: ' + JSON.stringify(cd.error) });
    var profile = (cd.content || []).map(function (i) { return i.type === 'text' ? i.text : ''; }).join('\n').trim();
    return res.status(200).json({
      writer: writer,
      profile: profile,
      sampleChars: corpus.length,
      articlesRead: fetchedUrls.length,
      expandedFromPages: expandedFrom,
      fetchedUrls: fetchedUrls,
      failedUrls: failedUrls
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
