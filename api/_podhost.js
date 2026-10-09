// Podcast hosts Pod-slap can upload an episode to as an unpublished draft
// (api/podslap.js; Jeff, 2026-10-09: "slap (upload) the file and the app
// uploads to their podcast platform and writes a headline and description but
// doesn't publish"). One adapter per host, each with:
//
//   shows(cred)                               -> [{ id, title }]   (also tests the key)
//   create(cred, file, ep)                    -> { id, url }        draft episode with the audio
//   update(cred, id, ep)                      -> {}                 new title/description on the draft
//
//   cred = { secret, clientId, showId }   file = { pathname, size, contentType, filename }
//   ep   = { title, description, tags }
//
// Nothing here ever publishes: Buzzsprout episodes are created private,
// Transistor episodes start as drafts, Podbean episodes are sent with
// status=draft. The audio streams from Vercel Blob straight to the host's
// upload URL (no 4.5MB request limit, nothing held in memory).
//
// Hosts with no public upload API (Amperwave, Megaphone without an enterprise
// key, Libsyn, Spreaker, Simplecast...) aren't here: Pod-slap still writes the
// title and description for them and the person uploads by hand.
var https = require('https');
var { Readable } = require('stream');
var UA = 'CoPublisherAI Pod-slap (https://ims-tool.vercel.app)';

function fail(host, r, d) {
  var msg = (d && (d.error_description || d.error || d.message || (d.errors && JSON.stringify(d.errors)))) || ('HTTP ' + r.status);
  var e = new Error(host + ': ' + String(typeof msg === 'string' ? msg : JSON.stringify(msg)).slice(0, 300));
  e.status = r.status === 401 || r.status === 403 ? 400 : 502;
  return e;
}
async function json(host, url, opts) {
  var r = await fetch(url, opts);
  var t = await r.text();
  var d = null; try { d = t ? JSON.parse(t) : {}; } catch (e) { d = { message: t.slice(0, 200) }; }
  if (!r.ok) throw fail(host, r, d);
  return d;
}

// PUT the uploaded file to a presigned URL, streamed from Blob, with an exact
// Content-Length (S3-style URLs refuse chunked uploads).
async function putFile(url, file, contentType) {
  var blob = require('@vercel/blob');
  var got = await blob.get(file.pathname, { access: 'private', useCache: false });
  if (!got || got.statusCode !== 200 || !got.stream) throw new Error('The uploaded file is gone. Slap it in again.');
  await new Promise(function (resolve, reject) {
    var u = new URL(url);
    var req = https.request({
      method: 'PUT', hostname: u.hostname, path: u.pathname + u.search, port: u.port || 443,
      headers: Object.assign({ 'Content-Length': file.size }, contentType ? { 'Content-Type': contentType } : {})
    }, function (res) {
      var body = '';
      res.on('data', function (c) { if (body.length < 2000) body += c; });
      res.on('end', function () { res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(new Error('Upload to the host failed (HTTP ' + res.statusCode + ') ' + body.slice(0, 200))); });
    });
    req.on('error', reject);
    req.setTimeout(280000, function () { req.destroy(new Error('Upload to the host timed out.')); });
    Readable.fromWeb(got.stream).on('error', reject).pipe(req);
  });
}

