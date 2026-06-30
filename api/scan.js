bash

cat /home/claude/insidemdsports/api/scan.js
Output

// api/scan.js
const sgMail = require('@sendgrid/mail');

const EXCLUDED = ['InsideMDSports', 'Jeff Ermann', 'IMS Radio', 'insidemdsports.com'];

const WATCH = {
  coaches: ['Mike Locksley', 'Buzz Williams', 'Brenda Frese', 'Ted Monachino', 'Clint Trickett', 'Aazaar Abdul-Rahim', 'Jeremy Shapiro', 'Latrell Scott', 'Kyle Schmitt'],
  fb26: ['Zion Elee', 'Darrell Carey', 'Jamarcus Whyce', 'Javonte Williams', 'Jesse Moody', 'Ontario Washington Jr.', 'Chuck Roberts'],
  fb27: ['Myles McAfee', 'Levi Babin', 'Mekhi Graham', 'Davion Vanderbilt'],
  fbTargets: ['Kenaz Sullivan', 'James Pace III', 'Dallas Pauldo', 'Anthony Jennings', 'Cahron Wheeler', 'Emerson Lewis', 'James Branch', 'Kendon Bauer', 'Franklin Richardson'],
  fbRoster: ['Malik Washington', 'Zahir Mathis', 'Sidney Stewart', 'Daniel Wingate', 'Dontay Joyner', 'Jamare Glasker', 'Messiah Delhomme'],
  bk: ['Pharrel Payne', 'Andre Mills', 'DJ Wagner', 'Tomislav Buljan', 'Bishop Boswell', 'Kaden House', 'Austin Brown', 'Adama Tambedou', 'Robert Jennings', 'Baba Oladotun', 'Guillermo del Pino', 'George Turkson', 'Michael McNair', 'Maban Jabriel'],
  bkTargets: ['Amir Jenkins', 'J\'Lon Lyons', 'Beau Daniels'],
  nfl: ['DJ Moore', 'Stefon Diggs', 'Chig Okonkwo', 'Nick Cross', 'Tai Felton', 'DJ Glaze', 'Deonte Banks', 'Jakorian Bennett', 'Tarheeb Still', 'Aaron Wiggins', 'Derik Queen', 'Kevin Huerter'],
  legends: ['Juan Dixon', 'Greivis Vasquez', 'Len Bias', 'Steve Blake', 'Melo Trimble', 'Anthony Cowan', 'Buck Williams', 'Len Elmore', 'Shawne Merriman', 'Boomer Esiason', 'Gary Williams'],
  admin: ['Jim Smith', 'Darryll Pines', 'Johnny Holliday'],
  reporters: ['Testudo Times', 'TerpRecruiting', 'DBKSports', 'Ahmed Ghafir', 'Nolan Rogalski', 'Matt Germack'],
  podcasts: ['Testudo Talk', 'Locked On Terps', 'Hear The Turtle', 'Under The Shell', 'Protect The Shell']
};

