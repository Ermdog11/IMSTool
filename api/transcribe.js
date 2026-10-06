// /api/transcribe — native audio/video transcription for the Content Editor
// (Transcribe tab), via AssemblyAI (ASSEMBLYAI_API_KEY).
//
//   POST { type:'blob.generate-client-token', ... }  -> Vercel Blob client-upload token
//        (sent by the browser's upload() helper, public/vendor/blob-client.js;
//        files go straight from the browser to private Blob storage under
//        transcribe/, which gets around Vercel's 4.5MB request-body limit)
//   POST { action:'start', pathname }   -> streams that uploaded blob to AssemblyAI,
//                                          deletes the blob, starts a transcript -> { id }
//   POST { action:'start', url }        -> starts a transcript from a direct audio/video
//                                          link (e.g. a podcast episode's MP3) -> { id }
//   GET  ?action=live-token             -> { token } short-lived (10 min to connect) token for
//                                          AssemblyAI real-time streaming, so the browser can
//                                          stream mic or shared-tab audio without seeing our key
//   GET  ?id=<transcript id>            -> { status, text, utterances:[{speaker,start,end,text}],
//                                            duration, error }
//   POST { action:'youtube', url }      -> a YouTube video's own captions as a transcript, right
//                                          away (no AssemblyAI, no cost; _youtube-transcript.js)
//                                          -> { id:'yt-<video id>', status:'completed', title, text,
//                                               utterances, duration, auto }
//                                          GET ?id=yt-<video id> fetches it again (Recent transcripts)
//
// Any signed-in member can use it (writers transcribe their own interviews).
// Fails open like the rest of the app when Supabase isn't configured.

var S = require('./_supabase');

var AAI = 'https://api.assemblyai.com/v2';
var PREFIX = 'transcribe/';
var MAX_BYTES = 1024 * 1024 * 1024; // 1GB

function aaiKey() {
  var k = process.env.ASSEMBLYAI_API_KEY;
  if (!k) { var e = new Error('Transcription isn\'t set up yet: add an ASSEMBLYAI_API_KEY in Vercel.'); e.status = 503; throw e; }
  return k;
}

async function auth(req) {
  if (!S.isConfigured()) return null;
  var ctx = await S.requireUser(req);
  // Publisher's per-role switch (api/_access.js).
  if (!(await require('./_access').allowed(ctx, 'tab_transcribe'))) {
    var e = new Error('Your publisher has turned Transcribe off for your role.'); e.status = 403; throw e;
  }
  return ctx;
}

async function aaiJson(path, opts) {
  var r = await fetch(AAI + path, opts);
  var d = await r.json().catch(function () { return {}; });
  if (!r.ok || d.error) {
    var e = new Error('AssemblyAI: ' + (d.error || ('HTTP ' + r.status)));
    e.status = r.status >= 400 && r.status < 500 ? 400 : 502;
    throw e;
  }
  return d;
}

// Names from the setup wizard's "people to watch" help spelling (players,
// coaches, recruits are exactly the words generic models get wrong).
async function keyTerms() {
  try {
    if (!S.isConfigured()) return [];
    var profile = await require('./_settings-store').getProfile(S.admin());
    var raw = profile.watchNames;
    var names = (Array.isArray(raw) ? raw : String(raw || '').split(/\n|,/))
      .map(function (x) { return String(x).trim(); })
      .filter(function (x) { return x && x.split(/\s+/).length <= 6 && x.length <= 50; });
    if (profile.teamName) names.unshift(String(profile.teamName).slice(0, 50));
    return names.slice(0, 200);
  } catch (e) { return []; }
}

async function startTranscript(audioUrl) {
  var key = aaiKey();
  var body = { audio_url: audioUrl, speaker_labels: true, punctuate: true, format_text: true };
  var terms = await keyTerms();
  var opts = function (b) {
    return { method: 'POST', headers: { authorization: key, 'content-type': 'application/json' }, body: JSON.stringify(b) };
  };
  if (terms.length) {
    try { return await aaiJson('/transcript', opts(Object.assign({ keyterms_prompt: terms }, body))); }
    catch (e) { if (!/keyterm/i.test(e.message)) throw e; } // model doesn't take key terms — go without
  }
  return aaiJson('/transcript', opts(body));
}

