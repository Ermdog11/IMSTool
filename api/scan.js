module.exports = async function handler(req, res) {
  try { await require('./_supabase').requireUserOrCron(req, res); }
  catch (authErr) { return res.status(authErr.status || 401).json({ error: authErr.message || 'Not signed in' }); }
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'no key set' });

  // If body has messages but no tools, act as a simple Claude proxy (card actions)
  var body = req.body || {};
  if (body.messages && !body.tools) {
    try {
      var pr = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body)
      });
      var pd = await pr.json();
      return res.status(pr.status).json(pd);
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Full scan: fetch Reddit + Google News RSS, then ask Claude to rate them
  // Window widened from 36h → 66h so a Friday-night story is still in the pool
  // Monday morning. News older than this is dropped before rating. Overridable
  // via body.hours for one-off checks (e.g. "how many 4-star stories in the
  // last 72h") without changing the standing window every other caller gets.
  var hoursOverride = body.hours || (req.query && req.query.hours);
  var windowHours = (hoursOverride && Number(hoursOverride) > 0) ? Number(hoursOverride) : 66;
  var cutoff = Date.now() - windowHours * 60 * 60 * 1000;
  var googleCutoff = Date.now() - windowHours * 60 * 60 * 1000;
  // Everything about WHICH team this newsroom covers — feeds, watchlist,
  // relevance words, rating-prompt wording, its own site — comes from the
  // newsroom's beat profile (api/_beat.js). InsideMDSports' profile is the
  // Maryland setup that used to be hard-coded here.
  var B = require('./_beat.js');
  var SB = require('./_supabase.js');
  var beat = await B.getBeat(SB.isConfigured() ? SB.admin() : null);
  // Our own outlet and known junk sources never show up as stories.
  var excluded = beat.excludeSources.slice();
  // Sources the editor has blocked via the "Block source" button — filtered out below and never shown again.
  var userBlocked = ((req.body && req.body.blockedSources) || [])
    .map(function(s) { return String(s || '').trim().toLowerCase(); })
    .filter(Boolean);
  if (userBlocked.length) excluded = excluded.concat(userBlocked);

  try {
    // RSS/news feeds: name is for diagnostics, src is the fallback source label.
    // A hand-tuned list from the profile when it has one, otherwise generated
    // from the team's names, people and outlets.
    var feedConfigs = B.feedsFor(beat).slice();
    // Our own outlet's landing page — its article URLs carry the headline as a
    // slug, used as a fuzzy-matched blocklist (see ownTitleWordSets / scrapeSlugs
    // below) and as "our own recent coverage" for the rater. Google News doesn't
    // reliably label or index our own outlet, so this is the only solid signal.
    if (beat.ownSite.url) feedConfigs.push({ url: beat.ownSite.url, name: 'ownsite/blocklist', scrapeSlugs: true });

    var redditFetches = B.redditFor(beat);

    // Source health (api/_source-health.js): a feed that has been dead for a
    // day is swapped for a Google News search of its site, or skipped if it
    // can't be fixed (Reddit). Every scan reports back how each source did.
    var SH = require('./_source-health.js');
    var shState = await SH.load();
    feedConfigs = SH.heal(feedConfigs, shState);
    redditFetches = SH.heal(redditFetches, shState);
    var feedStats = {};

    // Every external fetch gets its own timeout — without this, a single slow or
    // hanging RSS/Reddit source can block Promise.allSettled indefinitely (fetch()
    // has no default timeout), which drags the whole function past Vercel's
    // execution limit and shows up to the user as a request that never finishes.
    function fetchWithTimeout(url, options, timeoutMs) {
      var controller = new AbortController();
      var timer = setTimeout(function() { controller.abort(); }, timeoutMs || 8000);
      return fetch(url, Object.assign({}, options, { signal: controller.signal }))
        .finally(function() { clearTimeout(timer); });
    }

    var BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

    // Resolve a news.google.com/rss/articles/<id> redirect to the real publisher URL.
    // Google no longer embeds the URL in the id; it takes a page fetch (for the signature
    // + timestamp) then a batchexecute POST. Best-effort — returns null on any failure.
    async function resolveGoogleNewsUrl(gurl) {
      try {
        var m = String(gurl).match(/\/articles\/([^?/]+)/);
        if (!m) return null;
        var id = m[1];
        var page = await fetchWithTimeout('https://news.google.com/rss/articles/' + id, { headers: { 'User-Agent': BROWSER_UA } }, 8000).then(function(r) { return r.text(); });
        var ts = (page.match(/data-n-a-ts="([^"]+)"/) || [])[1];
        var sg = (page.match(/data-n-a-sg="([^"]+)"/) || [])[1];
        if (!ts || !sg) return null;
        var inner = '["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"en-US","US",1,[2,3,4,8],1,0,"655000234",0,0,null,0],"' + id + '",' + ts + ',"' + sg + '"]';
        var freq = JSON.stringify([[['Fbv4je', inner, null, 'generic']]]);
        var resp = await fetchWithTimeout('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': BROWSER_UA },
          body: 'f.req=' + encodeURIComponent(freq)
        }, 8000).then(function(r) { return r.text(); });
        var um = resp.match(/https?:\/\/[^\\"]+/);
        return (um && !/news\.google\.com/.test(um[0])) ? um[0] : null;
      } catch (e) { return null; }
    }

    var fetches = redditFetches.map(function(f) {
      return fetchWithTimeout(f.url, { headers: { 'User-Agent': 'IMSTool/1.0' } }, 8000);
    }).concat(feedConfigs.map(function(f) {
      // Scraped HTML pages 403 without a browser UA; RSS endpoints don't care either way.
      var opts = f.scrapeSlugs ? { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36' } } : {};
      return fetchWithTimeout(f.url, opts, 8000);
    }));

    var results = await Promise.allSettled(fetches);
    var stories = [];
    // Word-sets of headlines that originated on our own outlet — used to drop the same
    // stories when they resurface (unlabeled) in the general Google News feeds. Fuzzy
    // (word-overlap) matching, not exact-string: a syndication partner or Google News
    // itself will sometimes reword a headline slightly ("heading" -> "headed"), which
    // silently defeated the old exact-match check for months.
    var ownTitleWordSets = [];
    var ownHeadlines = []; // readable slugs of our own recent articles, fed to the rating prompt as context
    var blocklistSource = 'not run';
    function titleWords(t) {
      return (String(t).toLowerCase().match(/[a-z0-9]+/g) || []).filter(function(w) { return w.length > 2; });
    }
    function wordOverlap(aWords, bSet) {
      if (!aWords.length) return 0;
      var hits = 0;
      aWords.forEach(function(w) { if (bSet.has(w)) hits++; });
      return hits / aWords.length;
    }
    function isOwnOutletTitle(title) {
      var words = titleWords(title);
      if (words.length < 3) return false;
      return ownTitleWordSets.some(function(set) { return wordOverlap(words, set) >= 0.75; });
    }
    // Normalize for headline matching. Strip HTML entities and the trailing
    // " - Publisher" / " | Publisher" suffix Google News appends, so the Google copy
    // and a direct-feed copy of the same story normalize to the same key.
    function normTitle(t) {
      return String(t).toLowerCase()
        .replace(/&[a-z]+;|&#\d+;/g, ' ')
        .replace(/\s+[-|–—]\s+[^-|–—]{1,40}$/, '')
        .replace(/[^a-z0-9 ]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        // 80 chars (was 55): distinct stories on this beat often share their first
        // 8-10 words ("Maryland lands commitment from four-star..."), and a 55-char
        // key collapsed them into one. Longer key = fewer real stories lost to dedup.
        .substring(0, 80);
    }

    // Reddit results (first redditFetches.length entries of `results`)
    for (var ri = 0; ri < redditFetches.length; ri++) {
      if (results[ri].status !== 'fulfilled') continue;
      try {
        var rj = await results[ri].value.json();
        var posts = (rj.data && rj.data.children) || [];
        var rBefore = stories.length;
        feedStats[redditFetches[ri].name] = { items: posts.length, before: rBefore };
        posts.forEach(function(p) {
          var d = p.data;
          if (!d || !d.title) return;
          var created = d.created_utc * 1000;
          if (created < cutoff) return;
          var url = d.url || ('https://reddit.com' + d.permalink);
          // Skip reddit-hosted media and meme/image hosts
          if (/i\.redd\.it|v\.redd\.it|reddit\.com\/gallery|imgur\.com|gfycat|redgifs/i.test(url)) return;
          // Skip recurring discussion thread patterns
          if (/game thread|post game|postgame thread|daily discussion|weekly|free talk|megathread|who do you|what are your|unpopular opinion|rank your/i.test(d.title)) return;
          var src = 'Reddit r/' + d.subreddit;
          if (excluded.some(function(ex) { return src.toLowerCase().includes(ex) || url.toLowerCase().includes(ex); })) return;
          stories.push({ title: d.title, source: src, url: url, age: Math.round((Date.now() - created) / 3600000) });
        });
      } catch(e) { /* skip failed reddit */ }
    }

    // RSS feeds (Google News, Bing, direct site feeds)
    for (var gi = redditFetches.length; gi < results.length; gi++) {
      if (results[gi].status !== 'fulfilled') continue;
      var cfg = feedConfigs[gi - redditFetches.length];
      try {
        var xml = await results[gi].value.text();
        feedStats[cfg.name] = { items: (xml.match(/<item[\s>]|<entry[\s>]/g) || []).length, before: stories.length };
        // Our-outlet blocklist: pull headline slugs out of our own landing page's
        // article URLs (…/article/some-headline-slug-289225568/) and record them. This
        // scrape intermittently 406s (bot detection) — when that happens the page body
        // is a block page with zero article links, which used to silently zero out the
        // whole blocklist for that scan cycle (own-outlet stories then sailed straight
        // through with nothing to match against). Persist the last good scrape to Blob
        // and fall back to it whenever the live one fails or looks too thin to be real.
        if (cfg.scrapeSlugs) {
          var slugRe = B.ownArticleRegex(beat);
          var slugMatches = (slugRe && xml.match(slugRe)) || [];
          var freshSlugWords = {};
          var ownSlugTexts = [];
          slugMatches.forEach(function(m) {
            var slug = m.replace(/.*\/(?:article|longformarticle)\//, '').replace(/-\d{6,}$/, '').replace(/-/g, ' ');
            var words = titleWords(slug);
            if (words.length >= 3 && !freshSlugWords[words.join(' ')]) { freshSlugWords[words.join(' ')] = words; ownSlugTexts.push(slug); }
          });
          var freshCount = Object.keys(freshSlugWords).length;
          var scrapeOk = results[gi].value.status === 200 && freshCount >= 10;
          try {
            var blobMod = require('@vercel/blob');
            if (scrapeOk) {
              Object.keys(freshSlugWords).forEach(function(k) { ownTitleWordSets.push(new Set(freshSlugWords[k])); });
              ownHeadlines = ownSlugTexts.slice(0, 40);
              blocklistSource = 'live (' + freshCount + ')';
              // Best-effort persist; don't let a Blob hiccup affect the scan itself.
              blobMod.put('own-outlet-blocklist.json', JSON.stringify(Object.keys(freshSlugWords).map(function(k) { return freshSlugWords[k]; })), {
                access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json'
              }).catch(function() {});
            } else {
              var cached = await blobMod.get('own-outlet-blocklist.json', { access: 'private', useCache: false }).catch(function() { return null; });
              if (cached && cached.statusCode === 200) {
                var cachedWords = await new Response(cached.stream).json();
                (cachedWords || []).forEach(function(words) { ownTitleWordSets.push(new Set(words)); });
                ownHeadlines = (cachedWords || []).slice(0, 40).map(function(words) { return words.join(' '); });
                blocklistSource = 'cached fallback (' + (cachedWords || []).length + ') — live scrape returned status ' + results[gi].value.status + ' with ' + freshCount + ' links';
              } else {
                blocklistSource = 'UNAVAILABLE — live scrape status ' + results[gi].value.status + ', no cached fallback';
              }
            }
          } catch (e) { blocklistSource = 'error: ' + e.message; }
          continue;
        }
        // Google Alerts delivers Atom (<entry>), not RSS 2.0 (<item>) — different tags.
        var items = cfg.isAtom
          ? (xml.match(/<entry>[\s\S]*?<\/entry>/g) || [])
          : (xml.match(/<item>[\s\S]*?<\/item>/g) || []);
        items.forEach(function(item) {
          var title, link, src, srcUrl, pubDate, desc, realUrl, snippet;
          if (cfg.isAtom) {
            title = (item.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '';
            link = (item.match(/<link[^>]*href="([^"]*)"/) || [])[1] || '';
            src = cfg.src || 'Google Alerts';
            srcUrl = '';
            pubDate = (item.match(/<published>(.*?)<\/published>/) || item.match(/<updated>(.*?)<\/updated>/) || [])[1] || '';
            desc = (item.match(/<content[^>]*>([\s\S]*?)<\/content>/) || [])[1] || '';
            // Google Alerts wraps the real URL: .../url?...&url=<encoded>&...
            var gaUrl = link.replace(/&amp;/g, '&').match(/[?&]url=([^&]+)/);
            realUrl = gaUrl ? decodeURIComponent(gaUrl[1]) : link;
            snippet = desc.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
              .replace(/&amp;/g, '&').replace(/&#?[a-z0-9]+;/gi, ' ')
              .replace(/\s+/g, ' ').trim().slice(0, 320);
            if (!title) return;
            title = title.trim();
            if ((cfg.requireBeat || cfg.requireTerps) && !B.isRelevant(beat, title + ' ' + snippet)) return;
            var gaAge = pubDate ? Math.round((Date.now() - new Date(pubDate).getTime()) / 3600000) : 0;
            if (pubDate && new Date(pubDate).getTime() < googleCutoff) return;
            if (excluded.some(function(ex) { return src.toLowerCase().includes(ex) || title.toLowerCase().includes(ex) || realUrl.toLowerCase().includes(ex); })) return;
            stories.push({ title: title.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>'), source: src, url: (realUrl || link).trim(), age: gaAge, snippet: snippet });
            return;
          }
          title = (item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || item.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
          link = (item.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
          src = (item.match(/<source[^>]*>(.*?)<\/source>/) || [])[1] || cfg.src || 'Google News';
          srcUrl = (item.match(/<source[^>]*url="([^"]*)"/) || [])[1] || '';
          pubDate = (item.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || '';
          // Extract real article URL from description (Google News embeds it there)
          desc = (item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) || item.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '';
          realUrl = (desc.match(/href="(https?:\/\/[^"]+)"/) || [])[1] || link;
          // Bing wraps the real publisher URL in an apiclick redirect: ...&url=<encoded>&...
          var bingUrl = (link + ' ' + realUrl).replace(/&amp;/g, '&').match(/[?&]url=(https?%3[Aa][^&"\s<]+)/);
          if (bingUrl) { try { realUrl = decodeURIComponent(bingUrl[1]); } catch (e) {} }
          // Plain-text snippet from the feed (Bing + direct site feeds carry a real one;
          // Google News descriptions are just "<a>Title</a> Publisher" and get skipped)
          snippet = '';
          var rawSnip = desc;
          var ce = (item.match(/<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/) || [])[1];
          if (ce && ce.length > desc.length) rawSnip = ce;
          if (rawSnip && !/^\s*<a\s+href/i.test(rawSnip)) {
            snippet = rawSnip.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
              .replace(/&amp;/g, '&').replace(/&#?[a-z0-9]+;/gi, ' ')
              .replace(/\s+/g, ' ').trim().slice(0, 320);
          }
          if (!title) return;
          title = title.trim();
          // Auto-generated stat / box-score / live-score stub pages (FOX Sports etc.) are
          // never news — a real recap has analysis in the headline, not "Live Score".
          if (/\bstats?\s*(?:&|&amp;|and)\s*leaders?\b|\bstat leaders?\b|\bsplit stats?\b|\blive score\b|\bbox score\b|\bscoreboard\b|\bplay[- ]by[- ]play\b|\bfinal score\b/i.test(title)) return;
          // Generic team/player index pages (2026-09-21, Jeff: "we don't want static
          // pages with stats or no new info") — Google News occasionally indexes a
          // site's own team-hub or player-stub page (e.g. "St. Frances Academy
          // Panthers News", "Malik Washington Stats") instead of an actual article.
          // A real headline is a sentence with something happening in it; these are
          // just "<name> <category word>" with nothing else.
          if (/^[\w.' -]{2,60} (News|Stats?|Splits?|Schedule|Roster|Standings)$/i.test(title)) return;
          // Some direct feeds carry the whole publication — require beat relevance
          if ((cfg.requireBeat || cfg.requireTerps) && !B.isRelevant(beat, title + ' ' + desc)) return;
          var age = pubDate ? Math.round((Date.now() - new Date(pubDate).getTime()) / 3600000) : 0;
          if (pubDate && new Date(pubDate).getTime() < googleCutoff) return;
          if (excluded.some(function(ex) { return src.toLowerCase().includes(ex) || srcUrl.toLowerCase().includes(ex) || title.toLowerCase().includes(ex) || realUrl.toLowerCase().includes(ex); })) return;
          stories.push({ title: title.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>'), source: src, url: (realUrl || link).trim(), age: age, snippet: snippet });
        });
      } catch(e) { /* skip failed feed */ }
    }

    // Report every source's outcome (status, items, stories kept) to source health.
    try {
      var keptAfter = {};
      var names = redditFetches.map(function (f) { return f; }).concat(feedConfigs);
      // stories were appended in fetch order, so a feed's kept count is the
      // growth between its start and the next feed's start
      var order = names.map(function (f) { return f.name; }).filter(function (n) { return feedStats[n]; });
      order.forEach(function (n, k) {
        var next = k + 1 < order.length ? feedStats[order[k + 1]].before : stories.length;
        keptAfter[n] = Math.max(0, next - feedStats[n].before);
      });
      await SH.record(names.map(function (f, k) {
        var r = results[k];
        var st = feedStats[f.name] || {};
        return { name: f.name, url: f.url, healedFrom: f.healedFrom, status: r && r.status === 'fulfilled' ? r.value.status : 'FAILED',
          items: f.scrapeSlugs ? (ownHeadlines.length || 0) : (st.items || 0), kept: keptAfter[f.name] || 0 };
      }));
    } catch (e) { console.error('source health record failed:', e.message); }

    // Real, open-ended web search alongside the ~70 curated RSS queries above
    // — opt-in per caller (body.webSearch), set only by rolling-digest.js's
    // 3x/day cron, never by the client-side "Scan now" button / 30-min
    // auto-scan, since it's metered (Brave dropped its free tier). See _web-search.js.
    var webSearchCount = 0, webSearchWarnings = [];
    if (body.webSearch) {
      try {
        var S = require('./_supabase.js');
        if (S.isConfigured()) {
          var webSearchCreds = await require('./_settings-store.js').getWebSearch(S.admin());
          if (webSearchCreds) {
            var searchResult = await require('./_web-search.js').searchNews(webSearchCreds.apiKey);
            searchResult.results.forEach(function(item) { stories.push(item); });
            webSearchCount = searchResult.results.length;
            webSearchWarnings = searchResult.warnings;
          }
        }
      } catch (e) { webSearchWarnings.push(e.message); }
    }

    // Fast social-first search (X/Twitter) — catches viral/breaking beat
    // conversation before any RSS feed or news site covers it. Opt-in per
    // caller (body.xSearch), set only by api/x-scan.js's own ~30-min cron —
    // never the client-side "Scan now" / 30-min auto-scan, same reasoning as
    // webSearch above (metered, keep the cost predictable). See _x-search.js.
    var xSearchCount = 0, xSearchWarnings = [];
    if (body.xSearch) {
      try {
        var S2 = require('./_supabase.js');
        if (S2.isConfigured()) {
          var xSearchCreds = await require('./_settings-store.js').getXSearch(S2.admin());
          if (xSearchCreds) {
            var xResult = await require('./_x-search.js').searchX(xSearchCreds.bearerToken, body.xStorylines, body.xWatchHandles);
            xResult.results.forEach(function(item) { stories.push(item); });
            xSearchCount = xResult.results.length;
            xSearchWarnings = xResult.warnings;
          }
        }
      } catch (e) { xSearchWarnings.push(e.message); }
    }

    // Second, complementary web search (Google Programmable Search,
    // site-restricted — see _google-search.js for why it can't be whole-web).
    // Same opt-in/cadence reasoning as webSearch above; set alongside it by
    // rolling-digest.js's 3x/day cron.
    var googleSearchCount = 0, googleSearchWarnings = [];
    if (body.googleSearch) {
      try {
        var S3 = require('./_supabase.js');
        if (S3.isConfigured()) {
          var googleSearchCreds = await require('./_settings-store.js').getGoogleSearch(S3.admin());
          if (googleSearchCreds) {
            var googleResult = await require('./_google-search.js').searchNews(googleSearchCreds.apiKey, googleSearchCreds.engineId);
            googleResult.results.forEach(function(item) { stories.push(item); });
            googleSearchCount = googleResult.results.length;
            googleSearchWarnings = googleResult.warnings;
          }
        }
      } catch (e) { googleSearchWarnings.push(e.message); }
    }

    // Drop stories that originated on our own outlet (matched by headline against the blocklist feed)
    var ownFiltered = 0;
    stories = stories.filter(function(s) {
      if (isOwnOutletTitle(s.title)) { ownFiltered++; return false; }
      return true;
    });

    // Drop evergreen pages that only look new: single-play video clips, box
    // scores, stat and player-profile pages, team hubs (see _static-pages.js).
    // X posts are left alone; YouTube videos are added after this point.
    var staticFiltered = 0;
    stories = stories.filter(function(s) {
      if (s.source && s.source.charAt(0) === '@') return true;
      if (require('./_static-pages.js').isStaticPage(s.url, s.title)) { staticFiltered++; return false; }
      return true;
    });

    // Prefer a real (fetchable) publisher URL over a Google News redirect when the same
    // story appears from multiple feeds. Stable sort keeps age order within each group;
    // the "keep first" dedup below then keeps the real-URL copy.
    stories.sort(function(a, b) {
      return (/news\.google\.com/i.test(a.url) ? 1 : 0) - (/news\.google\.com/i.test(b.url) ? 1 : 0);
    });

    // Deduplicate by title similarity. When the same story shows up from multiple feeds,
    // keep the first but upgrade its URL/snippet from a later copy that has a real
    // (fetchable, non-Google-redirect) link or a real article snippet — the deep-read
    // pass needs those.
    var seenIdx = {};
    var deduped = [];
    stories.forEach(function(s) {
      var norm = normTitle(s.title);
      if (seenIdx[norm] === undefined) {
        seenIdx[norm] = deduped.length;
        deduped.push(s);
        return;
      }
      var kept = deduped[seenIdx[norm]];
      if (/news\.google\.com/i.test(kept.url) && !/news\.google\.com/i.test(s.url)) kept.url = s.url;
      if (!kept.snippet && s.snippet) kept.snippet = s.snippet;
    });
    stories = deduped;

    // Cap at the most recent N before sending to Claude. Raised 55 → 110: with
    // ~120 feeds the old cap discarded a lot of legitimate but slightly-older
    // stories purely on recency before they were ever rated.
    stories = stories.sort(function(a, b) { return a.age - b.age; }).slice(0, 110);

    // X-only pass (api/x-scan.js's 30-min cron): rate just the X posts. It used
    // to send all ~110 news stories through the Claude rating call every 30
    // minutes alongside a couple of X posts, re-rating the same articles the
    // 3x/day digest already covers. That was most of the Anthropic bill
    // (Jeff, 2026-10-02). No X posts this run → no Claude call at all.
    if (body.xOnly) {
      stories = stories.filter(function(s) { return s.source && s.source.charAt(0) === '@'; });
      if (!stories.length) {
        return res.status(200).json({ content: [{ type: 'text', text: '[]' }], overflow: [], videos: [], sources: [] });
      }
    }

    // Pull in YouTube videos (already quality-filtered by youtube.js — subs, AI-spam,
    // content-farm) and let the same Claude pass rate them for news value. High-rated
    // videos surface in the main feed / digest; the rest stay in the YouTube tab.
    var videoCount = 0;
    if (!body.xOnly) try {
      var ytHandler = require('./youtube.js');
      var ytQuery = { batch: '4' };
      if (userBlocked.length) ytQuery.blocked = userBlocked.join(',');
      var ytData = await new Promise(function(resolve) {
        ytHandler({ query: ytQuery }, { status: function() { return this; }, json: function(d) { resolve(d); return this; } }).catch(function() { resolve({}); });
      });
      (ytData.videos || []).slice(0, 25).forEach(function(v) {
        stories.push({
          title: v.title, source: v.channel || 'YouTube', url: v.url,
          age: v.age || 0, snippet: (v.description || '').slice(0, 320),
          kind: 'video', thumbnail: v.thumbnail || '', channel: v.channel || ''
        });
        videoCount++;
      });
    } catch (e) { /* YouTube is optional */ }

    var redditCount = stories.filter(function(s){return s.source.includes('Reddit');}).length;
    var googleCount = stories.filter(function(s){return !s.source.includes('Reddit') && s.kind !== 'video';}).length;
    var allNames = redditFetches.map(function(f) { return f.name; }).concat(feedConfigs.map(function(f) { return f.name; }));
    var fetchStatuses = results.map(function(r, i) {
      return allNames[i] + ':' + (r.status === 'fulfilled' ? r.value.status : 'FAILED');
    });
    console.log('Stories:', stories.length, '| Reddit:', redditCount, '| Google:', googleCount, '| YouTube:', videoCount, '| WebSearch:', webSearchCount, (webSearchWarnings.length ? '(' + webSearchWarnings.join('; ') + ')' : ''), '| XSearch:', xSearchCount, (xSearchWarnings.length ? '(' + xSearchWarnings.join('; ') + ')' : ''), '| GoogleSiteSearch:', googleSearchCount, (googleSearchWarnings.length ? '(' + googleSearchWarnings.join('; ') + ')' : ''), '| Own-outlet filtered:', ownFiltered, '| Static pages filtered:', staticFiltered, '| Blocklist size:', ownTitleWordSets.length, '| Blocklist source:', blocklistSource, '| Fetches:', fetchStatuses.join(', '));

    if (!stories.length) {
      var diagMsg = 'No stories found. Fetch results: ' + fetchStatuses.join(', ');
      return res.status(200).json({ error: diagMsg });
    }

    // Build numbered list for Claude — include the feed snippet where we have one
    var storyList = stories.map(function(s, i) {
      var line = (i + 1) + '. ' + (s.kind === 'video' ? '[VIDEO] ' : '') + '[' + s.source + '] ' + s.title + ' (' + s.age + 'h ago)';
      if (s.followUp) line += '\n   [DEVELOPING STORY WE ARE ACTIVELY COVERING: ' + s.followUp + ' — do NOT let this tag alone push the rating up. Only treat it as newsworthy despite low engagement if it is a genuine NEW development (a status actually changed, a real update). Reaction, analysis, jokes, or commentary about something that already fully happened rates exactly like any other social post — usually 1-2 — the tag is not a rating boost.]';
      if (s.watchedAccount) line += '\n   [WATCHED ACCOUNT: the publisher has specifically curated this X account as a credible ' + beat.team.short + ' beat source — do not downrate for low/no engagement or unfamiliarity, judge purely on newsworthiness]';
      if (s.snippet) line += '\n   snippet: ' + s.snippet;
      return line;
    }).join('\n');

    var flaggedNote = '';
    var flagged = (body.flagged || []).slice(-30);
    if (flagged.length) {
      flaggedNote = '\n\nThe editor has FLAGGED these recent stories as junk/irrelevant. Mark any similar stories (same subject, same kind of noise, same unrelated namesake) as irrelevant:true:\n' + flagged.map(function(f) { return '- [' + f.source + '] ' + f.headline; }).join('\n');
    }

    var today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    var prompt = B.ratingPrompt(beat, today);
    // Split so the ~250-name watch list + all the editorial rules above (identical on
    // every call) can be prompt-cached, and only the story list + flagged-junk note
    // (different every scan) gets sent fresh. Cuts real wall-clock time on every run
    // after the first cache write (Jeff, 2026-09-21: scans taking ~5 min).
    // Every scan (dashboard, digests, X scan): tell the rater what
    // InsideMDSports itself has already published, so stories we've already
    // covered aren't re-flagged as breaking, real gaps rate up, and our own
    // beat priorities shape the scores (Jeff, 2026-10-02). Reuses the 247
    // landing-page scrape the own-outlet filter already does — no extra fetch.
    // Newsroom profile from the setup wizard (/setup): the publisher's own
    // breaking rules, sports priorities and extra names. Best-effort — no
    // profile means the built-in rules above apply unchanged.
    var siteProfile = {};
    try {
      if (SB.isConfigured()) siteProfile = await require('./_settings-store.js').getProfile(SB.admin());
    } catch (e) { siteProfile = {}; }
    var profileNote = require('./_rating-rules.js').promptBlock(siteProfile);

    var ownCoverageNote = '';
    if (ownHeadlines.length) {
      ownCoverageNote = '\n\nOUR OWN RECENT COVERAGE — the latest articles ' + beat.outletName + ' has published (taken from article URLs, so wording is approximate):\n' +
        ownHeadlines.map(function(h) { return '- ' + h; }).join('\n') +
        '\n\nUse this to judge each story against what we have already done:\n' +
        '- ALREADY COVERED: if a story is about something we already published, it is not breaking for us. Rate it on whether it adds a genuinely new fact beyond our article; if not, cap it at 2.\n' +
        '- FOLLOW-UP TO OUR STORY: a genuinely new development on something we covered (a status change, a decision, a new quote that moves it forward) is a natural next story for us. Rate it one point higher than you otherwise would, up to the normal ceiling for that kind of event.\n' +
        '- GAP: a real ' + beat.team.short + ' story other outlets have that we have NOT covered is valuable. Rate it at least 3 if it is genuine ' + beat.team.short + ' news, and note "not yet covered by us" at the end of its summary.\n' +
        '- OUR BEAT: topics we publish on often (judge from the list above) are core beat. A borderline story on a core-beat topic can rate one point higher; a topic we never cover stays where the normal rules put it.\n' +
        'All of the NOT BREAKING, FOLLOW-UP COVERAGE and LOW-PRIORITY SPORTS rules above still apply and take precedence.';
    }
    // Editors' own 1-5 ratings (News Monitor cards and email links) teach the rater.
    var editorNote = '';
    try { editorNote = await require('./_story-ratings.js').promptNote(); } catch (e) {}
    var dynamicPrompt = flaggedNote + ownCoverageNote + profileNote + B.weightNote(beat) + editorNote + '\n\nStories:\n' + storyList;

    var cr = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 20000,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: dynamicPrompt }
          ]
        }]
      })
    });
    var cd = await cr.json();

    // Expose Claude API errors
    if (cd.error) return res.status(200).json({ error: 'Claude error: ' + JSON.stringify(cd.error) });
    if (!cd.content) return res.status(200).json({ error: 'Claude returned no content. Raw: ' + JSON.stringify(cd).substring(0, 300) });

    // Extract text from Claude response
    var text = cd.content.map(function(i) { return i.type === 'text' ? i.text : ''; }).join('\n');
    var cleaned = text.replace(/```json|```/g, '').trim();
    var start = cleaned.indexOf('[');
    var end = cleaned.lastIndexOf(']');
    if (start === -1 || end === -1) return res.status(200).json({ error: 'Claude did not return JSON. Response: ' + cleaned.substring(0, 300) });

    var parsed = JSON.parse(cleaned.substring(start, end + 1));

    // DEEP READ (digest runs only, body.deep === true): for stories the headline + snippet
    // couldn't settle (needsContext), resolve the Google News redirect if needed, fetch the
    // real article, and re-rate from its text.
    if (body.deep === true) {
      var deepCandidates = parsed
        .map(function(item) { return { item: item, orig: stories[item.idx - 1] }; })
        .filter(function(p) { return p.item && p.item.needsContext && p.orig && p.orig.url; })
        .slice(0, 6);

      if (deepCandidates.length) {
        // Resolve any Google News redirects to real publisher URLs (and keep them for output)
        await Promise.allSettled(deepCandidates.map(function(p) {
          if (!/news\.google\.com/i.test(p.orig.url)) return Promise.resolve();
          return resolveGoogleNewsUrl(p.orig.url).then(function(real) {
            if (real) { p.resolved = real; p.orig.url = real; }
          }).catch(function() {});
        }));

        var fetched = await Promise.allSettled(deepCandidates.map(function(p) {
          if (/news\.google\.com/i.test(p.orig.url)) return Promise.resolve('');
          return fetchWithTimeout(p.orig.url, { headers: { 'User-Agent': BROWSER_UA } }, 10000)
            .then(function(r) { return r.text(); })
            .then(function(html) {
              return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
                .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
                .replace(/&#?[a-z0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 2800);
            })
            .catch(function() { return ''; });
        }));

        var deepList = deepCandidates.map(function(p, k) {
          var art = fetched[k].status === 'fulfilled' ? fetched[k].value : '';
          return p.item.idx + '. [' + p.item.source + '] ' + p.item.headline + '\nARTICLE TEXT: ' + (art || '(could not fetch — judge from headline)');
        }).join('\n\n');

        var deepPrompt = B.deepPrompt(beat) + deepList;

        try {
          var dr = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 4000, messages: [{ role: 'user', content: deepPrompt }] })
          });
          var dd = await dr.json();
          var dtext = (dd.content || []).map(function(i) { return i.type === 'text' ? i.text : ''; }).join('\n');
          var dmatch = dtext.match(/\[[\s\S]*\]/);
          if (dmatch) {
            var byIdx = {};
            JSON.parse(dmatch[0]).forEach(function(d) { byIdx[d.idx] = d; });
            parsed.forEach(function(item) {
              var d = byIdx[item.idx];
              if (!d) return;
              if (typeof d.rating === 'number') item.rating = d.rating;
              if (typeof d.irrelevant === 'boolean') item.irrelevant = d.irrelevant;
              if (d.summary) item.summary = d.summary;
              if (d.category) item.category = d.category;
              if (d.sport) item.sport = d.sport;
              item.deepened = true;
            });
          }
        } catch (e) { /* deep pass is best-effort — keep the headline ratings */ }
      }
    }

    // Drop stories Claude marked as having no connection to our beat
    parsed = parsed.filter(function(item) { return !item.irrelevant; });

    // Final backstop for our own outlet: the deep-read pass resolves Google News
    // redirects to real publisher URLs, so a 247sports.com / insidemdsports.com link
    // that slipped past the source-label filter (mislabeled feed, reworded headline)
    // is catchable here by its now-resolved URL.
    var ownDomainRe = B.ownDomainRegex(beat);
    if (ownDomainRe) parsed = parsed.filter(function(item) {
      var orig = stories[item.idx - 1];
      var u = (orig && orig.url ? orig.url : '').toLowerCase();
      return !ownDomainRe.test(u);
    });

    // Editorial rule: sports we almost never write about are always filler (rating 1),
    // regardless of how Claude rated them.
    // A publisher's own "never cover" sports from the setup wizard replace this default list.
    var LOW_PRIORITY_SPORTS = require('./_rating-rules.js').ignoreSportsRegex(siteProfile) || B.lowPriorityRegex(beat);
    if (LOW_PRIORITY_SPORTS) parsed.forEach(function(item) {
      var t = ((item.headline || '') + ' ' + (item.summary || '')).toLowerCase();
      if (LOW_PRIORITY_SPORTS.test(t)) { item.rating = 1; item.lowPriority = true; }
    });

    // Re-attach URLs (and video metadata) by idx
    var withUrls = parsed.map(function(item) {
      var orig = stories[item.idx - 1];
      var extra = { url: orig ? orig.url : '', ageHours: orig ? orig.age : null };
      if (orig && orig.kind === 'video') { extra.kind = 'video'; extra.thumbnail = orig.thumbnail || ''; extra.channel = orig.channel || ''; }
      if (orig && orig.followUp) extra.followUp = orig.followUp;
      if (orig && orig.watchedAccount) extra.watchedAccount = true;
      return Object.assign({}, item, extra);
    });

    // Apply per-topic caps POST-rating so the most newsworthy stories stay in main feed.
    // Alumni get a tight cap of 1 main-feed slot PER PERSON (identified from the watch
    // lists so "DJ Moore" etc. match regardless of headline wording); the rest go to
    // overflow with a "More on this" link. General Terps topics still get 3.
    // Check original titles (not Claude's rewrites) for reliable name detection.
    var alumniWatch = B.alumniNames(beat)
      .map(function(name) { return { display: name, lc: name.toLowerCase() }; });
    // Videos are rated in the same pass but don't go through the article topic caps.
    var videoItems = withUrls.filter(function(it) { return it.kind === 'video' && !it.irrelevant; });
    var articleItems = withUrls.filter(function(it) { return it.kind !== 'video'; });

    var topicStop = B.topicStopRegex(beat);
    var topicRatingCount = {};
    var overflowStories = [];
    // Sort by rating desc so highest-rated stories claim their topic slots first
    var sortedByRating = articleItems.slice().sort(function(a, b) { return (b.rating || 0) - (a.rating || 0); });
    var mainIds = new Set();
    var alumniTopics = {};
    var claimedBy = {}; // topic -> idx of the main-feed item holding that slot (highest-rated, since pre-sorted)
    sortedByRating.forEach(function(item) {
      var orig = stories[item.idx - 1];
      var originalTitle = orig ? orig.title : (item.headline || '');
      var overflowTopic = null;
      var itemTopics = [];

      if (item.category === 'alumni') {
        // Identify which alum the story is about; cap that person at 1/scan.
        var lc = (originalTitle + ' ' + (item.headline || '') + ' ' + (item.summary || '')).toLowerCase();
        var who = null;
        for (var ai = 0; ai < alumniWatch.length; ai++) {
          if (lc.indexOf(alumniWatch[ai].lc) !== -1) { who = alumniWatch[ai].display; break; }
        }
        // Fall back to a two-word name if the alum isn't on a watch list
        if (!who) {
          var m = (originalTitle.match(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/g) || [])
            .filter(function(t) { return !topicStop.test(t); })[0];
          who = m || 'alumni';
        }
        itemTopics = [who];
        alumniTopics[who] = true;
        topicRatingCount[who] = (topicRatingCount[who] || 0) + 1;
        if (topicRatingCount[who] > 1) overflowTopic = who;
      } else {
        // Two-word capitalized phrases, minus team/org/place names ("Maryland Athletics",
        // "Maryland Terrapins", "College Football", "Big Ten"...) — those aren't people and
        // shouldn't spawn a "More on <topic>" grouping; sport sections already handle them.
        itemTopics = (originalTitle.match(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/g) || [])
          .filter(function(t) { return !topicStop.test(t); });
        for (var n of itemTopics) {
          topicRatingCount[n] = (topicRatingCount[n] || 0) + 1;
          var cap = alumniTopics[n] ? 1 : 3;
          if (topicRatingCount[n] > cap) overflowTopic = n;
        }
      }

      if (overflowTopic) {
        overflowStories.push({ title: item.headline, source: item.source, url: item.url, age: orig ? orig.age : 0, trendingTopic: overflowTopic });
      } else {
        mainIds.add(item.idx);
        itemTopics.forEach(function(t) { if (!claimedBy[t]) claimedBy[t] = item.idx; });
      }
    });

    var final = articleItems.filter(function(item) { return mainIds.has(item.idx); });

    // High-value videos (rating 4+) join the main feed / digest; every rated video is
    // returned separately for the YouTube tab.
    var ratedVideos = videoItems.filter(function(v) { return !v.republished; })
      .sort(function(a, b) { return (b.rating || 0) - (a.rating || 0) || (a.time || '').localeCompare(b.time || ''); });
    ratedVideos.forEach(function(v) { if ((v.rating || 0) >= 4) final.push(v); });

    // Tag the main-feed item that holds each overflowing topic's slot with a "+N more" count.
    var overflowCountByTopic = {};
    overflowStories.forEach(function(s) {
      overflowCountByTopic[s.trendingTopic] = (overflowCountByTopic[s.trendingTopic] || 0) + 1;
    });
    Object.keys(overflowCountByTopic).forEach(function(topic) {
      var holderIdx = claimedBy[topic];
      if (!holderIdx) return;
      var holder = final.filter(function(it) { return it.idx === holderIdx; })[0];
      if (holder && !holder.trendingTopic) {
        holder.trendingTopic = topic;
        holder.overflowCount = overflowCountByTopic[topic];
      }
    });

    return res.status(200).json({ content: [{ type: 'text', text: JSON.stringify(final) }], overflow: overflowStories, videos: ratedVideos, sources: fetchStatuses });

  } catch(e) {
    console.error('Scan error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
