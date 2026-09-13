// Small per-site "which stories have we already alerted on, and when" state
// for api/hot-story-check.js. Same Vercel Blob pattern as _push.js /
// _roster.js — a handful of entries, not worth a database table.
var { get, put } = require('@vercel/blob');

var STATE_PATH = 'hot-story-state.json';

async function loadState() {
  try {
    var result = await get(STATE_PATH, { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200) return {};
    var data = await new Response(result.stream).json();
    return (data && typeof data === 'object') ? data : {};
  } catch (e) { return {}; }
}

async function saveState(state) {
  await put(STATE_PATH, JSON.stringify(state), {
    access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json'
  });
}

module.exports = { loadState: loadState, saveState: saveState };
