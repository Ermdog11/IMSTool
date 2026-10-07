// Writer leaderboard (Jeff, 2026-10-06: "keep track of writers and how many
// impressions and other analytics of their work. Provide a sortable
// leaderboard. Publisher gets to decide if others on staff see it, or even
// that it exists" — see mon_leaderboard in _access.js).
//
// Who wrote what comes from the knowledge base (content_items: every draft
// saved, submitted or imported, with its byline; AI drafts excluded). Each
// article's numbers come from whatever analytics the newsroom connected:
//   - Google Search (Search Console): impressions and clicks per page
//   - site readers (Chartbeat snapshots every 3 hours): readers summed across
//     readings while the story was among the top pages, and its peak
//   - social (Buffer): posts linking the story, and their interactions
// Pages are matched to articles by URL path, else by the URL slug or page
// title against the headline (most words in common). Best-effort and
// cached for an hour; sources that aren't connected are just left out.

var Store = require('./_analytics-store');
var STOP = ('the a an and or of to in on for with at by from as is are was be his her their our your its it this that ' +
  'after before over into up out new how why what who will has have had not but vs about more than').split(' ');

function words(s) {
  return (String(s || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').match(/[a-z0-9']+/g) || [])
    .filter(function (w) { return w.length > 2 && STOP.indexOf(w) === -1; });
}
function pathOf(u) {
  try { return new URL(/^https?:/i.test(u) ? u : 'https://x.invalid' + (String(u).charAt(0) === '/' ? '' : '/') + u).pathname.replace(/\/+$/, '').toLowerCase(); }
  catch (e) { return String(u || '').toLowerCase(); }
}
function slugWords(u) { var p = pathOf(u).split('/').filter(Boolean); return words((p[p.length - 1] || '').replace(/-\d+$/, '').replace(/-/g, ' ')); }
function cleanTitle(t) { return String(t || '').split(/\s[|–—-]\s/)[0]; }

function overlap(a, b) {
  if (!a.length || !b.length) return 0;
  var hit = a.filter(function (w) { return b.indexOf(w) !== -1; }).length;
  return hit / Math.min(a.length, b.length);
}

function matcher(articles) {
  var byPath = {};
  articles.forEach(function (a) { if (a.url) byPath[pathOf(a.url)] = a; a._w = words(a.headline); });
  var cache = {};
  return function (url, title) {
    var k = (url || '') + '|' + (title || '');
    if (k in cache) return cache[k];
    var hit = url && byPath[pathOf(url)];
    if (!hit) {
      var cand = title ? words(cleanTitle(title)) : slugWords(url);
      var best = null, score = 0;
      articles.forEach(function (a) { var s = overlap(cand, a._w); if (s > score) { score = s; best = a; } });
      if (best && score >= 0.6 && cand.length >= 3) hit = best;
    }
    cache[k] = hit || null;
    return cache[k];
  };
}

function ymd(d) { return d.toISOString().slice(0, 10); }

