// /api/opps-spy — Opp Watch: follow your closest competition.
//
// Competitors are the beat's outlets marked followed (spy), or with "Email me
// when they publish" or "Text me" checked: set in the Opp Watch tab itself or
// in the setup wizard → Your beat.
//
//   GET ?run=1   (cron, every 15 min) -> polls each competitor's feed, records
//                new articles, emails the newsroom about the ones from outlets
//                with email alerts on. No Claude calls: just feeds.
//   GET          (News Monitor's Opp Watch tab) -> { competitors:[stats], items:[latest], available:[{name,domain}] }
//   POST         (Opp Watch tab, manage who you follow without the setup wizard;
//                Jeff, 2026-10-06: "editing Opp Watch and adding opps shouldn't
//                require a trip to the setup wizard"):
//                { action:'follow', name, site, alertEmail?, alertText? }  (site: website or RSS URL)
//                { action:'set', domain, alertEmail?, alertText?, eyes? }  (eyes: 1-5, how closely to watch them)
//                { action:'unfollow', domain }
//                { action:'lookup', name }  -> { name, site, x }: fills in a competitor's
//                website and X handle from the name (Jeff, 2026-10-06: "follow a
//                competition should be a box where twitter names autofill"). The
//                beat's own outlets list first; otherwise one web search.
//                follow also takes x (their X handle): saved on the outlet and
//                added to the watched X accounts, so their posts are checked too.
//                Saved into the beat profile's outlets, the same list the wizard edits.
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
  var q = names.map(function (n) { return 'site:' + (o.section || o.domain) + ' "' + n + '"'; }).join(' OR ');
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
    var blob = require('./_site-blob');
    var got = await blob.get(name, { access: 'private', useCache: false });
    if (got && got.statusCode === 200) return await new Response(got.stream).json();
  } catch (e) {}
  return fallback;
}
async function saveJson(name, data) {
  var blob = require('./_site-blob');
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
      ? 'Opp Watch: ' + toEmail[0].outlet.name + ' just published "' + toEmail[0].item.title.slice(0, 90) + '"'
      : 'Opp Watch: ' + toEmail.length + ' new stories from your competition';
    var html = '<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:620px">' +
      '<p style="color:#555;font-size:13px">From your CoPublisher AI Opp Watch, which follows the outlets you picked in setup.</p>' +
      toEmail.map(function (f) {
        return '<div style="border-top:1px solid #eee;padding:10px 0"><div style="font-size:12px;color:#888">' + esc(f.outlet.name) +
          (f.item.covered ? ' · <span style="color:#3B6D11">we covered this</span>' : ' · <b style="color:#cf0315">we haven\'t covered this</b>') + '</div>' +
          '<a href="' + esc(f.item.url) + '" style="font-size:15px;font-weight:600;color:#111;text-decoration:none">' + esc(f.item.title) + '</a></div>';
      }).join('') +
      '<p style="font-size:12px;color:#888;margin-top:14px">See everything on the Opp Watch tab: https://ims-tool.vercel.app/opps</p></div>';
    try { await require('./_mailer').sendMail({ subject: subject, html: html }); } catch (e) { console.error('Opp Watch email failed:', e.message); }
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
      name: o.name, domain: o.domain || '', key: key(o), x: o.x || '', eyes: Number(o.eyes) || 3, alertEmail: !!o.alertEmail, alertText: !!o.alertText,
      last24: mine.filter(function (i) { return now - i.at < 86400000; }).length,
      last7: week.length,
      gaps7: week.filter(function (i) { return !i.covered; }).length,
      lastAt: mine.length ? mine[0].at : null,
      topics: Object.keys(freq).filter(function (w) { return freq[w] > 1; }).sort(function (a, b) { return freq[b] - freq[a]; }).slice(0, 6),
      following: !!(state.outlets || {})[key(o)]
    };
  });
}

// Website or feed URL -> { domain, rss? }.
function parseSite(site) {
  var raw = String(site || '').trim();
  if (!raw) return null;
  var url;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw); } catch (e) { return null; }
  var domain = url.hostname.replace(/^www\./, '').toLowerCase();
  if (!/\./.test(domain)) return null;
  var isFeed = /(rss|feed|atom|\.xml)/i.test(url.pathname + url.search);
  // A section of a big site (247sports.com/college/maryland) narrows the
  // search to that section, so the rest of the site isn't followed too.
  var path = url.pathname.replace(/\/+$/, '');
  return { domain: domain, rss: isFeed ? url.href : null, section: !isFeed && path.length > 1 ? domain + path : null };
}

