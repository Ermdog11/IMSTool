// YouTube link -> transcript, from the video's own captions (Jeff, 2026-10-06:
// "in transcribe can we add ability to add a YouTube link and have it create
// a transcript from YouTube transcripts"). No audio is downloaded and no
// transcription service is paid for: it reads the caption track YouTube
// already shows under "Show transcript": the uploader's own captions when
// there are any, otherwise YouTube's auto-generated ones (marked as such,
// since auto captions misspell names more often).
//
// How: the watch page's player data lists the caption tracks; if YouTube
// serves our server a consent or bot-check page instead, the same data is
// asked for through YouTube's player API as its Android app does. Then the
// track is fetched as JSON (json3), or XML as a fallback. YouTube changes
// these internals now and then and sometimes blocks cloud servers, so this
// is best-effort: when it can't get captions it says so plainly, and the
// Transcribe tab's "Live from a browser tab" still works for any video.
//
// No speaker labels (captions don't have them): lines are grouped into
// passages of about 30 seconds with their start time, ready to copy.

var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function videoId(url) {
  var s = String(url || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  var m = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/|youtube-nocookie\.com\/embed\/)([A-Za-z0-9_-]{11})/i.exec(s);
  return m ? m[1] : null;
}

function decode(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(+n); })
    .replace(/<[^>]+>/g, '');
}

// The JSON object assigned after `marker` in a page script, by brace counting
// (it's too big and nested for a regex).
function jsonAfter(html, marker) {
  var i = html.indexOf(marker);
  if (i === -1) return null;
  i = html.indexOf('{', i);
  if (i === -1) return null;
  var depth = 0, inStr = false, esc = false;
  for (var j = i; j < html.length; j++) {
    var c = html[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(html.slice(i, j + 1)); } catch (e) { return null; } } }
  }
  return null;
}

async function get(url, opts) {
  var c = new AbortController(); var t = setTimeout(function () { c.abort(); }, 12000);
  try { return await fetch(url, Object.assign({ signal: c.signal }, opts || {})); } finally { clearTimeout(t); }
}

async function playerFromWatchPage(id) {
  var r = await get('https://www.youtube.com/watch?v=' + id + '&hl=en', {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+cb; SOCS=CAI' }
  });
  if (!r.ok) return null;
  return jsonAfter(await r.text(), 'ytInitialPlayerResponse');
}

async function playerFromApi(id) {
  var r = await get('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'com.google.android.youtube/19.29.37 (Linux; U; Android 14) gzip' },
    body: JSON.stringify({ videoId: id, context: { client: { clientName: 'ANDROID', clientVersion: '19.29.37', androidSdkVersion: 34, hl: 'en', gl: 'US' } } })
  });
  if (!r.ok) return null;
  return await r.json().catch(function () { return null; });
}

