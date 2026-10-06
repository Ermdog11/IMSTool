// What we've been writing about a lot lately (Jeff, 2026-10-06: "have the
// app give higher breaking news ratings to stories involving topics we have
// written about a lot recently").
//
// Counts, for each person and term on the beat profile (key figures, current
// watch-list people, key terms), how many of our own recent articles mention
// them: the latest headlines from our own site (the list scan.js already
// scrapes for the own-outlet filter) plus the last 14 days of articles in the
// knowledge base (drafts saved, submitted and imported, AI drafts excluded).
// scan.js hands the top ones to the rater, which bumps a genuinely new
// development on them. Best-effort: anything missing just means fewer topics.

function clean(n) { return String(n || '').replace(/\s*\(.*?\)\s*/g, '').trim(); }
function norm(s) { return ' ' + String(s || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim() + ' '; }

function candidates(beat) {
  var out = [], seen = {};
  function add(term, lastToo) {
    term = clean(term);
    if (!term || term.length < 4) return;
    var k = term.toLowerCase();
    if (seen[k]) return;
    seen[k] = 1;
    var parts = k.split(/\s+/), last = parts[parts.length - 1];
    out.push({ name: term, full: k, last: lastToo && parts.length > 1 && last.length >= 5 ? last : null });
  }
  (beat.keyFigures || []).forEach(function (n) { add(n, true); });
  (beat.watch || []).forEach(function (g) {
    if (g.alumni || Number(g.rating || 3) <= 1) return;
    var coaches = /coach|staff/i.test(g.label || '');
    (g.names || []).forEach(function (n) { add(n, coaches); });
  });
  (beat.keyTerms || []).forEach(function (t) { if (t.era !== 'historic') add(t.term, !!t.figure); });
  return out;
}

async function recentKnowledgeHeadlines(sb) {
  if (!sb) return [];
  try {
    var siteId = await require('./_chat-store').resolveSiteId(sb);
    var since = new Date(Date.now() - 14 * 86400000).toISOString();
    var q = await sb.from('content_items').select('headline, writer_name, created_at')
      .eq('site_id', siteId).gte('created_at', since).order('created_at', { ascending: false }).limit(150);
    return (q.data || []).filter(function (r) { return r.headline && !/^AI\b/.test(r.writer_name || ''); }).map(function (r) { return r.headline; });
  } catch (e) { return []; }
}

// ownHeadlines: our site's recent headlines (slugs are fine). Returns
// [{ name, count }] sorted by count, only topics in 3+ of our articles.
async function ourHotTopics(beat, ownHeadlines, sb, max) {
  var heads = (ownHeadlines || []).concat(await recentKnowledgeHeadlines(sb));
  // The same story can appear twice (site + knowledge base): count distinct headlines.
  var seen = {};
  heads = heads.map(norm).filter(function (h) { var k = h.replace(/ /g, ''); if (seen[k]) return false; seen[k] = 1; return h.trim(); });
  if (!heads.length) return [];
  var topics = candidates(beat).map(function (c) {
    var n = heads.filter(function (h) { return h.indexOf(' ' + c.full + ' ') !== -1 || (c.last && h.indexOf(' ' + c.last + ' ') !== -1); }).length;
    return { name: c.name, count: n };
  }).filter(function (t) { return t.count >= 3; });
  topics.sort(function (a, b) { return b.count - a.count; });
  return topics.slice(0, max || 8);
}

module.exports = { ourHotTopics: ourHotTopics, candidates: candidates };
