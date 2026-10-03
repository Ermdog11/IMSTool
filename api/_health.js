// Health alerts: tell the publisher when the app is broken instead of failing
// silently (2026-10-03: Claude credits ran out on 9/24 and nobody knew for 8
// days while every digest, X scan and Coverage Desk memo failed).
//
// Fed automatically by S.requireUserOrCron (api/_supabase.js), which wraps the
// response of every guarded route:
//   - any response that mentions Claude's "credit balance is too low" error
//     -> immediate email (at most every 6 hours while it lasts)
//   - a scheduled job (Vercel Cron) that fails twice in a row -> one email,
//     then an "all clear" email when it next succeeds
// GET /api/health returns the open problems for the in-app banner.
//
// State is one small Blob JSON. Best-effort throughout: a problem here must
// never break the job it's watching.

var KEY = 'health-state.json';
var CREDIT_RE = /credit balance is too low|insufficient[_ ]credit|billing/i;
var REPEAT_MS = 6 * 3600 * 1000;

async function load() {
  try {
    var blob = require('@vercel/blob');
    var got = await blob.get(KEY, { access: 'private', useCache: false });
    if (got && got.statusCode === 200) return await new Response(got.stream).json();
  } catch (e) {}
  return { jobs: {}, credit: null };
}
async function save(st) {
  try {
    await require('@vercel/blob').put(KEY, JSON.stringify(st), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
  } catch (e) { console.error('health save failed:', e.message); }
}

function to() { return process.env.HEALTH_EMAIL || process.env.ALERT_EMAIL || undefined; }
async function mail(subject, html) {
  try {
    await require('./_mailer').sendMail({
      to: to(), subject: subject,
      html: '<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px">' + html +
        '<p style="font-size:12px;color:#888;margin-top:16px">CoPublisher AI health alert. Open the app: https://ims-tool.vercel.app</p></div>'
    });
  } catch (e) { console.error('health email failed:', e.message); }
}
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').slice(0, 600); }
function errText(status, body) {
  if (body && typeof body === 'object') {
    var e = body.error || body.message || (body.success === false ? 'failed' : '');
    if (e) return typeof e === 'string' ? e : JSON.stringify(e);
  }
  return status >= 500 ? 'HTTP ' + status : '';
}

// Called once per response of a guarded route.
async function record(job, isCron, status, body) {
  var err = errText(status, body);
  var raw = '';
  try { raw = JSON.stringify(body || '').slice(0, 4000); } catch (e) {}
  var credit = CREDIT_RE.test(err) || /credit balance is too low/i.test(raw);
  if (!credit && !isCron) return; // only scheduled jobs are tracked for repeated failures

  var st = await load(); st.jobs = st.jobs || {};
  var now = Date.now(), dirty = false;

  if (credit) {
    if (!st.credit) st.credit = { since: now };
    st.credit.lastAt = now; st.credit.job = job;
    if (!st.credit.alertedAt || now - st.credit.alertedAt > REPEAT_MS) {
      st.credit.alertedAt = now;
      await mail('⚠️ CoPublisher is out of Claude credits',
        '<p><b>Claude credits have run out.</b> Scans, digests, breaking-news drafts, Coverage Desk and the Content Editor are paused until credits are added.</p>' +
        '<p><a href="https://console.anthropic.com/settings/billing" style="background:#2563eb;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none">Add credits</a></p>' +
        '<p style="font-size:12px;color:#666">First noticed by: ' + esc(job) + '</p>');
    }
    dirty = true;
  } else if (st.credit && !err) {
    // Any clean response after a credit outage means credits are back.
    var since = st.credit.since; st.credit = null; dirty = true;
    await mail('✅ CoPublisher: Claude credits are working again', '<p>Claude calls are succeeding again (outage started ' + new Date(since).toUTCString() + ').</p>');
  }

  if (isCron) {
    var j = st.jobs[job] || { fails: 0 };
    if (err) {
      j.fails = (j.fails || 0) + 1; j.lastError = err.slice(0, 500); j.lastAt = now;
      if (!j.since) j.since = now;
      if (j.fails >= 2 && !j.alertedAt && !credit) {
        j.alertedAt = now;
        await mail('⚠️ CoPublisher: ' + job + ' is failing',
          '<p>The scheduled job <b>' + esc(job) + '</b> has failed ' + j.fails + ' times in a row.</p><p style="font-family:monospace;font-size:12px;background:#f5f7fb;padding:8px;border-radius:6px">' + esc(j.lastError) + '</p>');
      }
      st.jobs[job] = j; dirty = true;
    } else if (j.fails) {
      if (j.alertedAt) await mail('✅ CoPublisher: ' + job + ' is working again', '<p><b>' + esc(job) + '</b> succeeded after ' + j.fails + ' failures.</p>');
      delete st.jobs[job]; dirty = true;
    }
  }
  if (dirty) await save(st);
}

// Wraps res so record() runs before the response is sent (the function
// stays alive until the response ends).
function watch(req, res, isCron) {
  if (!res || res.__healthWatched || typeof res.json !== 'function') return;
  res.__healthWatched = true;
  var job = String((req && req.url) || '').split('?')[0].replace(/^\/api\//, '') || 'unknown';
  var slot = String((req && req.url) || '').match(/[?&]slot=([a-z]+)/);
  if (slot) job += ' (' + slot[1] + ')';
  var code = 200;
  var origStatus = res.status && res.status.bind(res);
  if (origStatus) res.status = function (c) { code = c; return origStatus(c); };
  var origJson = res.json.bind(res);
  res.json = function (body) {
    record(job, isCron, code, body).catch(function () {}).then(function () { origJson(body); });
    return res;
  };
}

async function problems() {
  var st = await load(), out = [];
  if (st.credit) out.push({ kind: 'credit', since: st.credit.since, message: 'Claude credits ran out. Scans, digests and the Content Editor are paused until credits are added.', link: 'https://console.anthropic.com/settings/billing' });
  Object.keys(st.jobs || {}).forEach(function (k) {
    var j = st.jobs[k];
    if (j.fails >= 2) out.push({ kind: 'job', job: k, since: j.since, fails: j.fails, message: k + ' has failed ' + j.fails + ' times in a row: ' + String(j.lastError || '').slice(0, 160) });
  });
  return out;
}

module.exports = { watch: watch, record: record, problems: problems };
