// Recent episodes of the publisher's own podcast, for one-click embedding in an
// article. Reads the show's RSS feed and returns the latest episodes with a
// direct audio URL. Feed URL: env PODCAST_FEED_URL, else the default below.
// (Multi-tenant: this becomes per-site config.)

var DEFAULT_FEED = 'https://rss.amperwave.net/v2/feed/audacynetwork/imsradio';

function tag(xml, name) {
  var m = xml.match(new RegExp('<' + name + '[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/' + name + '>'));
  return m ? m[1].trim() : '';
}

async function fetchText(url) {
  var controller = new AbortController();
  var t = setTimeout(function () { controller.abort(); }, 9000);
  try {
    var r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IMSTool/1.0)' }, signal: controller.signal });
    return await r.text();
  } finally { clearTimeout(t); }
}

module.exports = async function handler(req, res) {
  var feed = (req.query && req.query.url) || process.env.PODCAST_FEED_URL || DEFAULT_FEED;
  try {
    var xml = await fetchText(feed);
    // If we got a landing page, try common feed paths off the same URL.
    if (!/<(item|entry)[\s>]/.test(xml)) {
      var base = feed.replace(/\/+$/, '');
      var tries = [base + '/feed', base + '/rss', base + '/rss.xml', base + '.xml', base + '/feed.xml'];
      for (var i = 0; i < tries.length; i++) {
        try { var x2 = await fetchText(tries[i]); if (/<(item|entry)[\s>]/.test(x2)) { xml = x2; feed = tries[i]; break; } } catch (e) {}
      }
    }
    if (!/<(item|entry)[\s>]/.test(xml)) {
      return res.status(200).json({ episodes: [], error: 'That URL is not a podcast RSS feed. Paste the show’s RSS feed URL (from Apple Podcasts “Copy RSS” or your podcast host) into PODCAST_FEED_URL.' });
    }

    var items = (xml.match(/<(?:item|entry)>[\s\S]*?<\/(?:item|entry)>/g) || []).slice(0, 12);
    var episodes = items.map(function (it) {
      var enc = it.match(/<enclosure[^>]*url="([^"]+)"[^>]*>/i)
        || it.match(/<media:content[^>]*url="([^"]+\.mp3[^"]*)"/i)
        || it.match(/<link[^>]*rel="enclosure"[^>]*href="([^"]+)"/i);
      var audio = enc ? enc[1] : '';
      if (!audio) return null;
      var pub = tag(it, 'pubDate');
      return {
        title: tag(it, 'title').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"'),
        date: pub ? new Date(pub).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '',
        audioUrl: audio,
        page: tag(it, 'link'),
        duration: (it.match(/<itunes:duration>([^<]+)<\/itunes:duration>/i) || [])[1] || ''
      };
    }).filter(Boolean);

    if (!episodes.length) return res.status(200).json({ episodes: [], error: 'No episodes found in the feed.' });
    var showTitle = tag(xml.split('<item>')[0], 'title') || 'Podcast';
    return res.status(200).json({ show: showTitle, episodes: episodes });
  } catch (e) {
    return res.status(200).json({ episodes: [], error: 'Could not read the podcast feed: ' + e.message });
  }
};
