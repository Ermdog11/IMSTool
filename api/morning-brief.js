// api/morning-brief.js
// Runs at 8 AM every day. Quick summary of overnight news.

import sgMail from '@sendgrid/mail';

export default async function handler(req, res) {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
  const ALERT_EMAIL = process.env.ALERT_EMAIL;
  const FROM_EMAIL = process.env.FROM_EMAIL;

  if (!ANTHROPIC_API_KEY || !SENDGRID_API_KEY || !ALERT_EMAIL || !FROM_EMAIL) {
    return res.status(500).json({ error: 'Missing environment variables.' });
  }

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
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
          content: `You are a news monitor for InsideMDSports. Search for any Maryland Terrapins athletics news from the past 8 hours (overnight). This is a morning brief — focus on anything that broke overnight that Jeff Ermann needs to know before starting his day.

EXCLUDE: InsideMDSports, Jeff Ermann, IMS Radio content.

Return ONLY a valid JSON array. Each item:
{headline, summary, category, sport, source, time, rating(1-5)}

Return up to 8 items sorted by rating descending. If nothing significant happened overnight, return an empty array.`
        }]
      })
    });

    const claudeData = await claudeRes.json();
    const text = claudeData.content.map(b => b.type === 'text' ? b.text : '').join('\n');
    const match = text.replace(/```json|```/g, '').match(/\[[\s\S]*\]/);

    const alerts = match ? JSON.parse(match[0]) : [];
    const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

    if (alerts.length === 0) {
      // Nothing overnight — send a short "all quiet" email
      sgMail.setApiKey(SENDGRID_API_KEY);
      await sgMail.send({
        to: ALERT_EMAIL,
        from: FROM_EMAIL,
        subject: `InsideMDSports morning brief — ${date}`,
        html: `<div style="font-family:-apple-system,sans-serif;max-width:500px;margin:0 auto;padding:20px;">
          <div style="background:#cf0315;padding:12px 16px;border-radius:8px 8px 0 0;"><span style="color:white;font-weight:700;">InsideMDSports morning brief — ${date}</span></div>
          <div style="background:white;padding:16px;border-radius:0 0 8px 8px;">
            <p style="color:#555;font-size:14px;">All quiet overnight. No significant Terps news since midnight. Check back for the evening scan.</p>
          </div>
        </div>`
      });
    } else {
      const itemsHTML = alerts.map(a => `
        <div style="padding:10px 0;border-bottom:1px solid #e8e6e1;">
          <div style="font-size:13px;font-weight:600;color:#1a1a1a;">${a.headline}</div>
          ${a.summary ? `<div style="font-size:12px;color:#555;margin-top:3px;">${a.summary}</div>` : ''}
          <div style="font-size:11px;color:#888;margin-top:3px;">${a.source} · ${a.time}</div>
        </div>`).join('');

      sgMail.setApiKey(SENDGRID_API_KEY);
      await sgMail.send({
        to: ALERT_EMAIL,
        from: FROM_EMAIL,
        subject: `☀️ InsideMDSports morning brief — ${alerts.length} overnight stories`,
        html: `<div style="font-family:-apple-system,sans-serif;max-width:500px;margin:0 auto;padding:20px;">
          <div style="background:#cf0315;padding:12px 16px;border-radius:8px 8px 0 0;"><span style="color:white;font-weight:700;">InsideMDSports morning brief — ${date}</span></div>
          <div style="background:white;padding:16px;border-radius:0 0 8px 8px;">
            <p style="font-size:12px;color:#888;margin-bottom:12px;">Here's what happened overnight. ${alerts.length} stories.</p>
            ${itemsHTML}
          </div>
        </div>`
      });
    }

    return res.status(200).json({ success: true, count: alerts.length });
  } catch (error) {
    console.error('Morning brief error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
