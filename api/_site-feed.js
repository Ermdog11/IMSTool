// Reads a news site directly, for outlets that Google News and Bing don't
// index well and whose RSS address has changed (Jeff, 2026-10-06: "why is it
// still not surfacing results from Inside the Black and Gold?" Its old
// /feed/ address returned 404, and the site: searches that replaced it came
// back empty). A feed config with `site: true` points at the outlet's home
// page; this:
//   1. opens the home page (as a browser) and follows its advertised feed
//      (<link rel="alternate" type="application/rss+xml|atom+xml">)
//   2. else tries the usual feed addresses (WordPress, Ghost, Substack, ...)
//   3. else reads the latest article links off the home page itself
// and always returns RSS-shaped XML, so scan.js parses it like any feed.
// Best-effort: failures come back as an empty feed with the reason logged.

var BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
var COMMON = ['/feed/', '/rss/', '/feed', '/rss', '/feed.xml', '/rss.xml', '/atom.xml', '/index.xml', '/?feed=rss2'];

async function get(url, ms) {
  var c = new AbortController(), t = setTimeout(function () { c.abort(); }, ms || 7000);
  try {
    var r = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html,application/xhtml+xml,application/rss+xml,application/xml;q=0.9,*/*;q=0.8' }, signal: c.signal, redirect: 'follow' });
    return { status: r.status, url: r.url || url, text: r.ok ? await r.text() : '' };
  } catch (e) { return { status: 'FAILED', url: url, text: '' }; }
  finally { clearTimeout(t); }
}

function isFeed(xml) { return /<(rss|feed|rdf:RDF)[\s>]/i.test(xml.slice(0, 3000)) && /<(item|entry)[\s>]/i.test(xml); }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function clean(s) { return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;|&#039;|&#39;/g, "'").replace(/&#822[01];|&[lr]dquo;|&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/&#?[a-z0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim(); }

// Atom -> the RSS item shape scan.js reads.
function atomToRss(xml) {
  var entries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/g) || [];
  return '<rss><channel>' + entries.map(function (e) {
    var title = (e.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '';
    var link = (e.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/) || e.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '';
    var date = (e.match(/<published>(.*?)<\/published>/) || e.match(/<updated>(.*?)<\/updated>/) || [])[1] || '';
    var sum = (e.match(/<summary[^>]*>([\s\S]*?)<\/summary>/) || [])[1] || '';
    return '<item><title>' + esc(clean(title)) + '</title><link>' + esc(link) + '</link>' + (date ? '<pubDate>' + new Date(date).toUTCString() + '</pubDate>' : '') + '<description>' + esc(clean(sum).slice(0, 400)) + '</description></item>';
  }).join('') + '</channel></rss>';
}

// Article links from a home page: same site, a slug-like path, and a real
// headline as the link text (at least 5 words).
function scrapeHome(html, base) {
  var host = new URL(base).hostname.replace(/^www\./, '');
  var seen = {}, items = [];
  var re = /<a\b[^>]*href="([^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi, m;
  while ((m = re.exec(html)) && items.length < 30) {
    var href; try { href = new URL(m[1], base); } catch (e) { continue; }
    if (href.hostname.replace(/^www\./, '') !== host) continue;
    var path = href.pathname;
    if (!/[a-z0-9]+-[a-z0-9]+-[a-z0-9]+/i.test(path) || /\/(tag|category|author|page|about|contact|privacy|terms|subscribe|login|account)\b/i.test(path)) continue;
    var text = clean(m[2]);
    if (text.split(' ').length < 5 || text.length > 200) continue;
    var key = href.origin + path;
    if (seen[key]) continue; seen[key] = 1;
    items.push('<item><title>' + esc(text) + '</title><link>' + esc(key) + '</link><description></description></item>');
  }
  return '<rss><channel>' + items.join('') + '</channel></rss>';
}

// -> a Response-like { status, text() } carrying RSS XML, plus .how.
async function fetchSite(homeUrl) {
  var how, stop = Date.now() + 20000; // never hold up the scan more than ~20s
  var home = await get(homeUrl, 8000);
  var xml = '';
  if (home.text) {
    var links = [], re = /<link\b[^>]*>/gi, m;
    while ((m = re.exec(home.text))) {
      var tag = m[0];
      if (/rel=["']alternate["']/i.test(tag) && /type=["']application\/(rss|atom)\+xml["']/i.test(tag) && !/comments/i.test(tag)) {
        var h = (tag.match(/href=["']([^"']+)["']/i) || [])[1];
        if (h) { try { links.push(new URL(h, home.url).toString()); } catch (e) {} }
      }
    }
    for (var i = 0; i < links.length && !xml && Date.now() < stop; i++) {
      var f = await get(links[i]);
      if (isFeed(f.text)) { xml = f.text; how = 'advertised feed ' + links[i]; }
    }
  }
  for (var j = 0; j < COMMON.length && !xml && Date.now() < stop; j++) {
    var u; try { u = new URL(COMMON[j], home.url || homeUrl).toString(); } catch (e) { continue; }
    var g = await get(u, 5000);
    if (isFeed(g.text)) { xml = g.text; how = 'feed at ' + u; }
    if (g.status === 'FAILED' && !home.text) break; // site unreachable: stop trying
  }
  if (xml && !/<item[\s>]/i.test(xml)) xml = atomToRss(xml);
  if (!xml && home.text) { xml = scrapeHome(home.text, home.url); how = 'home page links'; }
  if (!xml) how = 'unreachable (home page HTTP ' + home.status + ')';
  var n = (xml.match(/<item[\s>]/g) || []).length;
  console.log('Site source ' + homeUrl + ': ' + how + ', ' + n + ' items');
  return { status: xml ? 200 : (home.status === 'FAILED' ? 599 : home.status), how: how, text: async function () { return xml; } };
}

module.exports = { fetchSite: fetchSite, scrapeHome: scrapeHome, atomToRss: atomToRss };
