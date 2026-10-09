// What writers and editors can see and use in the Content Editor and the
// News Monitor, chosen by
// the publisher on /preferences (Jeff, 2026-10-05: "the publisher should
// always have the checkbox to edit an article into site style, but he should
// choose on preferences whether the writer sees it on his Content Editor
// screen").
//
// Stored in the site profile as editorAccess: { writer: { <key>: false }, editor: {...} }.
// Anything not set falls back to the role's default (ROLE_DEFAULTS below),
// which is "allowed" unless listed. The publisher always has everything.
//
// Roles (2026-10-06, Jeff approved): publisher; editor (the desk: everything
// but team, setup, keys and ad code); writer (staff: own drafts only, no
// analytics, Opp Watch read-only); contributor (freelancers: the Content
// Editor only, own drafts only); viewer (read-only News Monitor). The pages hide what's
// off; the routes below refuse it too, so hiding isn't the only lock.
// Keep FEATURES in sync with ACCESS_FEATURES in public/preferences.html.

var FEATURES = [
  { key: 'use_monitor',    label: 'Access the News Monitor' },
  { key: 'use_editor',     label: 'Access the Content Editor' },
  { key: 'drafts_all',     label: 'See and edit everyone\'s drafts (off: only their own)' },
  { key: 'mode_edit',      label: 'Full edit: rewrite in house style' },
  { key: 'mode_keep',      label: 'Keep my words: review only' },
  { key: 'mode_links',     label: 'Hotlinks only' },
  { key: 'add_with_edit',  label: 'Add podcast, related links and promos' },
  { key: 'ask_editor',     label: 'Ask the editor (chat)' },
  { key: 'act_fact_check', label: 'Extra fact-check' },
  { key: 'tab_transcribe', label: 'Transcribe' },
  { key: 'tab_podslap',    label: 'Pod-slap (upload a podcast episode as a draft, with its title and description)' },
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
  { key: 'mon_source_health', label: 'Source health (which news sources are working)' },
  { key: 'mon_roster',     label: 'Roster watch' },
  { key: 'mon_opps',       label: 'Opp Watch' },
  { key: 'mon_calendar',   label: 'Calendar' },
  { key: 'mon_leaderboard', label: 'Writer leaderboard', hidden: true },
  // News Monitor actions
  { key: 'act_write_story',label: 'Write it: draft an article from an alert or story idea' },
  { key: 'act_flag_block', label: 'Flag junk and block sources for the whole newsroom' },
  { key: 'act_x_follow',   label: 'Change which X accounts are followed' },
  { key: 'act_opps_edit',  label: 'Change who Opp Watch follows and its alerts' }
];

var ROLES = ['publisher', 'editor', 'writer', 'contributor', 'viewer'];
var MON = FEATURES.filter(function (f) { return /^mon_/.test(f.key); }).map(function (f) { return f.key; });
var ACT = FEATURES.filter(function (f) { return /^act_/.test(f.key); }).map(function (f) { return f.key; });
var EDITOR_TOOLS = FEATURES.filter(function (f) { return /^(mode_|tab_)/.test(f.key) || f.key === 'add_with_edit' || f.key === 'ask_editor'; }).map(function (f) { return f.key; });
function offs(keys) { var o = {}; keys.forEach(function (k) { o[k] = false; }); return o; }
// The writer leaderboard is off for everyone but the publisher until the
// publisher turns it on for a role, and while off it's not even listed for
// them (hidden: resolve() leaves it out, the route answers 404).
var ROLE_DEFAULTS = {
  editor: { mon_leaderboard: false },
  writer: { drafts_all: false, mon_analytics: false, act_opps_edit: false, mon_leaderboard: false },
  contributor: Object.assign(offs(['use_monitor', 'drafts_all', 'tab_writers', 'tab_inserts', 'tab_podslap'].concat(MON, ACT)), { act_fact_check: true }),
  viewer: Object.assign(offs(['use_editor', 'drafts_all', 'mon_analytics'].concat(ACT, EDITOR_TOOLS)))
};

function can(profile, role, key) {
  if (!role || role === 'publisher') return true;
  var a = profile && profile.editorAccess && profile.editorAccess[role];
  if (a && a[key] === false) return false;
  if (a && a[key] === true) return true;
  return (ROLE_DEFAULTS[role] || {})[key] !== false;
}

// Every switch for one role, for /api/me (the pages read it from there).
function resolve(profile, role) {
  var out = {};
  FEATURES.forEach(function (f) {
    var ok = can(profile, role, f.key);
    if (f.hidden && !ok) return; // off and hidden: don't even list it
    out[f.key] = ok;
  });
  return out;
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

module.exports = { FEATURES: FEATURES, ROLES: ROLES, ROLE_DEFAULTS: ROLE_DEFAULTS, can: can, resolve: resolve, allowed: allowed, deny: deny };
