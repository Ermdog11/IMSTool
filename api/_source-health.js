// Source health: the built-in defense against dead and silent feeds, for every
// newsroom (2026-10-03, after Inside The Black And Gold's feed turned out to
// have returned 404 on every scan for months without anyone knowing).
//
// Every scan reports how each source did (HTTP status, items in the feed,
// stories kept). From that history:
//   - DEAD: no successful fetch for 24h+ (404, blocked, timeouts). A direct
//     feed is automatically replaced by a Google News search of its site;
//     Reddit and other unfixable sources are skipped so they stop wasting time.
//   - SILENT: the feed answers but has returned nothing for 14 days.
//   - the first time a source goes dead or silent, one email says what
//     happened and what was done about it.
// GET /api/source-health shows the whole table in Settings.

var KEY = 'source-health.json';
var DEAD_MS = 24 * 3600 * 1000;
var SILENT_MS = 14 * 86400 * 1000;

async function load() {
  try {
    var got = await require('@vercel/blob').get(KEY, { access: 'private', useCache: false });
    if (got && got.statusCode === 200) return await new Response(got.stream).json();
  } catch (e) {}
  return { feeds: {} };
}
async function save(st) {
  try {
    await require('@vercel/blob').put(KEY, JSON.stringify(st), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
  } catch (e) {}
}

function host(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }
function isSearchFeed(url) { return /news\.google\.com|bing\.com\/news/.test(url); }
function isReddit(url) { return /reddit\.com/.test(url); }

function classify(e, now) {
  if (!e) return 'new';
  if (e.healedTo) return e.failingSince && now - e.failingSince >= DEAD_MS ? 'dead' : 'healed';
  if (e.lastOk && now - e.lastOk < DEAD_MS && e.lastItemsAt && now - e.lastItemsAt > SILENT_MS) return 'silent';
  if (e.failingSince && now - e.failingSince >= DEAD_MS) return 'dead';
  if (e.failingSince) return 'failing';
  if (e.lastItemsAt && now - e.lastItemsAt > SILENT_MS) return 'silent';
  return 'ok';
}

// Before a scan: swap out or skip feeds that have been dead for a day.
function heal(feeds, st) {
  var now = Date.now(), out = [];
  feeds.forEach(function (f) {
    var e = (st.feeds || {})[f.name];
    // A replacement sticks once made, so a working substitute doesn't flip
    // back to the dead original on the next scan.
    if (e && e.healedTo && e.url === f.url) return out.push(Object.assign({}, f, { url: e.healedTo, healedFrom: f.url }));
    if (classify(e, now) !== 'dead') return out.push(f);
    if (isReddit(f.url)) return; // blocked from servers; nothing to fall back to
    if (isSearchFeed(f.url)) return out.push(f); // a search query being down is transient; keep trying
    var h = host(f.url);
    if (!h || f.scrapeSlugs) return out.push(f);
    out.push(Object.assign({}, f, {
      url: 'https://news.google.com/rss/search?q=' + encodeURIComponent('site:' + h) + '&hl=en-US&gl=US&ceid=US:en',
      healedFrom: f.url
    }));
  });
  return out;
}

// After a scan: outcomes = [{ name, url, status (number|'FAILED'), items, kept, healedFrom }]
async function record(outcomes) {
  var st = await load(); st.feeds = st.feeds || {};
  var now = Date.now(), newlyBad = [];
  outcomes.forEach(function (o) {
    var e = st.feeds[o.name] || { firstSeen: now };
    var before = e.state || 'new';
    e.url = o.healedFrom || o.url;
    if (o.healedFrom) e.healedTo = o.url;
    e.lastStatus = o.status; e.lastAt = now;
    var ok = typeof o.status === 'number' && o.status >= 200 && o.status < 400;
    if (ok) {
      e.lastOk = now; e.failingSince = null;
      if (o.items > 0) e.lastItemsAt = now;
      if (!e.lastItemsAt) e.lastItemsAt = e.firstSeen; // count silence from when we started watching
      if (o.kept > 0) e.lastStoryAt = now;
    } else if (!e.failingSince) {
      e.failingSince = now;
    }
    var after = classify(e, now);
    // The swap happens on the scan after a feed is found dead, so report it
    // when it's dead (and fixable) or once it's been healed, whichever comes first.
    if ((after === 'dead' || after === 'silent' || after === 'healed') && after !== before && !e.notified) {
      var fixable = !isReddit(e.url) && !isSearchFeed(e.url);
      e.notified = after;
      newlyBad.push({ name: o.name, state: after === 'healed' ? 'dead' : after, url: e.url, status: after === 'healed' ? (e.deadStatus || 'error') : o.status, healed: (after === 'dead' || after === 'healed') && fixable });
    }
    if (!ok) e.deadStatus = o.status;
    if (after === 'ok') e.notified = null;
    e.state = after;
    st.feeds[o.name] = e;
  });
  // Sources skipped this run (dead and unfixable, like Reddit) aren't in
  // `outcomes`, so catch their transition to dead here.
  var reported = {}; outcomes.forEach(function (o) { reported[o.name] = 1; });
  Object.keys(st.feeds).forEach(function (name) {
    if (reported[name]) return;
    var e = st.feeds[name], after = classify(e, now);
    if (after === 'dead' && e.state !== 'dead' && !e.notified && now - (e.lastAt || 0) < 3 * 86400000) {
      e.notified = 'dead'; e.state = 'dead';
      newlyBad.push({ name: name, state: 'dead', url: e.url, status: e.deadStatus || e.lastStatus, healed: false });
    }
  });
  await save(st);
  if (newlyBad.length) await notify(newlyBad);
}

async function notify(list) {
  function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
  var rows = list.map(function (b) {
    var what = b.state === 'dead'
      ? (b.healed ? 'Stopped working (last response: ' + esc(b.status) + '). <b>Fixed automatically:</b> now searching its site through Google News instead.'
        : /reddit/.test(b.url) ? 'Blocked (last response: ' + esc(b.status) + '). Skipped from now on.'
        : 'Stopped working (last response: ' + esc(b.status) + '). Still retrying.')
      : 'Still answering, but has published nothing in 14 days. It may have moved or shut down.';
    return '<li style="margin-bottom:8px"><b>' + esc(b.name) + '</b>: ' + what + '<br><span style="font-size:12px;color:#888">' + esc(b.url) + '</span></li>';
  }).join('');
  try {
    await require('./_mailer').sendMail({
      to: process.env.HEALTH_EMAIL || process.env.ALERT_EMAIL || undefined,
      subject: 'CoPublisher: ' + list.length + ' news source' + (list.length > 1 ? 's need' : ' needs') + ' attention',
      html: '<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:600px"><p>CoPublisher checks every source on each scan. These changed:</p><ul>' + rows +
        '</ul><p style="font-size:12px;color:#888">See every source\'s status in Settings → Source health: https://ims-tool.vercel.app/settings</p></div>'
    });
  } catch (e) { console.error('source-health email failed:', e.message); }
}

async function table() {
  var st = await load(), now = Date.now();
  return Object.keys(st.feeds || {}).filter(function (name) {
    // Sources that are no longer scanned (removed from the beat) drop out after a
    // week; dead ones stay listed so their status is visible.
    var e = st.feeds[name];
    return e.state === 'dead' || now - (e.lastAt || 0) < 7 * 86400000;
  }).map(function (name) {
    var e = st.feeds[name];
    return { name: name, url: e.url, healedTo: e.healedTo || null, state: classify(e, now), lastStatus: e.lastStatus, lastOk: e.lastOk || null, lastStoryAt: e.lastStoryAt || null, failingSince: e.failingSince || null };
  }).sort(function (a, b) {
    var rank = { dead: 0, failing: 1, silent: 2, healed: 3, new: 4, ok: 5 };
    return (rank[a.state] - rank[b.state]) || a.name.localeCompare(b.name);
  });
}

module.exports = { load: load, heal: heal, record: record, table: table, classify: classify };
