// /api/roster-view — GET: current roster + dated add/drop history per team,
// for the in-app Roster Watch view (public/index.html). Read-only; detection
// itself happens in api/roster-check.js on its own cron.
//
//   GET -> { teams: [{ slug, label, url, checkedAt, roster:[{name,jersey}], history:[{playerName,changeType,detectedAt}] }] }

var S = require('./_supabase');
var Roster = require('./_roster');
var RosterStore = require('./_roster-store');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  // Same as the rest of the app: require sign-in once login is switched on,
  // otherwise business as usual (Roster Watch works with no login configured).
  if (S.isConfigured()) {
    try { await S.requireUser(req); }
    catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
  }

  try {
    var history = await RosterStore.historyForSite(500);
    var byTeam = {};
    history.forEach(function(h) {
      (byTeam[h.team_slug] = byTeam[h.team_slug] || []).push({
        playerName: h.player_name, changeType: h.change_type, detectedAt: h.detected_at
      });
    });

    var teams = await Promise.all(Roster.ROSTERS.map(async function(cfg) {
      var snap = await Roster.getSnapshot(cfg.slug);
      return {
        slug: cfg.slug,
        label: cfg.label,
        url: cfg.url,
        checkedAt: snap ? snap.checkedAt : null,
        roster: snap ? snap.players : [],
        history: byTeam[cfg.slug] || []
      };
    }));

    return res.status(200).json({ teams: teams });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
