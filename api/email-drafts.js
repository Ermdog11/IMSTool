// /api/email-drafts — the newsroom inbox, every 5 minutes (or "Check email
// now" on the Drafts tab): articles emailed to the +drafts address become
// Content Editor drafts (no Claude calls), and mail to the +calendar address
// goes on the calendar (one Claude call per email). The same run sends any
// calendar reminders that are due. See _email-drafts.js and _calendar.js.
//
//   GET -> { configured, address, calendarAddress, checked, saved:[{id,headline,from}],
//            calendar:[{subject,events,from}], skipped:[{from,why}], reminders }

var S = require('./_supabase');

module.exports = async function handler(req, res) {
  try { await S.requireUserOrCron(req, res); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message || 'Not signed in' }); }
  res.setHeader('Cache-Control', 'no-store');
  // Reminders first and on their own, so an inbox problem never holds one up.
  var reminders = 0;
  try { reminders = await require('./_calendar').sendDueReminders(); }
  catch (e) { console.error('Calendar reminders failed (non-fatal):', e.message); }
  try {
    var out = await require('./_email-drafts').run();
    out.reminders = reminders;
    if (out.saved.length || out.skipped.length || (out.calendar || []).length || reminders) console.log('Email drafts:', JSON.stringify(out));
    return res.status(200).json(out);
  } catch (e) {
    console.error('Email drafts failed (non-fatal):', e.message);
    return res.status(200).json({ error: e.message, saved: [], calendar: [], skipped: [], reminders: reminders });
  }
};

// Per-newsroom: this request runs as the signed-in person's newsroom (_site.js).
module.exports = require('./_site').wrap(module.exports);
