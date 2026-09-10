// /api/alert-prefs — who receives which alerts.
//
//   GET                                 -> { types, me:{type:bool}, team:[{userId,name,email,role,prefs}] }  (team only for publisher)
//   POST { userId?, type, enabled }      -> set one pref. Omit userId for yourself.
//                                          Setting someone else's requires publisher.
//
// Default when a row is absent: enabled (opt-out model), EXCEPT 'article_started'
// which defaults to publisher-only.

var S = require('./_supabase');

var ALERT_TYPES = [
  { key: 'breaking',        label: 'Breaking news (rating 5)',       defaultOn: 'all' },
  { key: 'article_started', label: 'A writer starts an article',     defaultOn: 'publisher' },
  { key: 'digest_nightly',  label: 'Nightly digest (8 PM)',          defaultOn: 'all' },
  { key: 'digest_rolling',  label: 'Rolling updates (3×/day)',       defaultOn: 'all' },
  { key: 'roster_change',   label: 'Roster changes',                 defaultOn: 'all' }
];
var VALID = ALERT_TYPES.map(function (t) { return t.key; });

function defaultFor(typeKey, role) {
  var t = ALERT_TYPES.filter(function (x) { return x.key === typeKey; })[0];
  if (!t) return false;
  if (t.defaultOn === 'all') return true;
  if (t.defaultOn === 'publisher') return role === 'publisher';
  return false;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!S.isConfigured()) return res.status(503).json({ error: 'Login not configured' });

  var ctx;
  try { ctx = await S.requireUser(req); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
  var sb = ctx.supabase, siteId = ctx.site.id;

  if (req.method === 'GET') {
    var mineRes = await sb.from('alert_prefs').select('alert_type, enabled')
      .eq('site_id', siteId).eq('user_id', ctx.user.id);
    var mine = {};
    VALID.forEach(function (k) { mine[k] = defaultFor(k, ctx.membership.role); });
    (mineRes.data || []).forEach(function (r) { mine[r.alert_type] = r.enabled; });

    var out = { types: ALERT_TYPES, me: mine };

    if (ctx.membership.role === 'publisher') {
      var mem = await sb.from('memberships')
        .select('user_id, role, profiles(email, full_name)').eq('site_id', siteId);
      var allPrefs = await sb.from('alert_prefs').select('user_id, alert_type, enabled').eq('site_id', siteId);
      var byUser = {};
      (allPrefs.data || []).forEach(function (r) {
        (byUser[r.user_id] = byUser[r.user_id] || {})[r.alert_type] = r.enabled;
      });
      out.team = (mem.data || []).map(function (m) {
        var prefs = {};
        VALID.forEach(function (k) {
          prefs[k] = (byUser[m.user_id] && byUser[m.user_id][k] !== undefined)
            ? byUser[m.user_id][k] : defaultFor(k, m.role);
        });
        return {
          userId: m.user_id, role: m.role,
          name: m.profiles && m.profiles.full_name, email: m.profiles && m.profiles.email,
          prefs: prefs
        };
      });
    }
    return res.status(200).json(out);
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });

  var body = req.body || {};
  var type = body.type;
  if (VALID.indexOf(type) === -1) return res.status(400).json({ error: 'Unknown alert type.' });
  var enabled = !!body.enabled;
  var targetUser = body.userId || ctx.user.id;

  if (targetUser !== ctx.user.id && ctx.membership.role !== 'publisher') {
    return res.status(403).json({ error: "Only the publisher can change other people's alerts." });
  }

  var up = await sb.from('alert_prefs').upsert({
    site_id: siteId, user_id: targetUser, alert_type: type, enabled: enabled
  }, { onConflict: 'user_id,site_id,alert_type' }).select().single();
  if (up.error) return res.status(500).json({ error: up.error.message });
  return res.status(200).json({ ok: true });
};

module.exports.ALERT_TYPES = ALERT_TYPES;
module.exports.defaultFor = defaultFor;
