module.exports = async function handler(req, res) {
  try {
    var r = await fetch('https://www.insidetheblackandgold.net/feed/');
    var xml = await r.text();
    var items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    var out = items.slice(0, 8).map(function(item) {
      var title = (item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || item.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
      var pubDate = (item.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
      var ageH = pubDate ? Math.round((Date.now() - new Date(pubDate).getTime()) / 3600000) : null;
      return { title: title.trim(), pubDate: pubDate, ageHours: ageH };
    });
    return res.status(200).json({ status: r.status, itemCount: items.length, sample: out, note: 'Scanner includes items younger than 36 hours' });
  } catch(e) {
    return res.status(200).json({ error: e.message });
  }
};
