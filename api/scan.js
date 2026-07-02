module.exports = async function handler(req, res) {
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'no key set' });

  var cutoff = Date.now() - 72 * 60 * 60 * 1000;
  var excludedSources = ['insidemd', 'inside md', 'jeff ermann', 'ims radio', '247sports', 'insidetheshell'];

  try {
    var fetches = [
      fetch('https://www.reddit.com/r/MarylandTerrapins/new.json?limit=25', { headers: { 'User-Agent': 'InsideMDSports-Monitor/1.0' } }),
      fetch('https://news.google.com/rss/search?q=Maryland+Terrapins&hl=en-US&gl=US&ceid=US:en', { headers: { 'User-Agent': 'InsideMDSports-Monitor/1.0' } }),
      fetch('https://news.google.com/rss/search?q=Maryland+Terrapins+football&hl=en-US&gl=US&ceid=US:en', { headers: { 'User-Agent': 'InsideMDSports-Monitor/1.0' } }),
      fetch('https://news.google.com/rss/search?q=Maryland+Terrapins+basketball&hl=en-US&gl=US&ceid=US:en', { headers: { 'User-Agent': 'InsideMDSports-Monitor/1.0' } }),
      fetch('https://news.google.com/rss/search?q=Maryland+Terrapins+recruiting&hl=en-US&gl=US&ceid=US:en', { headers: { 'User-Agent': 'InsideMDSports-Monitor/1.0' } }),
      fetch('https://news.google.com/rss/search?q=Maryland+Terrapins+transfer+portal&hl=en-US&gl=US&ceid=US:en', { headers: { 'User-Agent': 'InsideMDSports-Monitor/1.0' } }),
      fetch('https://news.google.com/rss/search?q=Maryland+Terrapins+NFL+NBA&hl=en-US&gl=US&ceid=US:en', { headers: { 'User-Agent': 'InsideMDSports-Monitor/1.0' } }),
      fetch('https://www.reddit.com/r/CFB/search.json?q=Maryland+Terrapins&sort=new&limit=15', { headers: { 'User-Agent': 'InsideMDSports-Monitor/1.0' } }),
      fetch('https://www.reddit.com/r/CollegeBasketball/search.json?q=Maryland&sort=new&limit=15', { headers: { 'User-Agent': 'InsideMDSports-Monitor/1.0' } }),
      fetch('https://www.reddit.com/r/nfl/search.json?q=Maryland&sort=new&limit=10', { headers: { 'User-Agent': 'InsideMDSports-Monitor/1.0' } }),
      fetch('https://www.reddit.com/r/nba/search.json?q=Maryland&sort=new&limit=10', { headers: { 'User-Agent': 'InsideMDSports-Monitor/1.0' } })
    ];

    var results = await Promise.allSettled(fetches);
    var stories = [];
    var seen = {};

    function isExcluded(title, source) {
      var combined = (title + ' ' + source).toLowerCase();
      return excludedSources.some(function(e) { return combined.includes(e); });
    }

    function addStory(title, source, time) {
      if (!title || isExcluded(title, source)) return;
      var dedupeKey = title.toLowerCase().substring(0, 50);
      if (seen[dedupeKey]) return;
      seen[dedupeKey] = true;
      stories.push({ title: title, source: source, time: time });
    }

    // Reddit r/MarylandTerrapins
    if (results[0].status === 'fulfilled' && results[0].value.ok) {
      var r0 = await results[0].value.json();
      (r0.data?.children || []).forEach(function(p) {
        var d = p.data;
        var ts = d.created_utc * 1000;
        if (ts < cutoff) return;
        addStory(d.title, 'r/MarylandTerrapins', Math.round((Date.now()-ts)/3600000) + 'h ago');
      });
    }

    // Google News feeds (indices 1-6)
    var xmlTexts = await Promise.allSettled(
      [1,2,3,4,5,6].map(function(i) {
        return results[i].status === 'fulfilled' && results[i].value.ok ? results[i].value.text() : Promise.resolve('');
      })
    );
    xmlTexts.forEach(function(r) {
      if (r.status !== 'fulfilled' || !r.value) return;
      var items = r.value.match(/<item>([\s\S]*?)<\/item>/g) || [];
      items.slice(0, 20).forEach(function(item) {
        var title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/) || [])[1] || '';
        var src = (item.match(/<source[^>]*>(.*?)<\/source>/) || [])[1] || '';
        var pub = (item.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || '';
        if (!title || title.includes('Google News') || !src) return;
        var pubTs = pub ? new Date(pub).getTime() : Date.now();
        if (pubTs < cutoff) return;
        addStory(title.replace(/&amp;/g,'&').replace(/&quot;/g,'"'), src, Math.round((Date.now()-pubTs)/3600000) + 'h ago');
      });
    });

    // Reddit r/CFB, r/CollegeBasketball, r/nfl, r/nba
    [
      { idx: 7, src: 'r/CFB' },
      { idx: 8, src: 'r/CollegeBasketball' },
      { idx: 9, src: 'r/nfl' },
      { idx: 10, src: 'r/nba' }
    ].forEach(async function(s) {
      if (results[s.idx].status !== 'fulfilled' || !results[s.idx].value.ok) return;
      var j = await results[s.idx].value.json();
      (j.data?.children || []).slice(0, 15).forEach(function(p) {
        var d = p.data;
        var ts = d.created_utc * 1000;
        if (ts < cutoff) return;
        addStory(d.title, s.src, Math.round((Date.now()-ts)/3600000) + 'h ago');
      });
    });

    if (!stories.length) {
      return res.status(200).json({ content: [{ type: 'text', text: '[]' }] });
    }

    var claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: 'You are a news monitor for InsideMDSports covering Maryland Terrapins athletics. Here are recent stories:\n\n' +
            stories.map(function(s, i) { return (i+1) + '. "' + s.title + '" — ' + s.source + ' (' + s.time + ')'; }).join('\n') +
            '\n\nInclude all stories relevant to Maryland Terrapins — football, basketball, recruiting, transfer portal, alumni (NFL/NBA/WNBA), social. EXCLUDE anything from InsideMDSports, Jeff Ermann, IMS Radio, or 247Sports.\n\nRATING GUIDE:\n5 = Breaking under 6 hours (commit, decommit, coaching move, injury)\n4 = Important news from today\n3 = General news\n2 = Minor notes\n1 = Low relevance\n\nReturn ONLY a valid JSON array, no other text. Each item:\n{"headline":string,"summary":"1-2 sentences","category":"recruiting"|"football"|"basketball"|"other-sport"|"alumni"|"social"|"podcast","sport":string,"source":string,"time":string,"rating":1-5}\n\nSort by rating descending. Up to 15 items.'
        }]
      })
    });

    var d = await claudeRes.json();
    return res.status(claudeRes.status).json(d);
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
