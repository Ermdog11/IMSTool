module.exports = async function handler(req, res) {
  var key = process.env.LISTEN_API_KEY;
  if (!key) return res.status(200).json({ episodes: [], error: 'LISTEN_API_KEY not set' });

  var cannabisTerms = ['cannabis podcast','marijuana podcast','weed podcast','420 podcast','dispensary podcast','thc podcast','cbd podcast','kush podcast','stoner podcast','pot podcast','smoke show','reefer podcast'];

  function isCannabis(text) {
    var t = (text || '').toLowerCase();
    return cannabisTerms.some(function(c) { return t.includes(c); });
  }

  var queries = [
    '"Maryland Terrapins"',
    '"Maryland football"',
    '"Maryland basketball"',
    '"Terps football"',
    '"Terps basketball"',
    'Terps'
  ];

  var episodes = [];
  var seen = [];
  var debug = [];

  for (var q of queries) {
    try {
      var url = 'https://listen-api.listennotes.com/api/v2/search?q=' + encodeURIComponent(q) + '&type=episode&sort_by_date=1&language=English&page_size=5';
      var r = await fetch(url, { headers: { 'X-ListenAPI-Key': key } });
      var qDebug = { query: q, status: r.status, ok: r.ok, added: 0, filtered: 0, deduped: 0 };
      if (!r.ok) { debug.push(qDebug); continue; }
      var data = await r.json();
      var results = (data.results || []);
      results.forEach(function(ep) {
        var title = ep.title_original || ep.title || '';
        var podcastTitle = (ep.podcast && ep.podcast.title_original) || (ep.podcast && ep.podcast.title) || '';
        var description = ep.description_original || ep.description || '';
        var listenUrl = ep.listennotes_url || '';
        var pubMs = ep.pub_date_ms || 0;
        if (!title) return;
        if (isCannabis(title) || isCannabis(podcastTitle) || isCannabis(description)) { qDebug.filtered++; return; }
        var norm = title.toLowerCase().replace(/[^a-z0-9 ]/g, '').substring(0, 60);
        if (seen.includes(norm)) { qDebug.deduped++; return; }
        seen.push(norm);
        var age = pubMs ? Math.round((Date.now() - pubMs) / 3600000) : 0;
        episodes.push({ title: title, podcast: podcastTitle, url: listenUrl, age: age, description: description.replace(/<[^>]+>/g,'').substring(0, 150) });
        qDebug.added++;
      });
      debug.push(qDebug);
    } catch(e) { debug.push({ query: q, error: e.message }); }
  }

  episodes.sort(function(a, b) { return a.age - b.age; });

  return res.status(200).json({ episodes: episodes, debug: debug });
};
