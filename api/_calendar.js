// Newsroom calendar (Jeff, 2026-10-06: forward an email like an SID's
// "Preseason Media Information" and get its dates on a calendar; "calendar
// should summarize anything entered concisely and offer a reminder
// text/email in increments of 30 minutes before any event up to six hours
// early").
//
// Events come in three ways: emailed to the newsroom Gmail's +calendar
// address (read with the +drafts mail by _email-drafts.js), pasted into the
// Calendar tab ("Add from text"), or typed in by hand. Claude reads the text
// and pulls out each dated item (credential deadline, game, media day...)
// with a one-line summary, plus a two-sentence summary of the whole email.
//
// Reminders: each person picks, per event, 30 minutes to 6 hours before (in
// 30-minute steps) and email or text. Each person can also set a default
// that's applied to events they add. Texts need a texting service (see the
// "Text with CoPublisher" TODO); until one is connected a text reminder goes
// out by email, and says so. Sent by the same 5-minute cron that reads the
// inbox (api/email-drafts.js -> sendDueReminders).
//
// Stored in Vercel Blob (calendar/events.json): small, newsroom-wide.

var { get, put } = require('./_site-blob');
var PATH = 'calendar/events.json';
var TZ = 'America/New_York';
var STEPS = [30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330, 360];

async function load() {
  try {
    var r = await get(PATH, { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200) return { events: [], prefs: {}, settings: {} };
    var d = await new Response(r.stream).json();
    return { events: d.events || [], prefs: d.prefs || {}, settings: d.settings || {}, heat: d.heat || null, dismissed: d.dismissed || [] };
  } catch (e) { return { events: [], prefs: {}, settings: {} }; }
}
async function save(data) {
  // Keep a year of history at most.
  var cutoff = Date.now() - 365 * 86400000;
  data.events = data.events.filter(function (e) { return Date.parse(e.start) > cutoff; }).slice(-2000);
  await put(PATH, JSON.stringify(data), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
}

function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// "2026-10-11" + "16:30" in New York -> ISO UTC. Works across DST: the
// offset is read for that date, not today.
function zonedIso(date, time, tz) {
  tz = tz || TZ;
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!m) return null;
  var t = /^(\d{1,2}):(\d{2})$/.exec(String(time || '')) || [null, '8', '00'];
  var guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +t[1], +t[2]);
  var parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(guess)).reduce(function (o, p) { o[p.type] = p.value; return o; }, {});
  var asLocal = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
  return new Date(guess - (asLocal - guess)).toISOString();
}

function fmtWhen(e) {
  var d = new Date(e.start);
  var day = d.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
  if (e.allDay) return day;
  return day + ', ' + d.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
}

var TOOL = {
  name: 'submit_calendar',
  description: 'The dated items in the text, for a newsroom calendar.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'The whole message in at most two short sentences: what it is and what the newsroom needs to do.' },
      events: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short, under 60 characters, e.g. "Credential requests close: GT exhibition" or "Media Day".' },
            date: { type: 'string', description: 'YYYY-MM-DD' },
            time: { type: 'string', description: 'Start time HH:MM, 24-hour, local to the event. Empty if no time is given.' },
            endTime: { type: 'string', description: 'End time HH:MM if given, else empty.' },
            location: { type: 'string', description: 'Place if given, else empty.' },
            kind: { type: 'string', enum: ['deadline', 'game', 'media', 'event'] },
            note: { type: 'string', description: 'One short line: what to do or know. Empty if the title says it all.' }
          },
          required: ['title', 'date', 'time', 'endTime', 'location', 'kind', 'note']
        }
      }
    },
    required: ['summary', 'events']
  }
};

