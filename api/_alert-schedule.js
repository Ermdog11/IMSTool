// Per-person alert schedules (Jeff, 2026-10-06: "all of the preferences should
// have something next to them where you can denote what days of the week you
// want these actions, and if you have specific time of day preferences. For
// all aspects"). Each person can limit each alert type to certain days of the
// week and a window of hours (Eastern; a window may run past midnight, e.g.
// 8 PM-7 AM). An alert outside someone's days/hours is skipped for them; the
// hot-spot alert waits for the window instead, since the spot is still ahead.
//
// Also the one place every alert email is filtered (_mailer.sendMail with
// opts.alertType): a team member who switched a type off doesn't get it, even
// when it goes to the newsroom email list (digests, roster changes, the
// Coverage Desk memo), which used to ignore personal switches.
//
// Blob alert-schedules.json: { email: { type: { days:[0-6], from:'HH:MM', to:'HH:MM' } } }
// (no entry, or every day with no hours, = any time). Best-effort: a failed
// read sends to everyone, as before.
var { get, put } = require('@vercel/blob');
var PATH = 'alert-schedules.json';
var TZ = 'America/New_York';

async function load() {
  try {
    var r = await get(PATH, { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200) return {};
    return (await new Response(r.stream).json()) || {};
  } catch (e) { return {}; }
}

function clean(s) {
  if (!s) return null;
  var days = Array.isArray(s.days) ? s.days.map(Number).filter(function (d) { return d >= 0 && d <= 6; }) : [0, 1, 2, 3, 4, 5, 6];
  days = Array.from(new Set(days)).sort();
  var hm = function (x) { return /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(x || '')) ? String(x).padStart(5, '0') : null; };
  var from = hm(s.from), to = hm(s.to);
  if (!from || !to || from === to) { from = null; to = null; }
  if (days.length === 7 && !from) return null; // any day, any time
  return { days: days, from: from, to: to };
}

async function set(email, type, schedule) {
  email = String(email || '').toLowerCase();
  if (!email || !type) throw new Error('email and type required');
  var all = await load();
  var mine = all[email] || {};
  var c = clean(schedule);
  if (c) mine[type] = c; else delete mine[type];
  if (Object.keys(mine).length) all[email] = mine; else delete all[email];
  await put(PATH, JSON.stringify(all), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
  return c;
}

function etParts(ms) {
  var p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).reduce(function (o, x) { o[x.type] = x.value; return o; }, {});
  return { dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), hm: String(+p.hour % 24).padStart(2, '0') + ':' + p.minute };
}

// Is this schedule open at nowMs? A window past midnight (from > to) counts
// its after-midnight hours toward the day it started.
function openAt(s, nowMs) {
  if (!s) return true;
  var t = etParts(nowMs);
  if (!s.from) return s.days.indexOf(t.dow) !== -1;
  if (s.from < s.to) return s.days.indexOf(t.dow) !== -1 && t.hm >= s.from && t.hm < s.to;
  if (t.hm >= s.from) return s.days.indexOf(t.dow) !== -1;
  if (t.hm < s.to) return s.days.indexOf((t.dow + 6) % 7) !== -1;
  return false;
}

async function allows(email, type, nowMs, all) {
  all = all || await load();
  var mine = all[String(email || '').toLowerCase()];
  return openAt(mine && mine[type], nowMs || Date.now());
}

// Recipients for an alert email right now: drops anyone whose schedule for
// this type is closed, and team members who switched the type off.
async function filter(emails, type, nowMs) {
  if (!type || !emails || !emails.length) return emails || [];
  var all = await load();
  var off = {};
  try {
    var S = require('./_supabase');
    if (S.isConfigured()) {
      var sb = S.admin();
      var site = await sb.from('sites').select('id').eq('slug', 'insidemdsports').single();
      if (site.data) {
        var mem = await sb.from('memberships').select('user_id, role, profiles(email)').eq('site_id', site.data.id);
        var prefs = await sb.from('alert_prefs').select('user_id, enabled').eq('site_id', site.data.id).eq('alert_type', type);
        var explicit = {}; (prefs.data || []).forEach(function (p) { explicit[p.user_id] = p.enabled; });
        var known = require('./alert-prefs').ALERT_TYPES.some(function (t) { return t.key === type; });
        (mem.data || []).forEach(function (m) {
          var em = m.profiles && m.profiles.email; if (!em) return;
          var on = explicit[m.user_id] !== undefined ? explicit[m.user_id] : (known ? require('./alert-prefs').defaultFor(type, m.role) : true);
          if (!on) off[em.toLowerCase()] = true;
        });
      }
    }
  } catch (e) { /* switches unknown: keep everyone */ }
  return emails.filter(function (e) {
    var k = String(e).toLowerCase();
    return !off[k] && openAt(all[k] && all[k][type], nowMs || Date.now());
  });
}

module.exports = { load: load, set: set, allows: allows, filter: filter, openAt: openAt, clean: clean };
