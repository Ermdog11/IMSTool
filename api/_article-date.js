// Reads an article's own publish date from its page (meta tags or JSON-LD).
// Search results and some feeds only know when a page was crawled, so a
// months-old article can arrive looking brand new (2026-10-04, Jeff: an old
// Chris Durr commitment went out as a breaking auto-draft). Used to date
// undated search results and as a last check before an auto-draft.
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

// For search results whose API gave no publish date (age null), read the
// date off the page itself: recent pages stay, old ones go. A page whose date
// still can't be found stays in with age null ("publish date unknown"):
// scan.js has its full article checked, and the digest never auto-drafts or
// pushes it as breaking. Search APIs filter by crawl date, so this is what
// catches a re-crawled old article.
async function fillMissingAges(results, maxAgeHours) {
  await Promise.all(results.map(async function(item) {
    if (item.age !== null) return;
    var pub = await publishedMs(item.url);
    if (!isNaN(pub)) item.age = Math.max(0, Math.round((Date.now() - pub) / 3600000));
  }));
  return results.filter(function(item) { return item.age === null || item.age <= maxAgeHours; });
}

module.exports = { publishedMs: publishedMs, fromHtml: fromHtml, fillMissingAges: fillMissingAges };
