var searchRotation = 0;

module.exports = async function handler(req, res) {
  var key = process.env.YOUTUBE_API_KEY;
  if (!key) return res.status(200).json({ videos: [], error: 'YOUTUBE_API_KEY not set — add it in Vercel environment variables' });

  var cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // 20 OR-groups mirroring the Google News queries. Names are paired with Maryland/Terps
  // context wherever ambiguity is possible so unrelated content (including cannabis "terps") is avoided.
  var allTerms = [
    '"Maryland Terrapins" | "Terps football" | "Terps basketball" | "Maryland Terrapins recruiting"',
    '"Maryland athletic director" | "SECU Stadium" | "Xfinity Center" | "Damon Evans Maryland" | "Jim Smith Maryland"',
    '"Mike Locksley" | "Pep Hamilton Maryland" | "Latrell Scott Maryland" | "Maryland football staff"',
    '"Malik Washington" Maryland | "Zahir Mathis" | "Dontay Joyner" | "Kyree Caldwell" | "Zeke Walkup"',
    '"Maryland football recruiting" | "Maryland football commits" | "Maryland official visit" | "James Branch" Maryland | "Dallas Pauldo"',
    '"Boomer Esiason" | "Vernon Davis" Maryland | "Stefon Diggs" | "Darnell Savage" | "DJ Moore" Bears',
    '"Shawne Merriman" | "LaMont Jordan" | "Jermaine Lewis" | "Torrey Smith" | "Randy Edsall"',
    '"Buzz Williams" Maryland | "Kevin Willard" | "Maryland basketball recruiting" | "Maryland basketball staff"',
    '"DJ Wagner" Maryland | "Baba Oladotun" | "Bishop Boswell" | "Kaden House" Maryland | "Adama Tambedou"',
    '"Len Bias" | "Juan Dixon" | "Greivis Vasquez" | "Melo Trimble" | "Steve Francis" Maryland | "Walt Williams" Maryland',
    '"Jalen Smith" Terps | "Kevin Huerter" | "Bruno Fernando" | "Jake Layman" | "Alex Len" | "Dez Wells"',
    '"Brenda Frese" | "Alyssa Thomas" | "Kristi Toliver" | "Diamond Miller" | "Maryland womens basketball"',
    '"John Tillman" Maryland | "Maryland mens lacrosse" | "Maryland womens lacrosse" | "Jared Bernhardt" | "Matt Rambo"',
    '"Maryland baseball" Terrapins | "Matt Swope" | "Sasho Cirovski" | "Zack Steffen" | "Maryland soccer" Terrapins',
    '"Maryland wrestling" Terrapins | "Maryland field hockey" | "Maryland volleyball" Terrapins | "Maryland gymnastics" | "Kyle Snyder" Maryland',
    '"Maryland transfer portal" | "Maryland decommit" | "Maryland portal target" | "Terps transfer portal"',
    '"Maryland NIL" Terrapins | "Maryland NIL collective" | "Terrapin Club" | "Maryland athletics fundraising"',
    '"Testudo Times" | "Terrapin Sports Report" | "On3 Maryland" | "Rivals Maryland" | "Fear the Turtle" Terps',
    '"Maryland football roster" | "Maryland basketball schedule" | "Maryland spring football" | "Maryland coaching search" Terrapins',
    '"Aaron Wiggins" Maryland | "Derik Queen" | "Pharrel Payne" | "Big Ten basketball" Maryland'
  ];

  // Rotate 5 groups per request to conserve quota (search costs 100 units each; 10k/day free)
  var batchSize = 5;
  var startIdx = (searchRotation * batchSize) % allTerms.length;
  searchRotation++;
  var terms = [];
  for (var i = 0; i < batchSize; i++) {
    terms.push(allTerms[(startIdx + i) % allTerms.length]);
  }

  var keywords = ['terps', 'terrapins', 'maryland', 'locksley', 'buzz williams', 'oladotun', 'derik queen', 'dj wagner', 'kevin willard', 'brenda frese', 'stefon diggs', 'boomer esiason', 'shawne merriman', 'torrey smith', 'lamont jordan', 'jermaine lewis', 'darnell savage', 'dj moore', 'vernon davis', 'len bias', 'juan dixon', 'greivis vasquez', 'melo trimble', 'kevin huerter', 'bruno fernando', 'jake layman', 'alex len', 'dez wells', 'jalen smith', 'aaron wiggins', 'alyssa thomas', 'kristi toliver', 'diamond miller', 'jared bernhardt', 'matt rambo', 'zack steffen', 'kyle snyder', 'matt swope', 'sasho cirovski', 'john tillman', 'testudo', 'zahir mathis', 'malik washington', 'pharrel payne', 'kaden house', 'bishop boswell', 'adama tambedou', 'randy edsall', 'pep hamilton', 'secu stadium', 'xfinity center', 'big ten'];
  function matchesKeywords(text) {
    var t = (text || '').toLowerCase();
    return keywords.some(function(k) { return t.includes(k); });
  }
  // Cannabis content guard ("terps"/"terpenes" overlap)
  var cannabisTerms = ['terpene', 'cannabis', 'marijuana', 'weed', 'thc', 'cbd', 'dispensary', 'kush', 'stoner', 'dab rig', '710', 'hemp'];
  function isCannabis(text) {
    var t = (text || '').toLowerCase();
    return cannabisTerms.some(function(c) { return t.includes(c); });
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
        if (isCannabis(text)) return;
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
