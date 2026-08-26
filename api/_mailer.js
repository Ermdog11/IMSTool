// Shared mailer: prefers Gmail SMTP (reliable delivery for gmail FROM addresses),
// falls back to SendGrid if Gmail credentials are not configured.
var nodemailer = require('nodemailer');

async function sendMail(opts) {
  var GMAIL_USER = process.env.GMAIL_USER;
  var GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

  var recipients = (process.env.ALERT_EMAIL || '')
    .split(',')
    .map(function(e) { return e.trim().replace(/[<>]/g, ''); })
    .filter(Boolean);
  if (!recipients.length) throw new Error('ALERT_EMAIL not set');

  if (GMAIL_USER && GMAIL_APP_PASSWORD) {
    var transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD.replace(/\s/g, '') }
    });
    var info = await transporter.sendMail({
      from: '"InsideMDSports Monitor" <' + GMAIL_USER + '>',
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
  var result = await sgMail.send({ to: recipients, from: FROM_EMAIL, subject: opts.subject, html: opts.html });
  return { via: 'sendgrid', to: recipients, status: result[0] && result[0].statusCode };
}

module.exports = { sendMail: sendMail };
