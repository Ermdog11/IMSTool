// The newsroom's BEAT PROFILE: everything the scanner needs to know about the
// team or topic a newsroom covers, so nothing in the scanning code is about
// any one team. Maryland is just InsideMDSports' profile.
//
// Where it lives: site_settings.profile.beat (written by the setup wizard).
// A newsroom with no saved beat falls back to a seed file in api/_beats/<slug>.json
// when one exists — InsideMDSports' seed is its hand-tuned feed list and
// watchlist exactly as they were hard-coded in scan.js, so its scans are
// unchanged.
//
// Shape (every field optional except team.name):
//   outletName, team:{name, school, short, nicknames[], level:'college'|'pro'|'high school',
//   conference, city}, coverage, subject, primarySports[], sportsEnum[], coreBeatsText,
//   lowPrioritySports[], keyFigures[], nameCollisions, proLeaguesText,
//   ownSite:{url, articlePath, domains[]}, excludeSources[], relevanceWords[],
//   topicStopwords[], outlets:[{name, domain, rss?, rating?}], subreddits[],
//   feeds:[{url,name,src?,requireBeat?,isAtom?}]  (explicit list; generated when absent),
//   reddit:[{url,name}], watch:[{label, names[], alumni?}]
//
// `rating` (1-5) on outlets, feeds and watch groups is the publisher's own
// importance score from the setup wizard; see weightNote().

var SEEDS = { insidemdsports: function () { return require('./_beats/insidemdsports.json'); } };
var DEFAULT_SLUG = 'insidemdsports';

function list(v) {
  return (Array.isArray(v) ? v : String(v || '').split(/\n|,/)).map(function (x) { return String(x).trim(); }).filter(Boolean);
}

// Fill in everything derivable from the basics so callers never need to
// null-check. Explicit values in the saved profile always win.
function normalize(b) {
  b = JSON.parse(JSON.stringify(b || {}));
  var t = b.team = b.team || {};
  t.name = t.name || 'our team';
  t.short = t.short || t.name.split(' ')[0];
  t.nicknames = list(t.nicknames);
  t.level = t.level || 'college';
  b.outletName = b.outletName || 'our outlet';
  b.coverage = b.coverage || ((t.school && t.name.indexOf(t.school) !== 0 ? t.school + ' ' : '') + t.name + (t.level === 'college' ? ' athletics' : ''));
  b.subject = b.subject || (t.name + (t.level === 'college' ? ' athletics' : ''));
  b.primarySports = list(b.primarySports).length ? list(b.primarySports) : ['football', 'basketball'];
  b.sportsEnum = list(b.sportsEnum).length ? list(b.sportsEnum) : b.primarySports.slice();
  b.coreBeatsText = b.coreBeatsText || b.primarySports.join(', ');
  b.lowPrioritySports = list(b.lowPrioritySports);
  b.keyFigures = list(b.keyFigures);
  b.proLeaguesText = b.proLeaguesText || (t.level === 'pro' ? 'other pro teams' : 'the pros');
  b.ownSite = b.ownSite || {};
  b.ownSite.domains = list(b.ownSite.domains);
  b.excludeSources = list(b.excludeSources).map(function (s) { return s.toLowerCase(); });
  if (b.outletName && b.excludeSources.indexOf(b.outletName.toLowerCase()) === -1) b.excludeSources.push(b.outletName.toLowerCase());
  b.relevanceWords = list(b.relevanceWords).map(function (s) { return s.toLowerCase(); });
  if (!b.relevanceWords.length) {
    var people = [];
    (b.watch || []).forEach(function (g) { if (!g.alumni && Number(g.rating || 3) > 1) people = people.concat(list(g.names)); });
    b.relevanceWords = [t.name].concat(t.nicknames, b.keyFigures, people, b.primarySports.map(function (s) { return t.short + ' ' + s; }))
      .map(function (s) { return s.replace(/\s*\(.*?\)\s*/g, '').trim().toLowerCase(); }).filter(function (s) { return s.length > 3; });
  }
  b.topicStopwords = list(b.topicStopwords).length ? list(b.topicStopwords)
    : [t.short, t.school || '', t.conference || '', 'university', 'college', 'ncaa', 'the'].concat(t.nicknames).filter(Boolean).map(function (s) { return s.toLowerCase(); });
  b.watch = (b.watch || []).map(function (g) {
    var o = { label: g.label || 'People', names: list(g.names), alumni: !!g.alumni };
    if (g.rating) o.rating = Number(g.rating);
    return o;
  }).filter(function (g) { return g.names.length; });
  // Communities: plain strings (seed) or { name, rating } (wizard).
  ['subreddits', 'podcasts', 'youtube'].forEach(function (k) {
    b[k] = (Array.isArray(b[k]) ? b[k] : list(b[k])).map(function (x) { return typeof x === 'string' ? { name: x } : x; })
      .filter(function (x) { return x && x.name; });
  });
  b.outlets = (b.outlets || []).filter(function (o) { return o && o.name; });
  // "Block all results from this source": its stories are dropped wherever
  // they show up (Google News, Bing, anywhere), not just its own feed.
  b.outlets.forEach(function (o) {
    if (!o.blocked) return;
    [o.name, o.domain].forEach(function (x) {
      x = String(x || '').toLowerCase().trim();
      if (x && b.excludeSources.indexOf(x) === -1) b.excludeSources.push(x);
    });
  });
  return b;
}

