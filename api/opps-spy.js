// /api/opps-spy — Opps Spy: follow your closest competition.
//
// Competitors are the beat's outlets (setup wizard → Your beat) with
// "Email me when they publish" or "Text me when they publish" checked.
//
//   GET ?run=1   (cron, every 15 min) -> polls each competitor's feed, records
//                new articles, emails the newsroom about the ones from outlets
//                with email alerts on. No Claude calls: just feeds.
//   GET          (News Monitor's Opps Spy tab) -> { competitors:[stats], items:[latest] }
//
// Each article is checked against our own recent headlines (the same
// own-outlet list scan.js keeps in Blob), so the tab can show what a rival
// had that we didn't. Text alerts are saved as a preference; sending them
// needs a texting service (TODO: Twilio), so for now only email goes out.
//
// The first time an outlet is followed its current articles are recorded
// silently, so turning on a competitor never sends a burst of old stories.

var S = require('./_supabase');
var Beat = require('./_beat');

var STATE_KEY = 'opps-spy-state.json';
var KEEP_ITEMS = 400;
var NEW_WINDOW_MS = 36 * 3600 * 1000;
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
var STOP = ('the a an and or of to in on for with at by from as is are was be his her their our your its it this that ' +
  'after before over into up out new how why what who will has have had not but vs about more than first last week season game games news report').split(' ');

