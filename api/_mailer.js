// Shared mailer: prefers Gmail SMTP (reliable delivery for gmail FROM addresses),
// falls back to SendGrid if Gmail credentials are not configured.
var nodemailer = require('nodemailer');

// Default recipients: ALERT_EMAIL plus ALERT_EMAIL_EXTRA (both comma-separated).
// ALERT_EMAIL is a write-only "sensitive" Vercel var, so adding someone there
// means retyping the whole list; ALERT_EMAIL_EXTRA takes additions on its own.
function digestList() {
  var seen = {};
  return [process.env.ALERT_EMAIL, process.env.ALERT_EMAIL_EXTRA].join(',').split(',')
    .map(function(e) { return e.trim().replace(/[<>]/g, ''); })
    .filter(function(e) {
      if (!e || e === 'undefined' || seen[e.toLowerCase()]) return false;
      seen[e.toLowerCase()] = true;
      return true;
    });
}

// opts: { subject, html, text?, to?, cc?, replyTo?, fromName?, alertType? }. replyTo/cc are
// for mail sent on a staff member's behalf (records requests), so replies go
// straight to them rather than to the CoPublisher mailbox.
async function sendMail(opts) {
  var GMAIL_USER = process.env.GMAIL_USER;
  var GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

  // Callers can override the recipient list (e.g. the dev digest, which goes
  // to a different pair of addresses than the newsroom's own ALERT_EMAIL).
  var recipients = opts.to
    ? (Array.isArray(opts.to) ? opts.to : String(opts.to).split(','))
      .map(function(e) { return e.trim().replace(/[<>]/g, ''); }).filter(Boolean)
    : digestList();
  // The digest list (ALERT_EMAIL) belongs to InsideMDSports. For any other
  // newsroom, mail with no "to" goes to that newsroom's own team, by alert
  // type (_site.js; multi-newsroom 2026-10-06).
  if (!opts.to && !require('./_site').isDefault()) {
    recipients = await require('./_supabase').teamRecipientsFor(opts.alertType || 'digest_rolling', require('./_site').slug());
    if (!recipients.length) return { skipped: 'no one in this newsroom gets this email' };
  }
  if (!recipients.length) throw new Error(opts.to ? 'No valid recipients in opts.to' : 'ALERT_EMAIL not set');
  // An alert email (opts.alertType) goes only to people who have that alert
  // on and whose days/hours for it include now (_alert-schedule.js).
  if (opts.alertType) {
    recipients = await require('./_alert-schedule').filter(recipients, opts.alertType);
    if (!recipients.length) return { skipped: 'nobody has this alert on right now', alertType: opts.alertType };
  }

  // Email, text or both, per person and alert (_alert-schedule.js, _sms.js).
  // With texting connected: anyone who chose text or both (and saved a mobile
  // number) gets a text; text-only people come off the email. Without it,
  // everyone keeps getting email.
  var texted = 0;
  try {
    var Sms = require('./_sms');
    if (Sms.isConfigured() && (opts.alertType || opts.channel)) {
      var Sched = require('./_alert-schedule');
      var schedAll = await Sched.load();
      var smsTo = [];
      recipients = recipients.filter(function (e) {
        var mine = schedAll[String(e).toLowerCase()] || {};
        var ch = opts.channel || Sched.channelOf(mine, opts.alertType);
        var ph = Sched.phoneOf(mine);
        if (!ph || ch === 'email') return true;
        smsTo.push(ph);
        return ch === 'both';
      });
      var body = Sms.fromEmail(opts);
      for (var si = 0; si < smsTo.length; si++) {
        try { await Sms.send(smsTo[si], body); texted++; } catch (e) { console.error('mailer: text failed:', e.message); }
      }
      if (!recipients.length) return { via: 'sms', texted: texted };
    }
  } catch (e) { console.error('mailer: text routing failed (email only):', e.message); }

  if (GMAIL_USER && GMAIL_APP_PASSWORD) {
    var transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD.replace(/\s/g, '') }
    });
    var info = await transporter.sendMail({
      from: '"' + String(opts.fromName || 'CoPublisher AI').replace(/["<>]/g, '') + '" <' + GMAIL_USER + '>',
      to: recipients.join(', '),
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
      cc: opts.cc,
      replyTo: opts.replyTo
    });
    return { via: 'gmail', to: recipients, id: info.messageId };
  }

  // Fallback: SendGrid
  var SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
  var FROM_EMAIL = process.env.FROM_EMAIL;
  if (!SENDGRID_API_KEY || !FROM_EMAIL) throw new Error('No mail credentials: set GMAIL_USER + GMAIL_APP_PASSWORD (preferred) or SENDGRID_API_KEY + FROM_EMAIL');
  var sgMail = require('@sendgrid/mail');
  sgMail.setApiKey(SENDGRID_API_KEY);
  var result = await sgMail.send({ to: recipients, from: { email: FROM_EMAIL, name: opts.fromName || 'CoPublisher AI' }, subject: opts.subject, html: opts.html, text: opts.text, cc: opts.cc, replyTo: opts.replyTo });
  return { via: 'sendgrid', to: recipients, status: result[0] && result[0].statusCode };
}

// Everyone a newsroom email with no "to" would go to, before switches and
// schedules: the digest list for InsideMDSports, the team for any other
// newsroom. The digests use it to send each person theirs at their own times.
async function baseRecipients(alertType) {
  if (require('./_site').isDefault()) return digestList();
  return require('./_supabase').teamRecipientsFor(alertType || 'digest_rolling', require('./_site').slug());
}

module.exports = { sendMail: sendMail, digestList: digestList, baseRecipients: baseRecipients };
