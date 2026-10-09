// /api/calendar — the News Monitor's Calendar tab (see _calendar.js).
//
//   GET                                   -> { events, address, me, myDefault, steps, tz }
//   POST { action:'add-text', text }      -> Claude pulls the dated items out of pasted text
//   POST { action:'add', title, date, time?, location?, note? }
//   POST { action:'update', id, title?, date?, time?, location?, note? }
//   POST { action:'delete', id }
//   POST { action:'remind', id, minutes, channel }   (minutes 0 = no reminder)
//   POST { action:'default', minutes, channel }      (your automatic reminder before every event)
//   POST { action:'remind-for', id, for:[emails]|'team', minutes, channel }  (reminders for anyone; others: editors+)
//   POST { action:'assign', id, email|'' , minutes?, channel? }  (put a writer on it, optional reminder; editors+)
//   POST { action:'heat-remind', minutes, channel }  (your reminder before every hot spot)
//   POST { action:'hot12', on, channel }             (alert me when a hot spot is within 12 hours)
//   POST { action:'quiet', from, to, off? }          (your quiet hours for hot-spot alerts, your time zone)
//   POST { action:'heat-on', on }                    (hot spots on/off for the newsroom; editors+)
//   POST { action:'heat-refresh' }                   (recompute this week's hot spots; editors+)
//   POST { action:'mode', mode:'ai'|'manual' }       (who runs the calendar; editors+. 'ai' adds the games now)

var S = require('./_supabase');
var Access = require('./_access');
var Cal = require('./_calendar');

