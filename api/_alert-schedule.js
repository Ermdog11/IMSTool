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
// Blob alert-schedules.json: { email: { _tz: 'America/Chicago', type: { days:[0-6], from:'HH:MM', to:'HH:MM' } } }
// _ch: { type: 'email'|'text'|'both' } and _phone: '+15551234567' are how they
// want each alert delivered (Jeff, 2026-10-07: email, text or both; _sms.js).
// _tz is the person's own time zone (Jeff, 2026-10-07: "add choice of time
// zone to preferences"); their days and hours are read in it. No _tz = Eastern.
// (no entry, or every day with no hours, = any time). Best-effort: a failed
// read sends to everyone, as before.
var { get, put } = require('./_site-blob');
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
  var tz = s.tz && validTz(s.tz) ? String(s.tz) : null;
  if (days.length === 7 && !from && !tz) return null; // any day, any time, own zone
  var out = { days: days, from: from, to: to };
  if (tz) out.tz = tz;
  return out;
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

function validTz(tz) {
  try { if (tz) { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } } catch (e) {}
  return false;
}

// One person's time zone ('America/New_York' unless they chose another).
function tzOf(mine) { return mine && validTz(mine._tz) ? mine._tz : TZ; }

var CHANNELS = ['email', 'text', 'both'];
function channelOf(mine, type) { var c = mine && mine._ch && mine._ch[type]; return CHANNELS.indexOf(c) !== -1 ? c : 'email'; }
function phoneOf(mine) { return (mine && mine._phone) || ''; }

