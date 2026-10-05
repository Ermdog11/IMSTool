// Each search costs 100 of the key's ~100-searches-a-day quota, so results
// are cached for an hour in Blob (shared by every instance, every open tab and
// scan.js), searches are reserved against the shared daily budget in
// _yt-quota.js, and when the budget is gone the last results are served
// instead of an error. The rotation index lives in the same Blob doc so
// consecutive refreshes walk through all the search groups, which are built
// from the beat profile (searchTerms). Channels that cover the beat are also
// read directly (channelUploads), far cheaper than searching.
var Quota = require('./_yt-quota.js');
var CACHE_PATH = 'youtube/cache.json';
var ytCache = { at: 0, payload: null, rotation: 0 };
var YT_CACHE_MS = 60 * 60 * 1000;

var B = require('./_beat.js');
var Hot = require('./_hot-topics.js');
var S = require('./_supabase.js');

// ── Beat words and searches (all from the beat profile) ──────────────────
function clean(n) { return String(n || '').replace(/\s*\(.*?\)\s*/g, '').trim(); }

function beatWords(beat) {
  var t = beat.team;
  var team = [t.name, t.short, t.school].concat(t.nicknames)
    .map(function(w) { return clean(w).toLowerCase(); })
    .filter(function(w, i, a) { return w.length >= 4 && a.indexOf(w) === i; });
  var people = [], alumni = [];
  beat.watch.forEach(function(g) {
    if (Number(g.rating || 3) <= 1) return;
    g.names.forEach(function(n) { (g.alumni ? alumni : people).push(clean(n).toLowerCase()); });
  });
  (beat.keyFigures || []).forEach(function(n) { people.push(clean(n).toLowerCase()); });
  (beat.keyTerms || []).forEach(function(x) {
    if ((x.kind || 'person') === 'person') (x.era === 'historic' ? alumni : people).push(clean(x.term).toLowerCase());
  });
  function uniq(a) { return a.filter(function(w, i) { return w.length >= 5 && w.indexOf(' ') !== -1 && a.indexOf(w) === i; }); }
  // Coaches and key figures are often called by last name alone in titles
  // ("Locksley on the QB battle"): match those too, with the team required
  // somewhere in the video (see matchBeat).
  var lastNames = [];
  beat.watch.forEach(function(g) {
    if (/coach|staff/i.test(g.label || '')) g.names.forEach(function(n) { lastNames.push(n); });
  });
  (beat.keyFigures || []).forEach(function(n) { lastNames.push(n); });
  lastNames = lastNames.map(function(n) { var parts = clean(n).toLowerCase().split(/\s+/); return parts[parts.length - 1]; })
    .filter(function(w, i, a) { return w.length >= 5 && a.indexOf(w) === i; });
  return { team: team, people: uniq(people), alumni: uniq(alumni), lastNames: lastNames };
}

function hasAny(list, text) { return list.some(function(w) { return text.indexOf(w) !== -1; }); }
function hasTeamWord(words, text) { return hasAny(words.team, String(text || '').toLowerCase()); }

// Is this video about our beat? Judged on its own title (and channel name),
// not just its description, which is where opponents' shows and "Big Ten"
// roundups mention us in passing:
//  - our team named in the title or channel, unless the title only names us
//    as the opponent ("Rutgers vs Maryland preview" on a Rutgers show); or
//  - one of our current people in the title, with our team named anywhere
//    (names collide: a recruit and an NFL player can share one); or
//  - an alum in the title with our team named in the title or description.
function matchBeat(words, title, desc, channel) {
  var tl = String(title || '').toLowerCase();
  var cl = String(channel || '').toLowerCase();
  var all = tl + ' ' + String(desc || '').toLowerCase() + ' ' + cl;
  var teamInChannel = hasAny(words.team, cl);
  var personInTitle = hasAny(words.people, tl);
  if (personInTitle && (teamInChannel || hasAny(words.team, all))) return true;
  if (hasAny(words.lastNames || [], tl) && hasAny(words.team, all)) return true;
  if (teamInChannel) return true;
  if (hasAny(words.team, tl)) return !onlyAsOpponent(words.team, tl);
  if (hasAny(words.alumni, tl) && hasAny(words.team, all)) return true;
  return false;
}

