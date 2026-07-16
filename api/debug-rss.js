module.exports = async function handler(req, res) {
  try {
    var xml = await fetch('https://news.google.com/rss/search?q=247sports+Maryland+Terrapins&hl=en-US&gl=US&ceid=US:en').then(function(r) { return r.text(); });
    var items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    var out = items.slice(0, 5).map(function(item) {
      var title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/) || [])[1] || '';
      var link = (item.match(/<link>(.*?)<\/link>/) || [])[1] || '';
      var src = (item.match(/<source[^>]*>(.*?)<\/source>/) || [])[1] || '';
      var srcUrl = (item.match(/<source[^>]*url="([^"]*)"/) || [])[1] || '';
      var desc = (item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) || [])[1] || '';
      var realUrl = (desc.match(/href="(https?:\/\/[^"]+)"/) || [])[1] || 'NOT FOUND';
      return { title: title, link: link, src: src, srcUrl: srcUrl, realUrl: realUrl };
    });
    return res.status(200).json(out);
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
