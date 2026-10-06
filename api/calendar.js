// /api/calendar — the News Monitor's Calendar tab (see _calendar.js).
//
//   GET                                   -> { events, address, me, myDefault, steps, tz }
//   POST { action:'add-text', text }      -> Claude pulls the dated items out of pasted text
//   POST { action:'add', title, date, time?, location?, note? }
//   POST { action:'update', id, title?, date?, time?, location?, note? }
//   POST { action:'delete', id }
//   POST { action:'remind', id, minutes, channel }   (minutes 0 = no reminder)
//   POST { action:'default', minutes, channel }      (your default for events you add)

var S = require('./_supabase');
var Access = require('./_access');
var Cal = require('./_calendar');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  var ctx;
  try { ctx = await S.requireUserOrCron(req, res); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message || 'Not signed in' }); }
  if (!(await Access.allowed(ctx, 'mon_calendar'))) return Access.deny(res);
  var me = String((ctx && ctx.user && ctx.user.email) || '').toLowerCase();
  try {
    if (req.method === 'GET') {
      var data = await Cal.load();
      var since = Date.now() - 2 * 86400000;
      var info = require('./_email-drafts').inboxInfo();
      return res.status(200).json({
        events: data.events.filter(function (e) { return Date.parse(e.start) >= since; }),
        address: info.calendarAddress, me: me, myDefault: data.prefs[me] || null, steps: Cal.STEPS, tz: Cal.TZ
      });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });
    var b = req.body || {};
    if (b.action === 'add-text') {
      var text = String(b.text || '').trim();
      if (text.length < 10) return res.status(400).json({ error: 'Paste the email or note first.' });
      var got = await Cal.extract(text, {});
      var saved = got.events.length ? await Cal.addEvents(got.events, { by: me, source: 'pasted', summary: got.summary }) : [];
      return res.status(200).json({ summary: got.summary, events: saved });
    }
    if (b.action === 'add') {
      var start = Cal.zonedIso(b.date, b.time || '');
      if (!start || !String(b.title || '').trim()) return res.status(400).json({ error: 'Add a title and a date.' });
      var ev = await Cal.addEvents([{ title: String(b.title).trim().slice(0, 120), start: start, allDay: !b.time, end: null, location: String(b.location || '').slice(0, 160), kind: 'event', note: String(b.note || '').slice(0, 240) }], { by: me, source: 'manual' });
      return res.status(200).json({ events: ev });
    }
    if (b.action === 'update') return res.status(200).json({ event: await Cal.updateEvent(b.id, b) });
    if (b.action === 'delete') { await Cal.deleteEvent(b.id); return res.status(200).json({ ok: true }); }
    if (b.action === 'remind') return res.status(200).json({ event: await Cal.setReminder(b.id, me, b.minutes, b.channel) });
    if (b.action === 'default') { await Cal.setDefault(me, b.minutes, b.channel); return res.status(200).json({ ok: true }); }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(/not found|Pick|Sign in|Bad date/.test(e.message) ? 400 : 500).json({ error: e.message });
  }
};