// The newsroom's Supabase client and site id, for the analytics the heat
// spots read. Null when login isn't configured (hot spots then just skip).
async function siteRef(ctx) {
  if (ctx && ctx.supabase && ctx.site) return { sb: ctx.supabase, id: ctx.site.id };
  if (!S.isConfigured()) return null;
  var sb = S.admin();
  var site = await sb.from('sites').select('id').eq('slug', require('./_site').slug()).single();
  return site.data ? { sb: sb, id: site.data.id } : null;
}
// { email: name } for everyone in this newsroom (null when login is off).
async function teamEmails(ctx) {
  var ref = await siteRef(ctx); if (!ref) return null;
  var mem = await ref.sb.from('memberships').select('profiles(email, full_name)').eq('site_id', ref.id);
  var out = {};
  (mem.data || []).forEach(function (m) { var p = m.profiles; if (p && p.email) out[p.email.toLowerCase()] = p.full_name || ''; });
  return out;
}
function canManage(ctx) {
  var role = ctx && ctx.membership && ctx.membership.role;
  return !role || role === 'publisher' || role === 'editor'; // no role = login off or cron
}

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
      // First look this week: fill in the week's hot spots (stored analytics only, no Claude).
      if (Cal.heatOn(data) && !(data.heat && data.heat.week === Cal.weekKey() && data.heat.v === Cal.HEAT_V)) {
        try { var ref0 = await siteRef(ctx); if (ref0) { await Cal.ensureHeatSpots(ref0.sb, ref0.id, false); data = await Cal.load(); } }
        catch (e) { console.error('Hot spots on load failed:', e.message); }
      }
      var since = Date.now() - 2 * 86400000;
      var info = require('./_email-drafts').inboxInfo();
      return res.status(200).json({
        events: data.events.filter(function (e) { return Date.parse(e.start) >= since; }),
        team: canManage(ctx) ? await teamEmails(ctx).then(function (t) { return t ? Object.keys(t).map(function (e) { return { email: e, name: t[e] }; }) : null; }).catch(function () { return null; }) : null,
        address: info.calendarAddress, me: me, myDefault: data.prefs[me] || null, steps: Cal.STEPS, tz: Cal.TZ,
        mode: Cal.mode(data),
        heat: { on: Cal.heatOn(data), canManage: canManage(ctx), mine: (data.prefs[me] && data.prefs[me].heat) || null, hot12: (data.prefs[me] && data.prefs[me].hot12) || null, quiet: Cal.quietOf(data, me), week: data.heat ? data.heat.week : null, basis: data.heat ? data.heat.basis : null, note: data.heat ? data.heat.note : null }
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
    if (b.action === 'hot12') { await Cal.setHot12(me, !!b.on, b.channel); return res.status(200).json({ ok: true }); }
    if (b.action === 'quiet') {
      try { return res.status(200).json({ ok: true, quiet: await Cal.setQuiet(me, b.from, b.to, !!b.off) }); }
      catch (e) { return res.status(400).json({ error: e.message }); }
    }
    if (b.action === 'heat-remind') { await Cal.setHeatReminder(me, b.minutes, b.channel); return res.status(200).json({ ok: true }); }
    if (b.action === 'heat-on' || b.action === 'heat-refresh') {
      if (!canManage(ctx)) return res.status(403).json({ error: 'Editors and publishers can change hot spots.' });
      if (b.action === 'heat-on') await Cal.setHeatOn(!!b.on);
      var ref = await siteRef(ctx);
      var heat = (b.action === 'heat-refresh' || b.on) && ref ? await Cal.ensureHeatSpots(ref.sb, ref.id, true) : { on: !!b.on, spots: [] };
      return res.status(200).json(heat);
    }
    if (b.action === 'mode') {
      if (!canManage(ctx)) return res.status(403).json({ error: 'Editors and publishers choose how the calendar is run.' });
      await Cal.setMode(b.mode);
      var added = [];
      if (b.mode === 'ai') {
        var ref1 = await siteRef(ctx);
        if (ref1) {
          try { await Cal.ensureHeatSpots(ref1.sb, ref1.id, false); } catch (e) { console.error('Hot spots on mode change failed:', e.message); }
          try { added = await require('./_ai-calendar').addGames(ref1.sb); } catch (e) { console.error('AI calendar games failed:', e.message); }
        }
      }
      return res.status(200).json({ mode: b.mode, added: added.length });
    }
    // Reminders for anyone on the team (yourself always; others: editors and
    // the publisher). b.for = [emails], or 'team' for everyone.
    if (b.action === 'remind-for') {
      var team = await teamEmails(ctx);
      var want = b.for === 'team' ? Object.keys(team) : (Array.isArray(b.for) ? b.for : [b.for]).map(function (x) { return String(x || '').toLowerCase(); });
      var others = want.filter(function (x) { return x && x !== me; });
      if (others.length && !canManage(ctx)) return res.status(403).json({ error: 'Editors and the publisher can set reminders for other people. You can set your own.' });
      var bad = want.filter(function (x) { return x !== me && team && !team[x]; });
      if (bad.length) return res.status(400).json({ error: 'Not on your team: ' + bad.join(', ') });
      return res.status(200).json({ event: await Cal.setRemindersFor(b.id, want, b.minutes, b.channel, me) });
    }
    if (b.action === 'assign') {
      if (!canManage(ctx)) return res.status(403).json({ error: 'Editors and the publisher assign writers.' });
      var team2 = await teamEmails(ctx), who = String(b.email || '').toLowerCase();
      if (who && team2 && !team2[who]) return res.status(400).json({ error: 'Not on your team: ' + who });
      var ev2 = await Cal.assign(b.id, who ? { email: who, name: team2 && team2[who] } : null, me);
      if (who && Number(b.minutes)) ev2 = await Cal.setRemindersFor(b.id, [who], b.minutes, b.channel, me);
      return res.status(200).json({ event: ev2 });
    }
    if (b.action === 'default') { await Cal.setDefault(me, b.minutes, b.channel); return res.status(200).json({ ok: true }); }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(/not found|Pick|Sign in|Bad date/.test(e.message) ? 400 : 500).json({ error: e.message });
  }
};

// Per-newsroom: this request runs as the signed-in person's newsroom (_site.js).
module.exports = require('./_site').wrap(module.exports);
