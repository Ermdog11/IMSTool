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
    'Terps',
    'Terrapins',
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
    return false;
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

    var searches = queries.map(function(q) {
      var url = 'https://bsky.social/xrpc/app.bsky.feed.searchPosts?sort=latest&limit=15&q=' + encodeURIComponent(q);
      return fetch(url, { headers: { 'Authorization': 'Bearer ' + token } }).then(function(r) {
        if (!r.ok) { return r.text().then(function(t) { debug.push({ q: q, status: r.status, body: t.substring(0, 120) }); return {}; }); }
        return r.json().then(function(d) { debug.push({ q: q, status: r.status, found: (d.posts || []).length }); return d; });
      }).catch(function(e) { debug.push({ q: q, error: e.message }); return {}; });
    });

    var results = await Promise.all(searches);

    var posts = [];
    var seen = [];

    results.forEach(function(data) {
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

    // Sort by engagement then recency
    posts.sort(function(a, b) { return (b.likes + b.reposts * 2) - (a.likes + a.reposts * 2) || a.age - b.age; });

    return res.status(200).json({ posts: posts, debug: debug });
  } catch(e) {
    return res.status(500).json({ posts: [], error: e.message });
  }
};
