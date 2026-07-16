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
  var cutoff = Date.now() - 36 * 60 * 60 * 1000;
  var googleCutoff = Date.now() - 36 * 60 * 60 * 1000;
  var excluded = ['insidemd', 'jeff ermann', 'ims radio', 'maryland.247sports', '247sports.com/college/maryland', 'insidetheshell'];

  try {
    var fetches = [
      fetch('https://www.reddit.com/r/MarylandTerrapins/new.json?limit=25', { headers: { 'User-Agent': 'IMSTool/1.0' } }),
      fetch('https://www.reddit.com/r/CFB/search.json?q=Maryland+Terrapins&sort=new&restrict_sr=on&limit=20', { headers: { 'User-Agent': 'IMSTool/1.0' } }),
      fetch('https://www.reddit.com/r/CollegeBasketball/search.json?q=Maryland+Terrapins&sort=new&restrict_sr=on&limit=20', { headers: { 'User-Agent': 'IMSTool/1.0' } }),
      // Google News OR-grouped feeds (indices 3-22)
      fetch('https://news.google.com/rss/search?q=%22Maryland+Terrapins%22+OR+%22Terps%22+OR+%22Maryland+Athletics%22+OR+%22Maryland+football%22+OR+%22Maryland+basketball%22+OR+%22Maryland+recruiting%22&hl=en-US&gl=US&ceid=US:en'),
      fetch('https://news.google.com/rss/search?q=%22James+E.+Smith%22+OR+%22Damon+Evans%22+OR+%22SECU+Stadium%22+OR+%22Xfinity+Center%22+OR+%22Maryland+athletic+director%22+OR+%22Barry+Gossett%22&hl=en-US&gl=US&ceid=US:en'),
      fetch('https://news.google.com/rss/search?q=%22Mike+Locksley%22+OR+%22Brian+Williams%22+OR+%22Clint+Trickett%22+OR+%22Andre+Powell%22+OR+%22Pep+Hamilton%22+OR+%22Latrell+Scott%22&hl=en-US&gl=US&ceid=US:en'),
      fetch('https://news.google.com/rss/search?q=%22Malik+Washington%22+OR+%22Zahir+Mathis%22+OR+%22Sidney+Stewart%22+OR+%22Dontay+Joyner%22+OR+%22Amory+Hills%22+OR+%22Kyree+Caldwell%22+OR+%22Zeke+Walkup%22&hl=en-US&gl=US&ceid=US:en'),
      fetch('https://news.google.com/rss/search?q=%22Maryland+football+recruiting%22+OR+%22Maryland+commits%22+OR+%22Maryland+official+visit%22+OR+%22Maryland+2027+recruiting%22+OR+%22Maryland+2028+recruiting%22+OR+%22James+Branch%22+OR+%22Dallas+Pauldo%22&hl=en-US&gl=US&ceid=US:en'),
      fetch('https://news.google.com/rss/search?q=%22Boomer+Esiason%22+OR+%22Randy+White%22+OR+%22Vernon+Davis%22+OR+%22Stefon+Diggs%22+OR+%22Darnell+Savage%22+OR+%22DJ+Moore%22+OR+%22Torrey+Smith%22&hl=en-US&gl=US&ceid=US:en'),
      fetch('https://news.google.com/rss/search?q=%22Shawne+Merriman%22+OR+%22E.J.+Henderson%22+OR+%22Josh+Wilson%22+OR+%22LaMont+Jordan%22+OR+%22Jermaine+Lewis%22+OR+%22Frank+Wycheck%22+OR+%22Randy+Edsall%22&hl=en-US&gl=US&ceid=US:en'),
      fetch('https://news.google.com/rss/search?q=%22Buzz+Williams%22+OR+%22Kevin+Willard%22+OR+%22Danny+Manning%22+OR+%22David+Cox%22+OR+%22Maryland+basketball+recruiting%22+OR+%22Maryland+basketball+NIL%22&hl=en-US&gl=US&ceid=US:en'),
      fetch('https://news.google.com/rss/search?q=%22DJ+Wagner%22+OR+%22Baba+Oladotun%22+OR+%22Mike+McNair%22+OR+%22Robert+Jennings%22+OR+%22Bishop+Boswell%22+OR+%22Kaden+House%22+OR+%22Adama+Tambedou%22&hl=en-US&gl=US&ceid=US:en'),
      fetch('https://news.google.com/rss/search?q=%22Len+Bias%22+OR+%22Juan+Dixon%22+OR+%22Greivis+Vasquez%22+OR+%22Melo+Trimble%22+OR+%22Joe+Smith%22+OR+%22Steve+Francis%22+OR+%22Walt+Williams%22&hl=en-US&gl=US&ceid=US:en'),
      fetch('https://news.google.com/rss/search?q=%22Diamond+Stone%22+OR+%22Jalen+Smith%22+OR+%22Kevin+Huerter%22+OR+%22Bruno+Fernando%22+OR+%22Jake+Layman%22+OR+%22Alex+Len%22+OR+%22Dez+Wells%22&hl=en-US&gl=US&ceid=US:en'),
      fetch('https://news.google.com/rss/search?q=%22Brenda+Frese%22+OR+%22Alyssa+Thomas%22+OR+%22Kristi+Toliver%22+OR+%22Diamond+Miller%22+OR+%22Maryland+women%27s+basketball%22+OR+%22Crystal+Langhorne%22&hl=en-US&gl=US&ceid=US:en'),
      fetch('https://news.google.com/rss/search?q=%22John+Tillman%22+OR+%22Logan+Wisnauskas%22+OR+%22Jared+Bernhardt%22+OR+%22Matt+Rambo%22+OR+%22Maryland+men%27s+lacrosse%22+OR+%22Maryland+women%27s+lacrosse%22+OR+%22Taylor+Cummings%22&hl=en-US&gl=US&ceid=US:en'),
      fetch('https://news.google.com/rss/search?q=%22Rob+Vaughn%22+OR+%22Maryland+baseball%22+OR+%22Sasho+Cirovski%22+OR+%22Patrick+Mullins%22+OR+%22Taylor+Twellman%22+OR+%22Zack+Steffen%22+OR+%22Maryland+soccer%22&hl=en-US&gl=US&ceid=US:en'),
      fetch('https://news.google.com/rss/search?q=%22Maryland+wrestling%22+OR+%22Missy+Meharg%22+OR+%22Maryland+field+hockey%22+OR+%22Maryland+volleyball%22+OR+%22Maryland+gymnastics%22+OR+%22Renaldo+Nehemiah%22+OR+%22Kyle+Snyder%22&hl=en-US&gl=US&ceid=US:en'),
      fetch('https://news.google.com/rss/search?q=%22Maryland+Crystal+Ball%22+OR+%22Maryland+decommitment%22+OR+%22Maryland+portal+target%22+OR+%22Maryland+transfer+portal%22+OR+%22Maryland+scholarship+offer%22+OR+%22Maryland+visit+weekend%22&hl=en-US&gl=US&ceid=US:en'),
      fetch('https://news.google.com/rss/search?q=%22Maryland+NIL%22+OR+%22Maryland+NIL+collective%22+OR+%22Maryland+Terrapin+Club%22+OR+%22Maryland+athletics+fundraising%22+OR+%22Maryland+athletics+revenue%22&hl=en-US&gl=US&ceid=US:en'),
      fetch('https://news.google.com/rss/search?q=%22Testudo+Times%22+OR+%22Terrapin+Sports+Report%22+OR+%22On3+Maryland%22+OR+%22Rivals+Maryland%22+OR+%22Fear+the+Turtle%22+OR+%22Fear+the+Podcast%22&hl=en-US&gl=US&ceid=US:en'),
      fetch('https://news.google.com/rss/search?q=%22Maryland+football+roster%22+OR+%22Maryland+basketball+schedule%22+OR+%22Maryland+spring+football%22+OR+%22Maryland+Big+Ten%22+OR+%22Maryland+coaching+search%22+OR+%22Maryland+stadium+renovation%22&hl=en-US&gl=US&ceid=US:en'),
      fetch('https://news.google.com/rss/search?q=%22Aaron+Wiggins%22+OR+%22Jalen+Smith+NBA%22+OR+%22Alex+Len+NBA%22+OR+%22Bruno+Fernando+NBA%22+OR+%22DJ+Moore+NFL%22+OR+%22Darnell+Savage+NFL%22+OR+%22Torrey+Smith+NFL%22&hl=en-US&gl=US&ceid=US:en')
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

    // Google News RSS (indices 3-22)
    for (var gi = 3; gi < results.length; gi++) {
      if (results[gi].status !== 'fulfilled') continue;
      try {
        var xml = await results[gi].value.text();
        var items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
        items.forEach(function(item) {
          var title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/) || [])[1] || '';
          var link = (item.match(/<link>(.*?)<\/link>/) || [])[1] || '';
          var src = (item.match(/<source[^>]*>(.*?)<\/source>/) || [])[1] || 'Google News';
          var srcUrl = (item.match(/<source[^>]*url="([^"]*)"/) || [])[1] || '';
          var pubDate = (item.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || '';
          // Extract real article URL from description (Google News embeds it there)
          var desc = (item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) || [])[1] || '';
          var realUrl = (desc.match(/href="(https?:\/\/[^"]+)"/) || [])[1] || link;
          if (!title) return;
          var age = pubDate ? Math.round((Date.now() - new Date(pubDate).getTime()) / 3600000) : 0;
          if (pubDate && new Date(pubDate).getTime() < googleCutoff) return;
          if (excluded.some(function(ex) { return src.toLowerCase().includes(ex) || srcUrl.toLowerCase().includes(ex) || title.toLowerCase().includes(ex) || realUrl.toLowerCase().includes(ex); })) return;
          stories.push({ title: title.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>'), source: src, url: realUrl || link, age: age });
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

    // Limit trending topic flood: max 4 stories sharing the same prominent name
    var nameCount = {};
    stories = stories.filter(function(s) {
      var names = s.title.match(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/g) || [];
      for (var n of names) {
        nameCount[n] = (nameCount[n] || 0) + 1;
        if (nameCount[n] > 4) return false;
      }
      return true;
    });

    // Cap at 40 most recent stories to keep Claude response within token limits
    stories = stories.sort(function(a, b) { return a.age - b.age; }).slice(0, 40);

    var redditCount = stories.filter(function(s){return s.source.includes('Reddit');}).length;
    var googleCount = stories.filter(function(s){return !s.source.includes('Reddit');}).length;
    var fetchStatuses = results.map(function(r, i) {
      var names = ['Reddit/MarylandTerrapins','Reddit/CFB','Reddit/CollegeBasketball','GNews/core','GNews/admin','GNews/fbstaff','GNews/fbplayers','GNews/fbrecruits','GNews/fblgd1','GNews/fblgd2','GNews/bbstaff','GNews/bbplayers','GNews/fmrbb1','GNews/fmrbb2','GNews/wbb','GNews/lacrosse','GNews/baseball','GNews/othersports','GNews/recruiting','GNews/nil','GNews/media','GNews/season','GNews/nflnba'];
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

    var today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    var prompt = 'You are a sports news editor for InsideMDSports covering University of Maryland Terrapins athletics. Today is ' + today + '.\n\nRate and categorize ALL of these stories. Return ONLY a JSON array, no other text. Include EVERY story.\n\nEach object must have:\n- idx: the story number (1-based)\n- headline: improved headline (keep original meaning)\n- source: the [Source] shown\n- time: e.g. "2h ago"\n- rating: 1-5 (5=breaking news, 4=major, 3=solid, 2=minor, 1=filler)\n- category: one of: recruiting, football, basketball, alumni, social, podcast, news\n- sport: football, basketball, lacrosse, soccer, or other\n- summary: one sentence\n- republished: true if this appears to be a recycled/republished article about events that clearly happened weeks or months ago (e.g. a recruiting visit scheduled in a prior month, an old signing, a past season result being re-reported). Use today\'s date to judge this. Set false for genuinely new stories.\n\nInclude ALL stories. Do not skip any.\n\nStories:\n' + storyList;

    var cr = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 8000, messages: [{ role: 'user', content: prompt }] })
    });
    var cd = await cr.json();

    // Expose Claude API errors
    if (cd.error) return res.status(200).json({ error: 'Claude error: ' + JSON.stringify(cd.error) });
    if (!cd.content) return res.status(200).json({ error: 'Claude returned no content. Raw: ' + JSON.stringify(cd).substring(0, 300) });

    // Extract text from Claude response
    var text = cd.content.map(function(i) { return i.type === 'text' ? i.text : ''; }).join('\n');
    var cleaned = text.replace(/```json|```/g, '').trim();
    var start = cleaned.indexOf('[');
    var end = cleaned.lastIndexOf(']');
    if (start === -1 || end === -1) return res.status(200).json({ error: 'Claude did not return JSON. Response: ' + cleaned.substring(0, 300) });

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
