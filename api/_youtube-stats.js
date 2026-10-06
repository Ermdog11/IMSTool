// YouTube channel stats for Analytics (Jeff, 2026-10-06: "wire YouTube
// analytics connections"). Public numbers through the YouTube Data API with
// the key the app already uses for the YouTube tab (YOUTUBE_API_KEY), so the
// newsroom only gives its channel handle or URL: no Google sign-in, no app
// review. That covers subscribers, and views, likes and comments per video.
// Watch time, retention and traffic sources are owner-only (YouTube
// Analytics API, Google sign-in with the yt-analytics scope); that's the
// later "YouTube Analytics" connection.
//
// Quota: about 4 units per summary (channel, uploads list, video stats),
// against the key's 10,000 a day.

var API = 'https://www.googleapis.com/youtube/v3';
var TZ = 'America/New_York';

function key() {
  var k = process.env.YOUTUBE_API_KEY;
  if (!k) { var e = new Error('YouTube isn\'t set up on the server (YOUTUBE_API_KEY).'); e.status = 503; throw e; }
  return k;
}

async function yt(path) {
  var r = await fetch(API + path + (path.indexOf('?') === -1 ? '?' : '&') + 'key=' + encodeURIComponent(key()));
  var d = await r.json().catch(function () { return {}; });
  if (!r.ok || d.error) throw new Error('YouTube: ' + ((d.error && d.error.message) || ('HTTP ' + r.status)));
  return d;
}

// "@Terrapins247", "youtube.com/@x", "youtube.com/channel/UC..." or a bare id.
async function resolveChannel(input) {
  var s = String(input || '').trim();
  var m = /(?:youtube\.com\/channel\/)?(UC[A-Za-z0-9_-]{22})/.exec(s);
  var q;
  if (m) q = '&id=' + m[1];
  else {
    var h = /@([A-Za-z0-9._-]{3,30})/.exec(s) || /youtube\.com\/(?:c\/|user\/)?([A-Za-z0-9._-]{3,30})/.exec(s) || /^([A-Za-z0-9._-]{3,30})$/.exec(s);
    if (!h) { var e = new Error('Give the channel\'s @handle or its youtube.com link.'); e.status = 400; throw e; }
    q = '&forHandle=' + encodeURIComponent('@' + h[1]);
  }
  var d = await yt('/channels?part=snippet,statistics' + q);
  var c = (d.items || [])[0];
  if (!c) { var e2 = new Error('Couldn\'t find that YouTube channel.'); e2.status = 400; throw e2; }
  return { channelId: c.id, title: c.snippet.title, handle: c.snippet.customUrl || '' };
}

function seconds(iso) {
  var m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(String(iso || ''));
  return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : 0;
}

function median(a) { if (!a.length) return null; var s = a.slice().sort(function (x, y) { return x - y; }); var i = Math.floor(s.length / 2); return s.length % 2 ? s[i] : Math.round((s[i - 1] + s[i]) / 2); }

// The last 50 uploads with their numbers, and a 30-day summary.
async function fetchSummary(channelId) {
  var ch = (await yt('/channels?part=snippet,statistics,contentDetails&id=' + encodeURIComponent(channelId))).items[0];
  if (!ch) throw new Error('YouTube channel not found.');
  var uploads = ch.contentDetails.relatedPlaylists.uploads;
  var list = await yt('/playlistItems?part=contentDetails&maxResults=50&playlistId=' + encodeURIComponent(uploads));
  var ids = (list.items || []).map(function (i) { return i.contentDetails.videoId; });
  var videos = [];
  if (ids.length) {
    var v = await yt('/videos?part=snippet,statistics,contentDetails&id=' + ids.join(','));
    videos = (v.items || []).map(function (x) {
      var st = x.statistics || {}, secs = seconds(x.contentDetails && x.contentDetails.duration);
      return {
        title: x.snippet.title, url: 'https://www.youtube.com/watch?v=' + x.id, publishedAt: x.snippet.publishedAt,
        views: +st.viewCount || 0, likes: +st.likeCount || 0, comments: +st.commentCount || 0,
        seconds: secs, short: secs > 0 && secs <= 180, live: x.snippet.liveBroadcastContent !== 'none' || /live|stream/i.test(x.snippet.title)
      };
    });
  }
  var since = Date.now() - 30 * 86400000;
  var recent = videos.filter(function (x) { return Date.parse(x.publishedAt) >= since; });
  function group(arr) { return { videos: arr.length, totalViews: arr.reduce(function (a, b) { return a + b.views; }, 0), medianViews: median(arr.map(function (x) { return x.views; })) }; }
  function best(keyFn) {
    var b = {};
    videos.forEach(function (x) { var k = keyFn(new Date(x.publishedAt)); (b[k] = b[k] || []).push(x.views); });
    var top = null;
    Object.keys(b).forEach(function (k) { if (b[k].length >= 3) { var m = median(b[k]); if (!top || m > top.medianViews) top = { when: k, medianViews: m, videos: b[k].length }; } });
    return top;
  }
  return {
    channel: { title: ch.snippet.title, subscribers: +ch.statistics.subscriberCount || null, totalViews: +ch.statistics.viewCount || 0, videoCount: +ch.statistics.videoCount || 0 },
    last30Days: Object.assign(group(recent), {
      shorts: group(recent.filter(function (x) { return x.short; })),
      longForm: group(recent.filter(function (x) { return !x.short; })),
      likesPer1kViews: (function () { var v = recent.reduce(function (a, b) { return a + b.views; }, 0); return v ? Math.round(recent.reduce(function (a, b) { return a + b.likes; }, 0) / v * 10000) / 10 : null; })()
    }),
    topVideos: videos.slice().sort(function (a, b) { return b.views - a.views; }).slice(0, 8),
    latestVideos: videos.slice(0, 10),
    bestDay: best(function (d) { return d.toLocaleString('en-US', { timeZone: TZ, weekday: 'long' }); }),
    bestHour: best(function (d) { return d.toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: true }); }),
    note: 'Public YouTube numbers (views, likes, comments) across the last 50 uploads. Views keep growing after upload, so newer videos are understated. Shorts = 3 minutes or less.'
  };
}

module.exports = { resolveChannel: resolveChannel, fetchSummary: fetchSummary };
