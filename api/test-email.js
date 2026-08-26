const sgMail = require('@sendgrid/mail');

module.exports = async function handler(req, res) {
  var SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
  var ALERT_EMAIL = process.env.ALERT_EMAIL;
  var FROM_EMAIL = process.env.FROM_EMAIL;
  if (!SENDGRID_API_KEY) return res.status(200).json({ ok: false, error: 'SENDGRID_API_KEY not set' });
  if (!ALERT_EMAIL) return res.status(200).json({ ok: false, error: 'ALERT_EMAIL not set' });
  if (!FROM_EMAIL) return res.status(200).json({ ok: false, error: 'FROM_EMAIL not set' });

  try {
    sgMail.setApiKey(SENDGRID_API_KEY);
    var recipients = ALERT_EMAIL.split(',').map(function(e) { return e.trim(); }).filter(Boolean);
    var result = await sgMail.send({
      to: recipients,
      from: FROM_EMAIL,
      subject: 'IMS Tool test email',
      html: '<p>This is a test email from the IMS Tool. If you are reading this, SendGrid works.</p>'
    });
    return res.status(200).json({ ok: true, sentTo: recipients, from: FROM_EMAIL, sgStatus: result[0] && result[0].statusCode });
  } catch (e) {
    var detail = (e.response && e.response.body) ? JSON.stringify(e.response.body) : e.message;
    return res.status(200).json({ ok: false, sendgridError: detail, from: FROM_EMAIL, to: ALERT_EMAIL });
  }
};
