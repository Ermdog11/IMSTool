// /api/roster-view — GET: what Roster Watch currently has on file, plus the
// dated history of every change, for the in-app view (public/index.html).
// Read-only; detection itself happens in api/roster-check.js on its own cron.
//
//   GET -> {
//     teams: [{ slug, label, url, checkedAt, roster:[{name,jersey}],
//               staff: { url, checkedAt, people:[{name,title,group}] } | null,
//               history:[{ name, changeType, detail, kind, detectedAt }] }],
//     department: { label, url, checkedAt, people:[{name,title,group}], history:[...] } | null,
//     departmentLabel   // "Athletic department" or "Front office", by beat type
//   }

var S = require('./_supabase');
var Beat = require('./_beat');
var Roster = require('./_roster');
var RosterStore = require('./_roster-store');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  // Same as the rest of the app: require sign-in once login is switched on,
  // otherwise business as usual (Roster Watch works with no login configured).
  if (S.isConfigured()) {
    var rvCtx;
    try { rvCtx = await S.requireUser(req); }
    catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
    if (!(await require('./_access').allowed(rvCtx, 'mon_roster'))) return require('./_access').deny(res);
  }

  try {
    var beat = await Beat.getBeat(S.isConfigured() ? S.admin() : null);
    var targets = Roster.watchTargets(beat);
    var history = await RosterStore.historyForSite(800);
    var bySlug = {};
    history.forEach(function (h) {
      (bySlug[h.team_slug] = bySlug[h.team_slug] || []).push({
        name: h.player_name, changeType: h.change_type, detail: h.detail || '',
        kind: h.watch_kind || 'players', detectedAt: h.detected_at
      });
    });
    var snaps = await Promise.all(targets.map(function (t) { return Roster.getSnapshot(t.slug); }));

    var teams = [], byTeam = {}, department = null;
    targets.forEach(function (t, i) {
      var snap = snaps[i];
      if (t.kind === 'department') {
        department = { label: t.label, url: t.url, checkedAt: snap ? snap.checkedAt : null, people: snap ? snap.people : [], history: bySlug[t.slug] || [] };
        return;
      }
      var team = byTeam[t.team];
      if (!team) {
        team = byTeam[t.team] = { slug: t.team, label: t.label.replace(/ coaches and staff$/, ''), url: null, checkedAt: null, roster: [], staff: null, history: [] };
        teams.push(team);
      }
      if (t.kind === 'players') {
        team.url = t.url; team.checkedAt = snap ? snap.checkedAt : null; team.roster = snap ? snap.people : [];
      } else {
        team.staff = { url: t.url, checkedAt: snap ? snap.checkedAt : null, people: snap ? snap.people : [] };
      }
      team.history = team.history.concat(bySlug[t.slug] || []);
    });
    teams.forEach(function (team) {
      team.history.sort(function (a, b) { return a.detectedAt < b.detectedAt ? 1 : -1; });
    });

    return res.status(200).json({ teams: teams, department: department, departmentLabel: Roster.departmentLabel(beat.team.level) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
