// Google News links and article text, shared by the scan (api/scan.js) and
// the draft writer (api/_breaking-draft.js). Best-effort throughout: any
// failure returns null / '' rather than throwing.

var BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

function fetchWithTimeout(url, options, timeoutMs) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, timeoutMs || 8000);
  return fetch(url, Object.assign({}, options, { signal: controller.signal }))
    .finally(function () { clearTimeout(timer); });
}

// Resolve a news.google.com/rss/articles/<id> redirect to the real publisher URL.
// Google no longer embeds the URL in the id; it takes a page fetch (for the signature
// + timestamp) then a batchexecute POST. Returns null on any failure.
async function resolve(gurl) {
  try {
    var m = String(gurl).match(/\/articles\/([^?/]+)/);
    if (!m) return null;
    var id = m[1];
    var page = await fetchWithTimeout('https://news.google.com/rss/articles/' + id, { headers: { 'User-Agent': BROWSER_UA } }, 8000).then(function (r) { return r.text(); });
    var ts = (page.match(/data-n-a-ts="([^"]+)"/) || [])[1];
    var sg = (page.match(/data-n-a-sg="([^"]+)"/) || [])[1];
    if (!ts || !sg) return null;
    var inner = '["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"en-US","US",1,[2,3,4,8],1,0,"655000234",0,0,null,0],"' + id + '",' + ts + ',"' + sg + '"]';
    var freq = JSON.stringify([[['Fbv4je', inner, null, 'generic']]]);
    var resp = await fetchWithTimeout('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': BROWSER_UA },
      body: 'f.req=' + encodeURIComponent(freq)
    }, 8000).then(function (r) { return r.text(); });
    var um = resp.match(/https?:\/\/[^\\"]+/);
    return (um && !/news\.google\.com/.test(um[0])) ? um[0] : null;
  } catch (e) { return null; }
}

// The readable text of an article page: its paragraphs, else the whole page
// stripped of markup. -> { url, text, publishedMs } or null.
async function articleText(url, maxChars) {
  try {
    if (!url) return null;
    if (/news\.google\.com/i.test(url)) url = await resolve(url);
    if (!url || !/^https?:\/\//i.test(url)) return null;
    var r = await fetchWithTimeout(url, { headers: { 'User-Agent': BROWSER_UA } }, 8000);
    if (!r.ok) return null;
    var html = (await r.text()).slice(0, 600000);
    var pub = require('./_article-date').fromHtml(html);
    var body = html.replace(/<(script|style|nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, ' ');
    var paras = (body.match(/<p[\s>][\s\S]*?<\/p>/gi) || []).map(clean).filter(function (p) { return p.length > 40; });
    var text = paras.length >= 3 ? paras.join('\n\n') : clean(body);
    return { url: url, text: text.slice(0, maxChars || 8000), publishedMs: isNaN(pub) ? null : pub };
  } catch (e) { return null; }
}

function clean(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&#8217;|&rsquo;/g, "'").replace(/&quot;|&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

module.exports = { resolve: resolve, articleText: articleText, BROWSER_UA: BROWSER_UA };
