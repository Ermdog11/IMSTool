const mailer = require('./_mailer.js');

// Which slot -> how many hours back to look (gap since the previous send in the 8am/12pm/5pm ET schedule, plus buffer)
var WINDOW_HOURS = {
  morning: 16,  // since last night's 5pm send
  midday: 5,    // since this morning's 8am send
  evening: 6    // since today's noon send
};

var SLOT_LABEL = {
  morning: 'morning',
  midday: 'midday',
  evening: 'evening'
};

// Cap each digest at this many of the most recent items
var MAX_ITEMS = 20;

// Sport sub-group order within each day
var GROUP_ORDER = ['Recruiting', 'Football', 'Basketball', 'Other sports', 'Alumni', 'Social & podcasts'];

// Parse a relative "time" string ("2h ago", "3 days ago", "just now") into hours-ago
function hoursAgo(t) {
  t = (t || '').toLowerCase();
  var m = t.match(/(\d+)/);
  var n = m ? parseInt(m[1], 10) : 0;
  if (/month/.test(t)) return n * 720;
  if (/week/.test(t)) return n * 168;
  if (/day/.test(t)) return n * 24;
  if (/(min|just now|moment)/.test(t)) return 0;
  return n; // hours
}

// Calendar-day label for an item, derived from its relative time
function dayKey(t) {
  var d = new Date(Date.now() - hoursAgo(t) * 3600000);
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

// Which sport sub-group an item belongs to (single group, no duplicates)
function groupOf(a) {
  if (a.category === 'recruiting') return 'Recruiting';
  if (a.category === 'alumni') return 'Alumni';
  if (['social', 'podcast'].indexOf(a.category) !== -1) return 'Social & podcasts';
  if (a.sport === 'football') return 'Football';
  if (['basketball', 'mens-basketball', 'womens-basketball'].indexOf(a.sport || '') !== -1) return 'Basketball';
  return 'Other sports';
}

function ratingStars(r) {
  r = r || 0;
  var s = '';
  for (var i = 0; i < 5; i++) s += (i < r) ? '★' : '☆';
  return s;
}

function itemHTML(item, overflowByTopic) {
  var headline = item.url
    ? '<a href="' + item.url + '" style="color:#1a1a1a;text-decoration:none;">' + item.headline + '</a>'
    : item.headline;
  var html = '<div style="padding:10px 0;border-bottom:1px solid #e8e6e1;">';
  html += '<div style="font-size:14px;font-weight:600;color:#1a1a1a;margin-bottom:4px;">' + headline + '</div>';
  if (item.summary) html += '<div style="font-size:12px;color:#555;line-height:1.5;">' + item.summary + '</div>';
  html += '<div style="font-size:11px;color:#888;margin-top:4px;">' +
    '<span style="color:#e0a800;letter-spacing:1px;">' + ratingStars(item.rating) + '</span> &middot; ' +
    item.source + ' &middot; ' + item.time + '</div>';

  // "More on this" — extra stories about the same person/topic that were held out of the feed
  var extras = (item.trendingTopic && overflowByTopic && overflowByTopic[item.trendingTopic]) || [];
  if (extras.length) {
    html += '<div style="font-size:11px;color:#888;margin-top:5px;">More on ' + item.trendingTopic + ': ' +
      extras.slice(0, 5).map(function(x) {
        return x.url
          ? '<a href="' + x.url + '" style="color:#888;text-decoration:underline;">' + x.title + '</a>'
          : x.title;
      }).join(' &nbsp;&middot;&nbsp; ') +
      '</div>';
  }

  html += '</div>';
  return html;
}

function buildEmailHTML(alerts, date, slot, overflowByTopic) {
  // Group by calendar day
  var days = {};
  alerts.forEach(function(a) {
    var k = dayKey(a.time);
    if (!days[k]) days[k] = { hrs: 0, items: [] };
    days[k].items.push(a);
    if (hoursAgo(a.time) > days[k].hrs) days[k].hrs = hoursAgo(a.time);
  });
  // Days in chronological order (oldest first)
  var dayKeys = Object.keys(days).sort(function(x, y) { return days[y].hrs - days[x].hrs; });

  var body = '';
  dayKeys.forEach(function(dk) {
    var dayItems = days[dk].items;
    var daySections = '';
    GROUP_ORDER.forEach(function(title) {
      var items = dayItems.filter(function(a) { return groupOf(a) === title; });
      if (!items.length) return;
      // Highest-rated first, then most recent
      items.sort(function(a, b) {
        return (b.rating || 0) - (a.rating || 0) || hoursAgo(a.time) - hoursAgo(b.time);
      });
      daySections += '<div style="margin-bottom:18px;">';
      daySections += '<div style="font-size:12px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;border-bottom:2px solid #cf0315;padding-bottom:5px;">' + title + '</div>';
      items.forEach(function(item) { daySections += itemHTML(item, overflowByTopic); });
      daySections += '</div>';
    });
    body += '<div style="margin-bottom:26px;">';
    body += '<div style="font-size:15px;font-weight:800;color:#1a1a1a;margin-bottom:12px;">' + dk + '</div>';
    body += daySections;
    body += '</div>';
  });

  var bodyMsg = alerts.length
    ? '<p style="font-size:13px;color:#555;margin-bottom:20px;">' + alerts.length + ' new ' + (alerts.length === 1 ? 'story' : 'stories') + ' since the last update.</p>' + body
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

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY.' });
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
      scanHandler({ body: { deep: true } }, fakeRes).catch(reject);
    });

    if (scanResult.error) throw new Error('Scan failed: ' + scanResult.error);
    var text = (scanResult.content || []).map(function(b) { return b.type === 'text' ? b.text : ''; }).join('\n');
    var match = text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON from scan');

    var allAlerts = JSON.parse(match[0]).filter(function(a) { return !a.republished; });

    // Only stories newer than this slot's window (rolling, since the previous send)
    var alerts = allAlerts.filter(function(a) { return hoursAgo(a.time) <= windowHours; });

    // Cap at the most recent MAX_ITEMS
    alerts.sort(function(a, b) { return hoursAgo(a.time) - hoursAgo(b.time); });
    alerts = alerts.slice(0, MAX_ITEMS);

    // Held-out "More on this" stories (same person/topic), grouped by topic
    var overflowByTopic = {};
    (scanResult.overflow || []).forEach(function(s) {
      if (!s.trendingTopic || (s.age || 0) > windowHours) return;
      (overflowByTopic[s.trendingTopic] = overflowByTopic[s.trendingTopic] || []).push(s);
    });

    var date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

    var mailResult = await mailer.sendMail({
      subject: alerts.length
        ? 'InsideMDSports ' + SLOT_LABEL[slot] + ' update — ' + alerts.length + ' new ' + (alerts.length === 1 ? 'story' : 'stories')
        : 'InsideMDSports ' + SLOT_LABEL[slot] + ' update — nothing new',
      html: buildEmailHTML(alerts, date, slot, overflowByTopic)
    });

    return res.status(200).json({ success: true, slot: slot, count: alerts.length, date: date, mail: mailResult });
  } catch (error) {
    console.error('Rolling digest error (' + slot + '):', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};
