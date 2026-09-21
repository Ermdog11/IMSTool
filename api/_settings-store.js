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

// Best-effort, same shape as getWebSearch — no key saved yet just means
// api/x-scan.js's cron has nothing to do this run.
async function getXSearch(sb) {
  try {
    var siteId = await resolveSiteId(sb);
    var q = await sb.from('site_settings').select('x_bearer_token').eq('site_id', siteId).single();
    if (q.error || !q.data || !q.data.x_bearer_token) return null;
    return { bearerToken: Crypto.decrypt(q.data.x_bearer_token) };
  } catch (e) {
    return null;
  }
}

async function saveXSearch(sb, bearerToken) {
  var siteId = await resolveSiteId(sb);
  var up = await sb.from('site_settings').upsert({
    site_id: siteId, x_bearer_token: Crypto.encrypt(bearerToken), updated_at: new Date().toISOString()
  }, { onConflict: 'site_id' });
  if (up.error) throw new Error(up.error.message);
  return { ok: true };
}

async function deleteXSearch(sb) {
  var siteId = await resolveSiteId(sb);
  var up = await sb.from('site_settings').update({
    x_bearer_token: null, updated_at: new Date().toISOString()
  }).eq('site_id', siteId);
  if (up.error) throw new Error(up.error.message);
  return { ok: true };
}

// Blocked sources, flagged junk, own-outlet excludes, hidden items — used to
// live only in browser localStorage (never followed the editor between
// browsers). Shared per newsroom, same as house style / search keys above.
var FEED_PREF_COLUMNS = {
  blockedSources: 'blocked_sources',
  flaggedStories: 'flagged_stories',
  ownSiteExclude: 'own_site_exclude',
  hiddenVideos: 'hidden_videos'
};

async function getFeedPrefs(sb) {
  var out = { blockedSources: [], flaggedStories: [], ownSiteExclude: [], hiddenVideos: [] };
  try {
    var siteId = await resolveSiteId(sb);
    var q = await sb.from('site_settings')
      .select('blocked_sources, flagged_stories, own_site_exclude, hidden_videos')
      .eq('site_id', siteId).single();
    if (q.error || !q.data) return out;
    out.blockedSources = q.data.blocked_sources || [];
    out.flaggedStories = q.data.flagged_stories || [];
    out.ownSiteExclude = q.data.own_site_exclude || [];
    out.hiddenVideos = q.data.hidden_videos || [];
    return out;
  } catch (e) {
    return out;
  }
}

async function saveFeedPrefs(sb, fields) {
  var siteId = await resolveSiteId(sb);
  var update = { site_id: siteId, updated_at: new Date().toISOString() };
  var touched = false;
  Object.keys(FEED_PREF_COLUMNS).forEach(function (key) {
    if (Array.isArray(fields[key])) { update[FEED_PREF_COLUMNS[key]] = fields[key]; touched = true; }
  });
  if (!touched) throw new Error('No recognized fields.');
  var up = await sb.from('site_settings').upsert(update, { onConflict: 'site_id' });
  if (up.error) throw new Error(up.error.message);
  return { ok: true };
}

module.exports = {
  getHouseStyle: getHouseStyle, saveHouseStyle: saveHouseStyle,
  getWebSearch: getWebSearch, saveWebSearch: saveWebSearch, deleteWebSearch: deleteWebSearch,
  getXSearch: getXSearch, saveXSearch: saveXSearch, deleteXSearch: deleteXSearch,
  getFeedPrefs: getFeedPrefs, saveFeedPrefs: saveFeedPrefs
};