// Text (an email body, a pasted note) -> { summary, events:[...] } with ISO starts.
async function extract(text, opts) {
  opts = opts || {};
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Missing ANTHROPIC_API_KEY.');
  var sent = opts.sentAt ? new Date(opts.sentAt) : new Date();
  var sentStr = sent.toLocaleString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  var user = 'This was written ' + sentStr + ' (Eastern). Pull out every item with a date a sports newsroom would want on its calendar: deadlines (credential requests, RSVPs, applications), games, press conferences, media days, events. Resolve relative dates ("this Sunday", "Thursday", "10/18") from the date it was written. Skip dates that are only background (a past game, a season record). If an item has a deadline and an event, make them two items. Keep every title and note short.\n\n' +
    (opts.subject ? 'SUBJECT: ' + opts.subject + '\n\n' : '') + String(text || '').slice(0, 12000);
  var r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2500, tools: [TOOL], tool_choice: { type: 'tool', name: TOOL.name }, messages: [{ role: 'user', content: user.toWellFormed() }] })
  });
  var d = await r.json();
  if (d.error) throw new Error('Claude error: ' + (d.error.message || JSON.stringify(d.error)));
  var out = ((d.content || []).filter(function (b) { return b.type === 'tool_use'; })[0] || {}).input || {};
  var events = (out.events || []).map(function (e) {
    var start = zonedIso(e.date, e.time || '');
    if (!start) return null;
    return {
      title: String(e.title || '').slice(0, 120), start: start, allDay: !e.time,
      end: e.endTime ? zonedIso(e.date, e.endTime) : null,
      location: String(e.location || '').slice(0, 160), kind: e.kind || 'event', note: String(e.note || '').slice(0, 240)
    };
  }).filter(Boolean).slice(0, 25);
  return { summary: String(out.summary || '').slice(0, 400), events: events };
}

// Saves extracted events; applies each adder's default reminder. Returns the saved events.
async function addEvents(list, meta) {
  meta = meta || {};
  var data = await load();
  var saved = [], fresh = [];
  list.forEach(function (e) {
    var dupe = data.events.filter(function (x) { return x.start === e.start && x.title.toLowerCase() === e.title.toLowerCase(); })[0];
    if (dupe) { saved.push(dupe); return; }
    var ev = Object.assign({ id: newId(), createdAt: new Date().toISOString(), createdBy: meta.by || '', source: meta.source || 'manual', sourceSubject: meta.subject || '', groupSummary: meta.summary || '', reminders: [] }, e);
    var def = meta.by && data.prefs[meta.by.toLowerCase()];
    if (def && def.minutes) ev.reminders.push({ email: meta.by.toLowerCase(), minutes: def.minutes, channel: def.channel || 'email', sentAt: null });
    data.events.push(ev);
    saved.push(ev); fresh.push(ev);
  });
  data.events.sort(function (a, b) { return a.start.localeCompare(b.start); });
  await save(data);
  if (fresh.length) await announce(fresh, meta);
  return saved;
}

// New items go to Team Chat and to everyone with the "New calendar items"
// alert on (Jeff, 2026-10-06: "when a new calendar event is added, it should
// auto post in chat and there should be permissions for getting an alert").
// Best-effort: never blocks the add.
async function announce(events, meta) {
  var S = require('./_supabase');
  var lines = events.map(function (e) { return fmtWhen(e) + ': ' + e.title + (e.location ? ' (' + e.location + ')' : ''); });
  var who = meta.by ? meta.by.split('@')[0] : '';
  try {
    if (S.isConfigured()) {
      await require('./_chat-store').postSystemMessage(S.admin(), {
        senderName: 'CoPublisher AI', kind: 'calendar', tag: 'Calendar',
        text: (events.length === 1 ? 'Added to the calendar: ' : events.length + ' items added to the calendar: ') + lines.join(' · '),
        meta: { events: events.map(function (e) { return { id: e.id, title: e.title, start: e.start }; }), by: meta.by || null, subject: meta.subject || null, url: '/calendar' }
      });
    }
  } catch (e) { console.error('Calendar chat post failed:', e.message); }
  try {
    var to = await S.recipientsFor('calendar');
    if (to.length) {
      await require('./_mailer').sendMail({
        to: to, alertType: 'calendar',
        subject: 'Calendar: ' + (events.length === 1 ? events[0].title + ' (' + fmtWhen(events[0]) + ')' : events.length + ' new items' + (meta.subject ? ' from "' + meta.subject + '"' : '')),
        html: '<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:14px">' +
          (meta.summary ? '<p>' + esc(meta.summary) + '</p>' : '') +
          '<ul>' + events.map(function (e) { return '<li><b>' + esc(fmtWhen(e)) + '</b>: ' + esc(e.title) + (e.note ? ' <span style="color:#666">' + esc(e.note) + '</span>' : '') + '</li>'; }).join('') + '</ul>' +
          '<p style="font-size:12px;color:#888">Added' + (who ? ' by ' + esc(who) : '') + '. <a href="https://ims-tool.vercel.app/calendar">Open the calendar</a> to set a reminder. Change who gets these in Permissions &amp; preferences.</p></div>'
      });
    }
  } catch (e) { console.error('Calendar alert email failed:', e.message); }
}

