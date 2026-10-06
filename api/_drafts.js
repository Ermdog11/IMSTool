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

// Where a draft came from, for the Drafts list's filter and badge. Older
// drafts have no `source`, so it's worked out from who wrote them.
function sourceOf(doc) {
  if (doc.source) return doc.source;
  var w = String(doc.writerName || '');
  if (/breaking/i.test(w)) return 'breaking';
  if (/Write it/i.test(w)) return 'alert';
  if (/From social/i.test(w)) return 'social';
  return 'copydesk';
}

async function saveDraft(doc) {
  await put('drafts/' + doc.id + '.json', JSON.stringify(doc), {
    access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json'
  });
  var index = await loadIndex();
  var entry = { id: doc.id, headline: doc.headline || '', writerName: doc.writerName || '', tier: doc.tier || 'free', status: doc.status || 'submitted', updatedAt: doc.updatedAt, createdAt: doc.createdAt || null, sourceUrl: doc.sourceUrl || null, source: sourceOf(doc), ownerId: doc.ownerId || null, ownerEmail: doc.ownerEmail || null };
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

// Whose draft it is (2026-10-06: writers and contributors see only their own,
// unless the publisher switches on "See and edit everyone's drafts" for the
// role; editors see all). ctx is the requireUser* result; cron and in-process
// callers, the publisher, and a newsroom without sign-in see everything.
function canSee(ctx, doc) {
  if (!ctx || !ctx.membership) return true;
  if (ctx.membership.role === 'publisher' || ctx.drafts_all) return true;
  var uid = ctx.user && ctx.user.id, email = String((ctx.user && ctx.user.email) || '').toLowerCase();
  return !!doc && ((doc.ownerId && doc.ownerId === uid) || (doc.ownerEmail && String(doc.ownerEmail).toLowerCase() === email));
}
// Owner fields for a new draft from a signed-in person.
function ownerOf(ctx) {
  return ctx && ctx.user ? { ownerId: ctx.user.id || null, ownerEmail: ctx.user.email || null } : {};
}

// Several at once (bulk delete from the Drafts list): one index write.
async function deleteDrafts(ids) {
  await Promise.all(ids.map(function (id) { return del('drafts/' + id + '.json').catch(function () {}); }));
  var gone = {}; ids.forEach(function (id) { gone[id] = 1; });
  var index = await loadIndex();
  await saveIndex(index.filter(function(e) { return !gone[e.id]; }));
}

// Dedup for anything auto-generated from an external source (e.g. the
// breaking-news auto-draft in rolling-digest.js) — don't draft the same
// story twice just because it's still in the scan window on a later run.
async function findBySourceUrl(url) {
  if (!url) return null;
  var index = await loadIndex();
  return index.find(function(e) { return e.sourceUrl === url; }) || null;
}

module.exports = { canSee: canSee, ownerOf: ownerOf, sourceOf: sourceOf, loadIndex: loadIndex, loadDraft: loadDraft, saveDraft: saveDraft, deleteDraft: deleteDraft, deleteDrafts: deleteDrafts, findBySourceUrl: findBySourceUrl };
