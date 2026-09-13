// Style drift matcher: for each submitted content_items row, finds the live
// URL on the outlet's own site (no manual paste — scrapes the same recent-
// articles page copyedit.js already uses for internal linking, fuzzy-matches
// by headline) and has Claude note what changed between our output and what
// actually published. Best-effort/non-blocking throughout, same shape as
// _knowledge.js — a failed match here must never break anything else.
//
// InsideMDSports publishes on 247Sports, which paywalls full article bodies.
// With a publisher-supplied session cookie (api/_scrape-store.js — one-time
// paste, connected on the Settings tab) it fetches as that logged-in
// subscriber and gets the real body; without one, only whatever's visible
// before the meter cuts in (often just the lede) is reachable, and that's
// flagged `paywalled: true` rather than silently treated as complete.

var BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
var PAYWALL_TEXT_FLOOR = 500; // shorter than this, on a page that fetched fine, almost certainly means a meter cut it off.
var MATCH_THRESHOLD = 0.6;
// Phrases 247Sports (and similar meters) show in place of the article when
// you're not entitled to read it — if these show up even WITH a cookie sent,
// the session is expired/invalid, not just "the article happens to be short."
var PAYWALL_MARKERS = /subscribe (?:now|to continue|to read)|continue reading|247sports\+|premium content|sign up to unlock/i;

function normWords(s) {
  return String(s || '').toLowerCase()
    .replace(/&[a-z]+;|&#\d+;/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(function(w) { return w.length > 2; }); // drop "a", "in", "to", ...
}

// Word-overlap similarity between our headline and 247's URL-slug-derived
// title — good enough to find "this is probably the same piece" without an
// exact string match (247's slug can trim or reorder a few words).
function overlapScore(a, b) {
  var wa = normWords(a), wb = normWords(b);
  if (!wa.length || !wb.length) return 0;
  var setB = {}; wb.forEach(function(w) { setB[w] = 1; });
  var hits = wa.filter(function(w) { return setB[w]; }).length;
  return hits / Math.max(wa.length, wb.length);
}

async function fetchArticleText(url, cookie) {
  var c = new AbortController();
  var t = setTimeout(function() { c.abort(); }, 15000);
  try {
    var headers = { 'User-Agent': BROWSER_UA };
    if (cookie) headers.Cookie = cookie;
    var resp = await fetch(url, { headers: headers, signal: c.signal });
    var html = await resp.text();
    if (!resp.ok) return { text: '', paywalled: false, error: 'HTTP ' + resp.status };

    var metaDesc = '';
    var mm = html.match(/<meta\s+(?:name|property)="(?:description|og:description)"\s+content="([^"]*)"/i);
    if (mm) metaDesc = mm[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');

    var body = html.replace(/<(script|style|nav|header|footer)[\s\S]*?<\/\1>/gi, ' ');
    var paras = (body.match(/<p[^>]*>[\s\S]*?<\/p>/gi) || [])
      .map(function(p) {
        return p.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
          .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
      })
      .filter(function(p) { return p.length > 40; }); // drop nav/byline/caption fragments

    var text = paras.join('\n\n').slice(0, 8000);
    if (!text && metaDesc) text = metaDesc;

    // With a session cookie, a short/marker-bearing result means the session
    // is bad, not that the article is short — surface that distinctly so
    // it's obvious the fix is reconnecting, not a scraping quirk.
    var authWallDetected = !!cookie && (PAYWALL_MARKERS.test(html) || text.length < PAYWALL_TEXT_FLOOR);
    var paywalled = !cookie && !!text && (PAYWALL_MARKERS.test(html) || text.length < PAYWALL_TEXT_FLOOR);

    return { text: text, metaDescription: metaDesc, paywalled: paywalled, authWallDetected: authWallDetected };
  } catch (e) {
    return { text: '', paywalled: false, error: e.message };
  } finally { clearTimeout(t); }
}

async function claudeDiff(headline, ours, published, paywalled) {
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  var prompt =
    'Two versions of the same news article. VERSION A is what our AI copydesk tool produced. VERSION B is what actually ' +
    'went live on the site' + (paywalled ? ' (only the portion visible before the outlet\'s paywall meter cuts in was reachable, likely just the lede)' : '') + '. ' +
    "Compare them and write 2-4 short bullet points on what a human writer/editor changed — cuts, additions, rewording, structure, tone. " +
    "Be concrete (quote or closely paraphrase the specific change), not generic. If VERSION B is too short/partial to say anything meaningful beyond the opening, say exactly that in one line instead of guessing.\n\n" +
    'HEADLINE: ' + headline + '\n\n' +
    'VERSION A (our output):\n' + ours.slice(0, 6000) + '\n\n' +
    'VERSION B (published):\n' + published.slice(0, 6000) + '\n\n' +
    'Return ONLY the bullet points as plain text lines starting with "- ". No preamble.';

  var r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 500, messages: [{ role: 'user', content: prompt }] })
  });
  var d = await r.json();
  if (d.error) throw new Error('Claude error: ' + JSON.stringify(d.error));
  return (d.content || []).map(function(b) { return b.type === 'text' ? b.text : ''; }).join('\n').trim();
}