async function setReminder(id, email, minutes, channel) {
  email = String(email || '').toLowerCase();
  if (!email) throw new Error('Sign in to set reminders.');
  minutes = Number(minutes) || 0;
  if (minutes && STEPS.indexOf(minutes) === -1) throw new Error('Pick 30 minutes to 6 hours, in 30-minute steps.');
  var data = await load();
  var ev = data.events.filter(function (e) { return e.id === id; })[0];
  if (!ev) throw new Error('Event not found');
  ev.reminders = (ev.reminders || []).filter(function (r) { return r.email !== email; });
  if (minutes) ev.reminders.push({ email: email, minutes: minutes, channel: (channel === 'text' || channel === 'both' ? channel : 'email'), sentAt: null });
  await save(data);
  return ev;
}

async function setDefault(email, minutes, channel) {
  email = String(email || '').toLowerCase();
  if (!email) throw new Error('Sign in to set a default reminder.');
  minutes = Number(minutes) || 0;
  if (minutes && STEPS.indexOf(minutes) === -1) throw new Error('Pick 30 minutes to 6 hours, in 30-minute steps.');
  var data = await load();
  // Merge: the same entry also holds the hot-spot reminder.
  var p = data.prefs[email] || {};
  if (minutes) { p.minutes = minutes; p.channel = (channel === 'text' || channel === 'both' ? channel : 'email'); } else { delete p.minutes; delete p.channel; }
  if (Object.keys(p).length) data.prefs[email] = p; else delete data.prefs[email];
  await save(data);
}

async function updateEvent(id, fields) {
  var data = await load();
  var ev = data.events.filter(function (e) { return e.id === id; })[0];
  if (!ev) throw new Error('Event not found');
  if (typeof fields.title === 'string' && fields.title.trim()) ev.title = fields.title.trim().slice(0, 120);
  if (typeof fields.note === 'string') ev.note = fields.note.trim().slice(0, 240);
  if (typeof fields.location === 'string') ev.location = fields.location.trim().slice(0, 160);
  if (fields.date) {
    var start = zonedIso(fields.date, fields.time || '');
    if (!start) throw new Error('Bad date');
    ev.start = start; ev.allDay = !fields.time;
    (ev.reminders || []).forEach(function (r) { r.sentAt = null; }); // moved: remind again
  }
  data.events.sort(function (a, b) { return a.start.localeCompare(b.start); });
  await save(data);
  return ev;
}

async function deleteEvent(id) {
  var data = await load();
  var gone = data.events.filter(function (e) { return e.id === id; })[0];
  data.events = data.events.filter(function (e) { return e.id !== id; });
  // Something the AI added and a person deleted: don't add it back next run.
  if (gone && gone.source === 'ai') data.dismissed = (data.dismissed || []).concat(dedupeKey(gone)).slice(-300);
  await save(data);
}

// ---- Who runs the calendar (Jeff, 2026-10-06: "have it ask whether you want
// the AI to actively calendar by adding games and other things it notices or
// be all controlled by users"). settings.mode: 'ai' (CoPublisher adds the
// beat's games, hot spots and dated items it spots in the news; see
// _ai-calendar.js) or 'manual' (only what people add; no hot spots either).
// Unset = not asked yet: the Calendar tab asks an editor or publisher, and
// meanwhile hot spots show (they were asked for) but nothing else is added.
function mode(data) { var m = data.settings && data.settings.mode; return m === 'ai' || m === 'manual' ? m : null; }
async function setMode(m) {
  if (m !== 'ai' && m !== 'manual') throw new Error('Pick AI-assisted or only what we add.');
  var data = await load();
  data.settings = Object.assign({}, data.settings, { mode: m });
  if (m === 'manual') { var now = Date.now(); data.events = data.events.filter(function (e) { return !((e.kind === 'heat' || e.source === 'ai') && Date.parse(e.start) > now); }); data.heat = null; }
  await save(data);
}

