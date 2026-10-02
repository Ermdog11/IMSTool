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

async function sendMail(opts) {
  var GMAIL_USER = process.env.GMAIL_USER;
  var GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

  // Callers can override the recipient list (e.g. the dev digest, which goes
  // to a different pair of addresses than the newsroom's own ALERT_EMAIL).
  var recipients = opts.to
    ? (Array.isArray(opts.to) ? opts.to : String(opts.to).split(','))
      .map(function(e) { return e.trim().replace(/[<>]/g, ''); }).filter(Boolean)
    : digestList();
  if (!recipients.length) throw new Error(opts.to ? 'No valid recipients in opts.to' : 'ALERT_EMAIL not set');

  if (GMAIL_USER && GMAIL_APP_PASSWORD) {
    var transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD.replace(/\s/g, '') }
    });
    var info = await transporter.sendMail({
      from: '"CoPublisher AI" <' + GMAIL_USER + '>',
      to: recipients.join(', '),
      subject: opts.subject,
      html: opts.html
    });
    return { via: 'gmail', to: recipients, id: info.messageId };
  }

  // Fallback: SendGrid
  var SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
  var FROM_EMAIL = process.env.FROM_EMAIL;
  if (!SENDGRID_API_KEY || !FROM_EMAIL) throw new Error('No mail credentials: set GMAIL_USER + GMAIL_APP_PASSWORD (preferred) or SENDGRID_API_KEY + FROM_EMAIL');
  var sgMail = require('@sendgrid/mail');
  sgMail.setApiKey(SENDGRID_API_KEY);
  var result = await sgMail.send({ to: recipients, from: { email: FROM_EMAIL, name: 'CoPublisher AI' }, subject: opts.subject, html: opts.html });
  return { via: 'sendgrid', to: recipients, status: result[0] && result[0].statusCode };
}

module.exports = { sendMail: sendMail, digestList: digestList };