// One window [from, to): every article's numbers in it, rolled up by writer.
async function windowStats(sb, siteId, rows, from, to) {
  var articles = rows.map(function (r) {
    return { id: r.id, headline: r.headline, url: r.url || '', writer: (r.writer_name || 'Unknown').trim() || 'Unknown', date: String(r.published_at || r.created_at).slice(0, 10),
      inPeriod: new Date(r.published_at || r.created_at) >= from && new Date(r.published_at || r.created_at) < to,
      impressions: 0, clicks: 0, readers: 0, peak: 0, readings: 0, socialPosts: 0, interactions: 0 };
  });
  var match = matcher(articles);
  var sources = { search: false, site: false, social: false }, notes = [];

  // Google Search: per-page impressions and clicks.
  try {
    var g = await Store.getConnection(sb, siteId, 'gsc');
    if (g && g.siteUrl) {
      var last = new Date(Math.min(to.getTime(), Date.now() - 86400000));
      var rowsG = await require('./_gsc').query(g.siteUrl, { start: ymd(from), end: ymd(last), dimensions: ['page'], rowLimit: 2500, fresh: true, pathPrefix: g.pathPrefix });
      rowsG.forEach(function (r) { var a = match(r.keys[0], null); if (a) { a.impressions += r.impressions; a.clicks += r.clicks; } });
      sources.search = true;
    }
  } catch (e) { notes.push('Google Search: ' + e.message); }

  // Site readers from the Chartbeat snapshots.
  try {
    var snaps = (await Store.listSnapshots(sb, siteId, 'chartbeat', from.toISOString())).filter(function (x) { return new Date(x.captured_at) < to; });
    if (snaps.length) sources.site = true;
    snaps.forEach(function (x) {
      ((x.metrics && x.metrics.pages) || []).forEach(function (p) {
        var a = match(p.path, p.title); if (!a) return;
        a.readers += p.visits || 0; a.readings++; if ((p.visits || 0) > a.peak) a.peak = p.visits || 0;
      });
    });
  } catch (e) { notes.push('Site readers: ' + e.message); }

  // Social: Buffer posts that link a story.
  try {
    var b = await Store.getConnection(sb, siteId, 'buffer');
    if (b && b.apiKey && b.organizationId) {
      var B = require('./_buffer');
      var posts = await B.getSentPosts(b.apiKey, b.organizationId, from.toISOString(), to.toISOString());
      posts.forEach(function (p) {
        var links = String(p.text || '').match(/https?:\/\/[^\s)]+/g) || [];
        var seen = {};
        links.forEach(function (l) {
          var a = match(l, null); if (!a || seen[a.id]) return; seen[a.id] = 1;
          a.socialPosts++; a.interactions += B.engagementOf(B.metricsMap(p.metrics)) || 0;
        });
      });
      sources.social = true;
    }
  } catch (e) { notes.push('Social: ' + e.message); }

  var by = {};
  articles.forEach(function (a) {
    var earned = a.impressions || a.readers || a.interactions;
    if (!a.inPeriod && !earned) return;
    var w = by[a.writer] = by[a.writer] || { writer: a.writer, articles: 0, impressions: 0, clicks: 0, readers: 0, peak: 0, socialPosts: 0, interactions: 0, stories: [] };
    if (a.inPeriod) w.articles++;
    w.impressions += a.impressions; w.clicks += a.clicks; w.readers += a.readers; w.peak = Math.max(w.peak, a.peak);
    w.socialPosts += a.socialPosts; w.interactions += a.interactions;
    if (a.inPeriod || earned) w.stories.push({ headline: a.headline, url: a.url, date: a.date, impressions: a.impressions, clicks: a.clicks, readers: a.readers, peak: a.peak, interactions: a.interactions });
  });
  Object.keys(by).forEach(function (k) {
    var w = by[k];
    w.ctrPct = w.impressions ? Math.round(w.clicks / w.impressions * 1000) / 10 : null;
    w.readersPerArticle = w.articles ? Math.round(w.readers / w.articles) : null;
  });
  return { by: by, sources: sources, notes: notes };
}

var METRICS = ['articles', 'impressions', 'clicks', 'ctrPct', 'readers', 'readersPerArticle', 'peak', 'socialPosts', 'interactions'];
function change(cur, prev) {
  if (cur == null || prev == null) return null;
  if (!prev) return cur ? null : 0; // new: no meaningful %
  return Math.round((cur - prev) / prev * 100);
}

