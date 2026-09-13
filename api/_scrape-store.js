// A publisher's own logged-in session for a paywalled outlet (247Sports
// today), so the style-drift scraper (api/_publish-match.js) can read full
// article bodies instead of whatever's visible before the paywall meter
// cuts in. Encrypted at rest (api/_crypto.js) and, deliberately, never
// decrypted or even returned anywhere except inside the scraper itself —
// the status endpoint only ever reports connected/not-connected.

var Crypto = require('./_crypto');

async function getCookie(sb, siteId, source) {
  var q = await sb.from('scrape_sessions').select('cookie').eq('site_id', siteId).eq('source', source).single();
  if (q.error || !q.data) return null;
  try { return Crypto.decrypt(q.data.cookie); } catch (e) { return null; }
}

async function status(sb, siteId, source) {
  var q = await sb.from('scrape_sessions').select('updated_at').eq('site_id', siteId).eq('source', source).single();
  if (q.error || !q.data) return { connected: false };
  return { connected: true, updatedAt: q.data.updated_at };
}

async function saveCookie(sb, siteId, source, cookie, userId) {
  var up = await sb.from('scrape_sessions').upsert({
    site_id: siteId, source: source, cookie: Crypto.encrypt(cookie), connected_by: userId, updated_at: new Date().toISOString()
  }, { onConflict: 'site_id,source' }).select('source').single();
  if (up.error) throw new Error(up.error.message);
  return up.data;
}

async function deleteCookie(sb, siteId, source) {
  var del = await sb.from('scrape_sessions').delete().eq('site_id', siteId).eq('source', source);
  if (del.error) throw new Error(del.error.message);
  return { ok: true };
}

module.exports = { getCookie: getCookie, status: status, saveCookie: saveCookie, deleteCookie: deleteCookie };
