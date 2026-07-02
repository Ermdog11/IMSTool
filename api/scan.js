module.exports = async function handler(req, res) {
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'no key set' });

  var cutoff = Date.now() - 72 * 60 * 60 * 1000;
  var excludedSources = ['insidemd', 'jeff ermann', 'ims radio'];
  var excludedUrls = ['maryland.247sports.com'];

  try {
    var results = await Promise.allSettled([
      fetch('https://www.reddit.com/r/MarylandTerrapins/new.json?limit=25', {
        headers: { 'User-Agent': 'InsideMDSports-Monitor/1.0' }
      }),
      fetch('https://news.google.com/rss/search?q=Maryland+Terrapins&hl=en-US&gl=US&ceid=US:en', {
        headers: { 'User-Agent': 'InsideMDSports-Monitor/1.0' }
      }),
      fetch('https://news.google.com/rss/search?q=Maryland+Terrapins+recruiting&hl=en-US&gl=US&ceid=US:en', {
        headers: { 'User-Agent': 'InsideMDSports-Monitor/1.0' }
      }),
      fetch('https://news.google.com/rss/search?q=Maryland+Terrapins+football&hl=en-US&gl=US&ceid=US:en', {
        headers: { 'User-Agent': 'InsideMDSports-Monitor/1.0' }
      }),
      fetch('https://news.google.com/rss/search?q=Maryland+Terrapins+basketball&hl=en-US&gl=US&ceid=US:en', {
        headers: { 'User-Agent': 'InsideMDSports-Monitor/1.0' }
      }),
      fetch('https://news.google.com/rss/search?q=Maryland+Terrapins+transfer+portal&hl=en-US&gl=US&ceid=US:en', {
        headers: { 'User-Agent': 'InsideMDSports-Monitor/1.0' }
      }),
      fetch('https://news.google.com/rss/search?q=Maryland+Terrapins+NFL+NBA+alumni&hl=en-US&gl=US&ceid=US:en', {
        headers: { 'User-Agent': 'InsideMDSports-Monitor/1.0' }
      }),
      fetch('https://www.reddit.com/r/CFB/search.json?q=Maryland&sort=new&limit=15', {
        headers: { 'User-Agent': 'InsideMDSports-Monitor/1.0' }
      }),
      fetch('https://www.reddit.com/r/CollegeBasketball/search.json?q=Maryland&sort=new&limit=15', {
        headers: { 'User-Agent': 'InsideMDSports-Monitor/1.0' }
      })
    ]);

    var stories = [];
    var seen = {};

    function addStory(title, source, url, time) {
      if (!title) return;
      var dedupeKey = title.toLowerCase().substring(0, 40);
      if (seen[dedupeKey]) return;
      var combined = (title + ' ' + source + ' ' + (url || '')).toLowerCase();
      if (excludedSources.some(function(e) { return combined.includes(e); })) return;
      if (excludedUrls.some(function(e) { return (url || '').toLowerCase().includes(e); })) return;
      seen[dedupeKey] = true;
      stories.push({ title: title, source: source, time: time });
    }

    // Reddit r/MarylandTerrapins
    if (results[0].status === 'fulfilled' && results[0].value.ok) {
      var reddit = await results[0].value.json();
      (reddit.data?.children || []).forEach(function(p) {
        var d = p.data;
        var ts = d.created_utc * 1000;
        if (ts < cutoff) return;
        var hoursAgo = Math.round((Date.now() - ts) / 3600000);
        addStory(d.title, 'r/MarylandTerrapins', d.url, hoursAgo + 'h ago');
      });
    }

    // Google News feeds (indices 1-6)
    var xmlResults = await Promise.allSettled([
      results[1].status === 'fulfilled' && results[1].value.ok ? results[1].value.text() : Promise.resolve(''),
      results[2].status === 'fulfilled' && results[2].value.ok ? results[2].value.text() : Promise.resolve(''),
      results[3].status === 'fulfilled' && results[3].value.ok ? results[3].value.text() : Promise.resolve(''),
      results[4].status === 'fulfilled' && results[4].value.ok ? results[4].value.text() : Promise.resolve(''),
      results[5].status === 'fulfilled' && results[5].value.ok ? results[5].value.text() : Promise.resolve(''),
      results[6].status === 'fulfilled' && results[6].value.ok ? results[6].value.text() : Promise.resolve('')
    ]);

    xmlResults.forEach(function(r) {
      if (r.status !== 'fulfilled' || !r.value) return;
      var xml = r.value;
      var items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
      items.slice(0, 20).forEach(function(item) {
        var title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/) || [])[1] || '';
        var src = (item.match(/<source[^>]*>(.*?)<\/source>/) || [])[1] || 'Google News';
        var link = (item.match(/<link>(.*?)<\/link>/) || [])[1] || '';
        var pub = (item.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || '';
        if (!title || title.includes('Google News')) return;
        var pubTs = pub ? new Date(pub).getTime() : Date.now();
        if (pubTs < cutoff) return;
        var hoursAgo = Math.round((Date.now() - pubTs) / 3600000);
        addStory(title.replace(/&amp;/g,'&').replace(/&quot;/g,'"'), src, link, hoursAgo + 'h ago');
      });
    });

    // Reddit r/CFB
    if (results[7].status === 'fulfilled' && results[7].value.ok) {
      var cfb = await results[7].value.json();
      (cfb.data?.children || []).slice(0, 15).forEach(function(p) {
        var d = p.data;
        var ts = d.created_utc * 1000;
        if (ts < cutoff) return;
        var hoursAgo = Math.round((Date.now() - ts) / 3600000);
        addStory(d.title, 'r/CFB', d.url, hoursAgo + 'h ago');
      });
    }

    // Reddit r/CollegeBasketball
    if (results[8].status === 'fulfilled' && results[8].value.ok) {
      var cbb = await results[8].value.json();
      (cbb.data?.children || []).slice(0, 15).forEach(function(p) {
        var d = p.data;
        var ts = d.created_utc * 1000;
        if (ts < cutoff) return;
        var hoursAgo = Math.round((Date.now() - ts) / 3600000);
        addStory(d.title, 'r/CollegeBasketball', d.url, hoursAgo + 'h ago');
      });
    }

    if (!stories.length) {
      return res.status(200).json({ content: [{ type: 'text', text: '[]' }] });
    }

    var claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: 'You are a news monitor for InsideMDSports covering Maryland Terrapins athletics. Here are recent stories:\n\n' +
            stories.map(function(s, i) { return (i+1) + '. "' + s.title + '" — ' + s.source + ' (' + s.time + ')'; }).join('\n') +
            '\n\nInclude all stories relevant to Maryland Terrapins athletics — football, basketball, recruiting, transfer portal, alumni (NFL/NBA/WNBA), and social buzz. EXCLUDE anything from: InsideMDSports, Jeff Ermann, IMS Radio, maryland.247sports.com. National 247Sports content is OK.\n\nRATING GUIDE:\n5 = Breaking under 6 hours (commit, decommit, coaching move, injury)\n4 = Important news from today\n3 = General news\n2 = Minor notes\n1 = Low relevance\n\nReturn ONLY a valid JSON array, no other text. Each item:\n{"headline": string, "summary": "1-2 sentences", "category": "recruiting"|"football"|"basketball"|"other-sport"|"alumni"|"social"|"podcast", "sport": string, "source": string, "time": string, "rating": 1-5}\n\nSort by rating descending. Up to 15 items.'
        }]
      })
    });

    var d = await claudeRes.json();
    return res.status(claudeRes.status).json(d);
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
