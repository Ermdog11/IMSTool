// Writes a short, publish-ready breaking-news article FROM a rated scan
// alert (headline/summary/source/time) — not editing an existing draft, like
// copyedit.js does, but drafting one from scratch off just those facts.
// Reuses copyedit.js's related-articles scrape for hotlinks so a story
// pointed to from here is never invented.
//
// Used by api/rolling-digest.js the moment a rating-5 story shows up in a
// scan — the whole point is a writer opens the Content Editor to a draft
// that's already 80% done instead of a blank page.

var relatedArticleIndex = require('./copyedit.js').relatedArticleIndex;

var TOOL = {
  name: 'submit_breaking_draft',
  description: 'Return a short breaking-news article drafted from the given facts.',
  input_schema: {
    type: 'object',
    properties: {
      headline: { type: 'string', description: 'Publishable, accurate, under 90 characters.' },
      edited: { type: 'string', description: 'The article as Markdown, 150-300 words, AP style.' },
      notes: { type: 'array', items: { type: 'string' } },
      factsToCheck: {
        type: 'array', items: { type: 'string' },
        description: 'Anything not explicitly given in the source facts that a human must verify before this publishes — this is a fast breaking draft, err on the side of flagging.'
      }
    },
    required: ['headline', 'edited', 'notes', 'factsToCheck']
  }
};

// What the writer is allowed to know (Jeff, 2026-10-06, on a Media Day draft
// that had Derik Queen and Julian Reese "returning", a year-plus after they
// left: "does that tool have access to the knowledge base?"). It didn't: it saw
// one headline and a one-line summary, and filled the gaps from the model's
// own memory, which is months out of date. Now it gets, best-effort each:
//   - the source article's full text (Google News links resolved)
//   - our own recent coverage of the topic from the knowledge base
//   - the current roster and staff from Roster watch
//   - today's date
// and a hard rule: no person, stat or past event that isn't in those.
// Then ("it needs access to all data"): the beat profile's watch lists and
// key people, the calendar (last week and next three), recent roster
// changes, and two research tools it can call before writing:
// search_knowledge_base (our whole archive, any date) and web_search
// (current facts: stats, injuries, schedules), at most 3 web searches.
var STOP = ('the a an and or of to in on for with at by from as is are was be his her their its it this that after before over into ' +
  'up out new how why what who will has have had not but vs about more than set day says said').split(' ');