async function saveMine(email, fn) {
  email = String(email || '').toLowerCase();
  if (!email) throw new Error('email required');
  var all = await load();
  var mine = all[email] || {};
  var out = fn(mine);
  if (Object.keys(mine).length) all[email] = mine; else delete all[email];
  await put(PATH, JSON.stringify(all), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
  return out;
}
function setChannel(email, type, ch) {
  if (CHANNELS.indexOf(ch) === -1) throw new Error('Choose email, text or both.');
  return saveMine(email, function (mine) {
    mine._ch = mine._ch || {};
    if (ch === 'email') delete mine._ch[type]; else mine._ch[type] = ch;
    if (!Object.keys(mine._ch).length) delete mine._ch;
    return ch;
  });
}
function setPhone(email, phone) {
  var p = phone ? require('./_sms').normalizePhone(phone) : '';
  if (phone && !p) throw new Error('That doesn\'t look like a mobile number. Use 10 digits, or + and the country code.');
  return saveMine(email, function (mine) { if (p) mine._phone = p; else delete mine._phone; return p; });
}

async function setTz(email, tz) {
  email = String(email || '').toLowerCase();
  if (!email) throw new Error('email required');
  if (tz && !validTz(tz)) throw new Error('Unknown time zone.');
  var all = await load();
  var mine = all[email] || {};
  if (tz && tz !== TZ) mine._tz = tz; else delete mine._tz;
  if (Object.keys(mine).length) all[email] = mine; else delete all[email];
  await put(PATH, JSON.stringify(all), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
  return mine._tz || TZ;
}

// The zone one alert's days and hours (and send times) are read in: the one
// picked on its ⏰ (Jeff, 2026-10-07: "a zone choice on each"), else the person's.
function tzFor(mine, type) { var s = mine && mine[type]; return s && s.tz && validTz(s.tz) ? s.tz : tzOf(mine); }

// Send times for the digests (Jeff, 2026-10-07: "let them set time"; the
// updates: "three different time slots ... or only receive 1 or 2 daily").
// _times: { digest_rolling: ['08:00','12:00','17:00'], digest_nightly: ['20:00'] },
// whole hours in the person's zone for that alert. No entry = the defaults.
var TIME_DEFAULTS = { digest_rolling: ['08:00', '12:00', '17:00'], digest_nightly: ['20:00'] };
var TIME_MAX = { digest_rolling: 3, digest_nightly: 1 };
function cleanTimes(type, times) {
  var ok = (Array.isArray(times) ? times : []).map(function (t) { return /^([01]?\d|2[0-3]):00$/.test(String(t)) ? String(t).padStart(5, '0') : null; })
    .filter(Boolean);
  ok = Array.from(new Set(ok)).sort();
  if (!ok.length) throw new Error('Pick at least one time.');
  if (ok.length > TIME_MAX[type]) throw new Error('Pick at most ' + TIME_MAX[type] + '.');
  return ok;
}
function timesOf(mine, type) {
  var t = mine && mine._times && mine._times[type];
  return Array.isArray(t) && t.length ? t : (TIME_DEFAULTS[type] || []);
}
function setTimes(email, type, times) {
  if (!TIME_DEFAULTS[type]) throw new Error('That alert has no send times.');
  var c = cleanTimes(type, times);
  return saveMine(email, function (mine) {
    mine._times = mine._times || {};
    if (c.join() === TIME_DEFAULTS[type].join()) delete mine._times[type]; else mine._times[type] = c;
    if (!Object.keys(mine._times).length) delete mine._times;
    return c;
  });
}
// Minutes past midnight in tz at ms.
function minuteOfDay(ms, tz) {
  var p = etParts(ms, tz); return +p.hm.slice(0, 2) * 60 + +p.hm.slice(3);
}
// Is one of this person's send times for `type` this hour (their zone)?
function dueNow(mine, type, nowMs) {
  var h = etParts(nowMs, tzFor(mine, type)).hm.slice(0, 2) + ':00';
  return timesOf(mine, type).indexOf(h) !== -1;
}
// Hours since the last digest email this person got before now: their
// previous update time, or the nightly digest if they get it and it was
// later (Jeff: the morning one "needs to include what's new since the PM
// digest"). At least 1; 24 when it's their only one.
function hoursSinceLast(mine, nowMs, nightlyOn) {
  var tz = tzFor(mine, 'digest_rolling');
  var now = minuteOfDay(nowMs, tz), gap = 1440;
  var list = timesOf(mine, 'digest_rolling').concat(nightlyOn ? timesOf(mine, 'digest_nightly') : []);
  list.forEach(function (t) {
    var d = (now - (+t.slice(0, 2) * 60) + 1440) % 1440;
    if (d >= 45 && d < gap) gap = d; // the current hour's own send is < 45 min ago
  });
  return Math.max(1, Math.ceil(gap / 60));
}

function etParts(ms, tz) {
  var p = new Intl.DateTimeFormat('en-US', { timeZone: tz || TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).reduce(function (o, x) { o[x.type] = x.value; return o; }, {});
  return { dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), hm: String(+p.hour % 24).padStart(2, '0') + ':' + p.minute };
}

// Is this schedule open at nowMs? A window past midnight (from > to) counts
// its after-midnight hours toward the day it started.
function openAt(s, nowMs, tz) {
  if (!s) return true;
  var t = etParts(nowMs, tz);
  if (!s.from) return s.days.indexOf(t.dow) !== -1;
  if (s.from < s.to) return s.days.indexOf(t.dow) !== -1 && t.hm >= s.from && t.hm < s.to;
  if (t.hm >= s.from) return s.days.indexOf(t.dow) !== -1;
  if (t.hm < s.to) return s.days.indexOf((t.dow + 6) % 7) !== -1;
  return false;
}

async function allows(email, type, nowMs, all) {
  all = all || await load();
  var mine = all[String(email || '').toLowerCase()];
  return openAt(mine && mine[type], nowMs || Date.now(), tzFor(mine, type));
}

// Recipients for an alert email right now: drops anyone whose schedule for
// this type is closed, and team members who switched the type off.
async function filter(emails, type, nowMs) {
  return (await split(emails, type, nowMs)).open;
}
// { open: who gets it now, closed: who has it on but is outside their
// days/hours for it (_held-alerts.js saves it for their next update) }.
async function split(emails, type, nowMs) {
  if (!type || !emails || !emails.length) return { open: emails || [], closed: [] };
  var all = await load();
  var off = await switchedOff(type);
  var out = { open: [], closed: [] };
  emails.forEach(function (e) {
    var k = String(e).toLowerCase();
    if (off[k]) return;
    (openAt(all[k] && all[k][type], nowMs || Date.now(), tzFor(all[k], type)) ? out.open : out.closed).push(e);
  });
  return out;
}

// { email: true } for team members who switched `type` off (or have it off
// by default for their role). Empty when the switches can't be read.
async function switchedOff(type) {
  var off = {};
  try {
    var S = require('./_supabase');
    if (S.isConfigured()) {
      var sb = S.admin();
      var site = await sb.from('sites').select('id').eq('slug', require('./_site').slug()).single();
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
  return off;
}

// Remove all of one person's schedules (account deletion).
async function clearAll(email) {
  var all = await load(); email = String(email || '').toLowerCase();
  if (!all[email]) return;
  delete all[email];
  await put(PATH, JSON.stringify(all), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
}

module.exports = { split: split, switchedOff: switchedOff, tzFor: tzFor, TIME_DEFAULTS: TIME_DEFAULTS, TIME_MAX: TIME_MAX, timesOf: timesOf, setTimes: setTimes, dueNow: dueNow, hoursSinceLast: hoursSinceLast, clearAll: clearAll, load: load, set: set, setTz: setTz, setChannel: setChannel, setPhone: setPhone, channelOf: channelOf, phoneOf: phoneOf, CHANNELS: CHANNELS, tzOf: tzOf, DEFAULT_TZ: TZ, allows: allows, filter: filter, openAt: openAt, clean: clean };
