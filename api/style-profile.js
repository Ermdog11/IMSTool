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

module.exports = async function handler(req, res) {
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY.' });

  var body = req.body || {};
  var writer = (body.writer || 'the writer').toString().slice(0, 80);
  var pasted = (body.samples || '').toString();
  var urls = (Array.isArray(body.urls) ? body.urls : String(body.urls || '').split(/\s+/))
    .map(function (u) { return (u || '').trim(); })
    .filter(function (u) { return /^https?:\/\//i.test(u); })
    .slice(0, 25);

  var fetchedUrls = [];
  var failedUrls = [];
  var fetchedText = '';

  if (urls.length) {
    var controller;
    var results = await Promise.allSettled(urls.map(function (u) {
      var c = new AbortController();
      var t = setTimeout(function () { c.abort(); }, 12000);
      return fetch(u, { headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9' }, signal: c.signal })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
        .finally(function () { clearTimeout(t); });
    }));
    results.forEach(function (r, i) {
      if (r.status === 'fulfilled') {
        var text = stripHtml(r.value);
        if (text.length > 400) { fetchedUrls.push(urls[i]); fetchedText += '\n\n--- ' + urls[i] + ' ---\n' + text.slice(0, 8000); }
        else { failedUrls.push(urls[i]); }
      } else {
        failedUrls.push(urls[i]);
      }
    });
  }

  var corpus = (pasted + '\n\n' + fetchedText).trim().slice(0, 90000);
  if (corpus.length < 500) {
    return res.status(200).json({ error: 'Not enough sample text. Paste a few full articles, or add URLs that load without a login.', failedUrls: failedUrls });
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
      fetchedUrls: fetchedUrls,
      failedUrls: failedUrls
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