// Same New York day and mostly the same words: treated as the same item, so
// the AI never adds a game twice under a slightly different title.
function words(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(function (w) { return w.length > 2 && ['the', 'and', 'for', 'with', 'game', 'vs'].indexOf(w) === -1; }); }
function dedupeKey(e) { return nyDay(Date.parse(e.start)) + '|' + words(e.title).sort().join(' '); }
function sameItem(a, b) {
  if (nyDay(Date.parse(a.start)) !== nyDay(Date.parse(b.start))) return false;
  var wa = words(a.title), wb = words(b.title);
  if (!wa.length || !wb.length) return false;
  var hit = wa.filter(function (w) { return wb.indexOf(w) !== -1; }).length;
  return hit / Math.min(wa.length, wb.length) >= 0.6;
}
// AI-found items -> only the ones not already on the calendar (or deleted
// by someone before), then saved like any other add.
async function addAiEvents(list, meta) {
  var data = await load();
  var now = Date.now();
  var fresh = [];
  list.forEach(function (e) {
    if (!e || !e.start || Date.parse(e.start) < now || Date.parse(e.start) > now + 60 * 86400000) return;
    if (data.events.concat(fresh).some(function (x) { return sameItem(x, e); })) return;
    if ((data.dismissed || []).some(function (k) { var p = k.split('|'); return sameItem({ start: e.start, title: e.title }, { start: zonedIso(p[0], '12:00'), title: p[1] }); })) return;
    fresh.push(Object.assign({}, e, { source: 'ai' }));
  });
  if (!fresh.length) return [];
  return await addEvents(fresh, Object.assign({ by: '', source: 'ai' }, meta || {}));
}

// All-day items are reminded relative to 8 AM that day.
function startMs(e) { return Date.parse(e.start); }

// Today's items (New York date), earliest first, for the Coverage Desk memo
// (Jeff, 2026-10-06: "daily coverage desk email should include that day's
// calendar events"). An all-day item counts on its date.
function nyDay(ms) { return new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ }); }
async function eventsOn(day) {
  day = day || nyDay(Date.now());
  var data = await load();
  return data.events.filter(function (e) { return e.start && nyDay(startMs(e)) === day; })
    .sort(function (a, b) { return startMs(a) - startMs(b); });
}
function timeOf(e) {
  return e.allDay ? 'All day' : new Date(e.start).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
}


// ---- Hot spots (the week's five best times to publish; _heat-spots.js) ----
// Newsroom-wide on/off (settings.heatSpots, on unless turned off) and each
// person's "remind me before every hot spot" (prefs[email].heat). The spots
// are ordinary calendar items of kind 'heat', replaced whenever the week is
// recomputed; past ones stay as history.