async function getBeat(sb, siteSlug) {
  var slug = siteSlug || DEFAULT_SLUG;
  var saved = null;
  try {
    if (sb) {
      var profile = await require('./_settings-store').getProfile(sb);
      if (profile && profile.beat && profile.beat.team && profile.beat.team.name) saved = profile.beat;
    }
  } catch (e) { /* fall through to seed */ }
  // The saved profile is layered over the seed, so a newsroom with a
  // hand-tuned seed (InsideMDSports) keeps its explicit feed list while the
  // wizard edits names, outlets, people and ratings on top of it.
  var seed = SEEDS[slug] ? SEEDS[slug]() : null;
  if (seed && saved) saved = Object.assign({}, seed, saved, { team: Object.assign({}, seed.team, saved.team) });
  return normalize(saved || seed || {});
}

// ── Feeds ─────────────────────────────────────────────────────────────────
function gnews(q) { return 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=en-US&gl=US&ceid=US:en'; }
function bing(q) { return 'https://www.bing.com/news/search?q=' + encodeURIComponent(q) + '&format=rss'; }
function quoted(s) { return '"' + s + '"'; }
function orJoin(arr) { return arr.map(quoted).join(' OR '); }
function chunks(arr, n) { var out = []; for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

// Built for a newsroom that has no hand-tuned feed list: search feeds from the
// team's names, people and outlets. Every generic search is relevance-filtered
// (requireBeat) because it can't be as precise as a hand-written query.
function generateFeeds(b) {
  var t = b.team, feeds = [];
  var names = [t.name].concat(t.nicknames.map(function (n) { return n; }));
  var teamQ = orJoin(names.slice(0, 4));
  var mainName = quoted(t.name);
  feeds.push({ url: gnews(teamQ), name: 'GNews/core' });
  feeds.push({ url: gnews(orJoin(b.primarySports.map(function (s) { return t.short + ' ' + s; }))), name: 'GNews/sports', requireBeat: true });

  // People, highest-rated groups first, ~6 names per query.
  var people = [];
  b.watch.slice().sort(function (a, c) { return (c.rating || 3) - (a.rating || 3); }).forEach(function (g) {
    if ((g.rating || 3) <= 1) return;
    g.names.forEach(function (n) { var clean = n.replace(/\s*\(.*?\)\s*/g, '').trim(); if (clean && people.indexOf(clean) === -1) people.push(clean); });
  });
  chunks(people.slice(0, 60), 6).forEach(function (c, i) { feeds.push({ url: gnews(orJoin(c)), name: 'GNews/people' + (i + 1), requireBeat: true }); });

  // Angle feeds.
  var angles = [['injuries', 'injury OR "ruled out" OR "day-to-day" OR suspension OR "out for the season"'],
    ['rankings', 'ranking OR "power rankings" OR poll'],
    ['scheduling', '"game time" OR kickoff OR announced OR "TV schedule"'],
    ['depthchart', '"depth chart" OR "starting lineup" OR "position battle"']];
  if (t.level === 'college' || t.level === 'high school') {
    angles.push(['recruiting', 'commit OR commitment OR "official visit" OR offer OR "transfer portal"']);
    angles.push(['portal', '"transfer portal" OR transfer OR decommit']);
  } else {
    angles.push(['moves', 'trade OR signs OR released OR waived OR "free agent" OR contract']);
  }
  angles.forEach(function (a) { feeds.push({ url: gnews(mainName + ' ' + a[1]), name: 'GNews/' + a[0] }); });

  // National outlets that cover every team.
  [['espn.com', 'ESPN'], ['cbssports.com', 'CBS Sports'], ['sports.yahoo.com', 'Yahoo Sports'], ['si.com', 'Sports Illustrated'],
    ['foxsports.com', 'FOX Sports'], ['nytimes.com', 'The Athletic']].concat(t.level === 'college' ? [['on3.com', 'On3'], ['rivals.com', 'Rivals']] : [])
    .forEach(function (o) {
      feeds.push({ url: gnews(names.slice(0, 2).map(function (n) { return 'site:' + o[0] + ' ' + quoted(n); }).join(' OR ')), name: o[1].replace(/\s+/g, ''), src: o[1] });
    });

  // The publisher's own list of outlets on this beat (from the wizard).
  b.outlets.forEach(function (o) {
    if (o.blocked || Number(o.rating || 3) <= 1) return;
    var f = outletFeed(b, o); if (f) feeds.push(f);
  });

  feeds.push({ url: bing(mainName), name: 'Bing/team' });
  if (b.keyFigures.length) feeds.push({ url: bing(orJoin(b.keyFigures.slice(0, 5))), name: 'Bing/figures', requireBeat: true });
  return feeds;
}

function outletFeed(b, o) {
  var names = [b.team.name].concat(b.team.nicknames);
  if (o.rss) return { url: o.rss, name: o.name, src: o.name, requireBeat: true };
  if (o.domain) return { url: gnews(names.slice(0, 2).map(function (n) { return 'site:' + o.domain + ' ' + quoted(n); }).join(' OR ')), name: o.name, src: o.name };
  return null;
}
function feedMatchesOutlet(f, o) {
  var u = ''; try { u = decodeURIComponent(f.url).toLowerCase(); } catch (e) { u = String(f.url).toLowerCase(); }
  if (o.domain && u.indexOf(String(o.domain).toLowerCase().replace(/^www\./, '')) !== -1) return true;
  var n = String(o.name).toLowerCase();
  return (f.src && f.src.toLowerCase() === n) || (f.name && f.name.toLowerCase() === n);
}
function feedsFor(b) {
  if (!(b.feeds && b.feeds.length)) return generateFeeds(b);
  // Hand-tuned list: outlets the publisher rated 1 drop out, and outlets it
  // added that the list doesn't already search get their own feed.
  var off = b.outlets.filter(function (o) { return o.blocked || Number(o.rating || 3) <= 1; });
  var feeds = b.feeds.filter(function (f) { return !off.some(function (o) { return feedMatchesOutlet(f, o); }); });
  b.outlets.forEach(function (o) {
    if (o.blocked || Number(o.rating || 3) <= 1 || feeds.some(function (f) { return feedMatchesOutlet(f, o); })) return;
    var f = outletFeed(b, o); if (f) feeds.push(f);
  });
  return feeds;
}

function subName(s) { return String(s.name || s).replace(/^\/?r\//i, '').trim(); }
function redditFor(b) {
  var offSubs = b.subreddits.filter(function (s) { return Number(s.rating || 3) <= 1; }).map(function (s) { return subName(s).toLowerCase(); });
  if (b.reddit && b.reddit.length) return b.reddit.filter(function (r) { return !offSubs.some(function (s) { return r.url.toLowerCase().indexOf('/r/' + s + '/') !== -1; }); });
  var out = b.subreddits.filter(function (s) { return Number(s.rating || 3) > 1; })
    .sort(function (x, y) { return Number(y.rating || 3) - Number(x.rating || 3); }).slice(0, 3).map(function (s) {
    s = subName(s);
    return { url: 'https://www.reddit.com/r/' + s + '/new.json?limit=40', name: 'Reddit/' + s };
  });
  out.push({ url: 'https://www.reddit.com/search.json?q=' + encodeURIComponent(quoted(b.team.name)) + '&sort=new&limit=25', name: 'Reddit/sitewide' });
  return out;
}

// ── Matching helpers ──────────────────────────────────────────────────────
function isRelevant(b, text) {
  text = String(text || '').toLowerCase();
  return b.relevanceWords.some(function (w) { return text.indexOf(w) !== -1; });
}
function topicStopRegex(b) {
  var esc = b.topicStopwords.map(function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); });
  return new RegExp('^(' + esc.map(function (s) { return s === 'the' ? 'the ' : s; }).join('|') + ')', 'i');
}
function ownDomainRegex(b) {
  if (!b.ownSite.domains.length) return null;
  return new RegExp(b.ownSite.domains.map(function (d) { return d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|'));
}
function ownArticleRegex(b) {
  if (!b.ownSite.articlePath) return null;
  var p = b.ownSite.articlePath.replace(/\/+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(p + '\\/(?:article|longformarticle)\\/[a-z0-9-]+-\\d{6,}', 'g');
}
function alumniNames(b) {
  var out = [];
  b.watch.forEach(function (g) { if (g.alumni && Number(g.rating || 3) > 1) out = out.concat(g.names); });
  return out;
}

// ── Rating prompt ─────────────────────────────────────────────────────────
function watchListText(b) {
  var t = b.team;
  return 'PEOPLE TO WATCH — current/recent ' + t.short + ' roster, commits, targets, staff, and alumni. Use this to confirm identity (see NAME COLLISIONS above) and to recognize names you might otherwise miss:\n' +
    b.watch.filter(function (g) { return Number(g.rating || 3) > 1; }).map(function (g) { return g.label + ': ' + g.names.join(', '); }).join('\n');
}

function primary(b) { return b.team.short + ' ' + b.primarySports.join(' or '); }
function nick(b) { return b.team.nicknames[0] || b.team.short; }

function ratingPrompt(b, today) {
  var t = b.team, S = t.short, N = nick(b), P = b.primarySports.join(' or ');
  var college = t.level !== 'pro';
  var collisions = b.nameCollisions || ('e.g. a pro athlete on another team who shares a name with a ' + S + ' player is NOT that player');
  return 'You are a sports news editor for ' + b.outletName + ' covering ' + b.coverage + '. Today is ' + today + '.\n\nRate and categorize ALL of these stories. Return ONLY a JSON array, no other text. Include EVERY story.\n\nEach object must have:\n- idx: the story number (1-based)\n- headline: a cleaned-up version of the ORIGINAL headline — fix grammar, clarity, length, and clickbait only. DO NOT add or change any factual detail that is not already in the original: player positions (WR, QB, DE, guard...), jersey numbers, class year, height/weight, star ratings, team or school names, coaches, scores, stats, or dates. If the original does not state a player\'s position or role, do not put one in. When unsure, keep the original wording.\n- source: the [Source] shown\n- time: e.g. "2h ago"\n- rating: 1-5 (5=breaking news, 4=major, 3=solid, 2=minor, 1=filler)\n- category: one of: recruiting, football, basketball, alumni, social, podcast, news\n- sport: ' + b.sportsEnum.join(', ') + ', or other\n- summary: one factual sentence based only on what the headline/source actually says — do not invent positions, numbers, quotes, or outcomes\n- irrelevant: true if the story has NO genuine connection to ' + b.subject + ', its coaches, players, recruits, or notable alumni (e.g. a random local charity story, general weather/campus news). These will be discarded.\n- needsContext: true if the headline and snippet do NOT give you enough to confidently judge the ' + S + ' relevance or the rating — e.g. a national roundup/ranking/preview that might bury a ' + S + ' player or angle, a vague headline, or a story where you suspect a stronger ' + N + ' angle exists in the body. We will pull the full article for these and re-rate.\n\nSome stories include a "snippet:" line — the opening of the article. Use it. If a snippet is present and still not enough, set needsContext:true.\n\nNAME COLLISIONS: many alumni share their name with unrelated athletes in other sports (' + collisions + '). Before tagging any story category:"alumni", use your own knowledge to confirm the person in the story is actually the former ' + S + ' athlete — check that their sport, team history, or position matches the real ' + S + ' alum, not just the name. If the story is clearly about a different person who merely shares the name, set irrelevant:true.\n\n' + watchListText(b) + '\n- republished: true if this appears to be a recycled/republished article about events that clearly happened weeks or months ago (e.g. a recruiting visit scheduled in a prior month, an old signing, a past season result being re-reported, an old controversy or quote resurfacing). Use today\'s date AND your knowledge of when events actually happened to judge this — if you recognize the underlying event as occurring more than 2 weeks ago, set republished true even if the article timestamp is recent. Be especially suspicious of aggregators (MSN, Yahoo, Sports Illustrated syndication) which frequently republish old stories with fresh timestamps. If a story references a SPECIFIC past game, match, ceremony, or event (e.g. a ' + (b.pastEventExample || S + '-rival basketball game') + ', a bowl game, a signing day, "spotted at", "sharing hugs at", "was in attendance at"), check whether that event actually happened in the last ~2 weeks — if it is from a prior season or months ago, set republished:true no matter how recent the timestamp looks. Set false only for genuinely new stories.\n\nPRIORITY — ALWAYS RATE 5, no discretion, for any of these when they relate to ' + primary(b) + ':\n' +
    (college ? '- A recruiting commitment or decommitment (any class, any star rating) — ' + P + '.\n- A player transferring — entering the portal, or committing to/leaving ' + S + ' via transfer.\n' : '- A trade, signing or release involving a current player.\n') +
    '- A coaching change — a coach (head or assistant, ' + P + ') hired, fired, or leaving for another job.\n- A major injury to a current player (season-ending, surgery, or a significant new injury update) — ' + P + '.\nThese are rating 5 even if the headline is otherwise plain or the source is minor — the EVENT is what makes it breaking, not the writeup. Do not downgrade one of these to 4 just because it seems like routine roster news.\n\nPRIORITY — ALWAYS RATE 4, no discretion, for any of these when they relate to ' + primary(b) + ' (the one-tier-down version of the rating-5 list above — same categories, earlier or lower-stakes stage):\n' +
    (college ? '- A scholarship offer extended to a recruit, or a recruit taking/scheduling an official or unofficial visit (not yet a commitment — that\'s rating 5).\n- A player entering the transfer portal, or being linked/rumored to ' + S + ' via transfer, before any commitment is confirmed.\n' : '- A credible trade or signing rumor involving the team, before anything is confirmed.\n') +
    '- An assistant coach or lower-profile staff hire/departure (a head coach change is rating 5).\n- A day-to-day, probable, or minor injury update / designation change for a current player (season-ending or a major new injury is rating 5).\nSame rule as above: the event puts it here regardless of how the headline reads or how minor the source seems.\n\nOutside those categories, rating 5 is reserved for a genuinely new, surprising ' + S + ' development of the same weight — a suspension, arrest or legal action involving a player or coach, an eligibility ruling, a player leaving the team, or a major program announcement (a new head coach contract, a facility or conference move). Rating 4 is for real ' + S + ' news a writer would likely cover today. Everything else is 3 or lower.\n\nNOT BREAKING — never rate these above 3, however they are worded or whoever posts them:\n' +
    (college ? '- Another school\'s recruiting or roster news: an opponent\'s recruiting board, commit list, class ranking or offer list, or a recruit committing somewhere else, UNLESS the recruit was a known ' + S + ' target or commit (then it is ' + S + ' news and the rules above apply).\n' : '- Another team\'s roster news, UNLESS it directly involves ' + S + ' (a trade partner, a former ' + S + ' player).\n') +
    '- A coach\'s or player\'s regularly scheduled media: a weekly radio or TV show, coach\'s call-in show, weekly press conference, podcast appearance or media availability. These are 2-3. Rate on the NEWS only if something said there is itself new and major (an injury, a starter change, a departure), in which case rate that news, not the appearance.\n- Previews, predictions, picks, power rankings, depth charts with no change, schedule or kickoff-time announcements, ticket or promotional posts, and opinion or reaction to known news.\n\nFOLLOW-UP COVERAGE OF AN ALREADY-CONCLUDED EVENT IS NOT BREAKING, no matter how many different outlets keep publishing about it. A completed game (any final score/result, win or loss, however big the upset) is newsworthy ONCE — the first recap right after it happened. Every additional piece about that SAME already-final game — a late recap, "X takeaways," analysis, reaction, a fantasy/power-rankings mention, syndicated re-coverage from a different outlet — is NOT rating 4-5 just because it references a big result. Rate those on whether they contain a genuinely NEW fact you have not already seen in this batch or would not already know (an injury revealed during the game, a suspension, a coach fired over it, a real quote breaking news of its own) — otherwise cap at 2-3, and 1 if it is pure reaction/analysis with nothing new. Apply the exact same logic to an already-known player injury: the ORIGINAL announcement is major (per the injury rules above), but a later mention of that SAME known status — a standard injury report listing, "still out," a fantasy-impact writeup — with no new development is routine, rating 1-2, even though the injury itself was once serious. If several stories in this batch are clearly about the same underlying event, only the single most substantive one should rate as high as the event itself warrants; the rest are follow-up coverage under this rule.\n\nFor former ' + S + ' players now in the ' + b.proLeaguesText + ' (see ' + b.proLeaguesText + ' alumni lists above): rate routine pro coverage (fantasy analysis, practice notes, game recaps, rankings) 1-2. Only rate 3+ for major news (trades, signings, serious injuries, milestones) or stories with a genuine ' + S + '/' + N + ' angle. IMPORTANT: ' + b.proLeaguesText + ' trades, signings, and roster moves from the most recent offseason (this past spring or summer) are OLD NEWS now — if a story reports a trade/signing that you know happened months ago (e.g. an offseason ' + (b.proLeagueExample || 'pro') + ' trade being re-reported), set republished:true even though the article looks fresh.\n\nFor Reddit posts: if the post is fan discussion, opinion, or a question rather than actual news, give it rating 1. Only rate Reddit posts 3+ if they report genuine news (commitments, injuries, hires, transfers, reports).\n\nFor X/Twitter posts (source starts with @): a post tagged [WATCHED ACCOUNT] is from a publisher-curated ' + S + ' beat source — treat it as inherently credible, judge purely on newsworthiness, never downrate for low engagement or an unfamiliar name. Everything else already cleared a minimum-engagement bar to reach you, so genuine reach/virality is already established there too — do not downrate one just for being a social post. What matters is WHO is posting and WHAT they are reporting: a known beat reporter, credible outlet account, or the team/player\'s own account reporting real news (a commitment, injury, transfer, hire) rates 4-5 exactly like any other breaking story. A post that only quotes a coach or player from a show, presser or interview, or shares another team\'s news, follows the NOT BREAKING rules above. An unverified claim, rumor, or hot take from an account you don\'t recognize as a credible source should rate lower (2-3) AND get needsContext:true — flag it for verification rather than reporting it as settled fact. Fan reaction, jokes, or pure opinion with no actual news in it is rating 1, same as Reddit.\n\nFor items marked [VIDEO] (YouTube): rate by news value the same as an article. Rate 4-5 for: genuine breaking or major news from a credible channel (a beat reporter or outlet breaking a commitment, injury, hire, transfer, or real report); OR a substantive sit-down interview, press conference, podcast episode, or one-on-one whose subject is a KEY ' + S + ' figure — a head coach' + (b.keyFigures.length ? ' (' + b.keyFigures.join(', ') + ')' : '') + ', a current starter or high-profile recruit/commit, the ' + (college ? 'athletic director' : 'general manager') + ', or a well-known alum (5 if the interview itself breaks news, otherwise 4). Routine analysis, previews, opinion/reaction videos, quick soundbites, sideline clips, watch-alongs, highlight reels, and generic "news roundup" videos are rating 1-2 no matter the view count or who is briefly quoted.\n\n' +
    (b.lowPrioritySports.length ? 'LOW-PRIORITY SPORTS: We almost never cover these. ALWAYS rate a story that is primarily about one of them as rating 1, no matter how newsworthy it seems: ' + b.lowPrioritySports.join(', ') + '. Our core beats are ' + b.coreBeatsText + '.\n\n' : 'Our core beats are ' + b.coreBeatsText + '.\n\n') +
    'Include ALL stories. Do not skip any.';
}

function deepPrompt(b) {
  var S = b.team.short;
  return 'You are the same ' + b.outletName + ' editor covering ' + b.coverage + '. Each item below is a story re-checked with its full article text. Return the CORRECTED rating now that you can see the body. Return ONLY a JSON array; each object: {"idx": <number, matching the number shown>, "rating": 1-5, "irrelevant": <bool>, "summary": "<one factual sentence, no invented facts>", "category": "recruiting|football|basketball|alumni|social|podcast|news", "sport": "' + b.sportsEnum.concat(['other']).join('|') + '"}. Scale: 5=breaking, 4=major, 3=solid, 2=minor, 1=filler. irrelevant:true ONLY if the article has no real ' + b.team.name + ' connection. If a national piece meaningfully covers a ' + S + ' player/recruit/coach/alum, rate that ' + S + ' angle (usually 2-4).' +
    (b.lowPrioritySports.length ? ' Stories primarily about ' + b.lowPrioritySports.slice(0, -1).join(', ') + ', or ' + b.lowPrioritySports[b.lowPrioritySports.length - 1].replace(/ & diving$/, '') + ' stay rating 1.' : '') + '\n\n';
}

// The publisher's 1-5 importance ratings from the setup wizard, as a note for
// the rater. Unrated (3) items add nothing, so a newsroom that never rated
// anything gets exactly the base prompt.
function weightNote(b) {
  var out = [];
  function bucket(items, nameOf) {
    var by = {};
    items.forEach(function (x) { var r = Number(x.rating || 3); if (r !== 3 && r > 1) (by[r] = by[r] || []).push(nameOf(x)); });
    return by;
  }
  var o = bucket(b.outlets.filter(function (x) { return !x.blocked; }), function (x) { return x.name; });
  if (o[5] || o[4] || o[2]) {
    out.push('SOURCE IMPORTANCE (the publisher\'s own ratings of the outlets on this beat):' +
      (o[5] ? '\n- Must-watch (5): ' + o[5].join(', ') + '. Treat their reporting as the most credible on this beat; a real development they report deserves its full rating.' : '') +
      (o[4] ? '\n- High (4): ' + o[4].join(', ') + '. Credible, regular sources.' : '') +
      (o[2] ? '\n- Low (2): ' + o[2].join(', ') + '. Rarely matters to us; rate their stories one point lower unless they break real news first.' : ''));
  }
  var g = bucket(b.watch, function (x) { return x.label; });
  if (g[5] || g[4] || g[2]) {
    out.push('PEOPLE PRIORITY (the publisher\'s own ratings of the PEOPLE TO WATCH groups):' +
      (g[5] ? '\n- Must-watch (5): ' + g[5].join('; ') + '. Any genuine news about these people is core to us; rate it one point higher than you otherwise would, within the rules above.' : '') +
      (g[4] ? '\n- High (4): ' + g[4].join('; ') + '. Important to us.' : '') +
      (g[2] ? '\n- Low (2): ' + g[2].join('; ') + '. Routine coverage of these people caps at 2; only major news rates higher.' : ''));
  }
  var c = bucket([].concat(b.subreddits, b.podcasts, b.youtube), function (x) { return x.name; });
  if (c[5] || c[4] || c[2]) {
    out.push('COMMUNITY AND SHOW IMPORTANCE (subreddits, podcasts and YouTube channels the publisher rated):' +
      (c[5] ? '\n- Must-watch (5): ' + c[5].join(', ') : '') + (c[4] ? '\n- High (4): ' + c[4].join(', ') : '') + (c[2] ? '\n- Low (2): ' + c[2].join(', ') : ''));
  }
  return out.length ? '\n\n' + out.join('\n\n') : '';
}

function lowPriorityRegex(b) {
  if (!b.lowPrioritySports.length) return null;
  var parts = b.lowPrioritySports.map(function (s) {
    if (/^swimming/i.test(s)) return 'swimming|swim (?:and|&) dive';
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[ -]');
  });
  return new RegExp('\\b(' + parts.join('|') + ')\\b', 'i');
}

module.exports = {
  getBeat: getBeat, normalize: normalize, generateFeeds: generateFeeds, feedsFor: feedsFor, redditFor: redditFor,
  isRelevant: isRelevant, topicStopRegex: topicStopRegex, ownDomainRegex: ownDomainRegex, ownArticleRegex: ownArticleRegex,
  alumniNames: alumniNames, ratingPrompt: ratingPrompt, deepPrompt: deepPrompt, watchListText: watchListText,
  lowPriorityRegex: lowPriorityRegex, nick: nick, weightNote: weightNote
};
