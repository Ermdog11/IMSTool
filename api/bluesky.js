module.exports = async function handler(req, res) {
  // Bluesky public search API — free, no auth required
  var cutoff = Date.now() - 48 * 60 * 60 * 1000;

  var queries = [
    '"Maryland Terrapins"',
    '"Terps football"',
    '"Terps basketball"',
    '"Maryland football" recruiting',
    '"Maryland basketball"',
    '"Mike Locksley"',
    '"Buzz Williams"'
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
    var searches = queries.map(function(q) {
      var url = 'https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?sort=latest&limit=15&q=' + encodeURIComponent(q);
      return fetch(url).then(function(r) { return r.ok ? r.json() : {}; }).catch(function() { return {}; });
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

    return res.status(200).json({ posts: posts });
  } catch(e) {
    return res.status(500).json({ posts: [], error: e.message });
  }
};