// Monday (New York) of the current week, as the key for "this week's spots".
function weekKey(ms) {
  ms = ms || Date.now();
  for (var i = 0; i < 7; i++) {
    var d = ms - i * 86400000;
    if (new Date(d).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long' }) === 'Monday') return nyDay(d);
  }
  return nyDay(ms);
}

var HEAT_V = 3; // 2: site readers lead, social capped (no 7 AM spots from one viral post); 3: renamed "Hot spot" (2026-10-06)
function heatOn(data) { return mode(data) !== 'manual' && !(data.settings && data.settings.heatSpots === false); }

function heatReminders(data) {
  return Object.keys(data.prefs || {}).filter(function (k) { return data.prefs[k] && data.prefs[k].heat && data.prefs[k].heat.minutes; })
    .map(function (k) { return { email: k, minutes: data.prefs[k].heat.minutes, channel: data.prefs[k].heat.channel || 'email', sentAt: null }; });
}

// Recompute this week's spots and put them on the calendar (unless the
// newsroom turned them off). force: recompute even if this week is done.
async function ensureHeatSpots(sb, siteId, force) {
  var data = await load();
  var wk = weekKey();
  if (!heatOn(data)) return { on: false, spots: [] };
  // HEAT_V: bump when the scoring changes, so this week's spots are redone.
  if (!force && data.heat && data.heat.week === wk && data.heat.v === HEAT_V) {
    return { on: true, spots: data.events.filter(function (e) { return e.kind === 'heat' && e.heatWeek === wk; }), basis: data.heat.basis, note: data.heat.note };
  }
  var got = await require('./_heat-spots').compute(sb, siteId);
  data = await load(); // re-read: someone may have added an event meanwhile
  var now = Date.now();
  data.events = data.events.filter(function (e) { return !(e.kind === 'heat' && Date.parse(e.start) > now); });
  var reminders = heatReminders(data);
  var added = got.spots.map(function (sp) {
    return {
      id: newId(), createdAt: new Date().toISOString(), createdBy: '', source: 'heat', kind: 'heat', heatWeek: wk, heatRank: sp.rank,
      title: '🔥 Hot spot #' + sp.rank + ': publish by ' + sp.label.replace(/^\S+ /, ''),
      start: zonedIso(sp.date, sp.time), allDay: false, end: null, location: '', note: sp.why,
      reminders: reminders.map(function (r) { return Object.assign({}, r); })
    };
  });
  data.events = data.events.concat(added).sort(function (a, b) { return a.start.localeCompare(b.start); });
  data.heat = { week: wk, v: HEAT_V, at: new Date().toISOString(), basis: got.basis, note: got.note };
  await save(data);
  return { on: true, spots: added, basis: got.basis, note: got.note };
}

async function setHeatOn(on) {
  var data = await load();
  data.settings = Object.assign({}, data.settings, { heatSpots: !!on });
  if (!on) { var now = Date.now(); data.events = data.events.filter(function (e) { return !(e.kind === 'heat' && Date.parse(e.start) > now); }); data.heat = null; }
  await save(data);
}

// Your reminder before every hot spot: saved as a preference and applied
// to this week's upcoming spots right away.
async function setHeatReminder(email, minutes, channel) {
  email = String(email || '').toLowerCase();
  if (!email) throw new Error('Sign in to set reminders.');
  minutes = Number(minutes) || 0;
  if (minutes && STEPS.indexOf(minutes) === -1) throw new Error('Pick 30 minutes to 6 hours, in 30-minute steps.');
  channel = (channel === 'text' || channel === 'both' ? channel : 'email');
  var data = await load();
  var p = data.prefs[email] || {};
  if (minutes) p.heat = { minutes: minutes, channel: channel }; else delete p.heat;
  if (Object.keys(p).length) data.prefs[email] = p; else delete data.prefs[email];
  var now = Date.now();
  data.events.forEach(function (e) {
    if (e.kind !== 'heat' || Date.parse(e.start) <= now) return;
    e.reminders = (e.reminders || []).filter(function (r) { return r.email !== email; });
    if (minutes) e.reminders.push({ email: email, minutes: minutes, channel: channel, sentAt: null });
  });
  await save(data);
}

// When a reminder goes out. A hot-spot heads-up that would land overnight
// (10 PM to 7 AM Eastern, e.g. "2 hours before" a 7 AM spot) comes at 8 PM
// the evening before instead, so there's time to have a story ready (Jeff,
// 2026-10-06: "a fix for when the hot spot is early and the email goes out
// too late to use it").
function etHour(ms) { return Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date(ms))) % 24; }
function reminderDueMs(e, r) {
  var due = startMs(e) - r.minutes * 60000;
  if (e.kind !== 'heat') return due;
  var h = etHour(due);
  if (h >= 22 || h < 7) {
    var evening = Date.parse(zonedIso(nyDay(h < 7 ? due - 12 * 3600000 : due), '20:00'));
    return Math.min(due, evening);
  }
  return due;
}