function buildAlertEmail(alert) {
  var color = alert.rating === 5 ? '#cf0315' : '#7a5200';
  var label = alert.rating === 5 ? 'BREAKING ALERT' : 'HIGH PRIORITY';
  return '<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;">' +
    '<div style="background:#cf0315;padding:16px 20px;">' +
    '<span style="color:white;font-weight:700;font-size:16px;">InsideMDSports — ' + label + '</span>' +
    '</div>' +
    '<div style="background:white;padding:24px;">' +
    '<div style="font-size:20px;font-weight:700;color:#1a1a1a;margin-bottom:12px;">' + alert.headline + '</div>' +
    '<div style="font-size:14px;color:#555;line-height:1.6;margin-bottom:16px;">' + (alert.summary || '') + '</div>' +
    '<div style="font-size:12px;color:#888;">Source: ' + alert.source + ' · ' + alert.time + '</div>' +
    '</div>' +
    '<div style="background:#1a1a1a;padding:12px 20px;text-align:center;">' +
    '<a href="https://ims-tool.vercel.app" style="color:#ffd520;font-size:12px;font-weight:600;text-decoration:none;">Open dashboard</a>' +
    '</div>' +
    '</div>';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  var SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
  var ALERT_EMAIL = process.env.ALERT_EMAIL;
  var FROM_EMAIL = process.env.FROM_EMAIL;

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  }

  try {
    // STEP 1: Search for news
    var searchRes = await fetch('https://api.anthropic.com/v1/messages', {
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
        messages: [{
          role: 'user',
          content: 'Search for the latest University of Maryland Terrapins athletics news from the past 24 hours. Focus on football and basketball recruiting, transfer portal, and team news. Watch for: Mike Locksley, Buzz Williams, Myles McAfee, Kenaz Sullivan, Pharrel Payne, Baba Oladotun, DJ Wagner, Andre Mills, DJ Moore, Stefon Diggs. Check r/MarylandTerrapins, Testudo Times, ESPN Maryland, 247Sports MD. Exclude InsideMDSports and Jeff Ermann content. Collect 10-15 stories and describe each one: what happened, who was involved, what source, and when.'
        }]
      })
    });

    var searchData = await searchRes.json();
    if (searchData.error) throw new Error('Search error: ' + searchData.error.message);

    var searchSummary = searchData.content
      .filter(function(b) { return b.type === 'text'; })
      .map(function(b) { return b.text; })
      .join('\n');

    // STEP 2: Convert to JSON
    var jsonRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: 'Convert these Maryland Terrapins news stories into a JSON array.\n\nStories:\n' + searchSummary + '\n\nOutput a JSON array where each item has: headline (string), summary (string), category (one of: recruiting/football/basketball/other-sport/alumni/social/podcast), sport (string), source (string), time (string), rating (number 1-5 where 5=breaking commit or decommit, 4=recruit visit or roster move, 3=team news, 2=minor notes, 1=low signal).\n\nOutput ONLY the raw JSON array. Start with [ and end with ]. No other text.'
        }]
      })
    });

    var jsonData = await jsonRes.json();
    if (jsonData.error) throw new Error('JSON error: ' + jsonData.error.message);

    var jsonText = jsonData.content
      .filter(function(b) { return b.type === 'text'; })
      .map(function(b) { return b.text; })
      .join('');

    // Parse JSON - try multiple approaches
    var alerts;
    var cleaned = jsonText.replace(/```json/g, '').replace(/```/g, '').trim();
    
    // Find the JSON array
    var start = cleaned.indexOf('[');
    var end = cleaned.lastIndexOf(']');
    if (start !== -1 && end !== -1) {
      try {
        alerts = JSON.parse(cleaned.substring(start, end + 1));
      } catch(e) {
        throw new Error('Parse failed: ' + cleaned.substring(0, 100));
      }
    } else {
      throw new Error('No JSON array found: ' + cleaned.substring(0, 100));
    }

    // Filter excluded sources
    alerts = alerts.filter(function(a) {
      return !EXCLUDED.some(function(ex) {
        return (a.source || '').toLowerCase().indexOf(ex.toLowerCase()) !== -1;
      });
    });

    // Send emails for rating 5
    if (SENDGRID_API_KEY && ALERT_EMAIL && FROM_EMAIL) {
      sgMail.setApiKey(SENDGRID_API_KEY);
      var recipients = ALERT_EMAIL.split(',').map(function(e) { return e.trim(); }).filter(Boolean);
      var breaking = alerts.filter(function(a) { return a.rating === 5; });
      for (var i = 0; i < breaking.length; i++) {
        await sgMail.send({
          to: recipients,
          from: FROM_EMAIL,
          subject: 'BREAKING: ' + breaking[i].headline,
          html: buildAlertEmail(breaking[i])
        });
      }
    }

    return res.status(200).json({
      success: true,
      count: alerts.length,
      breaking: alerts.filter(function(a) { return a.rating === 5; }).length,
      alerts: alerts,
      scannedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('Scan error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};
