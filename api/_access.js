// What writers and editors can see and use in the Content Editor and the
// News Monitor, chosen by
// the publisher on /preferences (Jeff, 2026-10-05: "the publisher should
// always have the checkbox to edit an article into site style, but he should
// choose on preferences whether the writer sees it on his Content Editor
// screen").
//
// Stored in the site profile as editorAccess: { writer: { <key>: false }, editor: {...} }.
// Anything not set is allowed, so a newsroom that never opens the page keeps
// everything. The publisher always has everything. The pages hide what's
// off; the routes below refuse it too, so hiding isn't the only lock.
// Keep FEATURES in sync with ACCESS_FEATURES in public/preferences.html.

var FEATURES = [
  { key: 'mode_edit',      label: 'Full edit: rewrite in house style' },
  { key: 'mode_keep',      label: 'Keep my words: review only' },
  { key: 'mode_links',     label: 'Hotlinks only' },
  { key: 'add_with_edit',  label: 'Add podcast, related links and promos' },
  { key: 'ask_editor',     label: 'Ask the editor (chat)' },
  { key: 'tab_transcribe', label: 'Transcribe' },
  { key: 'tab_social',     label: 'From social' },
  { key: 'tab_house_style',label: 'House style' },
  { key: 'tab_writers',    label: 'Writers' },
  { key: 'tab_inserts',    label: 'Inserts' },
  { key: 'tab_drafts',     label: 'Drafts' },
  // News Monitor sections (Alerts and Settings are always shown)
  { key: 'mon_digest',     label: 'Nightly digest' },
  { key: 'mon_social',     label: 'Hot social' },
  { key: 'mon_chat',       label: 'Team chat' },
  { key: 'mon_backlog',    label: 'Story backlog' },
  { key: 'mon_recruiting', label: 'Recruiting tracker' },
  { key: 'mon_trending',   label: 'Trending' },
  { key: 'mon_podcasts',   label: 'Podcasts' },
  { key: 'mon_youtube',    label: 'YouTube' },
  { key: 'mon_bluesky',    label: 'Bluesky' },
  { key: 'mon_analytics',  label: 'Analytics (traffic and audience numbers)' },
  { key: 'mon_roster',     label: 'Roster watch' },
  { key: 'mon_opps',       label: 'Opp Watch' },
  // News Monitor actions
  { key: 'act_write_story',label: 'Write it: draft an article from an alert or story idea' },
  { key: 'act_flag_block', label: 'Flag junk and block sources for the whole newsroom' },
  { key: 'act_x_follow',   label: 'Change which X accounts are followed' }
];

function can(profile, role, key) {
  if (!role || role === 'publisher') return true;
  var a = profile && profile.editorAccess && profile.editorAccess[role];
  return !(a && a[key] === false);
}

// For a route: true when the caller may use `key`. Cron/internal/open calls
// (no membership) always may. Best-effort: a failed profile read allows.
async function allowed(ctx, key) {
  var role = ctx && ctx.membership && ctx.membership.role;
  if (!role || role === 'publisher') return true;
  try {
    var profile = await require('./_settings-store').getProfile(ctx.supabase || require('./_supabase').admin());
    return can(profile, role, key);
  } catch (e) { return true; }
}

function deny(res) {
  return res.status(403).json({ error: 'Your publisher has turned this off for your role. Ask them to change it in Permissions & preferences.' });
}

module.exports = { FEATURES: FEATURES, can: can, allowed: allowed, deny: deny };
