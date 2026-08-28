var searchRotation = 0;
// Module-level cache survives warm invocations — the dashboard tab and scan.js both hit
// this endpoint, and each search costs 100 quota units (10k/day free).
var ytCache = { at: 0, payload: null };
var YT_CACHE_MS = 15 * 60 * 1000;

module.exports = async function handler(req, res) {
  var key = process.env.YOUTUBE_API_KEY;
  if (!key) return res.status(200).json({ videos: [], error: 'YOUTUBE_API_KEY not set — add it in Vercel environment variables' });

  var noCache = req.query && (req.query.nocache || req.query.fresh);
  if (!noCache && ytCache.payload && (Date.now() - ytCache.at) < YT_CACHE_MS) {
    return res.status(200).json(Object.assign({ cached: true }, ytCache.payload));
  }

  var cutoff = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

  // 20 OR-groups mirroring the Google News queries. Names are paired with Maryland/Terps
  // context wherever ambiguity is possible so unrelated content (including cannabis "terps") is avoided.
  var allTerms = [
    '"Maryland Terrapins" | "Terps football" | "Terps basketball" | "Maryland Terrapins recruiting"',
    '"Maryland athletic director" | "SECU Stadium" | "Xfinity Center" Terps | "Damon Evans Maryland" | "Jim Smith Maryland"',
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

  // Rotate groups per request to conserve quota (search costs 100 units each; 10k/day free)
  var batchSize = 7;
  var bReq = parseInt((req.query && req.query.batch) || '', 10);
  if (bReq >= 1 && bReq <= 12) batchSize = bReq;
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
  // Xfinity Center in Mansfield MA is a concert venue, not the UMD arena
  var venueNoise = ['mansfield', 'concert', 'live at xfinity', 'at xfinity center, mansfield', 'tour', 'full show', 'en vevo', 'setlist'];
  function isConcertVenue(text) {
    var t = (text || '').toLowerCase();
    if (!t.includes('xfinity')) return false;
    return venueNoise.some(function(v) { return t.includes(v); });
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

  // AI-narrated / text-to-speech / auto-generated spam. These channels churn out
  // dozens of robotic recap videos a day.
  var aiPhrases = [
    'ai voice', 'ai-generated', 'ai generated', 'text to speech', 'text-to-speech',
    'ai narrat', 'generated with ai', 'powered by ai', 'this video was created using',
    'synthetic voice', 'automated news', 'auto-generated', 'tts '
  ];
  var aiChannelPatterns = /(news now|sports now|now sports|daily sports|sports daily|news today|today news|sports report|report sports|sports central|central sports|fan nation|hoops nation|gridiron nation|rumor|rumors|breaking sports|sports break|insider report|\bai\b|\bbot\b|robot)/i;
  var clickbaitTitle = /(SHOCK(?:ING|ED|S)?|STUNNED|STUNNING|JUST IN|BREAKING NEWS|YOU WON'?T BELIEVE|BOMBSHELL|MASSIVE NEWS|HUGE NEWS)\b.*[!?]{2,}|[!?]{3,}|🚨\s*🚨/;
  function isAiSpam(title, desc, channel) {
    var t = ((title || '') + ' ' + (desc || '')).toLowerCase();
    if (aiPhrases.some(function(p) { return t.includes(p); })) return true;
    if (aiChannelPatterns.test(channel || '')) return true;
    if (clickbaitTitle.test(title || '')) return true;
    return false;
  }

  try {
    var searches = terms.map(function(term) {
      var url = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=date&maxResults=15&publishedAfter=' + encodeURIComponent(cutoff) + '&q=' + encodeURIComponent(term) + '&key=' + key;
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
        if (isConcertVenue(text)) return;
        if (isAiSpam(title, desc, channel)) return;
        var norm = title.toLowerCase().replace(/[^a-z0-9 ]/g, '').substring(0, 60);
        if (seen.includes(norm)) return;
        seen.push(norm);
        var pubMs = sn.publishedAt ? new Date(sn.publishedAt).getTime() : 0;
        videos.push({
          videoId: item.id.videoId,
          title: title,
          channel: channel,
          channelId: sn.channelId || '',
          url: 'https://www.youtube.com/watch?v=' + item.id.videoId,
          thumbnail: (sn.thumbnails && sn.thumbnails.medium && sn.thumbnails.medium.url) || '',
          age: pubMs ? Math.round((Date.now() - pubMs) / 3600000) : 0,
          description: desc.substring(0, 150)
        });
      });
    });

    // Enrich with full descriptions + view counts (videos.list is 1 unit / call, batched 50)
    var vidStats = {};
    var vidIds = videos.map(function(v) { return v.videoId; }).filter(Boolean);
    for (var vi = 0; vi < vidIds.length; vi += 50) {
      var vbatch = vidIds.slice(vi, vi + 50);
      try {
        var vRes = await fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=' + vbatch.join(',') + '&key=' + key);
        if (vRes.ok) {
          var vData = await vRes.json();
          (vData.items || []).forEach(function(v) {
            vidStats[v.id] = {
              fullDesc: (v.snippet && v.snippet.description) || '',
              views: parseInt((v.statistics && v.statistics.viewCount) || '0', 10)
            };
          });
        }
      } catch (e) { /* fall back to search-snippet data */ }
    }
    videos.forEach(function(v) {
      var s = vidStats[v.videoId];
      if (s) { v.fullDesc = s.fullDesc; v.views = s.views; }
    });
    // Re-check the AI/spam filter with the full description now that we have it
    videos = videos.filter(function(v) { return !isAiSpam(v.title, v.fullDesc || '', v.channel); });

    // Channel quality gate: subscriber floor + content-farm ratio (subs vs upload count)
    var channelIds = [];
    videos.forEach(function(v) { if (v.channelId && channelIds.indexOf(v.channelId) === -1) channelIds.push(v.channelId); });
    var chStats = {};
    for (var ci = 0; ci < channelIds.length; ci += 50) {
      var batch = channelIds.slice(ci, ci + 50);
      try {
        var chRes = await fetch('https://www.googleapis.com/youtube/v3/channels?part=statistics&id=' + batch.join(',') + '&key=' + key);
        if (chRes.ok) {
          var chData = await chRes.json();
          (chData.items || []).forEach(function(ch) {
            chStats[ch.id] = {
              subs: parseInt((ch.statistics && ch.statistics.subscriberCount) || '0', 10),
              videos: parseInt((ch.statistics && ch.statistics.videoCount) || '0', 10)
            };
          });
        }
      } catch (e) { /* pass through on lookup failure */ }
    }
    videos = videos.filter(function(v) {
      var c = chStats[v.channelId];
      if (!c) return true; // couldn't look up — keep
      if (c.subs < 400) return false;
      // content farm: thousands of uploads, comparatively few subscribers
      if (c.videos > 1500 && c.subs < 15000) return false;
      return true;
    });

    // Sort: real engagement first, then recency
    videos.sort(function(a, b) {
      var av = a.views || 0, bv = b.views || 0;
      if ((av >= 500) !== (bv >= 500)) return (bv >= 500 ? 1 : 0) - (av >= 500 ? 1 : 0);
      return a.age - b.age;
    });

    // Surface a longer description now that we have the full text
    videos.forEach(function(v) {
      if (v.fullDesc) v.description = v.fullDesc.replace(/\s+/g, ' ').trim().substring(0, 400);
      delete v.fullDesc;
      delete v.videoId;
    });

    if (!videos.length && apiError) return res.status(200).json({ videos: [], error: apiError });
    var payload = { videos: videos, searched: terms };
    ytCache = { at: Date.now(), payload: payload };
    return res.status(200).json(payload);
  } catch(e) {
    return res.status(500).json({ videos: [], error: e.message });
  }
};
