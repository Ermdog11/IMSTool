const sgMail = require('@sendgrid/mail');

module.exports = async function handler(req, res) {
  var ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  var SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
  var ALERT_EMAIL = process.env.ALERT_EMAIL;
  var FROM_EMAIL = process.env.FROM_EMAIL;

  if (!ANTHROPIC_API_KEY || !SENDGRID_API_KEY || !ALERT_EMAIL || !FROM_EMAIL) {
    return res.status(500).json({ error: 'Missing environment variables.' });
  }

  try {
    // Reuse the working scan pipeline instead of the retired web_search approach
    var scanHandler = require('./scan.js');
    var scanResult = await new Promise(function(resolve, reject) {
      var fakeRes = {
        status: function() { return this; },
        json: function(d) { resolve(d); return this; }
      };
      scanHandler({ body: {} }, fakeRes).catch(reject);
    });

    var alerts = [];
    if (!scanResult.error) {
      var text = (scanResult.content || []).map(function(b) { return b.type === 'text' ? b.text : ''; }).join('\n');
      var match = text.match(/\[[\s\S]*\]/);
      if (match) {
        // Morning brief: overnight window (12h), meaningful stories only
        alerts = JSON.parse(match[0]).filter(function(a) {
          if (a.republished) return false;
          if ((a.rating || 0) < 3) return false;
          var hours = parseInt((a.time || '').match(/\d+/) || '99', 10);
          return hours <= 12;
        }).slice(0, 8);
      }
    }
    var date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    var recipients = ALERT_EMAIL.split(',').map(function(e) { return e.trim(); }).filter(Boolean);

    sgMail.setApiKey(SENDGRID_API_KEY);

    if (alerts.length === 0) {
      await sgMail.send({
        to: recipients,
        from: FROM_EMAIL,
        subject: 'InsideMDSports morning brief — ' + date,
        html: '<div style="font-family:-apple-system,sans-serif;max-width:500px;margin:0 auto;padding:20px;"><div style="background:#cf0315;padding:12px 16px;border-radius:8px 8px 0 0;"><span style="color:white;font-weight:700;">InsideMDSports morning brief — ' + date + '</span></div><div style="background:white;padding:16px;border-radius:0 0 8px 8px;"><p style="color:#555;font-size:14px;">All quiet overnight. No significant Terps news since midnight.</p></div></div>'
      });
    } else {
      var itemsHTML = alerts.map(function(a) {
        return '<div style="padding:10px 0;border-bottom:1px solid #e8e6e1;"><div style="font-size:13px;font-weight:600;color:#1a1a1a;">' + a.headline + '</div>' +
          (a.summary ? '<div style="font-size:12px;color:#555;margin-top:3px;">' + a.summary + '</div>' : '') +
          '<div style="font-size:11px;color:#888;margin-top:3px;">' + a.source + ' &middot; ' + a.time + '</div></div>';
      }).join('');

      await sgMail.send({
        to: recipients,
        from: FROM_EMAIL,
        subject: 'InsideMDSports morning brief — ' + alerts.length + ' overnight stories',
        html: '<div style="font-family:-apple-system,sans-serif;max-width:500px;margin:0 auto;padding:20px;"><div style="background:#cf0315;padding:12px 16px;border-radius:8px 8px 0 0;"><span style="color:white;font-weight:700;">InsideMDSports morning brief — ' + date + '</span></div><div style="background:white;padding:16px;border-radius:0 0 8px 8px;"><p style="font-size:12px;color:#888;margin-bottom:12px;">Here\'s what happened overnight. ' + alerts.length + ' stories.</p>' + itemsHTML + '</div></div>'
      });
    }

    return res.status(200).json({ success: true, count: alerts.length });
  } catch (error) {
    console.error('Morning brief error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};
