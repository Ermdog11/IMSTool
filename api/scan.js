// api/scan.js
// This runs on Vercel's servers every 30 minutes automatically,
// OR when you hit "Scan now" in the dashboard.

import sgMail from '@sendgrid/mail';

const EXCLUDED = ['InsideMDSports', 'Jeff Ermann', 'IMS Radio', 'insidemdsports.com'];

const WATCH = {
  coaches: ['Mike Locksley', 'Buzz Williams', 'Brenda Frese', 'Ted Monachino', 'Clint Trickett', 'Aazaar Abdul-Rahim', 'Jeremy Shapiro', 'Latrell Scott', 'Kyle Schmitt'],
  fb26: ['Zion Elee', 'Darrell Carey', 'Jamarcus Whyce', 'Javonte Williams', 'Jesse Moody', 'Ontario Washington Jr.', 'Chuck Roberts'],
  fb27: ['Myles McAfee', 'Levi Babin', 'Mekhi Graham', 'Davion Vanderbilt'],
  fbTargets: ['Kenaz Sullivan', 'James Pace III', 'Dallas Pauldo', 'Anthony Jennings', 'Cahron Wheeler', 'Emerson Lewis', 'James Branch', 'Kendon Bauer', 'Franklin Richardson'],
  fbRoster: ['Malik Washington', 'Zahir Mathis', 'Sidney Stewart', 'Daniel Wingate', 'Dontay Joyner', 'Jamare Glasker', 'Messiah Delhomme'],
  bk: ['Pharrel Payne', 'Andre Mills', 'DJ Wagner', 'Tomislav Buljan', 'Bishop Boswell', 'Kaden House', 'Austin Brown', 'Adama Tambedou', 'Robert Jennings', 'Baba Oladotun', 'Guillermo del Pino', 'George Turkson', 'Michael McNair', 'Maban Jabriel'],
  bkTargets: ["Amir Jenkins", "J'Lon Lyons", 'Beau Daniels'],
  nfl: ['DJ Moore', 'Stefon Diggs', 'Chig Okonkwo', 'Nick Cross', 'Tai Felton', 'DJ Glaze', 'Deonte Banks', 'Jakorian Bennett', 'Tarheeb Still', 'Aaron Wiggins', 'Derik Queen', 'Kevin Huerter'],
  legends: ['Juan Dixon', 'Greivis Vasquez', 'Len Bias', 'Steve Blake', 'Melo Trimble', 'Anthony Cowan', 'Buck Williams', 'Len Elmore', 'Shawne Merriman', 'Boomer Esiason', 'Gary Williams'],
  admin: ['Jim Smith', 'Darryll Pines', 'Johnny Holliday'],
  reporters: ['Testudo Times', 'TerpRecruiting', 'DBKSports', 'Ahmed Ghafir', 'Nolan Rogalski', 'Matt Germack'],
  podcasts: ['Testudo Talk', 'Locked On Terps', 'Hear The Turtle', 'Under The Shell', 'Protect The Shell']
};

const buildPrompt = () => `You are a news monitor for InsideMDSports on 247Sports, covering University of Maryland Terrapins athletics exclusively for publisher Jeff Ermann. Search for the latest UMD Terrapins news right now.

CRITICAL EXCLUSION: Do NOT include content from InsideMDSports, Jeff Ermann, IMS Radio, or 247sports.com/college/maryland. Exception: include it if another outlet is REACTING to Jeff's reporting.

WATCH THESE PEOPLE — flag any mention:
Coaches: ${WATCH.coaches.join(', ')}
FB commits 2026: ${WATCH.fb26.join(', ')}
FB commits 2027: ${WATCH.fb27.join(', ')}
FB targets: ${WATCH.fbTargets.join(', ')}
FB roster: ${WATCH.fbRoster.join(', ')}
BK roster: ${WATCH.bk.join(', ')}
BK targets: ${WATCH.bkTargets.join(', ')}
NFL/NBA alumni: ${WATCH.nfl.join(', ')}
Legends: ${WATCH.legends.join(', ')}
Admin: ${WATCH.admin.join(', ')}
Reporters: ${WATCH.reporters.join(', ')}

CHECK THESE CHANNELS:
- r/MarylandTerrapins, r/CFB, r/CollegeBasketball
- Testudo Times, Inside the Black and Gold, The Diamondback
- ESPN Maryland, The Athletic Maryland, On3, Rivals, 247Sports MD boards
- Podcasts: ${WATCH.podcasts.join(', ')}
- YouTube: Maryland Terrapins football basketball recruiting
- Transfer portal trackers
- listennotes.com for podcast mentions

KEY PHRASES: "commits to Maryland","decommits from Maryland","Maryland offer","Maryland official visit","Crystal Ball Maryland","Terps transfer portal","Maryland football recruiting","Buzz Williams recruit","Locksley offer"

EXCLUDE (unless major news - NCAA title, national award, pro signing): tennis, track, golf, wrestling, field hockey, softball, baseball, lacrosse, soccer, gymnastics, swimming

RATING (be precise):
5=Breaking: commit, decommit, portal move, coaching hire/fire, major injury to starter
4=High value: named recruit activity, beat reporter scoop, transfer interest, roster move
3=Solid: general team/program news, alumni news, podcast
2=Informational: previews, minor notes, social buzz
1=Low signal: recaps, tangential mentions

Return ONLY a valid JSON array — no markdown, no explanation. Each item:
{headline, summary, category("recruiting"|"football"|"basketball"|"other-sport"|"alumni"|"social"|"podcast"), sport, source, time, rating(1-5)}

Return 10-15 items sorted by rating descending.`;

