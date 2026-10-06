// Vercel Cron can occasionally deliver the same scheduled run twice: on
// 2026-10-02 /api/coverage-desk started twice in the same second, which
// would have meant two copies of the memo. Each emailing cron calls claim()
// first; only the first delivery for that job and period gets true.
//
// Only for real cron deliveries: a manual "send now" (signed-in member or
// in-process call) is never blocked. Fails open: if Blob is unreachable the
// job runs, since a duplicate email beats a missing one.

var PREFIX = 'cron-once/';

async function claim(job, period) {
  var path = PREFIX + job + '/' + period + '.json';
  try {
    var blob = require('./_site-blob');
    var existing = await blob.head(path).catch(function() { return null; });
    if (existing) return false;
    // allowOverwrite:false makes the write itself fail if another delivery
    // created the marker between our check and now.
    await blob.put(path, JSON.stringify({ at: new Date().toISOString() }), {
      access: 'private', addRandomSuffix: false, allowOverwrite: false, contentType: 'application/json'
    });
    return true;
  } catch (e) {
    if (/already exists/i.test(e && e.message || '')) return false;
    return true;
  }
}

// UTC date, e.g. "2026-10-05": the period for once-a-day jobs.
function today() { return new Date().toISOString().slice(0, 10); }

module.exports = { claim: claim, today: today };
