// Reads an article's own publish date from its page (meta tags or JSON-LD).
// Used as a last check before CoPublisher AI auto-drafts and emails a
// "breaking" story: search results and some feeds only know when a page was
// crawled, so a months-old article can arrive looking brand new
// (2026-10-04, Jeff: an old Chris Durr commitment went out as breaking).
// Best-effort: any fetch or parse failure returns NaN (date unknown).

var META_KEYS = ['article:published_time', 'og:published_time', 'datepublished', 'pubdate', 'publishdate', 'publish-date', 'sailthru.date', 'parsely-pub-date', 'dc.date.issued', 'date'];

function fromHtml(html) {
  var metas = html.match(/<meta\b[^>]*>/gi) || [];
  for (var i = 0; i < metas.length; i++) {
    var tag = metas[i];
    var key = (tag.match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!key || META_KEYS.indexOf(key.toLowerCase()) === -1) continue;
    var val = (tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i) || [])[1];
    var ms = val ? new Date(val).getTime() : NaN;
    if (!isNaN(ms)) return ms;
  }
  var ld = html.match(/"datePublished"\s*:\s*"([^"]+)"/);
  if (ld) {
    var lms = new Date(ld[1]).getTime();
    if (!isNaN(lms)) return lms;
  }
  return NaN;
}

async function publishedMs(url) {
  if (!url) return NaN;
  try {
    var r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CoPublisherAI/1.0)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) return NaN;
    return fromHtml((await r.text()).slice(0, 400000));
  } catch (e) { return NaN; }
}

module.exports = { publishedMs: publishedMs, fromHtml: fromHtml };
