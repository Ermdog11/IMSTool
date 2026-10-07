// The newsroom's transcript library (Jeff, 2026-10-06: "there should be a
// transcript library that all transcripts are auto saved with descriptive
// titles and dates"). Every finished transcript from the Transcribe tab (an
// uploaded file, a link, a YouTube video, a live tab or mic session) is saved
// here for the whole newsroom, with a short descriptive title written by
// Claude from the opening of the transcript ("Mike Locksley weekly press
// conference: third-down woes, QB update") and the date.
//
// Vercel Blob, same pattern as _drafts.js: one JSON doc per transcript plus a
// small index (reads use useCache:false). Best-effort: a failed title falls
// back to the source's own name.
var { get, put, del } = require('./_site-blob');

var INDEX_PATH = 'transcripts/index.json';
var MAX = 2000;

async function readJson(path) {
  try {
    var r = await get(path, { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200) return null;
    return await new Response(r.stream).json();
  } catch (e) { return null; }
}
function writeJson(path, data) {
  return put(path, JSON.stringify(data), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
}
function itemPath(id) { return 'transcripts/items/' + String(id).replace(/[^A-Za-z0-9_-]/g, '_') + '.json'; }

async function list() { var l = await readJson(INDEX_PATH); return Array.isArray(l) ? l : []; }
function load(id) { return readJson(itemPath(id)); }

function plainText(data) {
  var us = (data && data.utterances) || [];
  return us.length ? us.map(function (u) { return u.text; }).join(' ') : String((data && data.text) || '');
}

// A descriptive title from the opening of the transcript.
async function titleFor(text, sourceName, names) {
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key || !text.trim()) return null;
  try {
    var beat = await require('./_beat').getBeat(require('./_supabase').isConfigured() ? require('./_supabase').admin() : null).catch(function () { return null; });
    var who = Object.keys(names || {}).map(function (k) { return 'Speaker ' + k + ' = ' + names[k]; }).join('; ');
    var r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 200,
        tools: [{ name: 'name_transcript', description: 'Give the transcript a title.', input_schema: { type: 'object', properties: { title: { type: 'string', description: 'Who is speaking and what it is, then the main topics: under 90 characters, no date, no quotes. E.g. "Mike Locksley weekly press conference: third-down woes, QB update".' } }, required: ['title'] } }],
        tool_choice: { type: 'tool', name: 'name_transcript' },
        messages: [{ role: 'user', content: ('This is a transcript for ' + ((beat && beat.outletName) || 'a sports newsroom') + ', which covers ' + ((beat && beat.coverage) || 'its beat') + '. Source: ' + (sourceName || 'unknown') + (who ? '. Speakers: ' + who : '') + '.\n\nOPENING OF THE TRANSCRIPT:\n' + text.slice(0, 6000) + '\n\nCall name_transcript. Name a speaker only if the transcript or the speaker names make clear who it is.').toWellFormed() }]
      })
    });
    var d = await r.json();
    var t = ((d.content || []).filter(function (b) { return b.type === 'tool_use'; })[0] || {}).input;
    return t && t.title ? String(t.title).replace(/^["“]|["”]$/g, '').slice(0, 120) : null;
  } catch (e) { return null; }
}

function entryOf(doc) {
  return { id: doc.id, title: doc.title, createdAt: doc.createdAt, updatedAt: doc.updatedAt, source: doc.source, sourceName: doc.sourceName || '',
    duration: doc.duration || null, speakers: doc.speakers || 0, by: doc.by || '', byId: doc.byId || null, snippet: plainText(doc).slice(0, 160) };
}

// Save (or refresh) one transcript. A transcript already in the library keeps
// its title unless it has none.
async function save(input, by) {
  var id = String(input.id || '').slice(0, 120);
  if (!id) throw new Error('id required');
  var now = new Date().toISOString();
  var doc = (await load(id)) || { id: id, createdAt: now, by: (by && by.email) || '', byId: (by && by.id) || null };
  doc.source = input.source || doc.source || 'file';
  doc.sourceName = input.sourceName || doc.sourceName || '';
  doc.sourceUrl = input.sourceUrl || doc.sourceUrl || '';
  if (input.data) {
    doc.utterances = (input.data.utterances || []).map(function (u) { return { speaker: u.speaker == null ? null : u.speaker, start: u.start || 0, end: u.end || null, text: String(u.text || '') }; });
    doc.text = doc.utterances.length ? '' : String(input.data.text || '');
    doc.duration = input.data.duration || doc.duration || null;
    if (input.data.auto != null) doc.auto = !!input.data.auto;
    // Spots the transcriber wasn't sure of (api/transcribe.js unsureSpans).
    if (Array.isArray(input.data.unsure)) doc.unsure = input.data.unsure.slice(0, 60).map(function (x) {
      return { start: x.start || 0, end: x.end || null, text: String(x.text || '').slice(0, 200), before: String(x.before || '').slice(0, 200), after: String(x.after || '').slice(0, 200), confidence: Number(x.confidence) || null };
    });
  }
  if (input.names) doc.names = input.names;
  if (Array.isArray(input.breaks)) doc.breaks = input.breaks.filter(Number.isInteger).slice(0, 5000);
  var sp = {}; (doc.utterances || []).forEach(function (u) { if (u.speaker != null) sp[u.speaker] = 1; });
  doc.speakers = Object.keys(sp).length;
  if (!doc.title) doc.title = (await titleFor(plainText(doc), doc.sourceName, doc.names)) || doc.sourceName || 'Transcript';
  doc.updatedAt = now;
  await writeJson(itemPath(id), doc);
  var idx = (await list()).filter(function (e) { return e.id !== id; });
  idx.unshift(entryOf(doc));
  await writeJson(INDEX_PATH, idx.slice(0, MAX));
  return doc;
}

async function update(id, patch) {
  var doc = await load(id);
  if (!doc) { var e = new Error('Not found'); e.status = 404; throw e; }
  if (patch.title != null && String(patch.title).trim()) doc.title = String(patch.title).trim().slice(0, 160);
  if (patch.names) doc.names = patch.names;
  if (Array.isArray(patch.breaks)) doc.breaks = patch.breaks.filter(Number.isInteger).slice(0, 5000);
  doc.updatedAt = new Date().toISOString();
  await writeJson(itemPath(id), doc);
  var idx = await list();
  var i = idx.findIndex(function (e) { return e.id === id; });
  if (i >= 0) idx[i] = entryOf(doc); else idx.unshift(entryOf(doc));
  await writeJson(INDEX_PATH, idx);
  return doc;
}

async function remove(id) {
  try { await del(itemPath(id)); } catch (e) {}
  var idx = (await list()).filter(function (e) { return e.id !== id; });
  await writeJson(INDEX_PATH, idx);
}

module.exports = { list: list, load: load, save: save, update: update, remove: remove, titleFor: titleFor };
