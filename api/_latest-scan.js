// The newsroom's latest full scan, shared by every open News Monitor tab.
// Each tab used to run its own full scan (~$0.20-0.30 of Claude) every 30
// minutes, so cost grew with every editor who left the dashboard open. Now a
// tab asks for the shared copy (scan.js, body.shared): it gets the stored
// result if it's fresh, and only the first tab to find it stale runs a new
// scan while a short lock tells the others to keep showing the stored one.
// The 3x/day digest scans save here too. Blob, best-effort like the other
// small state: a failed read just means that request runs its own scan.
var { get, put } = require('./_site-blob');

var LATEST_PATH = 'scans/latest.json';
var LOCK_PATH = 'scans/lock.json';
var LOCK_MS = 6 * 60 * 1000; // a full scan takes ~150s; a crashed one frees the lock after this

async function readJson(path) {
  try {
    var r = await get(path, { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200) return null;
    return await new Response(r.stream).json();
  } catch (e) { return null; }
}

async function writeJson(path, data) {
  try {
    await put(path, JSON.stringify(data), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
  } catch (e) { console.error('latest-scan write failed:', e.message); }
}

// { at, response } or null
function load() { return readJson(LATEST_PATH); }

async function save(response) {
  await writeJson(LATEST_PATH, { at: Date.now(), response: response });
  await writeJson(LOCK_PATH, { at: 0 });
}

// True if this request may run the scan (nobody else is mid-scan).
async function claim() {
  var lock = await readJson(LOCK_PATH);
  if (lock && lock.at && Date.now() - lock.at < LOCK_MS) return false;
  await writeJson(LOCK_PATH, { at: Date.now() });
  return true;
}

// A scan that failed lets the next tab try right away instead of waiting out the lock.
function release() { return writeJson(LOCK_PATH, { at: 0 }); }

module.exports = { load: load, save: save, claim: claim, release: release };