// Writes the edited outlets list into the saved beat profile. The saved beat
// only takes effect with a team name, so a newsroom still on its seed gets
// the seed's team copied in alongside (same values).
async function saveOutlets(sb, beat, outlets) {
  var Store = require('./_settings-store');
  var profile = await Store.getProfile(sb);
  var saved = Object.assign({}, profile.beat || {});
  if (!saved.team || !saved.team.name) saved.team = { name: beat.team.name, short: beat.team.short, school: beat.team.school, nicknames: beat.team.nicknames, level: beat.team.level };
  saved.outlets = outlets.map(function (o) {
    var c = {}; Object.keys(o).forEach(function (k) { if (o[k] !== undefined && o[k] !== null && o[k] !== '') c[k] = o[k]; }); return c;
  });
  await Store.saveProfile(sb, { beat: saved });
}

function cleanHandle(h) { var m = /^@?([A-Za-z0-9_]{1,15})$/.exec(String(h || '').trim().replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '').replace(/[/?].*$/, '')); return m ? m[1] : ''; }

// A competitor's website and X handle from its name: the beat's outlets
// first (no cost), then one Claude web search.
var LOOKUP_TOOL = {
  name: 'report_outlet',
  description: 'The outlet found.',
  input_schema: { type: 'object', properties: {
    name: { type: 'string', description: 'The outlet\'s proper name' },
    site: { type: 'string', description: 'The URL of its coverage of this team: the team section of a big site (e.g. on3.com/teams/maryland-terrapins), else its homepage. Empty if not found.' },
    x_handle: { type: 'string', description: 'Its X/Twitter handle without @, the one that covers this team (a team-specific account over a national one). Empty if not found.' }
  }, required: ['name', 'site', 'x_handle'] }
};
async function lookupOutlet(beat, name) {
  var n = String(name || '').trim().toLowerCase();
  if (n.length < 2) return null;
  var local = beat.outlets.filter(function (o) { return String(o.name || '').toLowerCase() === n; })[0] ||
    beat.outlets.filter(function (o) { return String(o.name || '').toLowerCase().indexOf(n) === 0; })[0];
  if (local && local.domain && local.x) return { name: local.name, site: local.section || local.domain, x: local.x, from: 'beat' };
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) return local ? { name: local.name, site: local.section || local.domain, x: local.x || '', from: 'beat' } : null;
  var team = beat.team.school || beat.team.name;
  var messages = [{ role: 'user', content: 'A sports newsroom covering ' + team + ' wants to follow a competitor called "' + name + '". Find that outlet\'s coverage of ' + team + ' (its team section or site) and its X/Twitter handle for that coverage. Use the outlet\'s own pages; never guess a handle. Then call report_outlet.' }];
  var out = null;
  for (var round = 0; round < 3 && !out; round++) {
    var r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1200, tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }, LOOKUP_TOOL], tool_choice: { type: 'auto' }, messages: messages })
    });
    var d = await r.json();
    if (d.error) throw new Error('Lookup: ' + (d.error.message || JSON.stringify(d.error)));
    var tu = (d.content || []).filter(function (b) { return b.type === 'tool_use' && b.name === LOOKUP_TOOL.name; })[0];
    if (tu) { out = tu.input || {}; break; }
    if (d.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: d.content });
  }
  if (!out) return local ? { name: local.name, site: local.section || local.domain, x: local.x || '', from: 'beat' } : null;
  var site = parseSite(out.site);
  return {
    name: (local && local.name) || String(out.name || name).slice(0, 80),
    site: local ? (local.section || local.domain) : (site ? (site.rss || site.section || site.domain) : ''),
    x: (local && local.x) || cleanHandle(out.x_handle), from: 'search'
  };
}

