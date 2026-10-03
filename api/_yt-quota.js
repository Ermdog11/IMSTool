// Shared YouTube Data API budget. Every search.list call costs 100 units and
// the key gets 10,000 units (~100 searches) a day, reset at midnight Pacific.
// Five callers (scan.js via youtube.js, the YouTube tab, copyedit's video
// suggestions, transcripts' channel lookups, the beat builder) used to spend
// it independently and blew through it by mid-day (Jeff, 2026-10-03:
// "Quota exceeded for quota metric 'Search Queries'"). They all go through
// take() now, plus a shared Blob cache so warm/cold instances and every open
// tab reuse the same results instead of each searching on its own.
//
// Best-effort like the rest of the Blob state: if Blob is unreachable, take()
// allows the search rather than turning YouTube off.
var { get, put } = require('@vercel/blob');

var DAILY_SEARCHES = 90; // leave headroom under Google's ~100/day
var STATE_PATH = 'youtube/quota.json';

function pacificDay() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

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
  } catch (e) { console.error('yt-quota write failed:', e.message); }
}

async function state() {
  var s = await readJson(STATE_PATH);
  var day = pacificDay();
  if (!s || s.day !== day) s = { day: day, used: 0, exhausted: false };
  return s;
}

// Reserve n searches. Returns false (and reserves nothing) when today's budget
// can't cover them.
async function take(n) {
  n = n || 1;
  var s = await state();
  if (s.exhausted || s.used + n > DAILY_SEARCHES) return false;
  s.used += n;
  await writeJson(STATE_PATH, s);
  return true;
}

// Google said the quota is gone: stop everyone trying again until tomorrow.
async function exhaust() {
  var s = await state();
  s.exhausted = true;
  await writeJson(STATE_PATH, s);
}

function isQuotaError(err) {
  var m = (err && (err.message || (err.errors && err.errors[0] && err.errors[0].reason))) || '';
  return /quota/i.test(m);
}

module.exports = { take: take, exhaust: exhaust, isQuotaError: isQuotaError, readJson: readJson, writeJson: writeJson, DAILY_SEARCHES: DAILY_SEARCHES };
