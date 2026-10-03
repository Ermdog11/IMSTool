// Pages that look fresh to a search engine but aren't news: team hubs,
// rosters, schedules, reference pages, single-play video clips, box scores,
// stat and player-profile pages. A search API dates a result by when it was
// last crawled, so a clip from last season ("DJ Wagner Sinks a 3-Pointer vs.
// Tennessee", Jeff 2026-10-03) can land in today's feed looking brand new.
// Shared by _web-search.js, _google-search.js and scan.js so they can't drift.

var HUB_URL_PATTERNS = [
  /espn\.com\/(?:college-football|mens-college-basketball|womens-college-basketball)\/team\//i,
  /cbssports\.com\/(?:college-football|college-basketball)\/teams\//i,
  /sports\.yahoo\.com\/(?:ncaaf|ncaab)\/teams\//i,
  /si\.com\/college\/maryland\/?$/i,
  /sports-reference\.com/i,
  /en\.wikipedia\.org\/wiki\//i,
  /umterps\.com\/?$/i,
  /umterps\.com\/sports\/[a-z-]+\/(?:roster|schedule)\/?$/i,
  /247sports\.com\/college\/maryland\/?$/i,
  /on3\.com\/teams\//i,
  /rivals\.com\/team\//i,
  /(?:^|\/)(?:teams|team)\/maryland-terrapins\/?$/i
];

// Video clips, box scores, stat tables and player bios — evergreen pages on
// any site, matched by URL shape. YouTube is left out: its results come from
// youtube.js with real upload dates and their own rating rules.
var STATIC_URL_PATTERNS = [
  /\/(?:video|videos|clip|clips|watch)\//i,
  /[?&](?:videoid|video_id|clip)=/i,
  /\/(?:boxscore|box-score|box_score|stats|statistics|gamecast|playbyplay|play-by-play|matchup)(?:\/|$|\?)/i,
  /\/(?:player|players|athlete|athletes|roster)\/[^/]+(?:\/[^/]*)?$/i,
  /umterps\.com\/sports\/[a-z-]+\/roster\//i
];

// Headline shapes of a single-play clip ("X Sinks a 3-Pointer vs. Tennessee",
// "X Throws Down a Dunk Against Y") and of stat/box-score pages.
var STATIC_TITLE_PATTERNS = [
  /\b(?:sinks|drains|buries|hits|knocks down|nails|splashes|throws down|slams|hammers|rejects|swats|blocks|finishes|scores|converts|finds|connects|hauls in)\s+(?:a|an|the)\s+(?:[\w-]+\s+){0,2}(?:3-pointer|three-pointer|three|trey|dunk|jam|jumper|layup|lay-up|and-one|alley-oop|block|bucket|touchdown|td|field goal|interception|pick-six|goal)\b.{0,30}\bvs\.?\s/i,
  /\b(?:box score|game stats|player stats|season stats|career stats|stats & bio|player bio|player profile)\b/i
];

function isStaticPage(url, title) {
  url = String(url || '');
  title = String(title || '');
  if (/(?:youtube\.com|youtu\.be)\//i.test(url)) return false;
  // A result in the headline ("in 1-0 win", "beats") means a game story, not a clip.
  var gameStory = /\b\d+-\d+\b|\b(?:win|wins|won|loss|loses|lost|beats|defeats|falls|tops|upsets|rallies)\b/i.test(title);
  return HUB_URL_PATTERNS.some(function(re) { return re.test(url); }) ||
    STATIC_URL_PATTERNS.some(function(re) { return re.test(url); }) ||
    (!gameStory && STATIC_TITLE_PATTERNS[0].test(title)) ||
    STATIC_TITLE_PATTERNS[1].test(title);
}

module.exports = { isStaticPage: isStaticPage };