// Runs one matching pass for a site: finds submitted pieces with no revision
// row yet, matches each against the outlet's recent-articles page, and
// records what changed. Returns a per-item report for logging.
async function runMatchPass(sb, siteId) {
  var report = [];
  var cookie = null;
  try { cookie = await require('./_scrape-store').getCookie(sb, siteId, '247sports'); }
  catch (e) { /* proceed without a session — falls back to whatever's public */ }

  var pendingRes = await sb.from('content_items')
    .select('id, headline, body, created_at')
    .eq('site_id', siteId)
    .eq('metadata->>status', 'submitted')
    .gte('created_at', new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString())
    .order('created_at', { ascending: false })
    .limit(50);
  if (pendingRes.error) throw new Error(pendingRes.error.message);
  var pending = pendingRes.data || [];
  if (!pending.length) return report;

  var alreadyRes = await sb.from('content_revisions').select('content_item_id').eq('site_id', siteId);
  var already = {};
  (alreadyRes.data || []).forEach(function(r) { already[r.content_item_id] = 1; });
  pending = pending.filter(function(p) { return !already[p.id] && p.headline; });
  if (!pending.length) return report;

  var freshIndex;
  try { freshIndex = await require('./copyedit.js').relatedArticleIndex(); }
  catch (e) { return [{ error: 'Could not load recent-articles index: ' + e.message }]; }

  for (var i = 0; i < pending.length; i++) {
    var item = pending[i];
    try {
      var best = null, bestScore = 0;
      freshIndex.forEach(function(f) {
        var score = overlapScore(item.headline, f.headline);
        if (score > bestScore) { bestScore = score; best = f; }
      });
      if (!best || bestScore < MATCH_THRESHOLD) {
        report.push({ headline: item.headline, status: 'no-match', bestScore: bestScore });
        continue;
      }

      var fetched = await fetchArticleText(best.url, cookie);
      if (!fetched.text) {
        report.push({ headline: item.headline, status: 'fetch-empty', url: best.url, error: fetched.error });
        continue;
      }

      var diffSummary = null;
      try { diffSummary = await claudeDiff(item.headline, item.body || '', fetched.text, fetched.paywalled); }
      catch (e) { diffSummary = null; }

      var ins = await sb.from('content_revisions').upsert({
        site_id: siteId, content_item_id: item.id, published_url: best.url,
        published_excerpt: fetched.text.slice(0, 4000), paywalled: fetched.paywalled,
        diff_summary: diffSummary, matched_at: new Date().toISOString()
      }, { onConflict: 'content_item_id' });
      if (ins.error) throw new Error(ins.error.message);

      report.push({
        headline: item.headline, status: 'matched', url: best.url, paywalled: fetched.paywalled, score: bestScore,
        authWallDetected: fetched.authWallDetected || undefined // present + true only when a cookie was sent but still blocked — session likely expired
      });
    } catch (e) {
      report.push({ headline: item.headline, status: 'error', error: e.message });
    }
  }

  return report;
}

module.exports = { runMatchPass: runMatchPass, overlapScore: overlapScore };