async function startFromBlob(pathname) {
  var blob = require('@vercel/blob');
  var got = await blob.get(pathname, { access: 'private', useCache: false });
  if (!got || got.statusCode !== 200 || !got.stream) { var e = new Error('Uploaded file not found. Try uploading again.'); e.status = 404; throw e; }
  try {
    var up = await aaiJson('/upload', {
      method: 'POST',
      headers: { authorization: aaiKey(), 'content-type': 'application/octet-stream' },
      body: got.stream,
      duplex: 'half'
    });
    return await startTranscript(up.upload_url);
  } finally {
    // AssemblyAI has its own copy now; don't keep interview audio around.
    blob.del(pathname).catch(function () {});
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      await auth(req);
      if (req.query && req.query.action === 'live-token') {
        var tr = await fetch('https://streaming.assemblyai.com/v3/token?expires_in_seconds=600&max_session_duration_seconds=10800', { headers: { authorization: aaiKey() } });
        var td = await tr.json().catch(function () { return {}; });
        if (!tr.ok || !td.token) return res.status(502).json({ error: 'AssemblyAI: ' + (td.error || ('HTTP ' + tr.status)) });
        return res.status(200).json({ token: td.token });
      }
      var id = String((req.query && req.query.id) || '');
      if (!/^[A-Za-z0-9_-]{6,80}$/.test(id)) return res.status(400).json({ error: 'Missing transcript id.' });
      if (/^yt-[A-Za-z0-9_-]{11}$/.test(id)) return res.status(200).json(await require('./_youtube-transcript').transcript(id.slice(3)));
      var t = await aaiJson('/transcript/' + id, { headers: { authorization: aaiKey() } });
      var utterances = (t.utterances || []).map(function (u) {
        return { speaker: u.speaker, start: u.start, end: u.end, text: u.text };
      });
      return res.status(200).json({
        id: t.id, status: t.status, error: t.error || null,
        duration: t.audio_duration || null,
        text: t.status === 'completed' ? (t.text || '') : '',
        utterances: t.status === 'completed' ? utterances : []
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });
    var body = req.body || {};

    if (body.type === 'blob.generate-client-token' || body.type === 'blob.upload-completed') {
      if (body.type === 'blob.generate-client-token') await auth(req);
      var client = require('@vercel/blob/client');
      var out = await client.handleUpload({
        request: req,
        body: body,
        onBeforeGenerateToken: async function (pathname) {
          if (pathname.indexOf(PREFIX) !== 0 || pathname.indexOf('..') !== -1) throw new Error('Bad upload path.');
          return {
            allowedContentTypes: ['audio/*', 'video/*', 'application/octet-stream'],
            maximumSizeInBytes: MAX_BYTES,
            addRandomSuffix: true
          };
        }
      });
      return res.status(200).json(out);
    }

    if (body.action === 'youtube') {
      await auth(req);
      return res.status(200).json(await require('./_youtube-transcript').transcript(body.url));
    }

    if (body.action === 'start') {
      await auth(req);
      aaiKey();
      var started;
      if (body.pathname) {
        var p = String(body.pathname);
        if (p.indexOf(PREFIX) !== 0 || p.indexOf('..') !== -1) return res.status(400).json({ error: 'Bad file path.' });
        started = await startFromBlob(p);
      } else if (body.url) {
        var u = String(body.url).trim();
        if (!/^https?:\/\//i.test(u)) return res.status(400).json({ error: 'Paste a full link starting with http.' });
        if (/youtube\.com|youtu\.be|twitter\.com|x\.com\//i.test(u)) {
          return res.status(400).json({ error: /youtu/i.test(u) ? 'For YouTube, use the YouTube link option (it reads the video\'s captions).' : 'That\'s a video page, not a media file. Use Live from a browser tab instead, or paste a direct link to the .mp3/.mp4.' });
        }
        started = await startTranscript(u);
      } else {
        return res.status(400).json({ error: 'Upload a file or paste a link.' });
      }
      return res.status(200).json({ id: started.id, status: started.status });
    }

    return res.status(400).json({ error: 'Unknown request.' });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
};
