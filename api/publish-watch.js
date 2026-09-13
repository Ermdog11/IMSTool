// Style drift watch — runs on its own cron. Fully automatic: no one pastes a
// URL. Checks 247Sports' own Maryland page for pieces matching a recently
// submitted draft, and records what changed between our output and what
// published (api/_publish-match.js does the matching/fetching/diffing).
//
// Same shape as roster-check.js / coverage-desk.js: cron -> best-effort work
// -> report. Silent by design for now (no email) — the notes accumulate in
// content_revisions for the style profiles / per-writer catalog to draw on
// once that retrieval side is built.

var S = require('./_supabase');
var SITE_SLUG = 'insidemdsports';

module.exports = async function handler(req, res) {
  if (!S.isConfigured()) return res.status(503).json({ error: 'Login not configured (Supabase)' });

  try {
    var sb = S.admin();
    var siteRes = await sb.from('sites').select('id').eq('slug', SITE_SLUG).single();
    if (siteRes.error || !siteRes.data) throw new Error('Site row missing (run db/schema.sql)');

    var report = await require('./_publish-match').runMatchPass(sb, siteRes.data.id);
    var matched = report.filter(function(r) { return r.status === 'matched'; }).length;
    return res.status(200).json({ checked: report.length, matched: matched, report: report });
  } catch (e) {
    console.error('publish-watch error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
