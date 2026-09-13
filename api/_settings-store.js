// Site-wide settings: the house style guide, and the Brave Search API key
// used to give the news scanner a real open-ended web search alongside its
// curated RSS feeds. Used both by the Content Editor / Settings UI
// (browser-facing) and by anything server-side that needs these without a
// browser involved (the breaking-news auto-draft, the scan cron).

var Crypto = require('./_crypto');

var SITE_SLUG = 'insidemdsports';
var siteIdCache = null;

async function resolveSiteId(sb) {
  if (siteIdCache) return siteIdCache;
  var r = await sb.from('sites').select('id').eq('slug', SITE_SLUG).single();
  if (r.error || !r.data) throw new Error('Settings store: site row missing (run db/schema.sql)');
  siteIdCache = r.data.id;
  return siteIdCache;
}

// Best-effort — a missing/unconfigured Supabase just means no shared house
// style yet, callers fall back to their own default rather than erroring.
async function getHouseStyle(sb) {
  try {
    var siteId = await resolveSiteId(sb);
    var q = await sb.from('site_settings').select('house_style_guide').eq('site_id', siteId).single();
    if (q.error || !q.data) return null;
    return q.data.house_style_guide || null;
  } catch (e) {
    return null;
  }
}

async function saveHouseStyle(sb, guide) {
  var siteId = await resolveSiteId(sb);
  var up = await sb.from('site_settings').upsert({
    site_id: siteId, house_style_guide: guide, updated_at: new Date().toISOString()
  }, { onConflict: 'site_id' });
  if (up.error) throw new Error(up.error.message);
  return { ok: true };
}

// Best-effort — no key saved yet is a normal, common state (scan.js just
// skips web search and falls back to RSS-only, same as always).
async function getWebSearch(sb) {
  try {
    var siteId = await resolveSiteId(sb);
    var q = await sb.from('site_settings').select('web_search_api_key').eq('site_id', siteId).single();
    if (q.error || !q.data || !q.data.web_search_api_key) return null;
    return { apiKey: Crypto.decrypt(q.data.web_search_api_key) };
  } catch (e) {
    return null;
  }
}

async function saveWebSearch(sb, apiKey) {
  var siteId = await resolveSiteId(sb);
  var up = await sb.from('site_settings').upsert({
    site_id: siteId, web_search_api_key: Crypto.encrypt(apiKey), updated_at: new Date().toISOString()
  }, { onConflict: 'site_id' });
  if (up.error) throw new Error(up.error.message);
  return { ok: true };
}

async function deleteWebSearch(sb) {
  var siteId = await resolveSiteId(sb);
  var up = await sb.from('site_settings').update({
    web_search_api_key: null, updated_at: new Date().toISOString()
  }).eq('site_id', siteId);
  if (up.error) throw new Error(up.error.message);
  return { ok: true };
}

module.exports = {
  getHouseStyle: getHouseStyle, saveHouseStyle: saveHouseStyle,
  getWebSearch: getWebSearch, saveWebSearch: saveWebSearch, deleteWebSearch: deleteWebSearch
};
