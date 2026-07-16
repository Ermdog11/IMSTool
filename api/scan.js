module.exports = async function handler(req, res) {
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'no key set' });

  // If body has messages but no tools, act as a simple Claude proxy (card actions)
  var body = req.body || {};
  if (body.messages && !body.tools) {
    try {
      var pr = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body)
      });
      var pd = await pr.json();
      return res.status(pr.status).json(pd);
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Full scan: fetch Reddit + Google News RSS, then ask Claude to rate them
  var cutoff = Date.now() - 72 * 60 * 60 * 1000;
  var excluded = ['insidemd', 'jeff ermann', 'ims radio', 'maryland.247sports', 'insidetheshell'];

  try {
    var fetches = [
      fetch('https://www.reddit.com/r/MarylandTerrapins/new.json?limit=25', { headers: { 'User-Agent': 'IMSTool/1.0' } }),
      fetch('https://www.reddit.com/r/CFB/search.json?q=Maryland+Terrapins&sort=new&restrict_sr=on&limit=20', { headers: { 'User-Agent': 'IMSTool/1.0' } }),
      fetch('https://www.reddit.com/r/CollegeBasketball/search.json?q=Maryland+Terrapins&sort=new&restrict_sr=on&limit=20', { headers: { 'User-Agent': 'IMSTool/1.0' } }),
      fetch('https://news.google.com/rss/search?q=Maryland+Terrapins+football&hl=en-US&gl=US&ceid=US:en'),
      fetch('https://news.google.com/rss/search?q=Maryland+Terrapins+basketball&hl=en-US&gl=US&ceid=US:en'),
      fetch('https://news.google.com/rss/search?q=Maryland+Terrapins+recruiting&hl=en-US&gl=US&ceid=US:en'),
      fetch('https://news.google.com/rss/search?q=Maryland+Terrapins+sports&hl=en-US&gl=US&ceid=US:en'),
      fetch('https://news.google.com/rss/search?q=247sports+Maryland+Terrapins&hl=en-US&gl=US&ceid=US:en')
    ];

    var results = await Promise.allSettled(fetches);
    var stories = [];

    // Reddit results (indices 0-2)
    for (var ri = 0; ri < 3; ri++) {
      if (results[ri].status !== 'fulfilled') continue;
      try {
        var rj = await results[ri].value.json();
        var posts = (rj.data && rj.data.children) || [];
        posts.forEach(function(p) {
          var d = p.data;
          if (!d || !d.title) return;
          var created = d.created_utc * 1000;
          if (created < cutoff) return;
          var url = d.url || ('https://reddit.com' + d.permalink);
          var src = 'Reddit r/' + d.subreddit;
          if (excluded.some(function(ex) { return src.toLowerCase().includes(ex) || url.toLowerCase().includes(ex); })) return;
          stories.push({ title: d.title, source: src, url: url, age: Math.round((Date.now() - created) / 3600000) });
        });
      } catch(e) { /* skip failed reddit */ }
    }

    // Google News RSS (indices 3-7)
    for (var gi = 3; gi < results.length; gi++) {
      if (results[gi].status !== 'fulfilled') continue;
      try {
        var xml = await results[gi].value.text();
        var items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
        items.forEach(function(item) {
          var title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/) || [])[1] || '';
          var link = (item.match(/<link>(.*?)<\/link>/) || [])[1] || '';
          var src = (item.match(/<source[^>]*>(.*?)<\/source>/) || [])[1] || 'Google News';
          var pubDate = (item.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || '';
          if (!title) return;
          var age = pubDate ? Math.round((Date.now() - new Date(pubDate).getTime()) / 3600000) : 0;
          if (pubDate && new Date(pubDate).getTime() < cutoff) return;
          if (excluded.some(function(ex) { return src.toLowerCase().includes(ex) || title.toLowerCase().includes(ex); })) return;
          stories.push({ title: title.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>'), source: src, url: link, age: age });
        });
      } catch(e) { /* skip failed feed */ }
    }

    // Deduplicate by title similarity
    var seen = [];
    stories = stories.filter(function(s) {
      var norm = s.title.toLowerCase().replace(/[^a-z0-9 ]/g, '').substring(0, 60);
      if (seen.includes(norm)) return false;
      seen.push(norm);
      return true;
    });

    var redditCount = stories.filter(function(s){return s.source.includes('Reddit');}).length;
    var googleCount = stories.filter(function(s){return !s.source.includes('Reddit');}).length;
    var fetchStatuses = results.map(function(r, i) {
      var names = ['Reddit/MarylandTerrapins','Reddit/CFB','Reddit/CollegeBasketball','GNews/football','GNews/basketball','GNews/recruiting','GNews/sports','GNews/247sports'];
      return names[i] + ':' + (r.status === 'fulfilled' ? r.value.status : 'FAILED');
    });
    console.log('Stories:', stories.length, '| Reddit:', redditCount, '| Google:', googleCount, '| Fetches:', fetchStatuses.join(', '));

    if (!stories.length) {
      var diagMsg = 'No stories found. Fetch results: ' + fetchStatuses.join(', ');
      return res.status(200).json({ error: diagMsg });
    }

    // Build numbered list for Claude
    var storyList = stories.map(function(s, i) {
      return (i + 1) + '. [' + s.source + '] ' + s.title + ' (' + s.age + 'h ago)';
    }).join('\n');

    var prompt = 'You are a sports news editor for InsideMDSports covering University of Maryland Terrapins athletics.\n\nRate and categorize these stories. Return ONLY a JSON array, no other text.\n\nEach object must have:\n- idx: the story number (1-based)\n- headline: improved headline (keep original meaning)\n- source: the [Source] shown\n- time: e.g. "2h ago"\n- rating: 1-5 (5=breaking news, 4=major, 3=solid, 2=minor, 1=filler)\n- category: one of: recruiting, football, basketball, alumni, social, podcast, news\n- sport: football, basketball, lacrosse, soccer, or other\n- summary: one sentence\n\nOnly include stories with rating 2 or higher. Exclude duplicate stories.\n\nStories:\n' + storyList;

    var cr = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 4000, messages: [{ role: 'user', content: prompt }] })
    });
    var cd = await cr.json();

    // Extract text from Claude response
    var text = (cd.content || []).map(function(i) { return i.type === 'text' ? i.text : ''; }).join('\n');
    var cleaned = text.replace(/```json|```/g, '').trim();
    var start = cleaned.indexOf('[');
    var end = cleaned.lastIndexOf(']');
    if (start === -1 || end === -1) return res.status(200).json({ content: [{ type: 'text', text: '[]' }] });

    var parsed = JSON.parse(cleaned.substring(start, end + 1));

    // Re-attach URLs by idx
    var final = parsed.map(function(item) {
      var orig = stories[item.idx - 1];
      return Object.assign({}, item, { url: orig ? orig.url : '' });
    });

    return res.status(200).json({ content: [{ type: 'text', text: JSON.stringify(final) }] });

  } catch(e) {
    console.error('Scan error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