async function recentCoverage(sb, alert) {
  try {
    var siteId = await require('./_chat-store').resolveSiteId(sb);
    var words = (String(alert.headline || '') + ' ' + String(alert.summary || '')).toLowerCase().match(/[a-z0-9']{3,}/g) || [];
    words = words.filter(function (w, i) { return STOP.indexOf(w) === -1 && words.indexOf(w) === i; }).slice(0, 10);
    var since = new Date(Date.now() - 120 * 86400000).toISOString();
    var rows = [];
    if (words.length) {
      var q = await sb.from('content_items').select('headline, body, published_at, created_at, writer_name').eq('site_id', siteId)
        .gte('created_at', since).textSearch('fts', words.join(' or '), { type: 'websearch', config: 'english' })
        .order('created_at', { ascending: false }).limit(6);
      rows = q.data || [];
    }
    if (rows.length < 3) {
      var l = await sb.from('content_items').select('headline, body, published_at, created_at, writer_name').eq('site_id', siteId)
        .gte('created_at', since).order('created_at', { ascending: false }).limit(6);
      rows = rows.concat((l.data || []).filter(function (r) { return !rows.some(function (x) { return x.headline === r.headline; }); }));
    }
    return rows.filter(function (r) { return r.headline && !/^AI\b/.test(r.writer_name || ''); }).slice(0, 8).map(function (r) {
      return '- ' + String(r.published_at || r.created_at).slice(0, 10) + ' "' + r.headline + '": ' + String(r.body || '').replace(/\s+/g, ' ').slice(0, 700);
    }).join('\n');
  } catch (e) { return ''; }
}

async function currentRoster(beat, alert) {
  try {
    var Roster = require('./_roster');
    var t = (String(alert.category || '') + ' ' + String(alert.headline || '') + ' ' + String(alert.summary || '')).toLowerCase();
    var targets = Roster.watchTargets(beat).filter(function (x) { return x.scope === 'teams'; });
    // The story's own sport when the label says so, else every team.
    var hit = targets.filter(function (x) { var w = String(x.label || '').toLowerCase().split(/\W+/).filter(function (v) { return v.length > 3; }); return w.some(function (v) { return t.indexOf(v) !== -1; }); });
    var out = [];
    var pick = (hit.length ? hit : targets).slice(0, 4);
    for (var i = 0; i < pick.length; i++) {
      var x = pick[i];
      var snap = await Roster.getSnapshot(x.slug);
      if (!snap || !snap.people || !snap.people.length) continue;
      out.push(x.label + ' (as of ' + String(snap.checkedAt || '').slice(0, 10) + '): ' + snap.people.map(function (p) { return p.name + (p.title ? ' (' + p.title + ')' : ''); }).join('; ').slice(0, 2500));
    }
    return out.join('\n');
  } catch (e) { return ''; }
}

function beatPeople(beat) {
  try {
    var lines = [];
    if (beat.keyFigures && beat.keyFigures.length) lines.push('Key figures: ' + beat.keyFigures.join(', '));
    var cur = (beat.keyTerms || []).filter(function (k) { return k.kind === 'person' && k.era !== 'historic'; }).map(function (k) { return k.term; });
    if (cur.length) lines.push('Current key people: ' + cur.join(', '));
    var hist = (beat.keyTerms || []).filter(function (k) { return k.kind === 'person' && k.era === 'historic'; }).map(function (k) { return k.term; });
    if (hist.length) lines.push('Former/historic (never describe these as current): ' + hist.join(', '));
    if (beat.watch && beat.watch.length) lines.push(require('./_beat').watchListText(beat));
    return lines.join('\n').slice(0, 5000);
  } catch (e) { return ''; }
}

async function calendarNotes() {
  try {
    var Cal = require('./_calendar');
    var data = await Cal.load();
    var from = Date.now() - 7 * 86400000, to = Date.now() + 21 * 86400000;
    return (data.events || []).filter(function (e) { var t = Date.parse(e.start); return e.kind !== 'heat' && t >= from && t <= to; })
      .sort(function (a, b) { return Date.parse(a.start) - Date.parse(b.start); }).slice(0, 25)
      .map(function (e) { return '- ' + new Date(e.start).toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' }) + ' ' + Cal.timeOf(e) + ': ' + (e.title || '') + (e.location ? ' (' + e.location + ')' : ''); })
      .join('\n');
  } catch (e) { return ''; }
}

async function rosterChanges() {
  try {
    var since = Date.now() - 120 * 86400000;
    var rows = await require('./_roster-store').historyForSite(60);
    return rows.filter(function (r) { return Date.parse(r.detected_at) >= since; }).slice(0, 40)
      .map(function (r) { return '- ' + String(r.detected_at).slice(0, 10) + ' ' + (r.team_label || r.team_slug || '') + ': ' + r.player_name + ' ' + String(r.change_type || '').replace(/_/g, ' ') + (r.detail ? ' (' + r.detail + ')' : ''); })
      .join('\n');
  } catch (e) { return ''; }
}

async function generateBreakingDraft(alert, styleGuide) {
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Missing ANTHROPIC_API_KEY');

  var S = require('./_supabase');
  var sb = S.isConfigured() ? S.admin() : null;
  var beat = await require('./_beat').getBeat(sb).catch(function () { return null; });
  var outlet = (beat && beat.outletName) || 'our outlet', coverage = (beat && beat.coverage) || 'our beat';
  var today = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  var got = await Promise.all([
    relatedArticleIndex().catch(function () { return []; }),
    require('./_gnews').articleText(alert.url, 8000),
    sb ? recentCoverage(sb, alert) : '',
    beat ? currentRoster(beat, alert) : '',
    calendarNotes(),
    rosterChanges()
  ]);
  var related = got[0] || [], article = got[1], coverageNotes = got[2], roster = got[3], calendar = got[4], changes = got[5];
  // Old news is never drafted as new (the same 14-day rule as the scan's
  // freshness check): a re-indexed article's page date gives it away.
  if (article && article.publishedMs && Date.now() - article.publishedMs > 14 * 86400000) {
    var old = new Error('This story was published ' + new Date(article.publishedMs).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' }) + ', so it is old news. No draft was written.');
    old.stale = true;
    throw old;
  }
  var people = beat ? beatPeople(beat) : '';
  var relatedList = related.map(function(r, i) { return (i + 1) + '. ' + r.headline + '  ->  ' + r.url; }).join('\n');

  var facts =
    'TODAY: ' + today + '\n' +
    'HEADLINE: ' + (alert.headline || '') + '\n' +
    'SUMMARY: ' + (alert.summary || '(none given)') + '\n' +
    'SOURCE: ' + (alert.source || 'unknown') + '\n' +
    'REPORTED: ' + (alert.time || 'unknown') + '\n' +
    'CATEGORY: ' + (alert.category || '') + (alert.url ? '\nSOURCE URL: ' + ((article && article.url) || alert.url) : '') +
    '\n\nSOURCE ARTICLE TEXT:\n' + (article && article.text ? article.text : '(could not be fetched: write only from the headline and summary, and keep it short)') +
    '\n\nOUR RECENT COVERAGE (from our own archive, newest first; use for current context only):\n' + (coverageNotes || '(none found)') +
    '\n\nCURRENT ROSTER AND STAFF (from our roster watch):\n' + (roster || '(not available)') +
    '\n\nRECENT ROSTER AND STAFF CHANGES (departures, arrivals; newest first):\n' + (changes || '(none recorded)') +
    '\n\nPEOPLE ON OUR BEAT (from our beat profile):\n' + (people || '(not set)') +
    '\n\nCALENDAR (last week and the next three weeks):\n' + (calendar || '(nothing on it)');

  var sys =
    'You are the copy chief for ' + outlet + ', which covers ' + coverage + '. Today is ' + today + '. A story just ' +
    "hit the scanner. Write a short, clean news article in the house style below, that a writer can review and send in minutes " +
    "— not the full feature, just the facts reported so far, tightly written.\n\n" +
    '=== HOUSE STYLE GUIDE (write in this voice, not generic wire-copy) ===\n' +
    (styleGuide || '(No house style guide set yet — apply standard clean sports-news style: AP style, active voice, tight sentences, attribute claims, no cliches.)') + '\n\n' +
    '- Use ONLY facts from the material you are given (source article, headline/summary, our coverage, roster, roster changes, beat people, calendar) or that you find with your research tools. Do NOT invent quotes, statistics, additional details, or context.\n' +
    '- YOUR OWN MEMORY IS OUT OF DATE. Rosters, coaching staffs and seasons have changed since you were trained. Never name a player, coach or staff member, and never describe a past season, game or result, unless it appears in that material or your research. Never call anyone a returning or current player unless the source article, the current roster or a search result from this season says so; anyone in RECENT ROSTER CHANGES as departed is gone. When unsure, leave it out and add it to factsToCheck.\n' +
    '- Our own past coverage (OUR RECENT COVERAGE, search_knowledge_base results) was true WHEN IT WAS PUBLISHED. Check each date: anything from before this season describes the past. A player an old story calls "returning" may have left since. Never present an old story\'s facts as current or link it as if it were today\'s news.\n' +
    '- Research tools, use them before writing when they would help: search_knowledge_base searches ALL of our own past coverage (any date), for background and consistency with what we have reported. web_search checks the open web for current facts (this season\'s stats, injuries, schedule, who is on the team now); prefer official athletics sites and established outlets, and only trust results from this season. Then call submit_breaking_draft.\n' +
    '- Where the source is thin (e.g. just a headline and a source name), keep the piece short rather than padding it with background.\n' +
    '- Lightly, where it costs nothing: make the first two sentences answer who/what/when on their own, and name people and teams in full on first mention. This helps AI search tools cite the story; never let it override the house voice.\n' +
    '- Insert Markdown links to our related coverage from the list below only where the linked article\'s headline is about exactly what the linked phrase says; never link a claim to an article that doesn\'t report it, never force a link, and never invent a URL not in the list.\n' +
    '- Write like a sharp beat writer, not a press release or a preview show (Jeff, 2026-10-06: "the writing isn\'t good"): concrete facts, short declarative sentences, no filler ("legitimate weapons", "heading into the season", "remains to be seen", "all eyes on"), no guessing at what a locker room, coach or fan base thinks, no predictions, no rhetorical questions. If the source is thin, write a short, tight piece: three short paragraphs of real facts beat six of padding.\n' +
    '- factsToCheck should flag anything a human needs to verify or add before this goes out (this is a fast draft off a single source, so lean toward flagging, not toward confidence).\n';

  var user = facts + '\n\nRELATED ARTICLES (for internal links):\n' + (relatedList || '(none available this run)');

  var CE = require('./copyedit.js');
  var web = Object.assign({}, CE.WEB_SEARCH_TOOL, { max_uses: 3 });
  var loop = await CE.runAgenticLoop(key, sys, user.toWellFormed(), [web, CE.KB_SEARCH_TOOL, TOOL], 'submit_breaking_draft', 4);
  if (loop.error) throw new Error('Claude error: ' + JSON.stringify(loop.error));
  var parsed = loop.input;
  if (!parsed) {
    // Out of research rounds without a draft: one last forced call.
    var r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 2000, system: sys,
        tools: [TOOL], tool_choice: { type: 'tool', name: 'submit_breaking_draft' },
        messages: [{ role: 'user', content: user.toWellFormed() }]
      })
    });
    var d = await r.json();
    if (d.error) throw new Error('Claude error: ' + JSON.stringify(d.error));
    var toolUse = (d.content || []).filter(function(b) { return b.type === 'tool_use' && b.name === 'submit_breaking_draft'; })[0];
    parsed = toolUse && toolUse.input;
  }
  if (!parsed || typeof parsed.edited !== 'string') throw new Error('No usable draft returned');

  parsed.notes = parsed.notes || [];
  parsed.factsToCheck = parsed.factsToCheck || [];
  parsed.relatedIndex = related.map(function(r2) { return { url: r2.url, headline: r2.headline }; });
  return parsed;
}

// The same grounding for any writing tool (the Content Editor's "Give
// directions" box when it writes a story, e.g. from a press-conference
// transcript): today's date, our recent coverage of the topic, the current
// roster and staff, recent roster changes, the beat's people and the calendar.
// No AI calls; each part is best-effort.
async function groundingText(topic) {
  var S = require('./_supabase');
  var sb = S.isConfigured() ? S.admin() : null;
  var beat = await require('./_beat').getBeat(sb).catch(function () { return null; });
  var alert = { headline: String(topic || '').slice(0, 300), summary: String(topic || '').slice(300, 1200), category: '' };
  var today = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  var got = await Promise.all([sb ? recentCoverage(sb, alert) : '', beat ? currentRoster(beat, alert) : '', rosterChanges(), calendarNotes()]);
  return 'TODAY: ' + today +
    '\n\nOUR RECENT COVERAGE (our own archive, newest first; for current context only):\n' + (got[0] || '(none found)') +
    '\n\nCURRENT ROSTER AND STAFF (from our roster watch):\n' + (got[1] || '(not available)') +
    '\n\nRECENT ROSTER AND STAFF CHANGES (departures, arrivals; newest first):\n' + (got[2] || '(none recorded)') +
    '\n\nPEOPLE ON OUR BEAT (from our beat profile):\n' + ((beat && beatPeople(beat)) || '(not set)') +
    '\n\nCALENDAR (last week and the next three weeks):\n' + (got[3] || '(nothing on it)');
}

module.exports = { generateBreakingDraft: generateBreakingDraft, groundingText: groundingText };
