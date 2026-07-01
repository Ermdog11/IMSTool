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
    var claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{
          role: 'user',
          content: 'You are a news monitor for InsideMDSports. Search for any Maryland Terrapins athletics news from the past 8 hours (overnight). This is a morning brief — focus on anything that broke overnight that Jeff Ermann needs to know before starting his day.\n\nEXCLUDE: InsideMDSports, Jeff Ermann, IMS Radio content.\n\nReturn ONLY a valid JSON array. Each item:\n{headline, summary, category, sport, source, time, rating(1-5)}\n\nReturn up to 8 items sorted by rating descending. If nothing significant happened overnight, return an empty array [].'
        }]
      })
    });

    var claudeData = await claudeRes.json();
    var text = claudeData.content.map(function(b) { return b.type === 'text' ? b.text : ''; }).join('\n');
    var match = text.replace(/```json|```/g, '').match(/\[[\s\S]*\]/);

    var alerts = match ? JSON.parse(match[0]) : [];
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
