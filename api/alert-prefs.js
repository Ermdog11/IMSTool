// /api/alert-prefs — who receives which alerts.
//
//   GET                                 -> { types, me:{type:bool}, team:[{userId,name,email,role,prefs}] }  (team only for publisher)
//   POST { userId?, type, enabled }      -> set one pref. Omit userId for yourself.
//   POST { type, schedule }              -> your own days/hours for that alert (_alert-schedule.js)
//   POST { timeZone }                    -> your own time zone for those days/hours
//   POST { channelFor, channel }         -> email, text or both for one alert
//   POST { phone }                       -> your mobile number for text alerts
//   POST { timesFor, times:['08:00'] }   -> when your digest / updates come (whole hours, your zone)
//                                          Setting someone else's requires publisher.
//
// Default when a row is absent: enabled (opt-out model), EXCEPT 'article_started'
// which defaults to publisher-only.

var S = require('./_supabase');

// `about`: what the alert is and when it comes, shown under each switch on
// Permissions & preferences (Jeff, 2026-10-06: "this also needs an explainer").
var ALERT_TYPES = [
  { key: 'breaking',        label: 'Breaking news (rating 5)',       defaultOn: 'all',
    about: 'The moment the scanner finds a story rated 5 out of 5, any time of day. The biggest news on your beat only.' },
  { key: 'article_started', label: 'A writer starts an article',     defaultOn: 'publisher',
    about: 'When someone on the team starts a new draft in the Content Editor, so you know who is writing what.' },
  { key: 'digest_nightly',  label: 'Nightly digest',                 defaultOn: 'all', times: 1,
    about: 'One email each evening with the day\'s stories on your beat, most important first. Pick the time below.' },
  { key: 'digest_rolling',  label: 'Rolling updates',                defaultOn: 'all', times: 3,
    about: 'Everything new since the last email you got that wasn\'t big enough for a breaking alert. Pick up to 3 times a day below; the first one covers the night.' },
  { key: 'roster_change',   label: 'Roster changes',                 defaultOn: 'all',
    about: 'When a player, coach or staff member is added to or removed from the official roster pages you watch.' },
  { key: 'hot_story',       label: 'A story goes hot',               defaultOn: 'all',
    about: 'One of our stories suddenly has lots of readers. Push it on social now.' },
  { key: 'records',         label: 'Public records requests',        defaultOn: 'editors',
    about: 'When a story is worth a public records request (coach hires and firings first), CoPublisher writes the request letter for you and asks if you want it to send it. Check the letter, tap Send, and it goes out under your name with replies coming to you. Or send it yourself. You can also ask for one on any alert with Request records.' },
  { key: 'calendar',        label: 'New calendar items',               defaultOn: 'editors',
    about: 'When a new date lands on the newsroom calendar, from an email forwarded to the calendar address or added in the app.' },
  { key: 'calendar_ideas',  label: 'Story ideas from the calendar',  defaultOn: 'editors',
    about: 'Each morning, when something worth a story is coming up on the calendar this week: what to write ahead of it and the day to publish it.' },
  { key: 'coverage_desk',   label: 'Coverage Desk memo (7 AM)',        defaultOn: 'all',
    about: 'A short morning memo: today\'s priorities, stories we haven\'t covered yet, follow-ups and what worked yesterday.' }
];
// Types that can have days/hours (_alert-schedule.js): every alert above, plus
// the hot-spot alert (its on/off lives with the calendar: api/calendar.js 'hot12').
var SCHEDULABLE = ALERT_TYPES.map(function (t) { return t.key; }).concat(['hot_spot']);
var VALID = ALERT_TYPES.map(function (t) { return t.key; });

function defaultFor(typeKey, role) {
  var t = ALERT_TYPES.filter(function (x) { return x.key === typeKey; })[0];
  if (!t) return false;
  // Freelance contributors and viewers start with every alert off.
  if (role === 'contributor' || role === 'viewer') return false;
  if (t.defaultOn === 'all') return true;
  if (t.defaultOn === 'publisher') return role === 'publisher';
  if (t.defaultOn === 'editors') return role === 'publisher' || role === 'editor';
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

    var schedAll = await require('./_alert-schedule').load();
    var mySched = schedAll[String(ctx.user.email || '').toLowerCase()] || {};
    var Sched0 = require('./_alert-schedule');
    var channels = {}; ALERT_TYPES.forEach(function (t) { channels[t.key] = Sched0.channelOf(mySched, t.key); });
    var out = { types: ALERT_TYPES, me: mine, schedules: mySched, timeZone: Sched0.tzOf(mySched),
      channels: channels, phone: Sched0.phoneOf(mySched), textingOn: require('./_sms').isConfigured(),
      times: { digest_rolling: Sched0.timesOf(mySched, 'digest_rolling'), digest_nightly: Sched0.timesOf(mySched, 'digest_nightly') } };

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
  // How you get one alert: { channelFor: type, channel: 'email'|'text'|'both' }.
  if (body.channelFor !== undefined) {
    if (VALID.indexOf(body.channelFor) === -1) return res.status(400).json({ error: 'Unknown alert type.' });
    try { return res.status(200).json({ ok: true, channel: await require('./_alert-schedule').setChannel(ctx.user.email, body.channelFor, String(body.channel || '')) }); }
    catch (e) { return res.status(400).json({ error: e.message }); }
  }
  // When your digest / updates come: { timesFor, times: ['08:00', ...] }.
  if (body.timesFor !== undefined) {
    try { return res.status(200).json({ ok: true, times: await require('./_alert-schedule').setTimes(ctx.user.email, String(body.timesFor), body.times) }); }
    catch (e) { return res.status(400).json({ error: e.message }); }
  }
  // Your mobile number for text alerts: { phone } ('' removes it).
  if (body.phone !== undefined) {
    try { return res.status(200).json({ ok: true, phone: await require('./_alert-schedule').setPhone(ctx.user.email, String(body.phone || '')) }); }
    catch (e) { return res.status(400).json({ error: e.message }); }
  }
  // Your own time zone: { timeZone: 'America/Chicago' } (your days and hours use it).
  if (body.timeZone !== undefined) {
    try { var tzSaved = await require('./_alert-schedule').setTz(ctx.user.email, String(body.timeZone || '')); return res.status(200).json({ ok: true, timeZone: tzSaved }); }
    catch (e) { return res.status(400).json({ error: e.message }); }
  }
  // Your own days/hours for one alert: { type, schedule:{ days:[0-6], from:'HH:MM', to:'HH:MM' } | null }
  if (body.schedule !== undefined) {
    if (SCHEDULABLE.indexOf(type) === -1) return res.status(400).json({ error: 'Unknown alert type.' });
    var saved = await require('./_alert-schedule').set(ctx.user.email, type, body.schedule);
    return res.status(200).json({ ok: true, schedule: saved });
  }
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

// Per-newsroom: this request runs as the signed-in person's newsroom (_site.js).
module.exports = require('./_site').wrap(module.exports);
