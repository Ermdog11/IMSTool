// /api/podslap — Pod-slap (Content Editor › 🎙️ Pod-slap; Jeff, 2026-10-09:
// "a tool called Pod-slap where they can just slap (upload) the file and the
// app uploads to their podcast platform and writes a headline and description
// but doesn't publish").
//
//   GET                                    -> { platform, platformName, supported, connection, canConnect, hosts }
//   POST { type:'blob.generate-client-token' } -> client-upload token (files go
//        straight from the browser to private Blob under podslap/, like Transcribe)
//   POST { action:'transcribe', pathname } -> { id } AssemblyAI transcript (poll
//        GET /api/transcribe?id=); the file is kept for the host upload
//   POST { action:'write', transcript, filename, note } -> { titles[3], description, chapters[], tags[] }
//   POST { action:'upload', pathname, title, description, tags } -> { id, url }
//        draft on the connected host; the file is deleted from Blob afterwards
//   POST { action:'update', id, title, description, tags } -> { ok } edits the draft
//   POST { action:'discard', pathname }    -> { ok } deletes the uploaded file
//   POST { action:'connect', platform, secret, clientId?, showId? } (publisher)
//        -> { ok, connection } or { shows:[...] } to pick one
//   POST { action:'disconnect' } (publisher)
//
// The host key is encrypted (_crypto.js) and kept per newsroom in Blob
// (podslap/connection.json via _site-blob); the browser never sees it.
// Nothing is ever published: see _podhost.js. 'write' spends Claude credits;
// 'transcribe' spends AssemblyAI credits. Fails open with login off.
var S = require('./_supabase');
var blob = require('@vercel/blob');
var siteBlob = require('./_site-blob');
var Host = require('./_podhost');

var PREFIX = 'podslap/';
var CONN = 'podslap/connection.json';
var MAX_BYTES = 1024 * 1024 * 1024;
var PLATFORM_NAMES = { amperwave: 'Amperwave', megaphone: 'Megaphone', buzzsprout: 'Buzzsprout', libsyn: 'Libsyn', spreaker: 'Spreaker', simplecast: 'Simplecast', transistor: 'Transistor', podbean: 'Podbean', other: 'your podcast host' };

async function auth(req) {
  if (!S.isConfigured()) return null;
  var ctx = await S.requireUser(req);
  if (!(await require('./_access').allowed(ctx, 'tab_podslap'))) { var e = new Error('Your publisher has turned Pod-slap off for your role.'); e.status = 403; throw e; }
  return ctx;
}
function isPublisher(ctx) { return !ctx || (ctx.membership && ctx.membership.role === 'publisher'); }
function okPath(p) { p = String(p || ''); return p.indexOf(PREFIX) === 0 && p.indexOf('..') === -1 && p !== CONN ? p : ''; }