// ── Buzzsprout: API token (Account › API access) + podcast id ──────────────
// https://github.com/buzzsprout/buzzsprout-api — episodes are created with
// private:true (unpublished), then start upload -> PUT -> complete.
var buzzsprout = {
  name: 'Buzzsprout',
  keyHelp: 'In Buzzsprout: My Account › API Access (bottom of the page). Copy the API token.',
  dashboard: function (cred, id) { return 'https://www.buzzsprout.com/' + cred.showId + '/episodes/' + id; },
  h: function (cred) { return { Authorization: 'Token token=' + cred.secret, 'User-Agent': UA, Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8' }; },
  shows: async function (cred) {
    var d = await json('Buzzsprout', 'https://www.buzzsprout.com/api/podcasts.json', { headers: this.h(cred) });
    return (Array.isArray(d) ? d : []).map(function (p) { return { id: String(p.id), title: p.title || ('Podcast ' + p.id) }; });
  },
  create: async function (cred, file, ep) {
    var base = 'https://www.buzzsprout.com/api/' + encodeURIComponent(cred.showId);
    var e = await json('Buzzsprout', base + '/episodes.json', { method: 'POST', headers: this.h(cred),
      body: JSON.stringify({ title: ep.title, description: ep.description, tags: (ep.tags || []).join(','), private: true }) });
    var start = await json('Buzzsprout', base + '/episodes/' + e.id + '/uploads', { method: 'POST', headers: this.h(cred),
      body: JSON.stringify({ filename: file.filename, type: file.contentType, byte_size: file.size }) });
    var up = start.upload || start;
    if (!up.upload_url || !up.id) throw new Error('Buzzsprout didn\'t give an upload address.');
    await putFile(up.upload_url, file, null);
    await json('Buzzsprout', base + '/episodes/' + e.id + '/uploads/' + encodeURIComponent(up.id) + '/complete', { method: 'POST', headers: this.h(cred) });
    return { id: String(e.id), url: this.dashboard(cred, e.id) };
  },
  update: async function (cred, id, ep) {
    await json('Buzzsprout', 'https://www.buzzsprout.com/api/' + encodeURIComponent(cred.showId) + '/episodes/' + encodeURIComponent(id) + '.json', { method: 'PUT', headers: this.h(cred),
      body: JSON.stringify({ title: ep.title, description: ep.description, tags: (ep.tags || []).join(','), private: true }) });
    return {};
  }
};

// ── Transistor: API key (Account › API) + show id ──────────────────────────
// authorize_upload -> PUT -> create the episode with that audio_url. New
// episodes are drafts until someone publishes them in Transistor.
var transistor = {
  name: 'Transistor',
  keyHelp: 'In Transistor: your account menu › Account Settings › API Key. Copy the key.',
  dashboard: function () { return 'https://dashboard.transistor.fm/'; },
  h: function (cred) { return { 'x-api-key': cred.secret, 'User-Agent': UA, Accept: 'application/json' }; },
  shows: async function (cred) {
    var d = await json('Transistor', 'https://api.transistor.fm/v1/shows?pagination[per]=50', { headers: this.h(cred) });
    return (d.data || []).map(function (s) { return { id: String(s.id), title: (s.attributes && s.attributes.title) || ('Show ' + s.id) }; });
  },
  form: function (ep, extra) {
    var f = new URLSearchParams();
    f.set('episode[title]', ep.title); f.set('episode[description]', ep.description);
    f.set('episode[summary]', String(ep.description || '').split('\n')[0].slice(0, 250));
    if (ep.tags && ep.tags.length) f.set('episode[keywords]', ep.tags.join(','));
    Object.keys(extra || {}).forEach(function (k) { f.set(k, extra[k]); });
    return f;
  },
  create: async function (cred, file, ep) {
    var a = await json('Transistor', 'https://api.transistor.fm/v1/episodes/authorize_upload?filename=' + encodeURIComponent(file.filename), { headers: this.h(cred) });
    var at = (a.data && a.data.attributes) || {};
    if (!at.upload_url || !at.audio_url) throw new Error('Transistor didn\'t give an upload address.');
    await putFile(at.upload_url, file, at.content_type || file.contentType);
    var e = await json('Transistor', 'https://api.transistor.fm/v1/episodes', { method: 'POST',
      headers: Object.assign(this.h(cred), { 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: this.form(ep, { 'episode[show_id]': cred.showId, 'episode[audio_url]': at.audio_url }).toString() });
    var id = e.data && e.data.id;
    return { id: String(id || ''), url: this.dashboard(cred, id) };
  },
  update: async function (cred, id, ep) {
    await json('Transistor', 'https://api.transistor.fm/v1/episodes/' + encodeURIComponent(id), { method: 'PATCH',
      headers: Object.assign(this.h(cred), { 'Content-Type': 'application/x-www-form-urlencoded' }), body: this.form(ep).toString() });
    return {};
  }
};

// ── Podbean: client ID + secret (Podbean API app) ──────────────────────────
// OAuth client credentials -> uploadAuthorize -> PUT -> episode with
// status=draft. One Podbean app is tied to one podcast, so no show id.
var podbean = {
  name: 'Podbean',
  needsClientId: true,
  keyHelp: 'In Podbean: developers.podbean.com › Manage Apps › create an app for your podcast. Copy its Client ID and Client Secret.',
  dashboard: function () { return 'https://www.podbean.com/dashboard'; },
  token: async function (cred) {
    var d = await json('Podbean', 'https://api.podbean.com/v1/oauth/token', { method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(cred.clientId + ':' + cred.secret).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: 'grant_type=client_credentials' });
    if (!d.access_token) throw new Error('Podbean didn\'t accept that Client ID and Secret.');
    return d.access_token;
  },
  shows: async function (cred) {
    var t = await this.token(cred);
    var d = await json('Podbean', 'https://api.podbean.com/v1/podcast?access_token=' + encodeURIComponent(t), { headers: { 'User-Agent': UA } });
    var p = d.podcast || {};
    return [{ id: String(p.id || 'podbean'), title: p.title || 'Your Podbean podcast' }];
  },
  create: async function (cred, file, ep) {
    var t = await this.token(cred);
    var a = await json('Podbean', 'https://api.podbean.com/v1/files/uploadAuthorize?access_token=' + encodeURIComponent(t) +
      '&filename=' + encodeURIComponent(file.filename) + '&filesize=' + file.size + '&content_type=' + encodeURIComponent(file.contentType), { headers: { 'User-Agent': UA } });
    if (!a.presigned_url || !a.file_key) throw new Error('Podbean didn\'t give an upload address.');
    await putFile(a.presigned_url, file, file.contentType);
    var f = new URLSearchParams({ access_token: t, title: ep.title, content: ep.description.replace(/\n/g, '<br>'), status: 'draft', type: 'public', media_key: a.file_key });
    var e = await json('Podbean', 'https://api.podbean.com/v1/episodes', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA }, body: f.toString() });
    var epi = e.episode || {};
    return { id: String(epi.id || ''), url: this.dashboard() };
  },
  update: async function (cred, id, ep) {
    var t = await this.token(cred);
    var f = new URLSearchParams({ access_token: t, title: ep.title, content: ep.description.replace(/\n/g, '<br>'), status: 'draft', type: 'public' });
    await json('Podbean', 'https://api.podbean.com/v1/episodes/' + encodeURIComponent(id), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA }, body: f.toString() });
    return {};
  }
};

var HOSTS = { buzzsprout: buzzsprout, transistor: transistor, podbean: podbean };
module.exports = { HOSTS: HOSTS, get: function (k) { return HOSTS[k] || null; } };
