// Module-level caches survive across warm invocations, cutting iTunes API calls
var feedUrlCache = {};
var discoveryRotation = 0;

module.exports = async function handler(req, res) {
  // Free approach: resolve podcast RSS feeds via iTunes Search API (no key needed),
  // then parse each feed directly. No ListenNotes dependency.
  // iTunes limits ~20 requests/min per IP, so we cache feed URLs and rotate discovery terms.

  // Which shows, keywords and discovery searches: built from the newsroom's
  // beat profile so they follow its current people (_beat.searchPlan).
  // InsideMDSports' hand-picked beat shows, regional/national shows and
  // blocked shows are in its profile's searchExtras.
  await require('./_supabase').optionalUser(req);
  var S0 = require('./_supabase');
  var Beat = require('./_beat');
  var plan;
  try { plan = Beat.searchPlan(await Beat.getBeat(S0.isConfigured() ? S0.admin() : null)); }
  catch (e) { return res.status(500).json({ episodes: [], error: e.message }); }
  // Shows entirely about the beat: every recent episode.
  var beatShows = plan.podcastShows;
  // Regional and national shows: only episodes that mention the beat.
  var regionalShows = plan.regionalShows;
  // Shows to always leave out (e.g. auto-generated text-to-speech "news today" shows).
  var blockedPodcasts = plan.blockedPodcasts.slice();
  try {
    var extraBlocked = String((req.query && req.query.blocked) || '')
      .split(',').map(function(s) { return s.trim().toLowerCase(); }).filter(Boolean);
    blockedPodcasts = blockedPodcasts.concat(extraBlocked);
  } catch (e) { /* ignore */ }
  function isBlockedPodcast(name) {
    var n = (name || '').toLowerCase();
    return blockedPodcasts.some(function(b) { return b && n.includes(b); });
  }

  var keywords = plan.podcastKeywords;
  var cutoff = Date.now() - 21 * 24 * 60 * 60 * 1000; // 21 days (podcasts age slower than news)
  if (!beatShows.length && !plan.podcastDiscovery.length) return res.status(200).json({ episodes: [], error: 'Set up your beat first (/setup) so we know which shows to follow.' });

  function matchesKeywords(text) {
    var t = (text || '').toLowerCase();
    return keywords.some(function(k) { return t.includes(k); });
  }

  var debug = { resolved: 0, cachedFeeds: 0, failedResolves: 0, feedsFetched: 0, discoveryCalls: 0, discoveryHits: 0 };

  async function resolveFeed(showName) {
    if (feedUrlCache[showName]) { debug.cachedFeeds++; return feedUrlCache[showName]; }
    try {
      var r = await fetch('https://itunes.apple.com/search?term=' + encodeURIComponent(showName) + '&media=podcast&limit=1');
      if (!r.ok) { debug.failedResolves++; return null; }
      var d = await r.json();
      var top = (d.results || [])[0];
      if (!top || !top.feedUrl) { debug.failedResolves++; return null; }
      var entry = { feedUrl: top.feedUrl, title: top.collectionName };
      feedUrlCache[showName] = entry;
      debug.resolved++;
      return entry;
    } catch(e) { debug.failedResolves++; return null; }
  }

  function parseFeed(xml, showTitle, requireKeywords) {
    var out = [];
    var items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    items.slice(0, 25).forEach(function(item) {
      var title = (item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || item.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
      var desc = (item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) || item.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '';
      var link = (item.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
      var pubDate = (item.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
      title = title.trim();
      if (!title) return;
      var pubMs = pubDate ? new Date(pubDate).getTime() : 0;
      if (pubMs && pubMs < cutoff) return;
      var plainDesc = desc.replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').trim();
      if (requireKeywords && !matchesKeywords(title + ' ' + plainDesc)) return;
      var age = pubMs ? Math.round((Date.now() - pubMs) / 3600000) : 0;
      out.push({ title: title.replace(/&amp;/g,'&'), podcast: showTitle, url: link.trim(), age: age, description: plainDesc.substring(0, 150) });
    });
    return out;
  }

  // Discovery: search iTunes for episodes across ALL podcasts (free, no key)
  async function discoverEpisodes(term) {
    try {
      var r = await fetch('https://itunes.apple.com/search?term=' + encodeURIComponent(term) + '&media=podcast&entity=podcastEpisode&limit=25');
      if (!r.ok) return [];
      var d = await r.json();
      return (d.results || []).map(function(ep) {
        var pubMs = ep.releaseDate ? new Date(ep.releaseDate).getTime() : 0;
        if (pubMs && pubMs < cutoff) return null;
        var desc = (ep.description || '').replace(/<[^>]+>/g, '').trim();
        return {
          title: ep.trackName || '',
          podcast: ep.collectionName || '',
          url: ep.trackViewUrl || '',
          age: pubMs ? Math.round((Date.now() - pubMs) / 3600000) : 0,
          description: desc.substring(0, 150)
        };
      }).filter(function(ep) { return ep && ep.title; });
    } catch(e) { return []; }
  }

  try {
    var allShows = beatShows.map(function(s) { return { name: s, requireKeywords: false }; })
      .concat(regionalShows.map(function(s) { return { name: s, requireKeywords: true }; }));

    var resolved = await Promise.allSettled(allShows.map(function(s) { return resolveFeed(s.name); }));

    var feedFetches = resolved.map(function(r, i) {
      if (r.status !== 'fulfilled' || !r.value || !r.value.feedUrl) return null;
      return fetch(r.value.feedUrl).then(function(fr) { return fr.text(); }).then(function(xml) {
        return { xml: xml, title: r.value.title, requireKeywords: allShows[i].requireKeywords };
      }).catch(function() { return null; });
    });

    // Rotate through discovery terms 4 at a time to stay under iTunes rate limits
    var allDiscoveryTerms = plan.podcastDiscovery;
    var batchSize = 6;
    var startIdx = allDiscoveryTerms.length ? (discoveryRotation * batchSize) % allDiscoveryTerms.length : 0;
    discoveryRotation++;
    var discoveryTerms = [];
    for (var di = 0; di < Math.min(batchSize, allDiscoveryTerms.length); di++) {
      discoveryTerms.push(allDiscoveryTerms[(startIdx + di) % allDiscoveryTerms.length]);
    }
    debug.discoveryCalls = discoveryTerms.length;
    var discoveryResults = await Promise.all(discoveryTerms.map(discoverEpisodes));

    var feeds = await Promise.all(feedFetches);
    debug.feedsFetched = feeds.filter(function(f) { return f && f.xml; }).length;

    var episodes = [];
    feeds.forEach(function(f) {
      if (!f || !f.xml) return;
      episodes = episodes.concat(parseFeed(f.xml, f.title, f.requireKeywords));
    });
    discoveryResults.forEach(function(list) {
      list.forEach(function(ep) {
        var text = ep.title + ' ' + ep.description + ' ' + ep.podcast;
        // Discovery results must actually mention Maryland/Terps names to avoid noise
        if (!matchesKeywords(text)) return;
        // Same-name athletes elsewhere: only the profile's "name + word" noise
        // rules apply here (an episode mentioning our own outlet is fine).
        if (Beat.isNoise(text, plan.noise.filter(function (n) { return n.indexOf(' + ') !== -1; }))) return;
        debug.discoveryHits++;
        episodes.push(ep);
      });
    });

    // Drop episodes from blocked shows/sources
    episodes = episodes.filter(function(ep) { return !isBlockedPodcast(ep.podcast); });

    // Dedupe by title
    var seen = [];
    episodes = episodes.filter(function(ep) {
      var norm = ep.title.toLowerCase().replace(/[^a-z0-9 ]/g, '').substring(0, 60);
      if (seen.includes(norm)) return false;
      seen.push(norm);
      return true;
    });

    episodes.sort(function(a, b) { return a.age - b.age; });

    return res.status(200).json({ episodes: episodes, debug: debug });
  } catch(e) {
    return res.status(500).json({ episodes: [], error: e.message });
  }
};

// Per-newsroom: this request runs as the signed-in person's newsroom (_site.js).
module.exports = require('./_site').wrap(module.exports);