// The period (last `days` days) and the same length just before it, so every
// number shows its change, like Google Analytics' "vs previous period".
async function compute(sb, siteId, days) {
  days = Math.max(1, Math.min(365, +days || 30));
  var now = new Date(), from = new Date(now.getTime() - days * 86400000), prevFrom = new Date(from.getTime() - days * 86400000);
  var q = await sb.from('content_items').select('id, headline, url, writer_name, created_at, published_at')
    .eq('site_id', siteId).gte('created_at', new Date(prevFrom.getTime() - 3 * 86400000).toISOString())
    .order('created_at', { ascending: false }).limit(4000);
  if (q.error) throw new Error(q.error.message);
  var rows = (q.data || []).filter(function (r) { return r.headline && !/^AI\b/.test(r.writer_name || ''); });
  var cur = await windowStats(sb, siteId, rows, from, now);
  var prev = await windowStats(sb, siteId, rows, prevFrom, from);
  var writers = Object.keys(cur.by).map(function (k) {
    var w = cur.by[k], p = prev.by[k] || null;
    w.prev = {}; w.change = {};
    METRICS.forEach(function (m) { w.prev[m] = p ? p[m] : null; w.change[m] = p ? change(w[m], p[m]) : null; });
    w.isNew = !p;
    w.stories.sort(function (x, y) { return (y.impressions + y.readers * 10) - (x.impressions + x.readers * 10); });
    w.topStory = w.stories[0] || null;
    w.stories = w.stories.slice(0, 10);
    return w;
  }).sort(function (x, y) { return y.impressions - x.impressions || y.readers - x.readers; });
  return { at: now.toISOString(), days: days, sources: cur.sources, notes: cur.notes.concat(prev.notes.filter(function (n) { return cur.notes.indexOf(n) === -1; })), writers: writers };
}

// Cached for an hour per period (each run calls Search Console and Buffer).
async function get(sb, siteId, days, refresh) {
  days = Math.max(1, Math.min(365, +days || 30));
  var path = 'writer-stats/' + days + '.json';
  var blob = require('./_site-blob');
  if (!refresh) {
    try {
      var got = await blob.get(path, { access: 'private', useCache: false });
      if (got && got.statusCode === 200) {
        var c = await new Response(got.stream).json();
        if (c && Date.now() - Date.parse(c.at) < 3600000) { if (!c.kudos) c.kudos = kudos(c); return c; }
      }
    } catch (e) { /* recompute */ }
  }
  var out = await compute(sb, siteId, days);
  out.kudos = kudos(out);
  try { await blob.put(path, JSON.stringify(out), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' }); } catch (e) { /* fine */ }
  return out;
}

// Kudos (Jeff, 2026-10-06: "include a daily insight or kudos based on the
// data"): up to three short, positive lines from the leaderboard: the top
// story, the biggest riser against the period before (with real volume), and
// the most productive writer. Never singles anyone out for a drop.
function kudos(stats) {
  var ws = (stats && stats.writers || []).filter(function (w) { return w.writer && w.writer !== 'Unknown'; });
  if (!ws.length) return [];
  var out = [], used = {};
  var fmt = function (n) { return Number(n || 0).toLocaleString('en-US'); };
  // Top story by Google impressions, else site readers.
  var stories = [];
  ws.forEach(function (w) { (w.stories || []).forEach(function (s) { stories.push({ w: w.writer, s: s }); }); });
  var byImp = stories.slice().sort(function (a, b) { return b.s.impressions - a.s.impressions || b.s.readers - a.s.readers; })[0];
  if (byImp && (byImp.s.impressions || byImp.s.readers)) {
    out.push('🏆 Top story: ' + byImp.w + '\'s "' + byImp.s.headline + '"' + (byImp.s.impressions ? ' with ' + fmt(byImp.s.impressions) + ' Google impressions' : '') + (byImp.s.readers ? (byImp.s.impressions ? ' and ' : ' with ') + fmt(byImp.s.readers) + ' site readers' : '') + '.');
    used[byImp.w] = 1;
  }
  // Biggest riser: impressions up the most %, with at least 500 impressions.
  var riser = ws.filter(function (w) { return !used[w.writer] && w.change && w.change.impressions > 0 && w.impressions >= 500; })
    .sort(function (a, b) { return b.change.impressions - a.change.impressions; })[0];
  if (riser) { out.push('📈 On the rise: ' + riser.writer + ', Google impressions up ' + riser.change.impressions + '% (' + fmt(riser.impressions) + ').'); used[riser.writer] = 1; }
  // Most stories filed.
  var busy = ws.filter(function (w) { return !used[w.writer] && w.articles >= 3; }).sort(function (a, b) { return b.articles - a.articles; })[0];
  if (busy) out.push('✍️ Most stories: ' + busy.writer + ' with ' + busy.articles + ' in the last ' + stats.days + ' days.');
  return out;
}

module.exports = { compute: compute, get: get, matcher: matcher, words: words, kudos: kudos };
