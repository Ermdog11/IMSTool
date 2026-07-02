module.exports = async function handler(req, res) {
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'no key set' });

  try {  var cutoff = Date.now() - 48 * 60 * 60 * 1000;
    // Fetch Reddit and Google News in parallel
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
      fetch('https://www.reddit.com/r/CFB/search.json?q=Maryland&sort=new&limit=15', {
        headers: { 'User-Agent': 'InsideMDSports-Monitor/1.0' }
      })
    ]);

    var stories = [];

       // Reddit r/MarylandTerrapins
    if (results[0].status === 'fulfilled' && results[0].value.ok) {
      var reddit = await results[0].value.json();
      (reddit.data?.children || []).forEach(function(p) {
        var d = p.data;
        var hoursAgo = Math.round((Date.now() - d.created_utc * 1000) / 3600000);
        if (hoursAgo > 48) return;
        stories.push({ title: d.title, source: 'r/MarylandTerrapins', time: hoursAgo + 'h ago' });
      });
    }

    // Google News - general
    if (results[1].status === 'fulfilled' && results[1].value.ok) {
      var xml = await results[1].value.text();
      var items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
      items.slice(0, 15).forEach(function(item) {
        var title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/) || [])[1] || '';
        var src = (item.match(/<source[^>]*>(.*?)<\/source>/) || [])[1] || 'Google News';
        var pub = (item.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || '';
        if (title && !title.includes('Google News')) stories.push({ title: title.replace(/&amp;/g,'&').replace(/&quot;/g,'"'), source: src, time: pub ? new Date(pub).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : 'recent' });
      });
    }

    // Google News - recruiting
    if (results[2].status === 'fulfilled' && results[2].value.ok) {
      var xml2 = await results[2].value.text();
      var items2 = xml2.match(/<item>([\s\S]*?)<\/item>/g) || [];
      items2.slice(0, 10).forEach(function(item) {
        var title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/) || [])[1] || '';
        var src = (item.match(/<source[^>]*>(.*?)<\/source>/) || [])[1] || 'Google News';
        if (title && !title.includes('Google News')) stories.push({ title: title.replace(/&amp;/g,'&').replace(/&quot;/g,'"'), source: src, time: 'recent' });
      });
    }

    // r/CFB Maryland mentions
    if (results[3].status === 'fulfilled' && results[3].value.ok) {
      var cfb = await results[3].value.json();
      (cfb.data?.children || []).slice(0, 10).forEach(function(p) {
        var d = p.data;
        var hoursAgo = Math.round((Date.now() - d.created_utc * 1000) / 3600000);
        stories.push({ title: d.title, source: 'r/CFB', time: hoursAgo + 'h ago' });
      });
    }

    if (!stories.length) {
      return res.status(200).json({ content: [{ type: 'text', text: '[]' }] });
    }

    // Send to Claude to rate and categorize
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
          content: 'You are a news monitor for InsideMDSports covering Maryland Terrapins athletics. Here are recent stories from Reddit and Google News:\n\n' +
            stories.map(function(s, i) { return (i+1) + '. "' + s.title + '" — ' + s.source + ' (' + s.time + ')'; }).join('\n') +
            '\n\nRate and categorize only stories actually about Maryland Terrapins. EXCLUDE anything from InsideMDSports or Jeff Ermann.\n\nReturn ONLY a valid JSON array, no other text. Each item:\n{"headline": string, "summary": "1-2 sentences about why this matters", "category": "recruiting"|"football"|"basketball"|"other-sport"|"alumni"|"social"|"podcast", "sport": string, "source": string, "time": string, "rating": 1-5}\n\nSort by rating descending. Up to 15 items.'
        }]
      })
    });

    var d = await claudeRes.json();
    return res.status(claudeRes.status).json(d);
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
