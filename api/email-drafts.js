// /api/email-drafts — turns articles emailed to the newsroom's +drafts
// address into Content Editor drafts. Cron every 5 minutes, or "Check now"
// on the Drafts tab. Reads mail only; no Claude calls. See _email-drafts.js.
//
//   GET -> { configured, address, checked, saved:[{id,headline,from}], skipped:[{from,why}] }

var S = require('./_supabase');

module.exports = async function handler(req, res) {
  try { await S.requireUserOrCron(req, res); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message || 'Not signed in' }); }
  res.setHeader('Cache-Control', 'no-store');
  try {
    var out = await require('./_email-drafts').run();
    if (out.saved.length || out.skipped.length) console.log('Email drafts:', JSON.stringify(out));
    return res.status(200).json(out);
  } catch (e) {
    console.error('Email drafts failed (non-fatal):', e.message);
    return res.status(200).json({ error: e.message, saved: [], skipped: [] });
  }
};
