// Shared desktop push helper. Browser push subscriptions are stored in Vercel
// Blob (same store roster-check.js uses) as one JSON list — small enough
// (a handful of devices) not to need a real database. Any endpoint that
// detects something worth an immediate desktop alert (breaking news, a
// roster change) calls sendPush() here.
var webpush = require('web-push');
var { get, put } = require('@vercel/blob');

var SUBS_PATH = 'push-subscriptions.json';
var configured = false;

function ensureConfigured() {
  if (configured) return true;
  var pub = process.env.VAPID_PUBLIC_KEY;
  var priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:jeffermann@gmail.com', pub, priv);
  configured = true;
  return true;
}

async function loadSubscriptions() {
  try {
    // get() reads by pathname directly (no list()-then-fetch indirection,
    // which showed read-after-write lag right after a save).
    var result = await get(SUBS_PATH, { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200) return [];
    var data = await new Response(result.stream).json();
    return Array.isArray(data) ? data : [];
  } catch (e) { return []; }
}

async function saveSubscriptions(subs) {
  await put(SUBS_PATH, JSON.stringify(subs), {
    access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json'
  });
}

async function addSubscription(sub) {
  var subs = await loadSubscriptions();
  if (!subs.some(function(s) { return s.endpoint === sub.endpoint; })) {
    subs.push(sub);
    await saveSubscriptions(subs);
  }
  return subs.length;
}

async function removeSubscription(endpoint) {
  var subs = await loadSubscriptions();
  var next = subs.filter(function(s) { return s.endpoint !== endpoint; });
  if (next.length !== subs.length) await saveSubscriptions(next);
}

// Sends to every stored subscription; prunes any that the push service reports
// as gone (410/404 — the browser unsubscribed or uninstalled it).
async function sendPush(payload) {
  if (!ensureConfigured()) return { sent: 0, reason: 'VAPID keys not configured' };
  var subs = await loadSubscriptions();
  if (!subs.length) return { sent: 0, reason: 'no subscriptions' };
  var body = JSON.stringify(payload);
  var dead = [];
  var sent = 0;
  await Promise.all(subs.map(async function(sub) {
    try {
      await webpush.sendNotification(sub, body);
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) dead.push(sub.endpoint);
    }
  }));
  if (dead.length) {
    var remaining = subs.filter(function(s) { return dead.indexOf(s.endpoint) === -1; });
    await saveSubscriptions(remaining);
  }
  return { sent: sent, total: subs.length };
}

module.exports = { addSubscription: addSubscription, removeSubscription: removeSubscription, sendPush: sendPush };
