var searchRotation = 0;

module.exports = async function handler(req, res) {
  var key = process.env.YOUTUBE_API_KEY;
  if (!key) return res.status(200).json({ videos: [], error: 'YOUTUBE_API_KEY not set — add it in Vercel environment variables' });

  var cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  var allTerms = [
    'Maryland Terrapins football',
    'Maryland Terrapins basketball',
    'Maryland Terrapins recruiting',
    'Terps football',
    'Terps basketball',
    'Mike Locksley',
    'Buzz Williams Maryland',
    'Malik Washington Maryland',
    'Baba Oladotun',
    'DJ Wagner Maryland',
    'Derik Queen',
    'Maryland Terrapins lacrosse'
  ];

  // Rotate 4 terms per request to conserve quota (search costs 100 units each)
  var batchSize = 4;
  var startIdx = (searchRotation * batchSize) % allTerms.length;
  searchRotation++;
  var terms = [];
  for (var i = 0; i < batchSize; i++) {
    terms.push(allTerms[(startIdx + i) % allTerms.length]);
  }

  var keywords = ['terps', 'terrapins', 'maryland', 'locksley', 'buzz williams', 'oladotun', 'derik queen', 'dj wagner'];
  function matchesKeywords(text) {
    var t = (text || '').toLowerCase();
    return keywords.some(function(k) { return t.includes(k); });
  }

  var excluded = ['insidemd', 'jeff ermann', 'ims radio', 'insidetheshell'];
  // Video game / simulation content
  var gamingTerms = ['college football 27', 'college football 26', 'cfb27', 'cfb 27', 'cfb26', 'dynasty', 'road to glory', 'simulation', 'sim ', 'ea sports', 'gameplay', 'gaming', 'franchise mode', 'restream', 'twitch', 'madden', 'nba 2k', '2k26', '2k27'];
  function isGaming(text) {
    var t = (text || '').toLowerCase();
    return gamingTerms.some(function(g) { return t.includes(g); });
  }

  try {
    var searches = terms.map(function(term) {
      var url = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=date&maxResults=10&publishedAfter=' + encodeURIComponent(cutoff) + '&q=' + encodeURIComponent(term) + '&key=' + key;
      return fetch(url).then(function(r) { return r.json(); }).catch(function() { return {}; });
    });

    var results = await Promise.all(searches);

    var videos = [];
    var seen = [];
    var apiError = null;

    results.forEach(function(data) {
      if (data.error) { apiError = data.error.message || 'YouTube API error'; return; }
      (data.items || []).forEach(function(item) {
        var sn = item.snippet;
        if (!sn || !item.id || !item.id.videoId) return;
        var title = (sn.title || '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
        var channel = sn.channelTitle || '';
        var desc = sn.description || '';
        var text = title + ' ' + desc + ' ' + channel;
        if (!matchesKeywords(text)) return;
        if (excluded.some(function(ex) { return text.toLowerCase().includes(ex); })) return;
        if (isGaming(text)) return;
        var norm = title.toLowerCase().replace(/[^a-z0-9 ]/g, '').substring(0, 60);
        if (seen.includes(norm)) return;
        seen.push(norm);
        var pubMs = sn.publishedAt ? new Date(sn.publishedAt).getTime() : 0;
        videos.push({
          title: title,
          channel: channel,
          url: 'https://www.youtube.com/watch?v=' + item.id.videoId,
          thumbnail: (sn.thumbnails && sn.thumbnails.medium && sn.thumbnails.medium.url) || '',
          age: pubMs ? Math.round((Date.now() - pubMs) / 3600000) : 0,
          description: desc.substring(0, 150)
        });
      });
    });

    videos.sort(function(a, b) { return a.age - b.age; });

    if (!videos.length && apiError) return res.status(200).json({ videos: [], error: apiError });
    return res.status(200).json({ videos: videos, searched: terms });
  } catch(e) {
    return res.status(500).json({ videos: [], error: e.message });
  }
};
