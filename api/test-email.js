var mailer = require('./_mailer.js');

module.exports = async function handler(req, res) {
  try { await require('./_supabase').requireUserOrCron(req); }
  catch (authErr) { return res.status(authErr.status || 401).json({ error: authErr.message || 'Not signed in' }); }
  try {
    var result = await mailer.sendMail({
      subject: 'IMS Tool test email',
      html: '<p>This is a test email from the IMS Tool. If you are reading this, email delivery works.</p>'
    });
    return res.status(200).json({ ok: true, result: result });
  } catch (e) {
    var detail = (e.response && e.response.body) ? JSON.stringify(e.response.body) : e.message;
    return res.status(200).json({ ok: false, error: detail });
  }
};
