// Roster-watch history: persists every change api/roster-check.js catches
// (a name added, a name dropped, a title change), so the in-app Roster Watch
// view (public/index.html) can show a dated history instead of just the
// latest snapshot.
//
// Best-effort by design, same pattern as _knowledge.js — a history write must
// never break the roster-check cron. If Supabase isn't configured, or
// anything here throws, we log and move on.

var S = require('./_supabase');
// The signed-in person's newsroom (_site.js), InsideMDSports for crons.
function resolveSiteId(sb) {
  return require('./_site').siteId(sb);
}

// events: [{ name, type: 'added'|'removed'|'title_changed', detail }]
// `detail` is the person's title, or "old title → new title" for a change.
// `kind` is the page type: 'players', 'staff' or 'department'.
async function recordEvents(slug, label, kind, events, detectedAt) {
  if (!S.isConfigured()) return { skipped: 'not configured' };
  if (!events || !events.length) return { skipped: 'no changes' };
  try {
    var sb = S.admin();
    var siteId = await resolveSiteId(sb);
    var when = detectedAt || new Date().toISOString();
    var rows = events.map(function (e) {
      return { site_id: siteId, team_slug: slug, team_label: label, player_name: e.name, change_type: e.type,
        detail: e.detail || null, watch_kind: kind || 'players', detected_at: when };
    });
    var ins = await sb.from('roster_events').insert(rows);
    if (ins.error) {
      // db/schema.sql hasn't been re-run since staff watching was added: the
      // table has no detail/watch_kind columns and doesn't accept
      // 'title_changed'. Keep logging what the old table can hold.
      var legacy = rows.filter(function (r) { return r.change_type !== 'title_changed'; }).map(function (r) {
        return { site_id: r.site_id, team_slug: r.team_slug, team_label: r.team_label, player_name: r.player_name, change_type: r.change_type, detected_at: r.detected_at };
      });
      if (!legacy.length) throw new Error(ins.error.message);
      var ins2 = await sb.from('roster_events').insert(legacy);
      if (ins2.error) throw new Error(ins2.error.message);
      return { ok: true, count: legacy.length, note: 're-run db/schema.sql to store titles and title changes' };
    }
    return { ok: true, count: rows.length };
  } catch (e) {
    console.error('Roster event logging failed (non-fatal):', e.message);
    return { error: e.message };
  }
}

// All history for the site, newest first, across every watched page — the
// view groups it back out by team_slug.
async function historyForSite(limit) {
  if (!S.isConfigured()) return [];
  try {
    var sb = S.admin();
    var siteId = await resolveSiteId(sb);
    var run = function (cols) {
      return sb.from('roster_events').select(cols)
        .eq('site_id', siteId).order('detected_at', { ascending: false }).limit(limit || 300);
    };
    var q = await run('team_slug, team_label, player_name, change_type, detail, watch_kind, detected_at');
    if (q.error) q = await run('team_slug, team_label, player_name, change_type, detected_at');
    if (q.error) throw new Error(q.error.message);
    return q.data || [];
  } catch (e) {
    console.error('Roster history read failed (non-fatal):', e.message);
    return [];
  }
}

module.exports = { recordEvents: recordEvents, historyForSite: historyForSite };
