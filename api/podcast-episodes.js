// Recent episodes of the publisher's own podcast, for one-click embedding in an
// article. Reads the show's RSS feed and returns the latest episodes with a
// direct audio URL. Feed URL: env PODCAST_FEED_URL, else the default below.
// (Multi-tenant: this becomes per-site config.)

var DEFAULT_FEED = 'https://studio.amperwave.com/podcasts/36676';

function tag(xml, name) {
  var m = xml.match(new RegExp('<' + name + '[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/' + name + '>'));
  return m ? m[1].trim() : '';
}

module.exports = async function handler(req, res) {
  var feed = process.env.PODCAST_FEED_URL || DEFAULT_FEED;
  try {
    var controller = new AbortController();
    var t = setTimeout(function () { controller.abort(); }, 9000);
    var xml = await fetch(feed, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IMSTool/1.0)' },
      signal: controller.signal
    }).then(function (r) { return r.text(); }).finally(function () { clearTimeout(t); });

    var items = (xml.match(/<item>[\s\S]*?<\/item>/g) || []).slice(0, 12);
    var episodes = items.map(function (it) {
      var enc = it.match(/<enclosure[^>]*url="([^"]+)"[^>]*>/i);
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
