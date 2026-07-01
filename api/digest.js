const sgMail = require('@sendgrid/mail');

const buildDigestPrompt = () => `You are a news monitor for InsideMDSports, covering University of Maryland Terrapins athletics. Search for ALL Maryland Terrapins news from the past 24 hours across all sources.

EXCLUDE: InsideMDSports, Jeff Ermann, IMS Radio content.

Gather news across: football, basketball (men's and women's), recruiting, transfer portal, alumni (NFL, NBA, WNBA), social media buzz, podcasts.

Return ONLY a valid JSON array. Each item:
{headline, summary, category("recruiting"|"football"|"basketball"|"other-sport"|"alumni"|"social"|"podcast"), sport, source, time, rating(1-5)}

Return up to 20 items sorted by rating descending.`;

const buildDigestEmailHTML = (alerts, date) => {
  const groups = {
    'Recruiting': alerts.filter(a => a.category === 'recruiting'),
    'Football': alerts.filter(a => a.sport === 'football' && a.category !== 'recruiting'),
    'Basketball': alerts.filter(a => ['basketball','mens-basketball','womens-basketball'].includes(a.sport||'') && a.category !== 'recruiting'),
    'Other sports': alerts.filter(a => !['football','basketball','mens-basketball','womens-basketball'].includes(a.sport||'') && !['recruiting','alumni','social','podcast'].includes(a.category)),
    'Alumni': alerts.filter(a => a.category === 'alumni'),
    'Social & podcasts': alerts.filter(a => ['social','podcast'].includes(a.category))
  };

  var sectionsHTML = '';
  for (var title in groups) {
    var items = groups[title];
    if (!items.length) continue;
    sectionsHTML += '<div style="margin-bottom:20px;">';
    sectionsHTML += '<div style="font-size:12px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;border-bottom:2px solid #cf0315;padding-bottom:5px;">' + title + '</div>';
    items.forEach(function(item) {
      sectionsHTML += '<div style="padding:10px 0;border-bottom:1px solid #e8e6e1;">';
      sectionsHTML += '<div style="font-size:14px;font-weight:600;color:#1a1a1a;margin-bottom:4px;">' + item.headline + '</div>';
      if (item.summary) sectionsHTML += '<div style="font-size:12px;color:#555;line-height:1.5;">' + item.summary + '</div>';
      sectionsHTML += '<div style="font-size:11px;color:#888;margin-top:4px;">' + item.source + ' &middot; ' + item.time + '</div>';
      sectionsHTML += '</div>';
    });
    sectionsHTML += '</div>';
  }

  return '<!DOCTYPE html><html><head></head><body style="font-family:-apple-system,sans-serif;background:#f7f6f3;margin:0;padding:20px;">' +
    '<div style="max-width:600px;margin:0 auto;background:white;border-radius:10px;overflow:hidden;">' +
    '<div style="background:#cf0315;padding:16px 20px;">' +
    '<div style="color:white;font-size:16px;font-weight:700;">InsideMDSports</div>' +
    '<div style="color:rgba(255,255,255,0.8);font-size:12px;">Nightly digest &mdash; ' + date + '</div>' +
    '</div>' +
    '<div style="padding:20px 24px;">' +
    '<p style="font-size:13px;color:#555;margin-bottom:20px;">Here\'s everything that happened in Terps athletics today. ' + alerts.length + ' stories across all sources.</p>' +
    sectionsHTML +
    '</div>' +
    '<div style="background:#1a1a1a;padding:12px 20px;text-align:center;">' +
    '<a href="https://247sports.com/college/maryland/" style="color:#ffd520;font-size:12px;font-weight:600;text-decoration:none;">Open InsideMDSports &rarr;</a>' +
    '</div></div></body></html>';
};

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
        max_tokens: 3000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: buildDigestPrompt() }]
      })
    });

    var claudeData = await claudeRes.json();
    var text = claudeData.content.map(function(b) { return b.type === 'text' ? b.text : ''; }).join('\n');
    var match = text.replace(/```json|```/g, '').match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON from Claude');

    var alerts = JSON.parse(match[0]);
    var date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

    sgMail.setApiKey(SENDGRID_API_KEY);
    var recipients = ALERT_EMAIL.split(',').map(function(e) { return e.trim(); }).filter(Boolean);
    await sgMail.send({
      to: recipients,
      from: FROM_EMAIL,
      subject: 'InsideMDSports nightly digest — ' + date,
      html: buildDigestEmailHTML(alerts, date)
    });

    return res.status(200).json({ success: true, count: alerts.length, date: date });
  } catch (error) {
    console.error('Digest error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};
