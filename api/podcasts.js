module.exports = async function handler(req, res) {
  // Free approach: resolve podcast RSS feeds via iTunes Search API (no key needed),
  // then parse each feed directly. No ListenNotes dependency.

  // Shows that are entirely Terps-focused: include every recent episode.
  var terpsShows = [
    'Locked On Terps',
    'Testudo Times Podcast'
  ];

  // Regional DC/Baltimore shows: include only episodes that mention Terps/Maryland.
  var regionalShows = [
    'The Kevin Sheehan Show',
    'The Sports Junkies',
    'Grant and Danny',
    '95 Connected Baltimore Maryland Sports',
    'Glenn Clark Radio',
    'BMitch & Finlay',
    'District of Sports DC',
    'The Solid Verbal College Football',
    'Eye on College Basketball',
    'Josh Pate College Football Show',
    'Andy & Ari On3',
    'Cover 3 College Football',
    'The Field of 68 After Dark',
    'Locked On Big Ten',
    'The Next Round',
    'Fear the Turtle Podcast',
    'The Athletic College Football Show',
    'Sports Wave Baltimore'
  ];

  var keywords = ['terps', 'terrapins', 'maryland football', 'maryland basketball', 'maryland lacrosse', 'maryland recruiting', 'mike locksley', 'buzz williams', 'kevin willard', 'brenda frese', 'university of maryland'];
  var cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000; // 14 days

  function matchesKeywords(text) {
    var t = (text || '').toLowerCase();
    return keywords.some(function(k) { return t.includes(k); });
  }

  async function resolveFeed(showName) {
    try {
      var r = await fetch('https://itunes.apple.com/search?term=' + encodeURIComponent(showName) + '&media=podcast&limit=1');
      if (!r.ok) return null;
      var d = await r.json();
      var top = (d.results || [])[0];
      return top ? { feedUrl: top.feedUrl, title: top.collectionName } : null;
    } catch(e) { return null; }
  }

  function parseFeed(xml, showTitle, requireKeywords) {
    var out = [];
    var items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    items.slice(0, 15).forEach(function(item) {
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
      var r = await fetch('https://itunes.apple.com/search?term=' + encodeURIComponent(term) + '&media=podcast&entity=podcastEpisode&limit=15');
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
    var allShows = terpsShows.map(function(s) { return { name: s, requireKeywords: false }; })
      .concat(regionalShows.map(function(s) { return { name: s, requireKeywords: true }; }));

    var resolved = await Promise.allSettled(allShows.map(function(s) { return resolveFeed(s.name); }));

    var feedFetches = resolved.map(function(r, i) {
      if (r.status !== 'fulfilled' || !r.value || !r.value.feedUrl) return null;
      return fetch(r.value.feedUrl).then(function(fr) { return fr.text(); }).then(function(xml) {
        return { xml: xml, title: r.value.title, requireKeywords: allShows[i].requireKeywords };
      }).catch(function() { return null; });
    });

    var discoveryTerms = ['Maryland Terrapins', 'Terps basketball', 'Terps football', 'Maryland Terrapins recruiting'];
    var discoveryResults = await Promise.all(discoveryTerms.map(discoverEpisodes));

    var feeds = await Promise.all(feedFetches);

    var episodes = [];
    feeds.forEach(function(f) {
      if (!f || !f.xml) return;
      episodes = episodes.concat(parseFeed(f.xml, f.title, f.requireKeywords));
    });
    discoveryResults.forEach(function(list) {
      list.forEach(function(ep) {
        // Discovery results must actually mention Maryland/Terps to avoid noise
        if (matchesKeywords(ep.title + ' ' + ep.description + ' ' + ep.podcast)) episodes.push(ep);
      });
    });

    // Dedupe by title
    var seen = [];
    episodes = episodes.filter(function(ep) {
      var norm = ep.title.toLowerCase().replace(/[^a-z0-9 ]/g, '').substring(0, 60);
      if (seen.includes(norm)) return false;
      seen.push(norm);
      return true;
    });

    episodes.sort(function(a, b) { return a.age - b.age; });

    return res.status(200).json({ episodes: episodes });
  } catch(e) {
    return res.status(500).json({ episodes: [], error: e.message });
  }
};