function words(t) { return (String(t).toLowerCase().match(/[a-z0-9']+/g) || []).filter(function (w) { return w.length > 2; }); }
function key(o) { return String(o.domain || o.name).toLowerCase(); }
function competitors(beat) { return beat.outlets.filter(function (o) { return !o.blocked && (o.alertEmail || o.alertText || o.spy); }); }

function feedUrl(beat, o) {
  if (o.rss) return o.rss;
  var names = [beat.team.name].concat(beat.team.nicknames).slice(0, 2);
  var q = names.map(function (n) { return 'site:' + o.domain + ' "' + n + '"'; }).join(' OR ');
  return 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=en-US&gl=US&ceid=US:en';
}

function decode(s) {
  return String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/<[^>]+>/g, '').trim();
}

async function fetchItems(beat, o) {
  var c = new AbortController(); var t = setTimeout(function () { c.abort(); }, 9000);
  try {
    var r = await fetch(feedUrl(beat, o), { headers: { 'User-Agent': UA }, signal: c.signal });
    var xml = await r.text();
    var blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
    return blocks.slice(0, 30).map(function (b) {
      var title = decode((b.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1]);
      var link = decode((b.match(/<link>([\s\S]*?)<\/link>/) || [])[1]) || ((b.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '');
      var date = (b.match(/<pubDate>(.*?)<\/pubDate>/) || b.match(/<published>(.*?)<\/published>/) || b.match(/<updated>(.*?)<\/updated>/) || [])[1];
      // Google News appends " - Outlet Name"
      title = title.replace(/\s+[-|–—]\s+[^-|–—]{2,60}$/, '');
      var at = date ? new Date(date).getTime() : Date.now();
      return { outlet: o.name, title: title, url: link, at: isNaN(at) ? Date.now() : at };
    }).filter(function (i) { return i.title && i.url; });
  } catch (e) { return []; } finally { clearTimeout(t); }
}

async function loadJson(name, fallback) {
  try {
    var blob = require('@vercel/blob');
    var got = await blob.get(name, { access: 'private', useCache: false });
    if (got && got.statusCode === 200) return await new Response(got.stream).json();
  } catch (e) {}
  return fallback;
}
async function saveJson(name, data) {
  var blob = require('@vercel/blob');
  await blob.put(name, JSON.stringify(data), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
}

// Did we publish this too? Word overlap against our own recent headlines.
function coveredByUs(title, ownSets) {
  var w = words(title).filter(function (x) { return STOP.indexOf(x) === -1; });
  if (w.length < 3) return false;
  return ownSets.some(function (set) {
    var hits = 0; w.forEach(function (x) { if (set.has(x)) hits++; });
    return hits / w.length >= 0.5;
  });
}

async function run(beat) {
  var comps = competitors(beat);
  var state = await loadJson(STATE_KEY, { outlets: {}, seen: {}, items: [] });
  state.outlets = state.outlets || {}; state.seen = state.seen || {}; state.items = state.items || [];
  if (!comps.length) return { competitors: 0, fresh: 0 };

  var ownWords = await loadJson('own-outlet-blocklist.json', []);
  var ownSets = (ownWords || []).map(function (w) { return new Set(w); });

  var results = await Promise.all(comps.map(function (o) { return fetchItems(beat, o); }));
  var fresh = [];
  comps.forEach(function (o, i) {
    var k = key(o), firstTime = !state.outlets[k];
    results[i].forEach(function (it) {
      var id = it.url.split('?')[0] + '|' + it.title.toLowerCase();
      if (state.seen[id]) return;
      state.seen[id] = Date.now();
      it.covered = coveredByUs(it.title, ownSets);
      state.items.push(it);
      if (!firstTime && Date.now() - it.at < NEW_WINDOW_MS) fresh.push({ item: it, outlet: o });
    });
    state.outlets[k] = { name: o.name, since: (state.outlets[k] && state.outlets[k].since) || Date.now() };
  });

  // Prune: keep the newest items, forget "seen" ids older than 14 days.
  state.items.sort(function (a, b) { return b.at - a.at; });
  state.items = state.items.slice(0, KEEP_ITEMS);
  var cutoff = Date.now() - 14 * 86400000;
  Object.keys(state.seen).forEach(function (id) { if (state.seen[id] < cutoff) delete state.seen[id]; });
  await saveJson(STATE_KEY, state);

  var toEmail = fresh.filter(function (f) { return f.outlet.alertEmail; });
  if (toEmail.length) {
    var esc = function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); };
    var subject = toEmail.length === 1
      ? 'Opps Spy: ' + toEmail[0].outlet.name + ' just published "' + toEmail[0].item.title.slice(0, 90) + '"'
      : 'Opps Spy: ' + toEmail.length + ' new stories from your competition';
    var html = '<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:620px">' +
      '<p style="color:#555;font-size:13px">From your CoPublisher AI Opps Spy, which follows the outlets you picked in setup.</p>' +
      toEmail.map(function (f) {
        return '<div style="border-top:1px solid #eee;padding:10px 0"><div style="font-size:12px;color:#888">' + esc(f.outlet.name) +
          (f.item.covered ? ' · <span style="color:#3B6D11">we covered this</span>' : ' · <b style="color:#cf0315">we haven\'t covered this</b>') + '</div>' +
          '<a href="' + esc(f.item.url) + '" style="font-size:15px;font-weight:600;color:#111;text-decoration:none">' + esc(f.item.title) + '</a></div>';
      }).join('') +
      '<p style="font-size:12px;color:#888;margin-top:14px">See everything on the Opps Spy tab: https://ims-tool.vercel.app/opps</p></div>';
    try { await require('./_mailer').sendMail({ subject: subject, html: html }); } catch (e) { console.error('Opps Spy email failed:', e.message); }
  }
  return { competitors: comps.length, fresh: fresh.length, emailed: toEmail.length };
}

function stats(beat, state) {
  var now = Date.now();
  return competitors(beat).map(function (o) {
    var mine = state.items.filter(function (i) { return i.outlet === o.name; });
    var week = mine.filter(function (i) { return now - i.at < 7 * 86400000; });
    var freq = {};
    var skip = STOP.concat(words(beat.team.name), words(beat.team.short), beat.team.nicknames.map(function (n) { return n.toLowerCase(); }));
    week.forEach(function (i) { words(i.title).forEach(function (w) { if (skip.indexOf(w) === -1 && !/^\d+$/.test(w)) freq[w] = (freq[w] || 0) + 1; }); });
    return {
      name: o.name, domain: o.domain || '', alertEmail: !!o.alertEmail, alertText: !!o.alertText,
      last24: mine.filter(function (i) { return now - i.at < 86400000; }).length,
      last7: week.length,
      gaps7: week.filter(function (i) { return !i.covered; }).length,
      lastAt: mine.length ? mine[0].at : null,
      topics: Object.keys(freq).filter(function (w) { return freq[w] > 1; }).sort(function (a, b) { return freq[b] - freq[a]; }).slice(0, 6),
      following: !!(state.outlets || {})[key(o)]
    };
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    var sb = S.isConfigured() ? S.admin() : null;
    if (req.query && req.query.run) {
      var beat = await Beat.getBeat(sb);
      return res.status(200).json(await run(beat));
    }
    if (S.isConfigured()) {
      try { await S.requireUser(req); } catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
    }
    var beat2 = await Beat.getBeat(sb);
    var state = await loadJson(STATE_KEY, { outlets: {}, items: [] });
    state.items = state.items || [];
    var names = competitors(beat2).map(function (o) { return o.name; });
    return res.status(200).json({
      competitors: stats(beat2, state),
      items: state.items.filter(function (i) { return names.indexOf(i.outlet) !== -1; }).slice(0, 120)
    });
  } catch (e) {
    console.error('Opps Spy error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