async function manage(req, res, ctx) {
  if (!(await require('./_access').allowed(ctx, 'act_opps_edit'))) return require('./_access').deny(res);
  if (!S.isConfigured()) return res.status(503).json({ error: 'Sign-in is not set up yet, so changes cannot be saved.' });
  var sb = S.admin();
  var body = req.body || {};
  var beat = await Beat.getBeat(sb);
  var outlets = beat.outlets.map(function (o) { return Object.assign({}, o); });
  var find = function (domain) { domain = String(domain || '').toLowerCase().replace(/^www\./, ''); return outlets.filter(function (o) { return key(o) === domain || String(o.domain || '').toLowerCase() === domain; })[0]; };
  if (body.action === 'lookup') {
    var found = await lookupOutlet(beat, body.name);
    return res.status(200).json(found || { name: String(body.name || ''), site: '', x: '' });
  }
  var addHandle = '';
  if (body.action === 'follow') {
    var name = String(body.name || '').trim().slice(0, 80);
    var site = parseSite(body.site || body.domain);
    if (!site) return res.status(400).json({ error: 'Add their website (e.g. on3.com/teams/maryland-terrapins) or RSS feed.' });
    var o = find(site.domain);
    if (!o) {
      if (!name) name = site.domain;
      o = { name: name, domain: site.domain, rating: 4 };
      outlets.push(o);
    } else if (name) o.name = name;
    if (site.rss) o.rss = site.rss;
    if (site.section) o.section = site.section;
    o.spy = true; o.blocked = false;
    var hx = cleanHandle(body.x);
    if (hx) { o.x = hx; addHandle = hx; }
    o.alertEmail = !!body.alertEmail; o.alertText = !!body.alertText;
    if (body.eyes) o.eyes = Math.max(1, Math.min(5, Math.round(+body.eyes) || 3));
  } else if (body.action === 'set') {
    var t = find(body.domain);
    if (!t) return res.status(404).json({ error: 'Not found' });
    t.spy = true;
    if (body.alertEmail !== undefined) t.alertEmail = !!body.alertEmail;
    if (body.alertText !== undefined) t.alertText = !!body.alertText;
    if (body.eyes !== undefined) t.eyes = Math.max(1, Math.min(5, Math.round(+body.eyes) || 3));
  } else if (body.action === 'unfollow') {
    var u = find(body.domain);
    if (!u) return res.status(404).json({ error: 'Not found' });
    u.spy = false; u.alertEmail = false; u.alertText = false; // stays a beat source, just not followed
  } else {
    return res.status(400).json({ error: 'Unknown action' });
  }
  await saveOutlets(sb, beat, outlets);
  // Their X account joins the watched X accounts, so the scan checks it too.
  if (addHandle) {
    try {
      var Store = require('./_settings-store');
      var cur = await Store.getXWatchHandles(sb);
      if (!cur.some(function (h) { return String(h).toLowerCase() === addHandle.toLowerCase(); })) await Store.saveXWatchHandles(sb, cur.concat(addHandle));
    } catch (e) { console.error('Opp Watch: adding X handle failed:', e.message); }
  }
  return res.status(200).json({ ok: true });
}

module.exports = async function handler(req, res) {
  try { await require('./_supabase').requireUserOrCron(req, res); }
  catch (authErr) { return res.status(authErr.status || 401).json({ error: authErr.message || 'Not signed in' }); }
  res.setHeader('Cache-Control', 'no-store');
  try {
    var sb = S.isConfigured() ? S.admin() : null;
    if (req.query && req.query.run) {
      var beat = await Beat.getBeat(sb);
      return res.status(200).json(await run(beat));
    }
    var oppCtx = null;
    if (S.isConfigured()) {
      try { oppCtx = await S.requireUser(req); } catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
      if (!(await require('./_access').allowed(oppCtx, 'mon_opps'))) return require('./_access').deny(res);
    }
    if (req.method === 'POST') return await manage(req, res, oppCtx);
    var beat2 = await Beat.getBeat(sb);
    var state = await loadJson(STATE_KEY, { outlets: {}, items: [] });
    state.items = state.items || [];
    var names = competitors(beat2).map(function (o) { return o.name; });
    return res.status(200).json({
      // Most-watched first (eyes 5 -> 1), then most active this week.
      competitors: stats(beat2, state).sort(function (a, b) { return (b.eyes - a.eyes) || (b.last7 - a.last7); }),
      items: state.items.filter(function (i) { return names.indexOf(i.outlet) !== -1; }).slice(0, 120),
      // Beat outlets not followed yet, for one-click follow in the tab.
      available: beat2.outlets.filter(function (o) { return !o.blocked && o.domain && names.indexOf(o.name) === -1; })
        .sort(function (a, b) { return Number(b.rating || 3) - Number(a.rating || 3); })
        .map(function (o) { return { name: o.name, domain: o.domain, x: o.x || '' }; }).slice(0, 30),
      // For autofill in the Follow box: every beat outlet, and the watched X accounts.
      known: beat2.outlets.filter(function (o) { return !o.blocked && o.name; }).map(function (o) { return { name: o.name, site: o.section || o.rss || o.domain || '', x: o.x || '' }; }).slice(0, 200),
      xHandles: await require('./_settings-store').getXWatchHandles(sb).catch(function () { return []; })
    });
  } catch (e) {
    console.error('Opp Watch error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};

// Per-newsroom: this request runs as the signed-in person's newsroom (_site.js).
module.exports = require('./_site').wrap(module.exports);
