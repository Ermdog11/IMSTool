// Alerts that came during someone's off hours, saved for their next update
// email (Jeff, 2026-10-07, whiteboard item 9: missed alerts during off hours
// go into the morning digest). _mailer.sendMail holds an alert for each
// person whose ⏰ days/hours for it are closed right now (not for anyone who
// switched it off); rolling-digest.js puts them in a "While you were off"
// box at the top of that person's next update and clears them.
//
// Blob held-alerts.json: { email: [{ type, subject, link, at }] }, newest
// 30 per person, nothing older than 48 hours. Best-effort: a failed read or
// write never blocks an email.
var { get, put } = require('./_site-blob');
var PATH = 'held-alerts.json';
var MAX = 30, MAX_AGE = 48 * 3600000;
// The digests themselves aren't held: the next one covers the same news.
var NOT_HELD = ['digest_rolling', 'digest_nightly'];

async function load() {
  try {
    var r = await get(PATH, { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200) return {};
    return (await new Response(r.stream).json()) || {};
  } catch (e) { return {}; }
}
async function save(all) {
  await put(PATH, JSON.stringify(all), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
}
function fresh(list, now) { return (list || []).filter(function (x) { return now - Date.parse(x.at) < MAX_AGE; }); }

// Hold one alert email for these people.
async function add(emails, type, opts) {
  if (!emails || !emails.length || NOT_HELD.indexOf(type) !== -1) return;
  try {
    var all = await load(), now = Date.now();
    var m = /href="(https?:\/\/[^"]+)"/i.exec(String(opts.html || ''));
    var item = { type: type, subject: String(opts.subject || '').slice(0, 200), link: m ? m[1] : '', at: new Date(now).toISOString() };
    emails.forEach(function (e) {
      var k = String(e).toLowerCase();
      all[k] = fresh(all[k], now).concat([item]).slice(-MAX);
    });
    await save(all);
  } catch (e) { console.error('held-alerts: save failed:', e.message); }
}

// { email: [items] } for these people (nothing removed).
async function peek(emails) {
  var all = await load(), now = Date.now(), out = {};
  (emails || []).forEach(function (e) { var k = String(e).toLowerCase(), l = fresh(all[k], now); if (l.length) out[k] = l; });
  return out;
}

// Remove what was shown to this person (items saved up to `upTo`).
async function clear(email, upTo) {
  try {
    var all = await load(), k = String(email).toLowerCase();
    if (!all[k]) return;
    all[k] = fresh(all[k], Date.now()).filter(function (x) { return x.at > upTo; });
    if (!all[k].length) delete all[k];
    await save(all);
  } catch (e) { console.error('held-alerts: clear failed:', e.message); }
}

function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function html(list, tz) {
  if (!list || !list.length) return '';
  return '<div style="margin-bottom:20px;border:1px solid #c7d2fe;background:#eef2ff;border-radius:8px;padding:12px 14px;">' +
    '<div style="font-size:12px;font-weight:700;color:#3730a3;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;">🌙 While you were off (' + list.length + ')</div>' +
    list.map(function (x) {
      var when = new Date(x.at).toLocaleString('en-US', { timeZone: tz || 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' });
      return '<div style="font-size:13px;padding:4px 0;border-top:1px solid #dbe1fb;">' +
        (x.link ? '<a href="' + esc(x.link) + '" style="color:#1a1a1a;">' + esc(x.subject) + '</a>' : esc(x.subject)) +
        ' <span style="color:#888;font-size:11px;">' + esc(when) + '</span></div>';
    }).join('') +
    '<div style="font-size:11px;color:#666;margin-top:6px;">These came outside the days and hours you picked for them. Change that on <a href="https://ims-tool.vercel.app/preferences#alerts" style="color:#3730a3;">Permissions &amp; preferences</a>.</div></div>';
}

module.exports = { add: add, peek: peek, clear: clear, html: html, NOT_HELD: NOT_HELD };