// True when every mention of our team in the title comes right after
// "vs", "at", "against", "hosts" and the like, i.e. another team's preview.
function onlyAsOpponent(team, tl) {
  var opp = /(?:\bvs\.?|\bv\.|\bversus|\bat|@|\bagainst|\bhosts?|\bfaces?|\bplays?|\bwelcomes?|\bvisit(?:s|ing)?|\btake(?:s)? on)\s*(?:no\.\s*\d+\s*|#\d+\s*)?$/;
  var found = false;
  for (var i = 0; i < team.length; i++) {
    var idx = tl.indexOf(team[i]);
    while (idx !== -1) {
      found = true;
      if (!opp.test(tl.slice(Math.max(0, idx - 24), idx).trim())) return false;
      idx = tl.indexOf(team[i], idx + 1);
    }
  }
  return found;
}

function q(s) { return '"' + clean(s) + '"'; }
function groupsOf(arr, n) { var out = []; for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

// YouTube search queries (OR groups), most important first. The rotation in
// the handler walks through them a few per refresh.
function searchTerms(beat) {
  var t = beat.team;
  var sports = (beat.primarySports || []).slice(0, 3);
  var out = [];
  out.push([t.name].concat(t.nicknames).slice(0, 4).map(q).concat(sports.map(function(s) { return q(t.short + ' ' + s); })).join(' | '));
  sports.slice(0, 2).forEach(function(s) {
    var base = t.short + ' ' + s;
    out.push([q(base) + ' press conference', q(base) + ' podcast', q(base) + ' interview'].join(' | '));
  });
  if (t.level === 'college' || t.level === 'high school') {
    out.push([q(t.short) + ' commit', q(t.short) + ' commitment', q(t.short) + ' transfer portal', q(t.short) + ' official visit'].join(' | '));
  }
  var people = [];
  beat.watch.slice().sort(function(a, c) { return (c.rating || 3) - (a.rating || 3); }).forEach(function(g) {
    if (g.alumni || Number(g.rating || 3) <= 1) return;
    g.names.forEach(function(n) { n = clean(n); if (n && people.indexOf(n) === -1) people.push(n); });
  });
  (beat.keyFigures || []).forEach(function(n) { n = clean(n); if (n && people.indexOf(n) === -1) people.unshift(n); });
  groupsOf(people.slice(0, 60), 5).forEach(function(g) { out.push(g.map(q).join(' | ')); });
  var alumni = [];
  beat.watch.forEach(function(g) {
    if (!g.alumni || Number(g.rating || 3) <= 1) return;
    g.names.forEach(function(n) { n = clean(n); if (n && alumni.indexOf(n) === -1) alumni.push(n); });
  });
  groupsOf(alumni.slice(0, 10), 5).forEach(function(g) { out.push(g.map(q).join(' | ') + ' ' + q(t.short)); });
  return out;
}

// ── Beat channels: configured in the setup wizard, or learned ─────────────
var CHANNELS_PATH = 'youtube/channels.json';

async function loadChannels() {
  var st = await Quota.readJson(CHANNELS_PATH);
  st = st && typeof st === 'object' ? st : {};
  st.configured = st.configured || {};
  st.learned = st.learned || {};
  return st;
}

// Turns the publisher's channel names into channel ids, at most one search
// per refresh, remembered for good. A channel URL, UC-id or @handle costs
// no search.
async function resolveConfiguredChannels(beat, st, key) {
  var changed = false, searched = 0;
  for (var i = 0; i < beat.youtube.length; i++) {
    var ch = beat.youtube[i];
    if (Number(ch.rating || 3) <= 1 || ch.blocked) continue;
    var name = String(ch.name || '').trim();
    if (!name || Object.prototype.hasOwnProperty.call(st.configured, name)) continue;
    var id = '';
    var m = name.match(/(UC[\w-]{22})/);
    var handle = (name.match(/(?:youtube\.com\/)?(@[\w.-]+)/) || [])[1];
    try {
      if (m) id = m[1];
      else if (handle) {
        var hr = await fetch('https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=' + encodeURIComponent(handle) + '&key=' + key).then(function(r) { return r.json(); });
        id = (hr.items && hr.items[0] && hr.items[0].id) || '';
      } else {
        if (searched >= 1 || !(await Quota.take(1))) continue;
        searched++;
        var sr = await fetch('https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=' + encodeURIComponent(name) + '&key=' + key).then(function(r) { return r.json(); });
        id = (sr.items && sr.items[0] && sr.items[0].id && sr.items[0].id.channelId) || '';
      }
    } catch (e) { continue; }
    st.configured[name] = id;
    changed = true;
  }
  if (changed) await Quota.writeJson(CHANNELS_PATH, st);
}

// Learned channels: posted beat videos on at least 2 refreshes in the last
// 60 days. Most active first; up to 60 are followed.
function learnedChannels(st) {
  var cutoff = Date.now() - 60 * 24 * 3600 * 1000;
  return Object.keys(st.learned)
    .filter(function(id) { var c = st.learned[id]; return c.hits >= 2 && c.last >= cutoff; })
    .sort(function(a, b) { return st.learned[b].hits - st.learned[a].hits; });
}

async function rememberChannels(st, videos) {
  var now = Date.now(), changed = false, counted = {};
  videos.forEach(function(v) {
    if (!v.channelId || counted[v.channelId] || st.configured && Object.values(st.configured).indexOf(v.channelId) !== -1) return;
    counted[v.channelId] = 1;
    var c = st.learned[v.channelId] || { title: v.channel, hits: 0, last: 0 };
    c.hits += 1; c.last = now; c.title = v.channel;
    st.learned[v.channelId] = c;
    changed = true;
  });
  if (!changed) return;
  var keep = Object.keys(st.learned).sort(function(a, b) { return st.learned[b].last - st.learned[a].last; }).slice(0, 150);
  var pruned = {};
  keep.forEach(function(id) { pruned[id] = st.learned[id]; });
  st.learned = pruned;
  await Quota.writeJson(CHANNELS_PATH, st);
}

// Recent uploads of the given channels. Each channel's public upload feed
// (youtube.com/feeds/videos.xml) costs no quota at all, so dozens of beat
// channels can be followed every refresh. Channels whose feed fails fall
// back to the Data API: 1 quota unit each (plus 1 per 50 channels), still
// far cheaper than a 100-unit search.
async function channelUploads(ids, key, cutoffMs) {
  if (!ids.length) return [];
  var out = [], failed = [];
  await Promise.all(ids.map(async function(id) {
    try {
      var r = await fetch('https://www.youtube.com/feeds/videos.xml?channel_id=' + id, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) { failed.push(id); return; }
      var xml = await r.text();
      (xml.match(/<entry>[\s\S]*?<\/entry>/g) || []).forEach(function(e) {
        function tag(re) { return ((e.match(re) || [])[1] || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>'); }
        var vid = tag(/<yt:videoId>([^<]+)<\/yt:videoId>/);
        var published = tag(/<published>([^<]+)<\/published>/);
        if (!vid || !published || Date.parse(published) < cutoffMs) return;
        out.push({ videoId: vid, snippet: {
          title: tag(/<title>([\s\S]*?)<\/title>/), description: tag(/<media:description>([\s\S]*?)<\/media:description>/),
          publishedAt: published, thumbnails: { medium: { url: 'https://i.ytimg.com/vi/' + vid + '/mqdefault.jpg' } },
          channelId: tag(/<yt:channelId>([^<]+)<\/yt:channelId>/) || id, channelTitle: tag(/<author>\s*<name>([\s\S]*?)<\/name>/)
        } });
      });
    } catch (e) { failed.push(id); }
  }));
  if (failed.length) out = out.concat(await channelUploadsApi(failed.slice(0, 25), key, cutoffMs));
  return out;
}

async function channelUploadsApi(ids, key, cutoffMs) {
  if (!ids.length) return [];
  var lists = [];
  for (var i = 0; i < ids.length; i += 50) {
    try {
      var r = await fetch('https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=' + ids.slice(i, i + 50).join(',') + '&key=' + key).then(function(x) { return x.json(); });
      (r.items || []).forEach(function(c) {
        var u = c.contentDetails && c.contentDetails.relatedPlaylists && c.contentDetails.relatedPlaylists.uploads;
        if (u) lists.push(u);
      });
    } catch (e) { /* best-effort */ }
  }
  var pages = await Promise.all(lists.map(function(pl) {
    return fetch('https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=10&playlistId=' + pl + '&key=' + key)
      .then(function(x) { return x.json(); }).catch(function() { return {}; });
  }));
  var out = [];
  pages.forEach(function(p) {
    (p.items || []).forEach(function(it) {
      var sn = it.snippet || {};
      var vid = (it.contentDetails && it.contentDetails.videoId) || (sn.resourceId && sn.resourceId.videoId);
      var published = (it.contentDetails && it.contentDetails.videoPublishedAt) || sn.publishedAt;
      if (!vid || !published || Date.parse(published) < cutoffMs) return;
      out.push({ videoId: vid, snippet: {
        title: sn.title, description: sn.description, publishedAt: published, thumbnails: sn.thumbnails,
        channelId: sn.videoOwnerChannelId || sn.channelId, channelTitle: sn.videoOwnerChannelTitle || sn.channelTitle
      } });
    });
  });
  return out;
}

module.exports = async function handler(req, res) {
  // Every search spends the shared daily YouTube quota, so members only (and
  // scan.js's in-process call). The page sends the token via _auth.js.
  try { await S.requireUserOrCron(req, res); }
  catch (authErr) { return res.status(authErr.status || 401).json({ error: authErr.message || 'Not signed in' }); }
  var key = process.env.YOUTUBE_API_KEY;
  if (!key) return res.status(200).json({ videos: [], error: 'YOUTUBE_API_KEY not set — add it in Vercel environment variables' });

  // Channels / videos the editor has blocked via the buttons in the YouTube tab.
  // Passed as ?blocked=a,b,c (channel names) and ?hidden=url1,url2 (single videos).
  var blockedChannels = String((req.query && req.query.blocked) || '')
    .split(',').map(function(s) { return s.trim().toLowerCase(); }).filter(Boolean);
  var hiddenVideos = String((req.query && req.query.hidden) || '')
    .split(',').map(function(s) { return s.trim(); }).filter(Boolean);
  function applyBlocks(payload) {
    if (!payload || !payload.videos) return payload;
    if (!blockedChannels.length && !hiddenVideos.length) return payload;
    var filtered = payload.videos.filter(function(v) {
      var ch = (v.channel || '').toLowerCase();
      if (blockedChannels.some(function(b) { return ch.includes(b) || b.includes(ch); })) return false;
      if (hiddenVideos.indexOf(v.url) !== -1) return false;
      return true;
    });
    return Object.assign({}, payload, { videos: filtered });
  }

  var noCache = req.query && (req.query.nocache || req.query.fresh);
  if (!ytCache.payload || (Date.now() - ytCache.at) >= YT_CACHE_MS) {
    var stored = await Quota.readJson(CACHE_PATH);
    if (stored && stored.at > ytCache.at) ytCache = stored;
  }
  function serveCached(note) {
    var p = ytCache.payload || { videos: [] };
    return res.status(200).json(applyBlocks(Object.assign({ cached: true, cachedAt: ytCache.at || null }, p, note ? { quotaNote: note } : {})));
  }
  // A manual refresh still waits at least 10 minutes between real searches.
  var minAge = noCache ? 10 * 60 * 1000 : YT_CACHE_MS;
  if (ytCache.payload && (Date.now() - ytCache.at) < minAge) return serveCached();

  var cutoff = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  var cutoffMs = Date.parse(cutoff);

  // Everything about the beat (team names, people, channels) comes from the
  // newsroom's beat profile, not a hard-coded list (2026-10-05, Jeff: "very
  // weak, doesn't find much hidden content, and produces lots of Rutgers and
  // Ohio State podcasts"). See matchBeat() for the relevance rule.
  var beat = await B.getBeat(S.isConfigured() ? S.admin() : null);
  var words = beatWords(beat);
  var allTerms = searchTerms(beat);

  // Rotate groups per request to conserve quota (search costs 100 units each; 10k/day free)
  var batchSize = 7;
  var bReq = parseInt((req.query && req.query.batch) || '', 10);
  if (bReq >= 1 && bReq <= 12) batchSize = Math.min(bReq, allTerms.length);
  batchSize = Math.min(batchSize, allTerms.length);
  if (!(await Quota.take(batchSize))) {
    return serveCached('YouTube search limit reached for today. Showing the last results; new searches resume after midnight Pacific.');
  }
  var rotation = ytCache.rotation || 0;
  // Who's hot on the beat right now (most-covered person in the last 48h of
  // scans, e.g. "Mike Locksley"): one slot of every refresh searches them,
  // newest first over the last 3 days, taking turns if two are hot.
  var hot = await Hot.hotPeople(beat, 2);
  var terms = [];
  var hotSlots = hot.length && batchSize > 1 ? 1 : 0;
  if (hotSlots) terms.push({ q: '"' + hot[rotation % hot.length].name + '"', hot: true });
  var rotated = batchSize - hotSlots;
  var startIdx = (rotation * rotated) % allTerms.length;
  for (var i = 0; i < rotated; i++) {
    terms.push({ q: allTerms[(startIdx + i) % allTerms.length] });
  }
  var hotNames = hot.map(function(h) { return h.name.toLowerCase(); });

  // Xfinity Center in Mansfield MA is a concert venue, not the UMD arena
  var venueNoise = ['mansfield', 'concert', 'live at xfinity', 'at xfinity center, mansfield', 'tour', 'full show', 'en vevo', 'setlist'];
  function isConcertVenue(text) {
    var t = (text || '').toLowerCase();
    if (!t.includes('xfinity')) return false;
    return venueNoise.some(function(v) { return t.includes(v); });
  }
  // Cannabis content guard ("terps"/"terpenes" overlap)
  var cannabisTerms = ['terpene', 'cannabis', 'marijuana', 'weed', 'thc', 'cbd', 'dispensary', 'kush', 'stoner', 'dab rig', '710', 'hemp'];
  function isCannabis(text) {
    var t = (text || '').toLowerCase();
    return cannabisTerms.some(function(c) { return t.includes(c); });
  }
  // State-name noise guard: a team named for its state ("Maryland") also
  // matches food, tourism and local-news videos about the state.
  var stateNoiseTerms = ['crab', 'seafood', 'old bay', 'crab cake', 'crab feast', 'crab house', 'blue crab', 'ocean city', 'national aquarium', 'chesapeake bay', 'recipe', 'cooking', 'weather forecast', 'lottery', 'real estate', 'zoning', 'city council'];
  function isStateNoise(text) {
    var t = (text || '').toLowerCase();
    return stateNoiseTerms.some(function(n) { return t.includes(n); });
  }

  // Our own outlet's channel, and anything the publisher excluded.
  var excluded = ['insidemd', 'jeff ermann', 'ims radio', 'insidetheshell'].concat(beat.excludeSources || [], beat.outletName ? [beat.outletName.toLowerCase()] : []);
  // Video game / simulation content
  var gamingTerms = ['college football 27', 'college football 26', 'cfb27', 'cfb 27', 'cfb26', 'dynasty', 'road to glory', 'simulation', 'sim ', 'ea sports', 'gameplay', 'gaming', 'franchise mode', 'restream', 'twitch', 'madden', 'nba 2k', '2k26', '2k27'];
  function isGaming(text) {
    var t = (text || '').toLowerCase();
    return gamingTerms.some(function(g) { return t.includes(g); });
  }

  // AI-narrated / text-to-speech / auto-generated spam. These channels churn out
  // dozens of robotic recap videos a day.
  var aiPhrases = [
    'ai voice', 'ai-generated', 'ai generated', 'text to speech', 'text-to-speech',
    'ai narrat', 'generated with ai', 'powered by ai', 'this video was created using',
    'synthetic voice', 'automated news', 'auto-generated', 'tts '
  ];
  var aiChannelPatterns = /(news now|sports now|now sports|daily sports|sports daily|news today|today news|sports central|central sports|hoops nation|gridiron nation|breaking sports|sports break|\bai\b|\bbot\b|robot)/i;
  var clickbaitTitle = /(SHOCK(?:ING|ED|S)?|STUNNED|STUNNING|JUST IN|BREAKING NEWS|YOU WON'?T BELIEVE|BOMBSHELL|MASSIVE NEWS|HUGE NEWS)\b.*[!?]{2,}|[!?]{4,}|🚨\s*🚨/;
  function isAiSpam(title, desc, channel) {
    var t = ((title || '') + ' ' + (desc || '')).toLowerCase();
    if (aiPhrases.some(function(p) { return t.includes(p); })) return true;
    if (aiChannelPatterns.test(channel || '')) return true;
    if (clickbaitTitle.test(title || '')) return true;
    return false;
  }

  // Channels that cover the beat: the publisher's list (setup wizard) plus
  // ones learned from past runs. Their uploads are read directly, 1 quota
  // unit per channel instead of 100 per search, which is how small beat
  // channels (podcasts, pressers, recruit interviews) get found.
  var channelState = await loadChannels();
  await resolveConfiguredChannels(beat, channelState, key);
  var beatChannelIds = {};
  Object.keys(channelState.configured).forEach(function(n) { var id = channelState.configured[n]; if (id) beatChannelIds[id] = 'configured'; });
  learnedChannels(channelState).forEach(function(id) { if (!beatChannelIds[id]) beatChannelIds[id] = 'learned'; });

  try {
    var hotCutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    var searches = terms.map(function(term) {
      var url = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=date&maxResults=25&publishedAfter=' + encodeURIComponent(term.hot ? hotCutoff : cutoff) + '&q=' + encodeURIComponent(term.q) + '&key=' + key;
      return fetch(url).then(function(r) { return r.json(); }).catch(function() { return {}; });
    });
    var results = await Promise.all(searches);
    var uploads = await channelUploads(Object.keys(beatChannelIds).slice(0, 60), key, cutoffMs);

    var videos = [];
    var seen = [];
    var apiError = null, quotaHit = false;

    function consider(sn, videoId, fromChannelFeed) {
      if (!sn || !videoId) return;
      var title = (sn.title || '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
      var channel = sn.channelTitle || '';
      var desc = sn.description || '';
      var text = title + ' ' + desc + ' ' + channel;
      var beatChannel = beatChannelIds[sn.channelId || ''];
      // A configured beat channel's uploads all count; everything else has
      // to be about our team or our people in its own title (see matchBeat).
      if (beatChannel !== 'configured' && !matchBeat(words, title, desc, channel)) return;
      if (excluded.some(function(ex) { return ex && text.toLowerCase().includes(ex); })) return;
      if (isGaming(text)) return;
      if (isCannabis(text)) return;
      if (!hasTeamWord(words, title + ' ' + channel) && isStateNoise(text)) return;
      if (isConcertVenue(text)) return;
      if (isAiSpam(title, desc, channel)) return;
      var norm = title.toLowerCase().replace(/[^a-z0-9 ]/g, '').substring(0, 60);
      if (seen.includes(norm)) return;
      seen.push(norm);
      var pubMs = sn.publishedAt ? new Date(sn.publishedAt).getTime() : 0;
      videos.push({
        videoId: videoId,
        title: title,
        channel: channel,
        channelId: sn.channelId || '',
        beatChannel: !!beatChannel,
        url: 'https://www.youtube.com/watch?v=' + videoId,
        thumbnail: (sn.thumbnails && sn.thumbnails.medium && sn.thumbnails.medium.url) || '',
        age: pubMs ? Math.round((Date.now() - pubMs) / 3600000) : 0,
        description: desc.substring(0, 150)
      });
    }

    uploads.forEach(function(u) { consider(u.snippet, u.videoId, true); });
    results.forEach(function(data) {
      if (data.error) { apiError = data.error.message || 'YouTube API error'; if (Quota.isQuotaError(data.error)) quotaHit = true; return; }
      (data.items || []).forEach(function(item) { consider(item.snippet, item.id && item.id.videoId, false); });
    });

    // Enrich with full descriptions + view counts (videos.list is 1 unit / call, batched 50)
    var vidStats = {};
    var vidIds = videos.map(function(v) { return v.videoId; }).filter(Boolean);
    for (var vi = 0; vi < vidIds.length; vi += 50) {
      var vbatch = vidIds.slice(vi, vi + 50);
      try {
        var vRes = await fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=' + vbatch.join(',') + '&key=' + key);
        if (vRes.ok) {
          var vData = await vRes.json();
          (vData.items || []).forEach(function(v) {
            vidStats[v.id] = {
              fullDesc: (v.snippet && v.snippet.description) || '',
              views: parseInt((v.statistics && v.statistics.viewCount) || '0', 10)
            };
          });
        }
      } catch (e) { /* fall back to search-snippet data */ }
    }
    videos.forEach(function(v) {
      var s = vidStats[v.videoId];
      if (s) { v.fullDesc = s.fullDesc; v.views = s.views; }
    });
    // Re-check the AI/spam filter with the full description now that we have it
    videos = videos.filter(function(v) { return !isAiSpam(v.title, v.fullDesc || '', v.channel); });

    // Channel quality gate: subscriber floor + content-farm ratio (subs vs upload count)
    var channelIds = [];
    videos.forEach(function(v) { if (v.channelId && channelIds.indexOf(v.channelId) === -1) channelIds.push(v.channelId); });
    var chStats = {};
    for (var ci = 0; ci < channelIds.length; ci += 50) {
      var batch = channelIds.slice(ci, ci + 50);
      try {
        var chRes = await fetch('https://www.googleapis.com/youtube/v3/channels?part=statistics&id=' + batch.join(',') + '&key=' + key);
        if (chRes.ok) {
          var chData = await chRes.json();
          (chData.items || []).forEach(function(ch) {
            chStats[ch.id] = {
              subs: parseInt((ch.statistics && ch.statistics.subscriberCount) || '0', 10),
              videos: parseInt((ch.statistics && ch.statistics.videoCount) || '0', 10)
            };
          });
        }
      } catch (e) { /* pass through on lookup failure */ }
    }
    videos = videos.filter(function(v) {
      // Beat channels are exempt: a small channel that covers the beat
      // (a podcast, a recruit's own channel) is the hidden content we want.
      if (v.beatChannel) return true;
      var c = chStats[v.channelId];
      if (!c) return true; // couldn't look up — keep
      if (c.subs < 400) return false;
      // content farm: thousands of uploads, comparatively few subscribers
      if (c.videos > 1500 && c.subs < 15000) return false;
      return true;
    });

    // Sort: videos about who's hot right now first, then real engagement,
    // then recency.
    videos.forEach(function(v) { var t = v.title.toLowerCase(); v.hot = hotNames.some(function(n) { return t.indexOf(n) !== -1; }); });
    videos.sort(function(a, b) {
      if (a.hot !== b.hot) return a.hot ? -1 : 1;
      var av = a.views || 0, bv = b.views || 0;
      if ((av >= 500) !== (bv >= 500)) return (bv >= 500 ? 1 : 0) - (av >= 500 ? 1 : 0);
      return a.age - b.age;
    });

    // Surface a longer description now that we have the full text
    videos.forEach(function(v) {
      if (v.fullDesc) v.description = v.fullDesc.replace(/\s+/g, ' ').trim().substring(0, 400);
      delete v.fullDesc;
      delete v.videoId;
    });

    if (quotaHit) await Quota.exhaust();
    if (!videos.length && apiError) {
      if (ytCache.payload) return serveCached(quotaHit ? 'YouTube search limit reached for today. Showing the last results; new searches resume after midnight Pacific.' : apiError);
      return res.status(200).json({ videos: [], error: quotaHit ? 'YouTube search limit reached for today; new searches resume after midnight Pacific.' : apiError });
    }
    // Learn channels: one that keeps posting videos about the beat gets its
    // uploads read directly from now on.
    await rememberChannels(channelState, videos);
    videos.forEach(function(v) { delete v.beatChannel; });
    var payload = { videos: videos, searched: terms.map(function(t) { return t.q; }), hot: hot.map(function(h) { return h.name; }) };
    ytCache = { at: Date.now(), payload: payload, rotation: rotation + 1 };
    await Quota.writeJson(CACHE_PATH, ytCache);
    return res.status(200).json(applyBlocks(payload));
  } catch(e) {
    return res.status(500).json({ videos: [], error: e.message });
  }
};