// "A hot spot is within 12 hours" alert (Jeff, 2026-10-06: "a checkbox on
// preferences to receive email or text alerts when a hot spot is within a 12
// hour window"). Per person, opt-in: prefs[email].hot12 = { channel }. Each
// spot alerts each person once. Never between 10 PM and 7 AM Eastern; from
// 8 PM a spot before noon tomorrow counts too, so an early spot is flagged
// the evening before instead of overnight.
async function setHot12(email, on, channel) {
  email = String(email || '').toLowerCase();
  if (!email) throw new Error('Sign in to set alerts.');
  var data = await load();
  var p = data.prefs[email] || {};
  if (on) p.hot12 = { channel: (channel === 'text' || channel === 'both' ? channel : 'email') }; else delete p.hot12;
  if (Object.keys(p).length) data.prefs[email] = p; else delete data.prefs[email];
  await save(data);
}
function hot12Due(e, now) {
  var s = startMs(e), h = etHour(now);
  if (s <= now || h >= 22 || h < 7) return false;
  if (s - now <= 12 * 3600000) return true;
  var tomorrow = nyDay(now + 86400000);
  return h >= 20 && nyDay(s) === tomorrow && etHour(s) < 12;
}

// Account deletion: drop one person's calendar preferences and pending reminders.
async function forgetPerson(email) {
  email = String(email || '').toLowerCase();
  var data = await load(), changed = false;
  if (data.prefs && data.prefs[email]) { delete data.prefs[email]; changed = true; }
  data.events.forEach(function (e) {
    var n = (e.reminders || []).length;
    e.reminders = (e.reminders || []).filter(function (r) { return r.email !== email; });
    if (e.reminders.length !== n) changed = true;
  });
  if (changed) await save(data);
}

// Cron: send every reminder that's due. Returns how many went out.
async function sendDueReminders() {
  var data = await load();
  var now = Date.now(), sent = 0, changed = false;
  var Mailer = require('./_mailer');
  for (var i = 0; i < data.events.length; i++) {
    var e = data.events[i];
    var s = startMs(e);
    if (s < now - 15 * 60000) continue; // already happened
    for (var j = 0; j < (e.reminders || []).length; j++) {
      var r = e.reminders[j];
      if (r.sentAt || now < reminderDueMs(e, r)) continue;
      var nightBefore = e.kind === 'heat' && nyDay(now) !== nyDay(s);
      try {
        await Mailer.sendMail({
          to: r.email, channel: r.channel || 'email',
          subject: nightBefore ? 'Hot spot tomorrow at ' + new Date(s).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }) + ': have a story ready tonight'
            : 'Reminder: ' + e.title + ' (' + fmtWhen(e) + ')',
          html: '<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:15px">' +
            '<p><b>' + esc(e.title) + '</b><br>' + esc(fmtWhen(e)) + (e.location ? ' · ' + esc(e.location) : '') + '</p>' +
            (nightBefore ? '<p>This hot spot is early, so this heads-up comes the evening before: line up the story tonight and schedule it for then.</p>' : '') +
            (e.note ? '<p>' + esc(e.note) + '</p>' : '') +
            ((r.channel === 'text' || r.channel === 'both') && !require('./_sms').isConfigured() ? '<p style="color:#888;font-size:12px">You asked for a text; texting isn\'t connected yet, so this came by email.</p>' : '') +
            '<p style="font-size:13px"><a href="https://ims-tool.vercel.app/calendar">Open the calendar</a></p></div>'
        });
        r.sentAt = new Date().toISOString(); sent++; changed = true;
      } catch (err) { console.error('Calendar reminder failed:', err.message); }
    }
  }
  // Hot spot within 12 hours, for everyone who opted in.
  var hotPeople = Object.keys(data.prefs || {}).filter(function (em) { return data.prefs[em] && data.prefs[em].hot12; });
  var schedAll = hotPeople.length ? await require('./_alert-schedule').load() : null;
  if (hotPeople.length && heatOn(data)) {
    for (var k = 0; k < data.events.length; k++) {
      var he = data.events[k];
      if (he.kind !== 'heat' || !hot12Due(he, now)) continue;
      he.hot12Sent = he.hot12Sent || [];
      for (var q = 0; q < hotPeople.length; q++) {
        var em = hotPeople[q];
        if (he.hot12Sent.indexOf(em) !== -1) continue;
        // Outside this person's days/hours for hot-spot alerts: wait (the
        // cron tries again every 5 minutes while the spot is still ahead).
        if (!(await require('./_alert-schedule').allows(em, 'hot_spot', now, schedAll))) continue;
        var hs = startMs(he), when = new Date(hs).toLocaleString('en-US', { timeZone: TZ, weekday: 'long', hour: 'numeric', minute: '2-digit' });
        try {
          await Mailer.sendMail({
            to: em, channel: data.prefs[em].hot12.channel || 'email',
            subject: '🔥 Hot spot ' + (nyDay(hs) === nyDay(now) ? 'today' : 'tomorrow') + ' at ' + new Date(hs).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }) + ': have a story ready',
            html: '<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:15px">' +
              '<p><b>' + esc(he.title) + '</b><br>' + esc(when) + '</p>' +
              (he.note ? '<p>' + esc(he.note) + '</p>' : '') +
              '<p>Have your best story ready to publish then.</p>' +
              ((data.prefs[em].hot12.channel === 'text' || data.prefs[em].hot12.channel === 'both') && !require('./_sms').isConfigured() ? '<p style="color:#888;font-size:12px">You asked for a text; texting isn\'t connected yet, so this came by email.</p>' : '') +
              '<p style="font-size:13px"><a href="https://ims-tool.vercel.app/calendar">Open the calendar</a> · <a href="https://ims-tool.vercel.app/preferences">Change this alert</a></p></div>'
          });
          he.hot12Sent.push(em); sent++; changed = true;
        } catch (err) { console.error('Hot spot alert failed:', err.message); }
      }
    }
  }
  if (changed) await save(data);
  return sent;
}