async function loadConn() {
  try {
    var r = await siteBlob.get(CONN, { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200) return null;
    return await new Response(r.stream).json();
  } catch (e) { return null; }
}
async function saveConn(c) {
  await siteBlob.put(CONN, JSON.stringify(c), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
}
function cred(c) {
  var Crypto = require('./_crypto');
  return { secret: Crypto.decrypt(c.secretEnc), clientId: c.clientId || '', showId: c.showId || '' };
}
function publicConn(c) { return c ? { platform: c.platform, name: Host.get(c.platform) ? Host.get(c.platform).name : c.platform, showId: c.showId, showName: c.showName || '', at: c.at, by: c.by || '' } : null; }

// Uploaded files nobody finished with: gone after two days.
async function sweep() {
  try {
    var l = await blob.list({ prefix: PREFIX, limit: 100 });
    var old = (l.blobs || []).filter(function (b) { return !/connection\.json$/.test(b.pathname) && Date.now() - Date.parse(b.uploadedAt) > 2 * 86400000; }).map(function (b) { return b.url; });
    if (old.length) await blob.del(old);
  } catch (e) {}
}

// The episode's title, description, chapters and tags, from its transcript.
var WRITE_TOOL = {
  name: 'submit_episode',
  description: 'The podcast episode\'s title options, description, chapters and tags.',
  input_schema: {
    type: 'object',
    properties: {
      titles: { type: 'array', items: { type: 'string' }, description: 'Three title options, best first. Under 70 characters, specific (the names and the news in it), no clickbait, no emoji, no episode number.' },
      description: { type: 'string', description: 'The episode description: a 2-3 sentence opening on what the episode covers and why it matters to fans, then a blank line, then "In this episode:" and 3-6 short "- " bullet points. Plain text.' },
      chapters: { type: 'array', items: { type: 'object', properties: { time: { type: 'string', description: 'MM:SS or H:MM:SS, from the transcript\'s timestamps' }, topic: { type: 'string' } }, required: ['time', 'topic'] }, description: '4-10 chapter markers where the topic changes.' },
      tags: { type: 'array', items: { type: 'string' }, description: '5-10 short tags: team, people, topics.' }
    },
    required: ['titles', 'description', 'chapters', 'tags']
  }
};
async function write(transcript, filename, note) {
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Missing ANTHROPIC_API_KEY.');
  var beat = await require('./_beat').getBeat(S.isConfigured() ? S.admin() : null).catch(function () { return {}; });
  var t = beat.team || {};
  var sys = 'You write titles and show notes for ' + (beat.outletName || 'a sports newsroom') + '\'s podcast, which covers ' + (beat.coverage || t.name || 'its beat') + '. ' +
    'Work only from the transcript: never add facts, scores, quotes or names that aren\'t in it, and spell names the way the transcript does. Sound like a beat reporter, not a hype account. ' +
    'Titles lead with the biggest news or the most interesting take in the episode. The description tells a fan what they will learn. Chapter times must be real timestamps from the transcript.';
  var user = (filename ? 'FILE: ' + filename + '\n' : '') + (note ? 'NOTE FROM THE HOST: ' + note + '\n' : '') + '\nTRANSCRIPT (each line starts with its time):\n' + String(transcript || '').slice(0, 160000);
  var r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2000, system: sys, tools: [WRITE_TOOL], tool_choice: { type: 'tool', name: WRITE_TOOL.name }, messages: [{ role: 'user', content: user.toWellFormed() }] })
  });
  var d = await r.json();
  if (d.error) throw new Error('Claude error: ' + (d.error.message || JSON.stringify(d.error)));
  var out = ((d.content || []).filter(function (b) { return b.type === 'tool_use'; })[0] || {}).input || {};
  return {
    titles: (out.titles || []).map(function (x) { return String(x).slice(0, 200); }).filter(Boolean).slice(0, 3),
    description: String(out.description || '').slice(0, 4000),
    chapters: (out.chapters || []).filter(function (c) { return c && /^\d{1,2}(:\d{2}){1,2}$/.test(String(c.time || '').trim()); }).slice(0, 12).map(function (c) { return { time: String(c.time).trim(), topic: String(c.topic || '').slice(0, 120) }; }),
    tags: (out.tags || []).map(function (x) { return String(x).slice(0, 40); }).filter(Boolean).slice(0, 12)
  };
}
function cleanEp(b) {
  var title = String(b.title || '').trim().slice(0, 200), description = String(b.description || '').trim().slice(0, 8000);
  if (!title) { var e = new Error('Add a title first.'); e.status = 400; throw e; }
  return { title: title, description: description, tags: (Array.isArray(b.tags) ? b.tags : []).map(function (x) { return String(x).slice(0, 40); }).slice(0, 12) };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    var body = req.body || {};
    // Browser upload straight to Blob (auth on the token request only; the
    // completion callback comes from Vercel, not the person).
    if (req.method === 'POST' && (body.type === 'blob.generate-client-token' || body.type === 'blob.upload-completed')) {
      if (body.type === 'blob.generate-client-token') await auth(req);
      var client = require('@vercel/blob/client');
      var out = await client.handleUpload({
        request: req, body: body,
        onBeforeGenerateToken: async function (pathname) {
          if (!okPath(pathname)) throw new Error('Bad upload path.');
          return { allowedContentTypes: ['audio/*', 'video/mp4', 'application/octet-stream'], maximumSizeInBytes: MAX_BYTES, addRandomSuffix: true };
        }
      });
      return res.status(200).json(out);
    }

    var ctx = await auth(req);
    var who = ctx ? String(ctx.user.email || '') : '';
    var profile = S.isConfigured() ? await require('./_settings-store').getProfile(S.admin()).catch(function () { return {}; }) : {};
    var platform = String((profile.podcast && profile.podcast.platform) || '');
    var conn = await loadConn();

    if (req.method === 'GET') {
      var sup = !!(conn && Host.get(conn.platform));
      return res.status(200).json({
        platform: platform, platformName: PLATFORM_NAMES[platform] || '', supported: sup, connection: publicConn(conn),
        canConnect: isPublisher(ctx), encryption: require('./_crypto').isConfigured(),
        hosts: Object.keys(Host.HOSTS).map(function (k) { var h = Host.HOSTS[k]; return { key: k, name: h.name, keyHelp: h.keyHelp, needsClientId: !!h.needsClientId }; })
      });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });
    sweep();

    if (body.action === 'transcribe') {
      var p = okPath(body.pathname);
      if (!p) return res.status(400).json({ error: 'Bad file path.' });
      var started = await require('./transcribe').startFromBlob(p, true);
      return res.status(200).json({ id: started.id });
    }

    if (body.action === 'write') {
      if (String(body.transcript || '').trim().length < 40) return res.status(400).json({ error: 'The transcript is empty, so there\'s nothing to write from. Is there talking in the file?' });
      return res.status(200).json(await write(body.transcript, String(body.filename || '').slice(0, 200), String(body.note || '').slice(0, 500)));
    }

    if (body.action === 'upload' || body.action === 'update') {
      if (!conn || !Host.get(conn.platform)) return res.status(400).json({ error: 'No podcast host is connected. The publisher can connect one at the top of Pod-slap.' });
      var host = Host.get(conn.platform), ep = cleanEp(body);
      if (body.action === 'update') {
        if (!body.id) return res.status(400).json({ error: 'Which draft?' });
        await host.update(cred(conn), String(body.id), ep);
        return res.status(200).json({ ok: true });
      }
      var path = okPath(body.pathname);
      if (!path) return res.status(400).json({ error: 'Bad file path.' });
      var head = await blob.head(path).catch(function () { return null; });
      if (!head) return res.status(404).json({ error: 'The uploaded file is gone. Slap it in again.' });
      var filename = String(body.filename || path.split('/').pop()).replace(/[^A-Za-z0-9._-]+/g, '-').slice(-100) || 'episode.mp3';
      var made = await host.create(cred(conn), { pathname: path, size: head.size, contentType: head.contentType || 'audio/mpeg', filename: filename }, ep);
      blob.del(path).catch(function () {});
      return res.status(200).json({ ok: true, id: made.id, url: made.url, host: host.name });
    }

    if (body.action === 'discard') {
      var dp = okPath(body.pathname);
      if (dp) await blob.del(dp).catch(function () {});
      return res.status(200).json({ ok: true });
    }

    if (body.action === 'connect' || body.action === 'disconnect') {
      if (!isPublisher(ctx)) return res.status(403).json({ error: 'Only the publisher connects the podcast host.' });
      if (body.action === 'disconnect') { await siteBlob.del(CONN).catch(function () {}); return res.status(200).json({ ok: true }); }
      var h = Host.get(body.platform);
      if (!h) return res.status(400).json({ error: 'Pod-slap can upload to Buzzsprout, Transistor or Podbean.' });
      var secret = String(body.secret || '').trim(), clientId = String(body.clientId || '').trim();
      if (!secret || (h.needsClientId && !clientId)) return res.status(400).json({ error: 'Paste the ' + (h.needsClientId ? 'Client ID and Client Secret' : 'API key') + ' first.' });
      if (!require('./_crypto').isConfigured()) return res.status(500).json({ error: 'Secure key storage isn\'t set up on the server (ANALYTICS_ENCRYPTION_KEY).' });
      var shows = await h.shows({ secret: secret, clientId: clientId });
      if (!shows.length) return res.status(400).json({ error: h.name + ' accepted the key but has no podcasts on that account.' });
      var pick = shows.filter(function (s) { return s.id === String(body.showId || ''); })[0] || (shows.length === 1 ? shows[0] : null);
      if (!pick) return res.status(200).json({ shows: shows });
      var c = { platform: body.platform, secretEnc: require('./_crypto').encrypt(secret), clientId: clientId, showId: pick.id, showName: pick.title, at: new Date().toISOString(), by: who };
      await saveConn(c);
      return res.status(200).json({ ok: true, connection: publicConn(c) });
    }

    return res.status(400).json({ error: 'Unknown action.' });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
};

// Per-newsroom: this request runs as the signed-in person's newsroom (_site.js).
module.exports = require('./_site').wrap(module.exports);
