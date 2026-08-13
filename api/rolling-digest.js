const sgMail = require('@sendgrid/mail');

// Which slot -> how many hours back to look (gap since the previous send in the 8am/12pm/7pm ET schedule)
var WINDOW_HOURS = {
  morning: 13,  // since last night's 7pm send
  midday: 4,    // since this morning's 8am send
  evening: 7    // since today's noon send
};

var SLOT_LABEL = {
  morning: 'morning',
  midday: 'midday',
  evening: 'evening'
};

function buildEmailHTML(alerts, date, slot) {
  var groups = {
    'Recruiting': alerts.filter(function(a) { return a.category === 'recruiting'; }),
    'Football': alerts.filter(function(a) { return a.sport === 'football' && a.category !== 'recruiting'; }),
    'Basketball': alerts.filter(function(a) { return ['basketball', 'mens-basketball', 'womens-basketball'].indexOf(a.sport || '') !== -1 && a.category !== 'recruiting'; }),
    'Other sports': alerts.filter(function(a) { return ['football', 'basketball', 'mens-basketball', 'womens-basketball'].indexOf(a.sport || '') === -1 && ['recruiting', 'alumni', 'social', 'podcast'].indexOf(a.category) === -1; }),
    'Alumni': alerts.filter(function(a) { return a.category === 'alumni'; }),
    'Social & podcasts': alerts.filter(function(a) { return ['social', 'podcast'].indexOf(a.category) !== -1; })
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

  var bodyMsg = alerts.length
    ? '<p style="font-size:13px;color:#555;margin-bottom:20px;">' + alerts.length + ' new ' + (alerts.length === 1 ? 'story' : 'stories') + ' since the last update.</p>' + sectionsHTML
    : '<p style="font-size:13px;color:#555;margin-bottom:20px;">No new Terps stories since the last update.</p>';

  return '<!DOCTYPE html><html><head></head><body style="font-family:-apple-system,sans-serif;background:#f7f6f3;margin:0;padding:20px;">' +
    '<div style="max-width:600px;margin:0 auto;background:white;border-radius:10px;overflow:hidden;">' +
    '<div style="background:#cf0315;padding:16px 20px;">' +
    '<div style="color:white;font-size:16px;font-weight:700;">InsideMDSports</div>' +
    '<div style="color:rgba(255,255,255,0.8);font-size:12px;">' + SLOT_LABEL[slot] + ' update &mdash; ' + date + '</div>' +
    '</div>' +
    '<div style="padding:20px 24px;">' +
    bodyMsg +
    '</div>' +
    '<div style="background:#1a1a1a;padding:12px 20px;text-align:center;">' +
    '<a href="https://247sports.com/college/maryland/" style="color:#ffd520;font-size:12px;font-weight:600;text-decoration:none;">Open InsideMDSports &rarr;</a>' +
    '</div></div></body></html>';
}

module.exports = async function handler(req, res) {
  var ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  var SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
  var ALERT_EMAIL = process.env.ALERT_EMAIL;
  var FROM_EMAIL = process.env.FROM_EMAIL;

  if (!ANTHROPIC_API_KEY || !SENDGRID_API_KEY || !ALERT_EMAIL || !FROM_EMAIL) {
    return res.status(500).json({ error: 'Missing environment variables.' });
  }

  var slot = (req.query && req.query.slot) || 'morning';
  var windowHours = WINDOW_HOURS[slot] || 8;

  try {
    var scanHandler = require('./scan.js');
    var scanResult = await new Promise(function(resolve, reject) {
      var fakeRes = {
        status: function() { return this; },
        json: function(d) { resolve(d); return this; }
      };
      scanHandler({ body: {} }, fakeRes).catch(reject);
    });

    if (scanResult.error) throw new Error('Scan failed: ' + scanResult.error);
    var text = (scanResult.content || []).map(function(b) { return b.type === 'text' ? b.text : ''; }).join('\n');
    var match = text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON from scan');

    var allAlerts = JSON.parse(match[0]).filter(function(a) { return !a.republished; });

    // Only stories newer than this slot's window (rolling, since the previous send)
    var alerts = allAlerts.filter(function(a) {
      var hoursMatch = (a.time || '').match(/\d+/);
      var hours = hoursMatch ? parseInt(hoursMatch[0], 10) : 99;
      return hours <= windowHours;
    });

    var date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    var recipients = ALERT_EMAIL.split(',').map(function(e) { return e.trim(); }).filter(Boolean);

    sgMail.setApiKey(SENDGRID_API_KEY);
    await sgMail.send({
      to: recipients,
      from: FROM_EMAIL,
      subject: alerts.length
        ? 'InsideMDSports ' + SLOT_LABEL[slot] + ' update — ' + alerts.length + ' new ' + (alerts.length === 1 ? 'story' : 'stories')
        : 'InsideMDSports ' + SLOT_LABEL[slot] + ' update — nothing new',
      html: buildEmailHTML(alerts, date, slot)
    });

    return res.status(200).json({ success: true, slot: slot, count: alerts.length, date: date });
  } catch (error) {
    console.error('Rolling digest error (' + slot + '):', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};