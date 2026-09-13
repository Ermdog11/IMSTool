// Site-wide settings (currently just the house style guide) — used both by
// the Content Editor (api/house-style.js, browser-facing) and by anything
// server-side that needs to write in-house-style without a browser involved
// (the breaking-news auto-draft in api/rolling-digest.js).

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

module.exports = { getHouseStyle: getHouseStyle, saveHouseStyle: saveHouseStyle };