// The +calendar email: extract, save, reply with the summary and events.
async function fromEmail(text, meta) {
  var got = await extract(text, { subject: meta.subject, sentAt: meta.sentAt });
  var saved = got.events.length ? await addEvents(got.events, { by: meta.from, source: 'email', subject: meta.subject, summary: got.summary }) : [];
  try {
    await require('./_mailer').sendMail({
      to: meta.from,
      subject: (saved.length ? 'Added to the calendar: ' : 'Nothing dated found: ') + (meta.subject || 'your email'),
      html: '<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:14px">' +
        (got.summary ? '<p>' + esc(got.summary) + '</p>' : '') +
        (saved.length ? '<ul>' + saved.map(function (e) { return '<li><b>' + esc(fmtWhen(e)) + '</b>: ' + esc(e.title) + (e.note ? ' <span style="color:#666">' + esc(e.note) + '</span>' : '') + '</li>'; }).join('') + '</ul>' +
          '<p><a href="https://ims-tool.vercel.app/calendar">Set a reminder</a> (email or text, 30 minutes to 6 hours before).</p>'
          : '<p>No dates were found in it, so nothing was added.</p>') + '</div>'
    });
  } catch (e) { console.error('Calendar confirmation failed:', e.message); }
  return { summary: got.summary, events: saved };
}

module.exports = { HEAT_V: HEAT_V, mode: mode, setMode: setMode, addAiEvents: addAiEvents, sameItem: sameItem, ensureHeatSpots: ensureHeatSpots, setHeatOn: setHeatOn, setHeatReminder: setHeatReminder, heatOn: heatOn, weekKey: weekKey, eventsOn: eventsOn, timeOf: timeOf, load: load, extract: extract, addEvents: addEvents, setReminder: setReminder, setDefault: setDefault, updateEvent: updateEvent, deleteEvent: deleteEvent, sendDueReminders: sendDueReminders, reminderDueMs: reminderDueMs, setHot12: setHot12, hot12Due: hot12Due, forgetPerson: forgetPerson, fromEmail: fromEmail, zonedIso: zonedIso, STEPS: STEPS, TZ: TZ };
