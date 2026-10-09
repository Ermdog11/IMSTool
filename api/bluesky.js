var Bluesky = require('./_bluesky');

module.exports = async function handler(req, res) {
  // Bluesky public search API (authenticated: it blocks datacenter IPs otherwise).
  var cutoff = Date.now() - 72 * 60 * 60 * 1000;

  // What to search comes from the newsroom's beat profile, so it follows the
  // current coaches and players (_beat.searchPlan; InsideMDSports' extra
  // phrases and noise rules are in its profile's searchExtras).
  await require('./_supabase').optionalUser(req);
  var S0 = require('./_supabase');
  var Beat = require('./_beat');
  var plan;
  try { plan = Beat.searchPlan(await Beat.getBeat(S0.isConfigured() ? S0.admin() : null)); }
  catch (e) { return res.status(500).json({ posts: [], error: e.message }); }
  var queries = plan.bluesky;
  if (!queries.length) return res.status(200).json({ posts: [], error: 'Set up your beat first (/setup) so we know what to search for.' });

  // Noise rules match the post; excluded sources (our own outlet and staff) match the author.
  function isNoise(text, author) { return Beat.isNoise(text + ' ' + author, plan.noise) || Beat.isNoise(author, plan.excludeAuthors); }
  function hasContext(text) {
    var t = (text || '').toLowerCase();
    return plan.blueskyContext.some(function(w) { return t.includes(w); });
  }

  try {
    var debug = [];

    // Bluesky blocks unauthenticated requests from datacenter IPs — authenticate with app password
    if (!Bluesky.isConfigured()) {
      return res.status(200).json({ posts: [], error: 'Bluesky login not configured — add BSKY_IDENTIFIER and BSKY_APP_PASSWORD in Vercel' });
    }
    var token;
    try { token = (await Bluesky.createSession()).token; }
    catch (e) { return res.status(200).json({ posts: [], error: e.message }); }

    var allQueries = queries;

    var searches = allQueries.map(function(entry) {
      var q = typeof entry === 'string' ? entry : entry.q;
      var requireContext = typeof entry === 'object' && entry.requireContext;
      var url = 'https://bsky.social/xrpc/app.bsky.feed.searchPosts?sort=latest&limit=40&q=' + encodeURIComponent(q);
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
        if (isNoise(text, handle + ' ' + displayName)) return;
        if (requireContext && !hasContext(text)) return;
        var norm = text.toLowerCase().replace(/[^a-z0-9 ]/g, '').substring(0, 80);
        if (seen.includes(norm)) return;
        seen.push(norm);
        var rkey = (p.uri || '').split('/').pop();

        // Does the post carry an outbound link? (external embed, richtext link facet,
        // or a bare URL in the text.) Link posts get sorted to the top.
        var embedType = (record.embed && record.embed['$type']) || (p.embed && p.embed['$type']) || '';
        var hasEmbedLink = /embed\.external/.test(embedType);
        var hasFacetLink = Array.isArray(record.facets) && record.facets.some(function(f) {
          return (f.features || []).some(function(ft) { return /facet#link/.test(ft['$type'] || ''); });
        });
        var linkInText = /https?:\/\/\S+/i.test(text);
        var externalUrl = '';
        if (record.embed && record.embed.external && record.embed.external.uri) externalUrl = record.embed.external.uri;
        var hasLink = hasEmbedLink || hasFacetLink || linkInText;

        posts.push({
          text: text.substring(0, 280),
          author: displayName,
          handle: handle,
          url: 'https://bsky.app/profile/' + handle + '/post/' + rkey,
          linkUrl: externalUrl,
          hasLink: hasLink,
          age: createdMs ? Math.round((Date.now() - createdMs) / 3600000) : 0,
          ageMin: createdMs ? Math.round((Date.now() - createdMs) / 60000) : 999999,
          likes: p.likeCount || 0,
          reposts: p.repostCount || 0
        });
      });
    });

    // Filter out low-follower accounts (min 75 followers — lowered from 150; the
    // link-first sort now keeps the signal near the top without the tighter gate)
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
      return count === undefined || count >= 75;
    });

    // Sort: link posts first (news usually links out), then most recent, with
    // engagement only as a final tiebreak. Previously this was engagement-first,
    // which buried every fresh post under older popular ones — the tab looked stale.
    posts.sort(function(a, b) {
      if (a.hasLink !== b.hasLink) return a.hasLink ? -1 : 1;
      if (a.ageMin !== b.ageMin) return a.ageMin - b.ageMin;
      return (b.likes + b.reposts * 2) - (a.likes + a.reposts * 2);
    });

    return res.status(200).json({ posts: posts, debug: debug });
  } catch(e) {
    return res.status(500).json({ posts: [], error: e.message });
  }
};

// Per-newsroom: this request runs as the signed-in person's newsroom (_site.js).
module.exports = require('./_site').wrap(module.exports);
