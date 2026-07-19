module.exports = async function handler(req, res) {
  var out = [];
  var urls = [
    'https://www.reddit.com/r/MarylandTerrapins/new.json?limit=25',
    'https://www.reddit.com/r/CFB/search.json?q=Maryland+Terrapins&sort=new&restrict_sr=on&limit=20',
    'https://www.reddit.com/r/CollegeBasketball/search.json?q=Maryland+Terrapins&sort=new&restrict_sr=on&limit=20'
  ];
  for (var u of urls) {
    try {
      var r = await fetch(u, { headers: { 'User-Agent': 'IMSTool/1.0' } });
      var info = { url: u, status: r.status, posts: 0, sampleTitles: [] };
      if (r.ok) {
        var d = await r.json();
        var posts = (d.data && d.data.children) || [];
        info.posts = posts.length;
        info.sampleTitles = posts.slice(0, 3).map(function(p) { return p.data && p.data.title; });
      } else {
        info.body = (await r.text()).substring(0, 200);
      }
      out.push(info);
    } catch(e) {
      out.push({ url: u, error: e.message });
    }
  }
  return res.status(200).json(out);
};
