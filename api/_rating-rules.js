// The publisher-editable rating rules behind the setup wizard (/setup). The
// wizard (public/setup.html) shows these same event keys as plain-language
// choices; api/scan.js turns a saved profile into a block of rules appended
// to its rating prompt, overriding the built-in defaults where they differ.

var LEVELS = {
  breaking: { rating: 5, label: 'Breaking (5)' },
  major: { rating: 4, label: 'Major (4)' },
  normal: { rating: 3, label: 'Normal (3)' },
  low: { rating: 2, label: 'Low (2)' },
  ignore: { rating: 1, label: 'Ignore (1)' }
};

// Defaults match the rules InsideMDSports runs on today.
var EVENTS = [
  { key: 'commitment', label: 'A recruit commits or decommits', def: 'breaking' },
  { key: 'transfer', label: 'A player transfers in or out (portal entry or new school)', def: 'breaking' },
  { key: 'coaching_change', label: 'Head coach hired, fired or leaving', def: 'breaking' },
  { key: 'major_injury', label: 'Season-ending or major injury', def: 'breaking' },
  { key: 'legal', label: 'Suspension, arrest or legal trouble', def: 'breaking' },
  { key: 'assistant_change', label: 'Assistant coach or staff hire or departure', def: 'major' },
  { key: 'offer_visit', label: 'Scholarship offer or recruit visit', def: 'major' },
  { key: 'minor_injury', label: 'Day-to-day or minor injury update', def: 'major' },
  { key: 'game_result', label: 'Game result (the first report, not follow-ups)', def: 'normal' },
  { key: 'alumni_pro', label: 'Former players in the pros (routine coverage)', def: 'low' },
  { key: 'opponent_news', label: "Another team's recruiting or roster news", def: 'low' },
  { key: 'weekly_media', label: "Coach's weekly show, press conference or podcast", def: 'low' },
  { key: 'previews', label: 'Previews, predictions and rankings', def: 'low' }
];

function list(v) {
  return (Array.isArray(v) ? v : String(v || '').split(/\n|,/))
    .map(function (x) { return String(x).trim(); }).filter(Boolean);
}

// Returns '' when the profile has nothing rating-related, so scans for a site
// that never ran the wizard behave exactly as before.
function promptBlock(profile) {
  profile = profile || {};
  var out = [];
  var rules = profile.rules || {};
  var ruleLines = EVENTS.filter(function (e) { return LEVELS[rules[e.key]]; }).map(function (e) {
    var lv = LEVELS[rules[e.key]];
    return '- ' + e.label + ': rating ' + lv.rating + (rules[e.key] === 'breaking' ? ' (breaking)' : '');
  });
  if (ruleLines.length) out.push('Rate these kinds of stories at exactly this level when they involve our beat:\n' + ruleLines.join('\n'));

  var sports = profile.sports || {};
  var core = list(sports.core), some = list(sports.secondary), never = list(sports.ignore);
  if (core.length) out.push('Our core sports: ' + core.join(', ') + '.');
  if (some.length) out.push('Sports we cover occasionally (cap routine stories at 3): ' + some.join(', ') + '.');
  if (never.length) out.push('Sports we never cover (always rating 1): ' + never.join(', ') + '.');

  if (profile.alwaysBreaking) out.push('Also always breaking for us: ' + String(profile.alwaysBreaking).slice(0, 1500));
  if (profile.neverBreaking) out.push('Never breaking for us (cap at 2): ' + String(profile.neverBreaking).slice(0, 1500));

  var names = list(profile.watchNames).slice(0, 400);
  if (names.length) out.push('Additional people to watch (treat stories about them as on our beat): ' + names.join(', '));

  if (!out.length) return '';
  return "\n\nPUBLISHER'S OWN SETTINGS (from the newsroom's setup wizard). Where these conflict with any rule above, these win:\n" + out.join('\n');
}

// Regex for sports the publisher never covers, or null to keep scan.js's default.
function ignoreSportsRegex(profile) {
  var never = list(((profile || {}).sports || {}).ignore);
  if (!never.length) return null;
  return new RegExp('\\b(' + never.map(function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|') + ')\\b', 'i');
}

module.exports = { LEVELS: LEVELS, EVENTS: EVENTS, promptBlock: promptBlock, ignoreSportsRegex: ignoreSportsRegex };