function tracksOf(player) {
  return (player && player.captions && player.captions.playerCaptionsTracklistRenderer && player.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
}

// The uploader's English captions, then auto-generated English, then
// whatever is first.
function pickTrack(tracks) {
  var en = function (t) { return /^en/i.test(t.languageCode || ''); };
  return tracks.filter(function (t) { return en(t) && t.kind !== 'asr'; })[0] ||
    tracks.filter(function (t) { return en(t); })[0] || tracks[0] || null;
}

// Caption body -> [{ start (ms), end (ms), text }].
function parseJson3(d) {
  return ((d && d.events) || []).filter(function (e) { return e.segs; }).map(function (e) {
    return { start: e.tStartMs || 0, end: (e.tStartMs || 0) + (e.dDurationMs || 0), text: decode(e.segs.map(function (s) { return s.utf8 || ''; }).join('')).replace(/\s+/g, ' ').trim() };
  }).filter(function (l) { return l.text; });
}
function parseXml(xml) {
  var out = [], re = /<text start="([\d.]+)"(?: dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g, m;
  while ((m = re.exec(xml))) {
    var s = Math.round(parseFloat(m[1]) * 1000);
    out.push({ start: s, end: s + Math.round(parseFloat(m[2] || '0') * 1000), text: decode(decode(m[3])).replace(/\s+/g, ' ').trim() });
  }
  // Newer "format 3" XML: <p t="ms" d="ms">…</p>
  if (!out.length) {
    var re2 = /<p t="(\d+)"(?: d="(\d+)")?[^>]*>([\s\S]*?)<\/p>/g;
    while ((m = re2.exec(xml))) out.push({ start: +m[1], end: +m[1] + (+m[2] || 0), text: decode(m[3]).replace(/\s+/g, ' ').trim() });
  }
  return out.filter(function (l) { return l.text; });
}

// Lines -> passages of about 30 seconds, broken at a sentence end when one
// comes along, so quotes read cleanly.
function passages(lines) {
  var out = [], cur = null;
  lines.forEach(function (l) {
    if (/^\[(music|applause|laughter|inaudible)\]$/i.test(l.text)) return;
    if (!cur) cur = { speaker: null, start: l.start, end: l.end, text: l.text };
    else { cur.text += ' ' + l.text; cur.end = l.end; }
    var long = cur.end - cur.start >= 30000;
    if ((long && /[.?!]["')\]]?$/.test(cur.text)) || cur.end - cur.start >= 60000) { out.push(cur); cur = null; }
  });
  if (cur) out.push(cur);
  return out;
}

// -> { id, status:'completed', title, text, utterances, duration, auto, language }
async function transcript(url) {
  var id = videoId(url);
  if (!id) { var e0 = new Error('That doesn\'t look like a YouTube video link.'); e0.status = 400; throw e0; }
  var player = null;
  try { player = await playerFromWatchPage(id); } catch (e) { /* try the API */ }
  if (!tracksOf(player).length) { try { player = (await playerFromApi(id)) || player; } catch (e) { /* below */ } }
  var status = player && player.playabilityStatus && player.playabilityStatus.status;
  var track = pickTrack(tracksOf(player));
  if (!track) {
    var why = !player ? 'YouTube didn\'t answer our server' :
      status && status !== 'OK' ? 'YouTube says: ' + ((player.playabilityStatus.reason) || status) :
      'this video has no captions';
    var e1 = new Error('Couldn\'t get a transcript: ' + why + '. You can still transcribe it with "Live from a browser tab" below.'); e1.status = 422; throw e1;
  }
  var lines = [];
  var base = String(track.baseUrl || '');
  try {
    var r = await get(base + (/[?&]fmt=/.test(base) ? '' : '&fmt=json3'), { headers: { 'User-Agent': UA } });
    var body = await r.text();
    if (body.trim().charAt(0) === '{') lines = parseJson3(JSON.parse(body));
    else lines = parseXml(body);
  } catch (e) { /* try XML below */ }
  if (!lines.length) {
    try { var r2 = await get(base.replace(/&fmt=[^&]*/, ''), { headers: { 'User-Agent': UA } }); lines = parseXml(await r2.text()); } catch (e) { /* below */ }
  }
  if (!lines.length) { var e2 = new Error('Couldn\'t get a transcript: YouTube listed captions but wouldn\'t send them to our server. You can still transcribe it with "Live from a browser tab" below.'); e2.status = 422; throw e2; }
  var details = (player && player.videoDetails) || {};
  var utterances = passages(lines);
  return {
    id: 'yt-' + id, status: 'completed', source: 'youtube',
    title: details.title || 'YouTube video', author: details.author || '',
    duration: +details.lengthSeconds || Math.round(lines[lines.length - 1].end / 1000),
    auto: track.kind === 'asr', language: track.languageCode || '',
    text: utterances.map(function (u) { return u.text; }).join('\n\n'),
    utterances: utterances
  };
}

module.exports = { transcript: transcript, videoId: videoId, jsonAfter: jsonAfter, parseJson3: parseJson3, parseXml: parseXml, passages: passages, pickTrack: pickTrack };
