// Editorial Desk draft storage (Vercel Blob). One JSON doc per draft plus a
// small index doc (so listing drafts doesn't depend on Blob's list() API,
// which showed CDN read-after-write lag in the push-subscription work —
// see _push.js). Every read uses useCache:false for the same reason.
var { get, put, del } = require('@vercel/blob');

var INDEX_PATH = 'drafts/index.json';

async function loadIndex() {
  try {
    var result = await get(INDEX_PATH, { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200) return [];
    var data = await new Response(result.stream).json();
    return Array.isArray(data) ? data : [];
  } catch (e) { return []; }
}

async function saveIndex(list) {
  await put(INDEX_PATH, JSON.stringify(list), {
    access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json'
  });
}

async function loadDraft(id) {
  try {
    var result = await get('drafts/' + id + '.json', { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200) return null;
    return await new Response(result.stream).json();
  } catch (e) { return null; }
}

async function saveDraft(doc) {
  await put('drafts/' + doc.id + '.json', JSON.stringify(doc), {
    access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json'
  });
  var index = await loadIndex();
  var entry = { id: doc.id, headline: doc.headline || '', writerName: doc.writerName || '', tier: doc.tier || 'free', status: doc.status || 'submitted', updatedAt: doc.updatedAt };
  var i = index.findIndex(function(e) { return e.id === doc.id; });
  if (i === -1) index.unshift(entry); else index[i] = entry;
  await saveIndex(index);

  // Newsroom knowledge base: every save/submit/edit of this draft updates its
  // one content_items row. Best-effort - never throws, never blocks the draft
  // itself from saving even if Supabase is down or not configured.
  try { await require('./_knowledge').upsertFromDraft(doc); } catch (e) { /* logged inside, swallow here too */ }
}

async function deleteDraft(id) {
  try { await del('drafts/' + id + '.json'); } catch (e) { /* already gone is fine */ }
  var index = await loadIndex();
  await saveIndex(index.filter(function(e) { return e.id !== id; }));
}

module.exports = { loadIndex: loadIndex, loadDraft: loadDraft, saveDraft: saveDraft, deleteDraft: deleteDraft };
