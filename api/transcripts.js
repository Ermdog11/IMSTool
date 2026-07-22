// Scans YouTube captions of key podcast/show channels for Maryland mentions
// buried inside episodes that never mention Maryland in the title/description.
var channelCache = {}; // showName -> channelId (survives warm invocations)

module.exports = async function handler(req, res) {
  var key = process.env.YOUTUBE_API_KEY;
  if (!key) return res.status(200).json({ hits: [], error: 'YOUTUBE_API_KEY not set' });

  var shows = [
    'The Solid Verbal',
    'Josh Pate College Football',
    'Andy & Ari On3',
    'Cover 3 College Football Podcast',
    'The Field of 68',
    'Eye on College Basketball',
    'Locked On Big Ten'
  ];

  var keywords = ['maryland', 'terps', 'terrapins', 'locksley', 'buzz williams', 'oladotun', 'derik queen', 'malik washington'];
  var cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  var debug = [];

  async function getChannelId(name) {
    if (channelCache[name]) return channelCache[name];
    try {
      var r = await fetch('https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=' + encodeURIComponent(name) + '&key=' + key);
      if (!r.ok) return null;
      var d = await r.json();
      var id = d.items && d.items[0] && d.items[0].id && d.items[0].id.channelId;
      if (id) channelCache[name] = id;
      return id || null;
    } catch(e) { return null; }
  }

  async function getRecentVideos(channelId) {
    try {
      // Uploads playlist id = channel id with UC -> UU
      var playlistId = 'UU' + channelId.substring(2);
      var r = await fetch('https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=5&playlistId=' + playlistId + '&key=' + key);
      if (!r.ok) return [];
      var d = await r.json();
      return (d.items || []).map(function(it) {
        var sn = it.snippet || {};
        return {
          videoId: (sn.resourceId && sn.resourceId.videoId) || '',
          title: sn.title || '',
          channel: sn.channelTitle || '',
          publishedAt: sn.publishedAt || ''
        };
      }).filter(function(v) {
        return v.videoId && (!v.publishedAt || new Date(v.publishedAt).getTime() >= cutoff);
      });
    } catch(e) { return []; }
  }

  async function getCaptionText(videoId) {
    // Manual captions via timedtext (free, no auth). Auto-generated captions are not
    // accessible this way — those videos are skipped.
    try {
      var r = await fetch('https://video.google.com/timedtext?lang=en&v=' + videoId);
      if (!r.ok) return '';
      var xml = await r.text();
      if (!xml || xml.length < 50) return '';
      var texts = xml.match(/<text[^>]*>([\s\S]*?)<\/text>/g) || [];
      return texts.map(function(t) {
        return t.replace(/<[^>]+>/g, '').replace(/&amp;#39;/g, "'").replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
      }).join(' ');
    } catch(e) { return ''; }
  }

  try {
    var hits = [];

    for (var s of shows) {
      var channelId = await getChannelId(s);
      if (!channelId) { debug.push({ show: s, error: 'channel not found' }); continue; }
      var videos = await getRecentVideos(channelId);
      debug.push({ show: s, videos: videos.length });

      for (var v of videos) {
        var transcript = await getCaptionText(v.videoId);
        if (!transcript) continue;
        var lower = transcript.toLowerCase();
        var matched = keywords.filter(function(k) { return lower.includes(k); });
        if (!matched.length) continue;
        // Extract a snippet around the first mention
        var idx = lower.indexOf(matched[0]);
        var snippet = transcript.substring(Math.max(0, idx - 150), idx + 250).trim();
        hits.push({
          title: v.title,
          channel: v.channel,
          url: 'https://www.youtube.com/watch?v=' + v.videoId,
          matched: matched,
          snippet: '…' + snippet + '…',
          age: v.publishedAt ? Math.round((Date.now() - new Date(v.publishedAt).getTime()) / 3600000) : 0
        });
      }
    }

    hits.sort(function(a, b) { return a.age - b.age; });
    return res.status(200).json({ hits: hits, debug: debug });
  } catch(e) {
    return res.status(500).json({ hits: [], error: e.message });
  }
};
