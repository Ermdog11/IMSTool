module.exports = async function handler(req, res) {
  // Bluesky public search API — free, no auth required
  var cutoff = Date.now() - 72 * 60 * 60 * 1000;

  var queries = [
    '"Maryland Terrapins"',
    '"Terps football"',
    '"Terps basketball"',
    '"Maryland football"',
    '"Maryland basketball"',
    '"Mike Locksley"',
    '"Buzz Williams"',
    '"Maryland recruiting"',
    '"Maryland transfer portal"',
    { q: 'Terps', requireContext: true },
    { q: 'Terrapins', requireContext: true },
    '"Derik Queen"',
    '"Baba Oladotun"',
    '"Malik Washington"',
    '"Brenda Frese"',
    '"Maryland lacrosse"'
  ];

  var excluded = ['insidemd', 'jeff ermann', 'ims radio', 'insidetheshell'];
  var cannabisTerms = ['terpene', 'cannabis', 'marijuana', 'weed', 'thc', 'cbd', 'dispensary', 'kush'];

  function isNoise(text) {
    var t = (text || '').toLowerCase();
    if (excluded.some(function(ex) { return t.includes(ex); })) return true;
    if (cannabisTerms.some(function(c) { return t.includes(c); })) return true;
    // Actual turtles / off-topic wordplay
    if (/tortoise|turtle disaster|sunbathing|pet terrapin|terf/.test(t)) return true;
    // Dolphins WR Malik Washington (different player)
    if (t.includes('malik washington') && (t.includes('dolphins') || t.includes('miami') || t.includes('dynasty') || t.includes('fantasy'))) return true;
    return false;
  }

  // Maryland sports context required for bare Terps/Terrapins searches
  var contextWords = ['maryland', 'umd', 'college park', 'locksley', 'willard', 'buzz williams', 'frese', 'big ten', 'b1g', 'football', 'basketball', 'lacrosse', 'recruiting', 'commit', 'portal', 'testudo', 'xfinity', 'secu'];
  function hasContext(text) {
    var t = (text || '').toLowerCase();
    return contextWords.some(function(w) { return t.includes(w); });
  }

  try {
    var debug = [];

    // Bluesky blocks unauthenticated requests from datacenter IPs — authenticate with app password
    var identifier = process.env.BSKY_IDENTIFIER;
    var appPassword = process.env.BSKY_APP_PASSWORD;
    if (!identifier || !appPassword) {
      return res.status(200).json({ posts: [], error: 'Bluesky login not configured — add BSKY_IDENTIFIER and BSKY_APP_PASSWORD in Vercel' });
    }

    var sessionRes = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: identifier, password: appPassword })
    });
    if (!sessionRes.ok) {
      var errText = await sessionRes.text();
      return res.status(200).json({ posts: [], error: 'Bluesky login failed (' + sessionRes.status + '): ' + errText.substring(0, 150) });
    }
    var session = await sessionRes.json();
    var token = session.accessJwt;

    var searches = queries.map(function(entry) {
      var q = typeof entry === 'string' ? entry : entry.q;
      var requireContext = typeof entry === 'object' && entry.requireContext;
      var url = 'https://bsky.social/xrpc/app.bsky.feed.searchPosts?sort=latest&limit=15&q=' + encodeURIComponent(q);
      return fetch(url, { headers: { 'Authorization': 'Bearer ' + token } }).then(function(r) {
        if (!r.ok) { return r.text().then(function(t) { debug.push({ q: q, status: r.status, body: t.substring(0, 120) }); return {}; }); }
        return r.json().then(function(d) { debug.push({ q: q, status: r.status, found: (d.posts || []).length }); d.requireContext = requireContext; return d; });
      }).catch(function(e) { debug.push({ q: q, error: e.message }); return {}; });
    });

    var results = await Promise.all(searches);

    var posts = [];
    var seen = [];

    results.forEach(function(data) {
      var requireContext = data.requireContext;
      (data.posts || []).forEach(function(p) {
        var record = p.record || {};
        var text = record.text || '';
        var author = p.author || {};
        var handle = author.handle || '';
        var displayName = author.displayName || handle;
        var createdMs = record.createdAt ? new Date(record.createdAt).getTime() : 0;
        if (!text) return;
        if (createdMs && createdMs < cutoff) return;
        if (isNoise(text + ' ' + handle + ' ' + displayName)) return;
        if (requireContext && !hasContext(text)) return;
        var norm = text.toLowerCase().replace(/[^a-z0-9 ]/g, '').substring(0, 80);
        if (seen.includes(norm)) return;
        seen.push(norm);
        var rkey = (p.uri || '').split('/').pop();
        posts.push({
          text: text.substring(0, 280),
          author: displayName,
          handle: handle,
          url: 'https://bsky.app/profile/' + handle + '/post/' + rkey,
          age: createdMs ? Math.round((Date.now() - createdMs) / 3600000) : 0,
          likes: p.likeCount || 0,
          reposts: p.repostCount || 0
        });
      });
    });

    // Filter out low-follower accounts (min 150 followers)
    var uniqueHandles = [];
    posts.forEach(function(p) { if (!uniqueHandles.includes(p.handle)) uniqueHandles.push(p.handle); });
    var followerCounts = {};
    // getProfiles accepts up to 25 actors per call
    for (var pi = 0; pi < uniqueHandles.length; pi += 25) {
      var batch = uniqueHandles.slice(pi, pi + 25);
      try {
        var qs = batch.map(function(h) { return 'actors=' + encodeURIComponent(h); }).join('&');
        var pr = await fetch('https://bsky.social/xrpc/app.bsky.actor.getProfiles?' + qs, { headers: { 'Authorization': 'Bearer ' + token } });
        if (pr.ok) {
          var pd = await pr.json();
          (pd.profiles || []).forEach(function(prof) {
            followerCounts[prof.handle] = prof.followersCount || 0;
          });
        }
      } catch(e) { /* if profile lookup fails, posts pass through */ }
    }
    posts = posts.filter(function(p) {
      var count = followerCounts[p.handle];
      return count === undefined || count >= 150;
    });

    // Sort by engagement then recency
    posts.sort(function(a, b) { return (b.likes + b.reposts * 2) - (a.likes + a.reposts * 2) || a.age - b.age; });

    return res.status(200).json({ posts: posts, debug: debug });
  } catch(e) {
    return res.status(500).json({ posts: [], error: e.message });
  }
};
