// Public-records requests from the News Monitor ("Request records" on alert
// cards about contracts, schedules, budgets, hires and other business news).
//
//   POST {action:'draft', alert}  -> Claude judges whether records behind the
//        story are obtainable under a public-records law (FOIA, a state act like
//        Maryland's PIA) and, if so, drafts the request letter addressed to the
//        records office in the beat profile (beat.records, api/_beat.js), or,
//        for another agency, one looked up on its own website.
//   POST {action:'send', to, subject, body, alert, cc?} -> emails it from the
//        CoPublisher mailbox under the staff member's name, CC'd to them with
//        Reply-To set to them, so the records office answers the reporter
//        directly. Editors and publishers only; writers use "Open in my email".
//   GET  -> the newsroom's sent requests, newest first.
//
// Nothing is ever sent without a person reviewing the letter and clicking
// Send. Drafting, the records-office lookup and the log live in _records.js,
// shared with the proactive suggestions cron (records-suggest.js).
var S = require('./_supabase.js');
var Beat = require('./_beat.js');
var Records = require('./_records.js');
var { sendMail } = require('./_mailer.js');

var SITE = 'insidemdsports';
var EMAIL_RE = Records.EMAIL_RE;

function clean(a) {
  a = a || {};
  return {
    headline: String(a.headline || '').slice(0, 500),
    summary: String(a.summary || '').slice(0, 3000),
    source: String(a.source || '').slice(0, 200),
    url: a.url ? String(a.url).slice(0, 2000) : ''
  };
}

module.exports = async function handler(req, res) {
  var auth;
  try { auth = await S.requireUserOrCron(req, res); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message || 'Not signed in' }); }

  if (req.method === 'GET') {
    var all = await Records.loadState();
    return res.status(200).json({ requests: all[SITE] || [] });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });

  var body = req.body || {};
  var user = auth && auth.user;
  var who = {
    email: (user && user.email) || '',
    name: (auth && auth.membership && auth.membership.byline) || (user && user.user_metadata && (user.user_metadata.full_name || user.user_metadata.name)) || ''
  };

  try {
    if (body.action === 'draft') {
      var story = clean(body.alert);
      if (!story.headline) return res.status(400).json({ error: 'alert.headline required' });
      var beat = await Beat.getBeat(S.isConfigured() ? S.admin() : null);
      return res.status(200).json(await Records.draft(story, beat, who));
    }

    if (body.action === 'send') {
      // Mail goes out to a third party under a staff member's name: a signed-in
      // editor or publisher only (cron and in-process callers never send).
      if (auth && (auth.cron || auth.internal)) return res.status(403).json({ error: 'Records requests are sent by a person, not a scheduled job' });
      if (auth && auth.membership && auth.membership.role === 'writer') return res.status(403).json({ error: 'Ask an editor to send it, or use "Open in my email" to send it yourself' });
      var to = String(body.to || '').trim();
      var subject = String(body.subject || '').trim().slice(0, 300);
      var text = String(body.body || '').trim().slice(0, 20000);
      if (!EMAIL_RE.test(to)) return res.status(400).json({ error: 'Enter the records office email address' });
      if (!subject || !text) return res.status(400).json({ error: 'Subject and letter are required' });
      if (/\[[^\]]{2,60}\]/.test(text)) return res.status(400).json({ error: 'Fill in the [bracketed] placeholders in the letter first' });
      var cc = [who.email].concat(String(body.cc || '').split(/[,;\s]+/)).map(function (e) { return e.trim(); })
        .filter(function (e, i, arr) { return e && EMAIL_RE.test(e) && e.toLowerCase() !== to.toLowerCase() && arr.indexOf(e) === i; });
      var replyTo = who.email || cc[0] || '';
      if (!replyTo) return res.status(400).json({ error: 'Add your email in CC so the records office can reply to you' });
      var beat2 = await Beat.getBeat(S.isConfigured() ? S.admin() : null);
      var esc = function (s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
      var sent = await sendMail({
        to: [to], cc: cc, replyTo: replyTo, subject: subject, text: text,
        html: '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap;">' + esc(text) + '</div>',
        fromName: (who.name ? who.name + ', ' : '') + beat2.outletName
      });
      var entry = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        sentAt: new Date().toISOString(), to: to, cc: cc, subject: subject,
        agency: String(body.agency || '').slice(0, 200), law: String(body.law || '').slice(0, 300),
        responseNote: String(body.responseNote || '').slice(0, 300),
        story: clean(body.alert), requestedBy: who.email || null, via: sent.via
      };
      try { await Records.appendLog(SITE, entry); } catch (e) { console.error('records log failed', e.message); }
      return res.status(200).json({ ok: true, request: entry });
    }

    return res.status(400).json({ error: "action must be 'draft' or 'send'" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
