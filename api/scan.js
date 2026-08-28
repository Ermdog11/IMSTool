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
  // Sources the editor has blocked via the "Block source" button — filtered out below and never shown again.
  var userBlocked = ((req.body && req.body.blockedSources) || [])
    .map(function(s) { return String(s || '').trim().toLowerCase(); })
    .filter(Boolean);
  if (userBlocked.length) excluded = excluded.concat(userBlocked);

  try {
    // RSS/news feeds: name is for diagnostics, src is the fallback source label
    var feedConfigs = [
      { url: 'https://news.google.com/rss/search?q=%22Maryland+Terrapins%22+OR+%22Terps%22+OR+%22Maryland+Athletics%22+OR+%22Maryland+football%22+OR+%22Maryland+basketball%22+OR+%22Maryland+recruiting%22&hl=en-US&gl=US&ceid=US:en', name: 'GNews/core' },
      { url: 'https://news.google.com/rss/search?q=%22James+E.+Smith%22+OR+%22Damon+Evans%22+OR+%22SECU+Stadium%22+OR+%22Xfinity+Center%22+OR+%22Maryland+athletic+director%22+OR+%22Barry+Gossett%22&hl=en-US&gl=US&ceid=US:en', name: 'GNews/admin' },
      { url: 'https://news.google.com/rss/search?q=%22Mike+Locksley%22+OR+%22Brian+Williams%22+OR+%22Clint+Trickett%22+OR+%22Andre+Powell%22+OR+%22Pep+Hamilton%22+OR+%22Latrell+Scott%22&hl=en-US&gl=US&ceid=US:en', name: 'GNews/fbstaff' },
      { url: 'https://news.google.com/rss/search?q=%22Malik+Washington%22+OR+%22Zahir+Mathis%22+OR+%22Sidney+Stewart%22+OR+%22Dontay+Joyner%22+OR+%22Amory+Hills%22+OR+%22Kyree+Caldwell%22+OR+%22Zeke+Walkup%22&hl=en-US&gl=US&ceid=US:en', name: 'GNews/fbplayers' },
      { url: 'https://news.google.com/rss/search?q=%22Maryland+football+recruiting%22+OR+%22Maryland+commits%22+OR+%22Maryland+official+visit%22+OR+%22Maryland+2027+recruiting%22+OR+%22Maryland+2028+recruiting%22+OR+%22James+Branch%22+OR+%22Dallas+Pauldo%22&hl=en-US&gl=US&ceid=US:en', name: 'GNews/fbrecruits' },
      { url: 'https://news.google.com/rss/search?q=%22Boomer+Esiason%22+OR+%22Randy+White%22+OR+%22Vernon+Davis%22+OR+%22Stefon+Diggs%22+OR+%22Darnell+Savage%22+OR+%22DJ+Moore%22+OR+%22Torrey+Smith%22&hl=en-US&gl=US&ceid=US:en', name: 'GNews/fblgd1' },
      { url: 'https://news.google.com/rss/search?q=%22Shawne+Merriman%22+OR+%22E.J.+Henderson%22+OR+%22Josh+Wilson%22+OR+%22LaMont+Jordan%22+OR+%22Jermaine+Lewis%22+OR+%22Frank+Wycheck%22+OR+%22Randy+Edsall%22&hl=en-US&gl=US&ceid=US:en', name: 'GNews/fblgd2' },
      { url: 'https://news.google.com/rss/search?q=%22Buzz+Williams%22+OR+%22Kevin+Willard%22+OR+%22Danny+Manning%22+OR+%22David+Cox%22+OR+%22Maryland+basketball+recruiting%22+OR+%22Maryland+basketball+NIL%22&hl=en-US&gl=US&ceid=US:en', name: 'GNews/bbstaff' },
      { url: 'https://news.google.com/rss/search?q=%22DJ+Wagner%22+OR+%22Baba+Oladotun%22+OR+%22Mike+McNair%22+OR+%22Robert+Jennings%22+OR+%22Bishop+Boswell%22+OR+%22Kaden+House%22+OR+%22Adama+Tambedou%22&hl=en-US&gl=US&ceid=US:en', name: 'GNews/bbplayers' },
      { url: 'https://news.google.com/rss/search?q=%22Len+Bias%22+OR+%22Juan+Dixon%22+OR+%22Greivis+Vasquez%22+OR+%22Melo+Trimble%22+OR+%22Joe+Smith%22+OR+%22Steve+Francis%22+OR+%22Walt+Williams%22&hl=en-US&gl=US&ceid=US:en', name: 'GNews/fmrbb1' },
      { url: 'https://news.google.com/rss/search?q=%22Jalen+Smith%22+OR+%22Kevin+Huerter%22+OR+%22Bruno+Fernando%22+OR+%22Jake+Layman%22+OR+%22Alex+Len%22+OR+%22Dez+Wells%22&hl=en-US&gl=US&ceid=US:en', name: 'GNews/fmrbb2' },
      { url: 'https://news.google.com/rss/search?q=%22Brenda+Frese%22+OR+%22Alyssa+Thomas%22+OR+%22Kristi+Toliver%22+OR+%22Diamond+Miller%22+OR+%22Maryland+women%27s+basketball%22+OR+%22Crystal+Langhorne%22&hl=en-US&gl=US&ceid=US:en', name: 'GNews/wbb' },
      { url: 'https://news.google.com/rss/search?q=%22John+Tillman%22+OR+%22Logan+Wisnauskas%22+OR+%22Jared+Bernhardt%22+OR+%22Matt+Rambo%22+OR+%22Maryland+men%27s+lacrosse%22+OR+%22Maryland+women%27s+lacrosse%22+OR+%22Taylor+Cummings%22&hl=en-US&gl=US&ceid=US:en', name: 'GNews/lacrosse' },
      { url: 'https://news.google.com/rss/search?q=%22Rob+Vaughn%22+OR+%22Maryland+baseball%22+OR+%22Sasho+Cirovski%22+OR+%22Patrick+Mullins%22+OR+%22Taylor+Twellman%22+OR+%22Zack+Steffen%22+OR+%22Maryland+soccer%22&hl=en-US&gl=US&ceid=US:en', name: 'GNews/baseball' },
      { url: 'https://news.google.com/rss/search?q=%22Maryland+wrestling%22+OR+%22Missy+Meharg%22+OR+%22Maryland+field+hockey%22+OR+%22Maryland+volleyball%22+OR+%22Maryland+gymnastics%22+OR+%22Renaldo+Nehemiah%22+OR+%22Kyle+Snyder%22&hl=en-US&gl=US&ceid=US:en', name: 'GNews/othersports' },
      { url: 'https://news.google.com/rss/search?q=%22Maryland+Crystal+Ball%22+OR+%22Maryland+decommitment%22+OR+%22Maryland+portal+target%22+OR+%22Maryland+transfer+portal%22+OR+%22Maryland+scholarship+offer%22+OR+%22Maryland+visit+weekend%22&hl=en-US&gl=US&ceid=US:en', name: 'GNews/recruiting' },
      { url: 'https://news.google.com/rss/search?q=%22Maryland+NIL%22+OR+%22Maryland+NIL+collective%22+OR+%22Maryland+Terrapin+Club%22+OR+%22Maryland+athletics+fundraising%22+OR+%22Maryland+athletics+revenue%22&hl=en-US&gl=US&ceid=US:en', name: 'GNews/nil' },
      { url: 'https://news.google.com/rss/search?q=%22Testudo+Times%22+OR+%22Terrapin+Sports+Report%22+OR+%22On3+Maryland%22+OR+%22Rivals+Maryland%22+OR+%22Fear+the+Turtle%22+OR+%22Fear+the+Podcast%22&hl=en-US&gl=US&ceid=US:en', name: 'GNews/media' },
      { url: 'https://news.google.com/rss/search?q=%22Maryland+football+roster%22+OR+%22Maryland+basketball+schedule%22+OR+%22Maryland+spring+football%22+OR+%22Maryland+Big+Ten%22+OR+%22Maryland+coaching+search%22+OR+%22Maryland+stadium+renovation%22&hl=en-US&gl=US&ceid=US:en', name: 'GNews/season' },
      { url: 'https://news.google.com/rss/search?q=%22Aaron+Wiggins%22+OR+%22Jalen+Smith+NBA%22+OR+%22Alex+Len+NBA%22+OR+%22Bruno+Fernando+NBA%22+OR+%22DJ+Moore+NFL%22+OR+%22Darnell+Savage+NFL%22+OR+%22Torrey+Smith+NFL%22&hl=en-US&gl=US&ceid=US:en', name: 'GNews/nflnba' },
      { url: 'https://www.insidetheblackandgold.net/feed/', name: 'ITBG', src: 'Inside The Black And Gold' },
      { url: 'https://news.google.com/rss/search?q=site%3Anytimes.com+%22Maryland+Terrapins%22&hl=en-US&gl=US&ceid=US:en', name: 'Athletic/terrapins', src: 'The Athletic' },
      { url: 'https://news.google.com/rss/search?q=site%3Anytimes.com+%22Terps%22+OR+site%3Anytimes.com+%22Locksley%22&hl=en-US&gl=US&ceid=US:en', name: 'Athletic/names', src: 'The Athletic' },
      { url: 'https://news.google.com/rss/search?q=site%3Aespn.com+%22Maryland+Terrapins%22&hl=en-US&gl=US&ceid=US:en', name: 'ESPN/terrapins', src: 'ESPN' },
      { url: 'https://news.google.com/rss/search?q=site%3Aespn.com+%22Terps%22+OR+site%3Aespn.com+%22Locksley%22+OR+site%3Aespn.com+%22Buzz+Williams%22&hl=en-US&gl=US&ceid=US:en', name: 'ESPN/names', src: 'ESPN' },
      { url: 'https://news.google.com/rss/search?q=site%3Afoxsports.com+%22Maryland+Terrapins%22&hl=en-US&gl=US&ceid=US:en', name: 'FoxSports/terrapins', src: 'FOX Sports' },
      { url: 'https://news.google.com/rss/search?q=site%3Afoxsports.com+%22Terps%22+OR+site%3Afoxsports.com+%22Locksley%22+OR+site%3Afoxsports.com+%22Buzz+Williams%22&hl=en-US&gl=US&ceid=US:en', name: 'FoxSports/names', src: 'FOX Sports' },
      { url: 'https://collegehoopstoday.com/feed/', name: 'Rothstein', src: 'College Hoops Today (Rothstein)', requireTerps: true },
      { url: 'https://news.google.com/rss/search?q=site%3Acollegehoopstoday.com+%22Maryland%22&hl=en-US&gl=US&ceid=US:en', name: 'Rothstein/gnews', src: 'College Hoops Today (Rothstein)' },
      { url: 'https://news.google.com/rss/search?q=site%3Acbssports.com+%22Maryland+Terrapins%22+OR+site%3Acbssports.com+%22Terps%22&hl=en-US&gl=US&ceid=US:en', name: 'CBS/terps', src: 'CBS Sports' },
      { url: 'https://news.google.com/rss/search?q=site%3Asports.yahoo.com+%22Maryland+Terrapins%22+OR+site%3Asports.yahoo.com+%22Terps%22&hl=en-US&gl=US&ceid=US:en', name: 'Yahoo/terps', src: 'Yahoo Sports' },
      { url: 'https://news.google.com/rss/search?q=site%3Aon3.com+%22Maryland%22+recruiting+OR+commit+OR+portal&hl=en-US&gl=US&ceid=US:en', name: 'On3/maryland' },
      { url: 'https://news.google.com/rss/search?q=site%3Arivals.com+%22Maryland%22+recruiting+OR+commit+OR+portal&hl=en-US&gl=US&ceid=US:en', name: 'Rivals/maryland' },
      { url: 'https://news.google.com/rss/search?q=site%3A247sports.com+%22Maryland+Terrapins%22+commit+OR+recruiting+OR+portal+-site%3Amaryland.247sports.com&hl=en-US&gl=US&ceid=US:en', name: '247national/maryland' },
      // Our own outlet (247Sports Maryland / InsideMDSports). Google News reports its source
      // as plain "247Sports" and gives a redirect URL, and it doesn't index the site anyway,
      // so neither the src label nor the URL can be matched against `excluded`. Instead we
      // scrape the Maryland landing page — its article URLs carry the headline as a slug —
      // and use those headlines as a blocklist (see ownTitles / scrapeSlugs below).
      { url: 'https://247sports.com/college/maryland/', name: 'own247/blocklist', scrapeSlugs: true },
      { url: 'https://news.google.com/rss/search?q=site%3Abtn.com+%22Maryland%22&hl=en-US&gl=US&ceid=US:en', name: 'BTN', src: 'Big Ten Network' },
      { url: 'https://news.google.com/rss/search?q=site%3Asi.com+%22Maryland+Terrapins%22+OR+site%3Asi.com+%22Terps%22&hl=en-US&gl=US&ceid=US:en', name: 'SI/terps', src: 'Sports Illustrated' },
      { url: 'https://news.google.com/rss/search?q=%22Maryland+Terrapins%22+preview+OR+prediction+OR+%22scouting+report%22&hl=en-US&gl=US&ceid=US:en', name: 'GNews/opponents' },
      // Bing News — independent index, catches stories Google misses
      { url: 'https://www.bing.com/news/search?q=%22Maryland+Terrapins%22&format=rss', name: 'Bing/terrapins' },
      { url: 'https://www.bing.com/news/search?q=%22Terps%22+football+OR+basketball&format=rss', name: 'Bing/terps' },
      { url: 'https://www.bing.com/news/search?q=%22Maryland+football%22+OR+%22Maryland+basketball%22+recruiting&format=rss', name: 'Bing/recruiting' },
      // Niche site direct feeds — no dependence on search engine indexing
      { url: 'https://www.testudotimes.com/rss/index.xml', name: 'TestudoTimes', src: 'Testudo Times' },
      { url: 'https://dbknews.com/feed/', name: 'Diamondback', src: 'The Diamondback', requireTerps: true },
      { url: 'https://pressboxonline.com/feed/', name: 'PressBox', src: 'PressBox', requireTerps: true },
      // UMD official — roster moves and schedule changes announced here first
      { url: 'https://umterps.com/rss.aspx', name: 'UMTerps', src: 'UMTerps.com' },
      // Regional outlets via Google News site queries (their own feeds are unreliable)
      { url: 'https://news.google.com/rss/search?q=site%3Abaltimoresun.com+%22Terps%22+OR+site%3Abaltimoresun.com+%22Maryland+Terrapins%22&hl=en-US&gl=US&ceid=US:en', name: 'BaltSun', src: 'Baltimore Sun' },
      { url: 'https://news.google.com/rss/search?q=site%3Awashingtonpost.com+%22Terps%22+OR+site%3Awashingtonpost.com+%22Maryland+Terrapins%22&hl=en-US&gl=US&ceid=US:en', name: 'WaPo', src: 'Washington Post' },
      { url: 'https://news.google.com/rss/search?q=site%3Athebaltimorebanner.com+%22Terps%22+OR+site%3Athebaltimorebanner.com+%22Maryland+Terrapins%22&hl=en-US&gl=US&ceid=US:en', name: 'BaltBanner', src: 'Baltimore Banner' },
      // Rival team boards — recruiting battles often break on other schools' sites
      { url: 'https://news.google.com/rss/search?q=%22beats+out+Maryland%22+OR+%22over+Maryland%22+recruiting+OR+commit&hl=en-US&gl=US&ceid=US:en', name: 'GNews/rivalwins' },
      { url: 'https://news.google.com/rss/search?q=Maryland+%22official+visit%22+OR+%22top+schools%22+OR+%22decision+date%22+recruit&hl=en-US&gl=US&ceid=US:en', name: 'GNews/rivalbattles' },
      // Local TV stations — occasionally break local angles first
      { url: 'https://news.google.com/rss/search?q=site%3Awbaltv.com+%22Terps%22+OR+site%3Awbaltv.com+%22Maryland+Terrapins%22&hl=en-US&gl=US&ceid=US:en', name: 'WBAL', src: 'WBAL-TV' },
      { url: 'https://news.google.com/rss/search?q=site%3Acbsnews.com+%22Terps%22+OR+site%3Acbsnews.com+%22Maryland+Terrapins%22&hl=en-US&gl=US&ceid=US:en', name: 'WJZ', src: 'WJZ/CBS Baltimore' },
      { url: 'https://news.google.com/rss/search?q=site%3Awusa9.com+%22Terps%22+OR+site%3Awusa9.com+%22Maryland+Terrapins%22&hl=en-US&gl=US&ceid=US:en', name: 'WUSA9', src: 'WUSA9' },
      { url: 'https://news.google.com/rss/search?q=site%3Awtop.com+%22Terps%22+OR+site%3Awtop.com+%22Maryland+Terrapins%22&hl=en-US&gl=US&ceid=US:en', name: 'WTOP', src: 'WTOP' },
      // High school sports — recruit performances before the national radar
      { url: 'https://news.google.com/rss/search?q=%22committed+to+Maryland%22+OR+%22Maryland+commit%22+OR+%22Terps+commit%22+%22high+school%22&hl=en-US&gl=US&ceid=US:en', name: 'HS/commits' },
      { url: 'https://news.google.com/rss/search?q=site%3Amaxpreps.com+Maryland+Terrapins+OR+%22committed+to+Maryland%22&hl=en-US&gl=US&ceid=US:en', name: 'HS/maxpreps', src: 'MaxPreps' },
      { url: 'https://news.google.com/rss/search?q=%22Maryland+offer%22+OR+%22offered+by+Maryland%22+high+school+football+OR+basketball&hl=en-US&gl=US&ceid=US:en', name: 'HS/offers' }
    ];

    var redditFetches = [
      { url: 'https://www.reddit.com/r/MarylandTerrapins/new.json?limit=25', name: 'Reddit/MarylandTerrapins' },
      { url: 'https://www.reddit.com/r/CFB/search.json?q=Maryland+Terrapins&sort=new&restrict_sr=on&limit=20', name: 'Reddit/CFB' },
      { url: 'https://www.reddit.com/r/CollegeBasketball/search.json?q=Maryland+Terrapins&sort=new&restrict_sr=on&limit=20', name: 'Reddit/CollegeBasketball' }
    ];

    // Every external fetch gets its own timeout — without this, a single slow or
    // hanging RSS/Reddit source can block Promise.allSettled indefinitely (fetch()
    // has no default timeout), which drags the whole function past Vercel's
    // execution limit and shows up to the user as a request that never finishes.
    function fetchWithTimeout(url, options, timeoutMs) {
      var controller = new AbortController();
      var timer = setTimeout(function() { controller.abort(); }, timeoutMs || 8000);
      return fetch(url, Object.assign({}, options, { signal: controller.signal }))
        .finally(function() { clearTimeout(timer); });
    }

    var fetches = redditFetches.map(function(f) {
      return fetchWithTimeout(f.url, { headers: { 'User-Agent': 'IMSTool/1.0' } }, 8000);
    }).concat(feedConfigs.map(function(f) {
      // Scraped HTML pages 403 without a browser UA; RSS endpoints don't care either way.
      var opts = f.scrapeSlugs ? { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36' } } : {};
      return fetchWithTimeout(f.url, opts, 8000);
    }));

    var results = await Promise.allSettled(fetches);
    var stories = [];
    // Normalized headlines of articles that originated on our own outlet — used to drop
    // the same stories when they resurface (unlabeled) in the general Google News feeds.
    var ownTitles = {};
    // Normalize for headline matching. Strip HTML entities first so "&amp;" (raw feed
    // title) and "&" (decoded story title) normalize the same way.
    function normTitle(t) {
      return t.toLowerCase().replace(/&[a-z]+;|&#\d+;/g, ' ').replace(/[^a-z0-9 ]/g, '').substring(0, 60);
    }

    // Reddit results (indices 0-2)
    for (var ri = 0; ri < redditFetches.length; ri++) {
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
          // Skip reddit-hosted media and meme/image hosts
          if (/i\.redd\.it|v\.redd\.it|reddit\.com\/gallery|imgur\.com|gfycat|redgifs/i.test(url)) return;
          // Skip recurring discussion thread patterns
          if (/game thread|post game|postgame thread|daily discussion|weekly|free talk|megathread|who do you|what are your|unpopular opinion|rank your/i.test(d.title)) return;
          var src = 'Reddit r/' + d.subreddit;
          if (excluded.some(function(ex) { return src.toLowerCase().includes(ex) || url.toLowerCase().includes(ex); })) return;
          stories.push({ title: d.title, source: src, url: url, age: Math.round((Date.now() - created) / 3600000) });
        });
      } catch(e) { /* skip failed reddit */ }
    }

    // RSS feeds (Google News, Bing, direct site feeds)
    for (var gi = redditFetches.length; gi < results.length; gi++) {
      if (results[gi].status !== 'fulfilled') continue;
      var cfg = feedConfigs[gi - redditFetches.length];
      try {
        var xml = await results[gi].value.text();
        // Our-outlet blocklist: pull headline slugs out of the Maryland landing page's
        // article URLs (…/article/some-headline-slug-289225568/) and record them.
        if (cfg.scrapeSlugs) {
          var slugMatches = xml.match(/\/college\/maryland\/(?:article|longformarticle)\/[a-z0-9-]+-\d{6,}/g) || [];
          slugMatches.forEach(function(m) {
            var slug = m.replace(/.*\/(?:article|longformarticle)\//, '').replace(/-\d{6,}$/, '').replace(/-/g, ' ');
            if (slug) ownTitles[normTitle(slug)] = true;
          });
          continue;
        }
        var items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
        items.forEach(function(item) {
          var title = (item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || item.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
          var link = (item.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
          var src = (item.match(/<source[^>]*>(.*?)<\/source>/) || [])[1] || cfg.src || 'Google News';
          var srcUrl = (item.match(/<source[^>]*url="([^"]*)"/) || [])[1] || '';
          var pubDate = (item.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || '';
          // Extract real article URL from description (Google News embeds it there)
          var desc = (item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) || item.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '';
          var realUrl = (desc.match(/href="(https?:\/\/[^"]+)"/) || [])[1] || link;
          // Bing wraps the real publisher URL in an apiclick redirect: ...&url=<encoded>&...
          var bingUrl = (link + ' ' + realUrl).replace(/&amp;/g, '&').match(/[?&]url=(https?%3[Aa][^&"\s<]+)/);
          if (bingUrl) { try { realUrl = decodeURIComponent(bingUrl[1]); } catch (e) {} }
          // Plain-text snippet from the feed (Bing + direct site feeds carry a real one;
          // Google News descriptions are just "<a>Title</a> Publisher" and get skipped)
          var snippet = '';
          var rawSnip = desc;
          var ce = (item.match(/<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/) || [])[1];
          if (ce && ce.length > desc.length) rawSnip = ce;
          if (rawSnip && !/^\s*<a\s+href/i.test(rawSnip)) {
            snippet = rawSnip.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
              .replace(/&amp;/g, '&').replace(/&#?[a-z0-9]+;/gi, ' ')
              .replace(/\s+/g, ' ').trim().slice(0, 320);
          }
          if (!title) return;
          title = title.trim();
          // Auto-generated stat / leaderboard stub pages (FOX Sports etc.) are never news — drop them
          if (/\bstats?\s*(?:&|&amp;|and)\s*leaders?\b|\bstat leaders?\b/i.test(title)) return;
          // Some direct feeds carry the whole publication — require Terps relevance
          if (cfg.requireTerps) {
            var relevanceText = (title + ' ' + desc).toLowerCase();
            var terpsWords = ['terps', 'terrapins', 'maryland athletic', 'maryland football', 'maryland basketball', 'maryland lacrosse', 'maryland soccer', 'maryland baseball', 'maryland wrestling', 'maryland volleyball', 'maryland gymnastics', 'field hockey', 'locksley', 'buzz williams', 'willard', 'frese', 'umterps', 'xfinity center', 'secu stadium', 'college park recruit'];
            if (!terpsWords.some(function(w) { return relevanceText.includes(w); })) return;
          }
          var age = pubDate ? Math.round((Date.now() - new Date(pubDate).getTime()) / 3600000) : 0;
          if (pubDate && new Date(pubDate).getTime() < googleCutoff) return;
          if (excluded.some(function(ex) { return src.toLowerCase().includes(ex) || srcUrl.toLowerCase().includes(ex) || title.toLowerCase().includes(ex) || realUrl.toLowerCase().includes(ex); })) return;
          stories.push({ title: title.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>'), source: src, url: (realUrl || link).trim(), age: age, snippet: snippet });
        });
      } catch(e) { /* skip failed feed */ }
    }

    // Drop stories that originated on our own outlet (matched by headline against the blocklist feed)
    var ownFiltered = 0;
    stories = stories.filter(function(s) {
      if (ownTitles[normTitle(s.title)]) { ownFiltered++; return false; }
      return true;
    });

    // Deduplicate by title similarity. When the same story shows up from multiple feeds,
    // keep the first but upgrade its URL/snippet from a later copy that has a real
    // (fetchable, non-Google-redirect) link or a real article snippet — the deep-read
    // pass needs those.
    var seenIdx = {};
    var deduped = [];
    stories.forEach(function(s) {
      var norm = normTitle(s.title);
      if (seenIdx[norm] === undefined) {
        seenIdx[norm] = deduped.length;
        deduped.push(s);
        return;
      }
      var kept = deduped[seenIdx[norm]];
      if (/news\.google\.com/i.test(kept.url) && !/news\.google\.com/i.test(s.url)) kept.url = s.url;
      if (!kept.snippet && s.snippet) kept.snippet = s.snippet;
    });
    stories = deduped;

    // Cap at 40 most recent before sending to Claude
    stories = stories.sort(function(a, b) { return a.age - b.age; }).slice(0, 40);

    var redditCount = stories.filter(function(s){return s.source.includes('Reddit');}).length;
    var googleCount = stories.filter(function(s){return !s.source.includes('Reddit');}).length;
    var allNames = redditFetches.map(function(f) { return f.name; }).concat(feedConfigs.map(function(f) { return f.name; }));
    var fetchStatuses = results.map(function(r, i) {
      return allNames[i] + ':' + (r.status === 'fulfilled' ? r.value.status : 'FAILED');
    });
    console.log('Stories:', stories.length, '| Reddit:', redditCount, '| Google:', googleCount, '| Own-outlet filtered:', ownFiltered, '| Blocklist size:', Object.keys(ownTitles).length, '| Fetches:', fetchStatuses.join(', '));

    if (!stories.length) {
      var diagMsg = 'No stories found. Fetch results: ' + fetchStatuses.join(', ');
      return res.status(200).json({ error: diagMsg });
    }

    // Build numbered list for Claude — include the feed snippet where we have one
    var storyList = stories.map(function(s, i) {
      var line = (i + 1) + '. [' + s.source + '] ' + s.title + ' (' + s.age + 'h ago)';
      if (s.snippet) line += '\n   snippet: ' + s.snippet;
      return line;
    }).join('\n');

    var flaggedNote = '';
    var flagged = (body.flagged || []).slice(-30);
    if (flagged.length) {
      flaggedNote = '\n\nThe editor has FLAGGED these recent stories as junk/irrelevant. Mark any similar stories (same subject, same kind of noise, same unrelated namesake) as irrelevant:true:\n' + flagged.map(function(f) { return '- [' + f.source + '] ' + f.headline; }).join('\n');
    }

    var WATCH = {
      coaches: ['Mike Locksley','Buzz Williams','Brenda Frese','Ted Monachino','Clint Trickett','Aazaar Abdul-Rahim','Jeremy Shapiro','Latrell Scott','Kyle Schmitt','Andre Powell','Gary Williams','Dave Pietramala'],
      fbCommits26: ['Zion Elee','Darrell Carey','Jamarcus Whyce','Javonte Williams','Jesse Moody','Ontario Washington Jr.','Chuck Roberts'],
      fbCommits27: ['Myles McAfee','Levi Babin','Mekhi Graham','Davion Vanderbilt','Dallas Pauldo','Kenaz Sullivan','James Branch','Kyren Caldwell','Charles Roberts','Emerson Lewis','Jayden Agberodiola','Terrance Grant Jr.','Zeke Walkup','William Jackson','Anthony Henderson','Caleb Canty','Kendon Bauer','Shelvy Clark','Alex Fontenot','Abdus Kone','Kevin Jackson','Mason McClure'],
      fbTargets: ['James Pace III','Anthony Jennings','Cahron Wheeler','Franklin Richardson'],
      fbRoster: ['Malik Washington (Maryland QB)','Zahir Mathis','Sidney Stewart','Daniel Wingate','Dontay Joyner','Jamare Glasker','Messiah Delhomme','Justin Merriman','Lavain Scruggs','Jayden Shipps','Darrell Carey','Gavin Edwards'],
      bkRoster: ['Pharrel Payne','Andre Mills','DJ Wagner','Tomislav Buljan','Bishop Boswell','Kaden House','Austin Brown','Adama Tambedou','Robert Jennings','Baba Oladotun','Guillermo del Pino','Alexandre K\'Medehouto','George Turkson','Michael McNair','Maban Jabriel','Lukas Sotell'],
      bkTargets: ['Amir Jenkins','Beau Daniels','Markus Kerr','Corey Dixon'],
      nflAlumni: ['DJ Moore','Stefon Diggs','Chig Okonkwo','Nick Cross','Tai Felton','DJ Glaze','Deonte Banks','Jakorian Bennett','Tarheeb Still','Corey Bullock','Jalil Farooq','Shaleak Knotts','Dante Trader Jr.','Kaden Prather','Ruben Hyppolite II','Jeshaun Jones'],
      nbaAlumni: ['Derik Queen','Aaron Wiggins','Kevin Huerter','Joe Smith','Steve Blake','Buck Williams','Len Elmore','Tom McMillen','Alex Len','Bruno Fernando','Jalen Smith'],
      wnba: ['Kristi Toliver','Crystal Langhorne','Marissa Coleman'],
      legends: ['Juan Dixon','Greivis Vasquez','Len Bias','Albert King','Adrian Branch','John Lucas','Lonny Baxter','Walt Williams','Keith Booth','Johnny Rhodes','Terence Morris','Jake Layman','Dez Wells','Melo Trimble','Anthony Cowan','Nik Caner-Medley','Gene Shue','Derrick Lewis','Ernest Graham','Greg Manning','Keith Gatlin','Terrell Stokes','Eric Hayes','Duane Simpkins','Kevin McLinton','James Gist','Shawne Merriman','Boomer Esiason','Randy White','Vernon Davis','E.J. Henderson','Lydell Mitchell','Dominique Dawes','Thea LaFond','Quincy Wilson','Graham Zusi','Taylor Cummings','Frank Urso','Gary Gait'],
      admin: ['Jim Smith','Darryll Pines','Johnny Holliday','Damon Evans','Geroy Simon'],
      reporters: ['Testudo Times','TerpRecruiting','DBKSports','Ahmed Ghafir','Nolan Rogalski','Matt Germack'],
      podcasts: ['Testudo Talk','Locked On Terps','Hear The Turtle','Under The Shell','Protect The Shell','Testudos and Touchdowns']
    };
    var watchListText = 'PEOPLE TO WATCH — current/recent Maryland roster, commits, targets, staff, and alumni. Use this to confirm identity (see NAME COLLISIONS above) and to recognize names you might otherwise miss:\nCoaches: ' + WATCH.coaches.join(', ') + '\nFB commits 2026: ' + WATCH.fbCommits26.join(', ') + '\nFB commits 2027: ' + WATCH.fbCommits27.join(', ') + '\nFB targets: ' + WATCH.fbTargets.join(', ') + '\nFB roster: ' + WATCH.fbRoster.join(', ') + '\nBK roster: ' + WATCH.bkRoster.join(', ') + '\nBK targets: ' + WATCH.bkTargets.join(', ') + '\nNFL alumni: ' + WATCH.nflAlumni.join(', ') + '\nNBA alumni: ' + WATCH.nbaAlumni.join(', ') + '\nWNBA alumni: ' + WATCH.wnba.join(', ') + '\nLegends: ' + WATCH.legends.join(', ') + '\nAdmin: ' + WATCH.admin.join(', ') + '\nReporters/outlets to recognize as legitimate Terps coverage: ' + WATCH.reporters.join(', ') + '\nPodcasts: ' + WATCH.podcasts.join(', ');

    var today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    var prompt = 'You are a sports news editor for InsideMDSports covering University of Maryland Terrapins athletics. Today is ' + today + '.\n\nRate and categorize ALL of these stories. Return ONLY a JSON array, no other text. Include EVERY story.\n\nEach object must have:\n- idx: the story number (1-based)\n- headline: a cleaned-up version of the ORIGINAL headline — fix grammar, clarity, length, and clickbait only. DO NOT add or change any factual detail that is not already in the original: player positions (WR, QB, DE, guard...), jersey numbers, class year, height/weight, star ratings, team or school names, coaches, scores, stats, or dates. If the original does not state a player\'s position or role, do not put one in. When unsure, keep the original wording.\n- source: the [Source] shown\n- time: e.g. "2h ago"\n- rating: 1-5 (5=breaking news, 4=major, 3=solid, 2=minor, 1=filler)\n- category: one of: recruiting, football, basketball, alumni, social, podcast, news\n- sport: football, basketball, lacrosse, soccer, or other\n- summary: one factual sentence based only on what the headline/source actually says — do not invent positions, numbers, quotes, or outcomes\n- irrelevant: true if the story has NO genuine connection to Maryland Terrapins athletics, its coaches, players, recruits, or notable alumni (e.g. a random local charity story, general weather/campus news). These will be discarded.\n- needsContext: true if the headline and snippet do NOT give you enough to confidently judge the Maryland relevance or the rating — e.g. a national roundup/ranking/preview that might bury a Maryland player or angle, a vague headline, or a story where you suspect a stronger Terps angle exists in the body. We will pull the full article for these and re-rate.\n\nSome stories include a "snippet:" line — the opening of the article. Use it. If a snippet is present and still not enough, set needsContext:true.\n\nNAME COLLISIONS: many alumni share their name with unrelated athletes in other sports (e.g. Joe Smith the Chicago Cubs pitcher is NOT Maryland alum Joe Smith the former NBA player; Malik Washington the Miami Dolphins receiver is NOT the Maryland alum of the same name — Maryland\'s Malik Washington is the current QB). Before tagging any story category:"alumni", use your own knowledge to confirm the person in the story is actually the former Maryland athlete — check that their sport, team history, or position matches the real Maryland alum, not just the name. If the story is clearly about a different person who merely shares the name, set irrelevant:true.\n\n' + watchListText + '\n- republished: true if this appears to be a recycled/republished article about events that clearly happened weeks or months ago (e.g. a recruiting visit scheduled in a prior month, an old signing, a past season result being re-reported, an old controversy or quote resurfacing). Use today\'s date AND your knowledge of when events actually happened to judge this — if you recognize the underlying event as occurring more than 2 weeks ago, set republished true even if the article timestamp is recent. Be especially suspicious of aggregators (MSN, Yahoo, Sports Illustrated syndication) which frequently republish old stories with fresh timestamps. Set false only for genuinely new stories.\n\nPRIORITY: If a story headline or summary contains "breaking", "commits", "committed", "commitment", or "decommit" and it relates to Maryland, rate it 4 or 5 — these are high-value stories.\n\nFor former Maryland players now in the NFL/NBA (see NFL/NBA alumni lists above): rate routine pro coverage (fantasy analysis, practice notes, game recaps, rankings) 1-2. Only rate 3+ for major news (trades, signings, serious injuries, milestones) or stories with a genuine Maryland/Terps angle.\n\nFor Reddit posts: if the post is fan discussion, opinion, or a question rather than actual news, give it rating 1. Only rate Reddit posts 3+ if they report genuine news (commitments, injuries, hires, transfers, reports).\n\nLOW-PRIORITY SPORTS: We almost never cover these. ALWAYS rate a story that is primarily about one of them as rating 1, no matter how newsworthy it seems: volleyball, tennis, golf, cross country, wrestling, softball, field hockey, swimming & diving. Our core beats are football, men\'s and women\'s basketball, and men\'s and women\'s lacrosse.\n\nInclude ALL stories. Do not skip any.' + flaggedNote + '\n\nStories:\n' + storyList;

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

    // DEEP READ (digest runs only, body.deep === true): for stories the headline + snippet
    // couldn't settle (needsContext), fetch the real article and re-rate from its text.
    // Google-redirect URLs aren't fetchable, so those are skipped.
    if (body.deep === true) {
      var deepCandidates = parsed
        .map(function(item) { return { item: item, orig: stories[item.idx - 1] }; })
        .filter(function(p) {
          return p.item && p.item.needsContext && p.orig && p.orig.url && !/news\.google\.com/i.test(p.orig.url);
        })
        .slice(0, 8);

      if (deepCandidates.length) {
        var fetched = await Promise.allSettled(deepCandidates.map(function(p) {
          return fetchWithTimeout(p.orig.url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36' } }, 10000)
            .then(function(r) { return r.text(); })
            .then(function(html) {
              return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
                .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
                .replace(/&#?[a-z0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 2800);
            })
            .catch(function() { return ''; });
        }));

        var deepList = deepCandidates.map(function(p, k) {
          var art = fetched[k].status === 'fulfilled' ? fetched[k].value : '';
          return p.item.idx + '. [' + p.item.source + '] ' + p.item.headline + '\nARTICLE TEXT: ' + (art || '(could not fetch — judge from headline)');
        }).join('\n\n');

        var deepPrompt = 'You are the same InsideMDSports editor covering University of Maryland Terrapins athletics. Each item below is a story re-checked with its full article text. Return the CORRECTED rating now that you can see the body. Return ONLY a JSON array; each object: {"idx": <number, matching the number shown>, "rating": 1-5, "irrelevant": <bool>, "summary": "<one factual sentence, no invented facts>", "category": "recruiting|football|basketball|alumni|social|podcast|news", "sport": "football|basketball|lacrosse|soccer|other"}. Scale: 5=breaking, 4=major, 3=solid, 2=minor, 1=filler. irrelevant:true ONLY if the article has no real Maryland Terrapins connection. If a national piece meaningfully covers a Maryland player/recruit/coach/alum, rate that Maryland angle (usually 2-4). Stories primarily about volleyball, tennis, golf, cross country, wrestling, softball, field hockey, or swimming stay rating 1.\n\n' + deepList;

        try {
          var dr = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 4000, messages: [{ role: 'user', content: deepPrompt }] })
          });
          var dd = await dr.json();
          var dtext = (dd.content || []).map(function(i) { return i.type === 'text' ? i.text : ''; }).join('\n');
          var dmatch = dtext.match(/\[[\s\S]*\]/);
          if (dmatch) {
            var byIdx = {};
            JSON.parse(dmatch[0]).forEach(function(d) { byIdx[d.idx] = d; });
            parsed.forEach(function(item) {
              var d = byIdx[item.idx];
              if (!d) return;
              if (typeof d.rating === 'number') item.rating = d.rating;
              if (typeof d.irrelevant === 'boolean') item.irrelevant = d.irrelevant;
              if (d.summary) item.summary = d.summary;
              if (d.category) item.category = d.category;
              if (d.sport) item.sport = d.sport;
              item.deepened = true;
            });
          }
        } catch (e) { /* deep pass is best-effort — keep the headline ratings */ }
      }
    }

    // Drop stories Claude marked as having no Maryland connection
    parsed = parsed.filter(function(item) { return !item.irrelevant; });

    // Editorial rule: sports we almost never write about are always filler (rating 1),
    // regardless of how Claude rated them.
    var LOW_PRIORITY_SPORTS = /\b(volleyball|tennis|golf|cross[ -]country|wrestling|softball|field hockey|swimming|swim (?:and|&) dive)\b/i;
    parsed.forEach(function(item) {
      var t = ((item.headline || '') + ' ' + (item.summary || '')).toLowerCase();
      if (LOW_PRIORITY_SPORTS.test(t)) item.rating = 1;
    });

    // Re-attach URLs by idx
    var withUrls = parsed.map(function(item) {
      var orig = stories[item.idx - 1];
      return Object.assign({}, item, { url: orig ? orig.url : '' });
    });

    // Apply per-topic caps POST-rating so the most newsworthy stories stay in main feed.
    // Alumni get a tight cap of 1 main-feed slot PER PERSON (identified from the watch
    // lists so "DJ Moore" etc. match regardless of headline wording); the rest go to
    // overflow with a "More on this" link. General Terps topics still get 3.
    // Check original titles (not Claude's rewrites) for reliable name detection.
    var alumniWatch = [].concat(WATCH.nflAlumni, WATCH.nbaAlumni, WATCH.wnba, WATCH.legends)
      .map(function(name) { return { display: name, lc: name.toLowerCase() }; });
    var topicRatingCount = {};
    var overflowStories = [];
    // Sort by rating desc so highest-rated stories claim their topic slots first
    var sortedByRating = withUrls.slice().sort(function(a, b) { return (b.rating || 0) - (a.rating || 0); });
    var mainIds = new Set();
    var alumniTopics = {};
    var claimedBy = {}; // topic -> idx of the main-feed item holding that slot (highest-rated, since pre-sorted)
    sortedByRating.forEach(function(item) {
      var orig = stories[item.idx - 1];
      var originalTitle = orig ? orig.title : (item.headline || '');
      var overflowTopic = null;
      var itemTopics = [];

      if (item.category === 'alumni') {
        // Identify which alum the story is about; cap that person at 1/scan.
        var lc = (originalTitle + ' ' + (item.headline || '') + ' ' + (item.summary || '')).toLowerCase();
        var who = null;
        for (var ai = 0; ai < alumniWatch.length; ai++) {
          if (lc.indexOf(alumniWatch[ai].lc) !== -1) { who = alumniWatch[ai].display; break; }
        }
        // Fall back to a two-word name if the alum isn't on a watch list
        if (!who) {
          var m = (originalTitle.match(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/g) || [])
            .filter(function(t) { return !/^(maryland|university|college|big ten|terps|terrapin|ncaa|the )/i.test(t); })[0];
          who = m || 'alumni';
        }
        itemTopics = [who];
        alumniTopics[who] = true;
        topicRatingCount[who] = (topicRatingCount[who] || 0) + 1;
        if (topicRatingCount[who] > 1) overflowTopic = who;
      } else {
        // Two-word capitalized phrases, minus team/org/place names ("Maryland Athletics",
        // "Maryland Terrapins", "College Football", "Big Ten"...) — those aren't people and
        // shouldn't spawn a "More on <topic>" grouping; sport sections already handle them.
        itemTopics = (originalTitle.match(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/g) || [])
          .filter(function(t) { return !/^(maryland|university|college|big ten|terps|terrapin|ncaa|the )/i.test(t); });
        for (var n of itemTopics) {
          topicRatingCount[n] = (topicRatingCount[n] || 0) + 1;
          var cap = alumniTopics[n] ? 1 : 3;
          if (topicRatingCount[n] > cap) overflowTopic = n;
        }
      }

      if (overflowTopic) {
        overflowStories.push({ title: item.headline, source: item.source, url: item.url, age: orig ? orig.age : 0, trendingTopic: overflowTopic });
      } else {
        mainIds.add(item.idx);
        itemTopics.forEach(function(t) { if (!claimedBy[t]) claimedBy[t] = item.idx; });
      }
    });

    var final = withUrls.filter(function(item) { return mainIds.has(item.idx); });

    // Tag the main-feed item that holds each overflowing topic's slot with a "+N more" count.
    var overflowCountByTopic = {};
    overflowStories.forEach(function(s) {
      overflowCountByTopic[s.trendingTopic] = (overflowCountByTopic[s.trendingTopic] || 0) + 1;
    });
    Object.keys(overflowCountByTopic).forEach(function(topic) {
      var holderIdx = claimedBy[topic];
      if (!holderIdx) return;
      var holder = final.filter(function(it) { return it.idx === holderIdx; })[0];
      if (holder && !holder.trendingTopic) {
        holder.trendingTopic = topic;
        holder.overflowCount = overflowCountByTopic[topic];
      }
    });

    return res.status(200).json({ content: [{ type: 'text', text: JSON.stringify(final) }], overflow: overflowStories, sources: fetchStatuses });

  } catch(e) {
    console.error('Scan error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
