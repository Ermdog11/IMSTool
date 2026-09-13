// Roster-watch history: persists every add/drop api/roster-check.js catches,
// so the in-app Roster Watch view (public/index.html) can show a dated
// history per team instead of just the latest snapshot.
//
// Best-effort by design, same pattern as _knowledge.js — a history write must
// never break the roster-check cron. If Supabase isn't configured, or
// anything here throws, we log and move on.

var S = require('./_supabase');
var SITE_SLUG = 'insidemdsports';
var siteIdCache = null;

async function resolveSiteId(sb) {
  if (siteIdCache) return siteIdCache;
  var r = await sb.from('sites').select('id').eq('slug', SITE_SLUG).single();
  if (r.error || !r.data) throw new Error('Roster store: site row missing (run db/schema.sql)');
  siteIdCache = r.data.id;
  return siteIdCache;
}

async function recordChanges(teamSlug, teamLabel, added, removed, detectedAt) {
  if (!S.isConfigured()) return { skipped: 'not configured' };
  if (!added.length && !removed.length) return { skipped: 'no changes' };
  try {
    var sb = S.admin();
    var siteId = await resolveSiteId(sb);
    var when = detectedAt || new Date().toISOString();
    var rows = added.map(function(name) {
      return { site_id: siteId, team_slug: teamSlug, team_label: teamLabel, player_name: name, change_type: 'added', detected_at: when };
    }).concat(removed.map(function(name) {
      return { site_id: siteId, team_slug: teamSlug, team_label: teamLabel, player_name: name, change_type: 'removed', detected_at: when };
    }));
    var ins = await sb.from('roster_events').insert(rows);
    if (ins.error) throw new Error(ins.error.message);
    return { ok: true, count: rows.length };
  } catch (e) {
    console.error('Roster event logging failed (non-fatal):', e.message);
    return { error: e.message };
  }
}

// All history for the site, newest first, across every team — the view
// groups it back out by team_slug.
async function historyForSite(limit) {
  if (!S.isConfigured()) return [];
  try {
    var sb = S.admin();
    var siteId = await resolveSiteId(sb);
    var q = await sb.from('roster_events')
      .select('team_slug, team_label, player_name, change_type, detected_at')
      .eq('site_id', siteId).order('detected_at', { ascending: false }).limit(limit || 300);
    if (q.error) throw new Error(q.error.message);
    return q.data || [];
  } catch (e) {
    console.error('Roster history read failed (non-fatal):', e.message);
    return [];
  }
}

module.exports = { recordChanges: recordChanges, historyForSite: historyForSite };
