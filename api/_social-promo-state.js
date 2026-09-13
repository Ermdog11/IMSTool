// Per-site state for the Bluesky promo bot (api/social-promo-check.js):
// the on/off toggle (publisher-controlled, off by default) and which of our
// own posts have already gotten a promo reply, so a still-hot post doesn't
// get replied to twice. Same Vercel Blob pattern as _hot-story.js/_push.js —
// small enough not to need a database table.
var { get, put } = require('@vercel/blob');

var PATH = 'social-promo-state.json';

async function loadAll() {
  try {
    var result = await get(PATH, { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200) return {};
    var data = await new Response(result.stream).json();
    return (data && typeof data === 'object') ? data : {};
  } catch (e) { return {}; }
}

async function saveAll(state) {
  await put(PATH, JSON.stringify(state), {
    access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json'
  });
}

async function isEnabled(siteSlug) {
  var state = await loadAll();
  return !!(state[siteSlug] && state[siteSlug].enabled);
}

async function setEnabled(siteSlug, enabled) {
  var state = await loadAll();
  state[siteSlug] = Object.assign({}, state[siteSlug], { enabled: !!enabled });
  await saveAll(state);
}

async function alreadyRepliedUris(siteSlug) {
  var state = await loadAll();
  return (state[siteSlug] && state[siteSlug].repliedUris) || [];
}

async function markReplied(siteSlug, uris) {
  var state = await loadAll();
  var site = state[siteSlug] || {};
  var existing = site.repliedUris || [];
  // Keep the list from growing forever — only the most recent 200 matter for dedup.
  site.repliedUris = existing.concat(uris).slice(-200);
  state[siteSlug] = site;
  await saveAll(state);
}

module.exports = {
  isEnabled: isEnabled,
  setEnabled: setEnabled,
  alreadyRepliedUris: alreadyRepliedUris,
  markReplied: markReplied
};