const buildAlertEmail = (alert) => `
<!DOCTYPE html>
<html>
<head><style>
  body { font-family: -apple-system, sans-serif; background: #f7f6f3; margin: 0; padding: 20px; }
  .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 10px; overflow: hidden; }
  .header { background: #cf0315; padding: 16px 20px; display: flex; align-items: center; gap: 10px; }
  .header-logo { background: white; color: #cf0315; font-weight: 700; font-size: 12px; padding: 4px 8px; border-radius: 4px; }
  .header-title { color: white; font-size: 14px; font-weight: 600; }
  .badge { background: ${alert.rating === 5 ? '#fff0f0' : '#fffae0'}; color: ${alert.rating === 5 ? '#a80210' : '#7a5200'}; font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 20px; display: inline-block; margin-bottom: 10px; }
  .body { padding: 24px; }
  .headline { font-size: 20px; font-weight: 700; color: #1a1a1a; line-height: 1.3; margin-bottom: 12px; }
  .summary { font-size: 14px; color: #555; line-height: 1.6; margin-bottom: 16px; }
  .meta { font-size: 12px; color: #888; border-top: 1px solid #e8e6e1; padding-top: 12px; }
  .footer { background: #1a1a1a; padding: 12px 20px; text-align: center; }
  .footer a { color: #ffd520; font-size: 12px; font-weight: 600; text-decoration: none; }
</style></head>
<body>
  <div class="container">
    <div class="header">
      <span class="header-logo">IMS</span>
      <span class="header-title">InsideMDSports — ${alert.rating === 5 ? '🔴 BREAKING ALERT' : '🟡 HIGH PRIORITY ALERT'}</span>
    </div>
    <div class="body">
      <span class="badge">${alert.rating === 5 ? 'Rating 5 — Breaking' : 'Rating 4 — High priority'} · ${alert.category}</span>
      <div class="headline">${alert.headline}</div>
      <div class="summary">${alert.summary || ''}</div>
      <div class="meta">Source: ${alert.source} · ${alert.time} · Sport: ${alert.sport || alert.category}</div>
    </div>
    <div class="footer">
      <a href="https://247sports.com/college/maryland/">Open InsideMDSports dashboard →</a>
    </div>
  </div>
</body>
</html>`;

export default async function handler(req, res) {
  // Allow both GET (from cron) and POST (from dashboard "Scan now" button)
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
  const ALERT_EMAIL = process.env.ALERT_EMAIL; // your email address
  const FROM_EMAIL = process.env.FROM_EMAIL;   // verified sender email in SendGrid

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in environment variables' });
  }

  try {
    // Step 1: Call Claude with web search to get news
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: buildPrompt() }]
      })
    });

    const claudeData = await claudeRes.json();

    if (claudeData.error) {
      throw new Error(`Claude API error: ${claudeData.error.message}`);
    }

    // Step 2: Extract the JSON from Claude's response
    // Web search responses contain multiple block types - collect all text blocks
    const textBlocks = claudeData.content
      .filter(block => block.type === 'text')
      .map(block => block.text);

    const fullText = textBlocks.join('\n');

    // Try multiple extraction strategies
    let alerts = null;

    // Strategy 1: Look for JSON array in code blocks
    const codeBlockMatch = fullText.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
    if (codeBlockMatch) {
      try { alerts = JSON.parse(codeBlockMatch[1]); } catch(e) {}
    }

    // Strategy 2: Find the largest JSON array in the response
    if (!alerts) {
      const allArrays = [];
      const regex = /\[[\s\S]*?\]/g;
      let match;
      const cleaned = fullText.replace(/```json|```/g, '');
      while ((match = regex.exec(cleaned)) !== null) {
        try {
          const parsed = JSON.parse(match[0]);
          if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].headline) {
            allArrays.push(parsed);
          }
        } catch(e) {}
      }
      if (allArrays.length > 0) {
        alerts = allArrays.sort((a, b) => b.length - a.length)[0];
      }
    }

    // Strategy 3: Find any JSON array at all
    if (!alerts) {
      const lastResort = fullText.replace(/```json|```/g, '').match(/\[[\s\S]*\]/);
      if (lastResort) {
        try { alerts = JSON.parse(lastResort[0]); } catch(e) {}
      }
    }

    if (!alerts || !Array.isArray(alerts)) {
      // Return the raw response for debugging
      throw new Error(`Claude did not return valid JSON. Response preview: ${fullText.substring(0, 200)}`);
    }

    // Step 3: Filter out any excluded sources that slipped through
    alerts = alerts.filter(alert =>
      !EXCLUDED.some(ex => (alert.source || '').toLowerCase().includes(ex.toLowerCase()))
    );

    // Step 4: Send immediate email alerts for rating 5 stories
    if (SENDGRID_API_KEY && ALERT_EMAIL && FROM_EMAIL) {
      sgMail.setApiKey(SENDGRID_API_KEY);

      // Support multiple recipients: "email1@x.com, email2@x.com"
      const recipients = ALERT_EMAIL.split(',').map(e => e.trim()).filter(Boolean);

      const breakingAlerts = alerts.filter(a => a.rating === 5);

      for (const alert of breakingAlerts) {
        await sgMail.send({
          to: recipients,
          from: FROM_EMAIL,
          subject: `🔴 BREAKING: ${alert.headline}`,
          html: buildAlertEmail(alert)
        });
      }
    }

    // Step 5: Return all alerts to the dashboard
    return res.status(200).json({
      success: true,
      count: alerts.length,
      breaking: alerts.filter(a => a.rating === 5).length,
      alerts: alerts,
      scannedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('Scan error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}
