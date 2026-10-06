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
    beat ? currentRoster(beat, alert) : ''
  ]);
  var related = got[0] || [], article = got[1], coverageNotes = got[2], roster = got[3];
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
    '\n\nCURRENT ROSTER AND STAFF (from our roster watch):\n' + (roster || '(not available)');

  var sys =
    'You are the copy chief for ' + outlet + ', which covers ' + coverage + '. Today is ' + today + '. A story just ' +
    "hit the scanner. Write a short, clean news article in the house style below, that a writer can review and send in minutes " +
    "— not the full feature, just the facts reported so far, tightly written.\n\n" +
    '=== HOUSE STYLE GUIDE (write in this voice, not generic wire-copy) ===\n' +
    (styleGuide || '(No house style guide set yet — apply standard clean sports-news style: AP style, active voice, tight sentences, attribute claims, no cliches.)') + '\n\n' +
    '- Use ONLY the facts in the SOURCE ARTICLE TEXT, the headline/summary, OUR RECENT COVERAGE and the CURRENT ROSTER. Do NOT invent quotes, statistics, additional details, or context beyond those.\n' +
    '- YOUR OWN MEMORY IS OUT OF DATE. Rosters, coaching staffs and seasons have changed since you were trained. Never name a player, coach or staff member, and never describe a past season, game or result, unless it appears in the material above. Never call anyone a returning or current player unless the source article or the current roster says so. When unsure, leave it out and add it to factsToCheck.\n' +
    '- Where the source is thin (e.g. just a headline and a source name), keep the piece short rather than padding it with background.\n' +
    '- Lightly, where it costs nothing: make the first two sentences answer who/what/when on their own, and name people and teams in full on first mention. This helps AI search tools cite the story; never let it override the house voice.\n' +
    '- Insert Markdown links to our related coverage from the list below where a phrase genuinely connects — do not force it, and never invent a URL not in the list.\n' +
    '- factsToCheck should flag anything a human needs to verify or add before this goes out (this is a fast draft off a single source, so lean toward flagging, not toward confidence).\n';

  var user = facts + '\n\nRELATED ARTICLES (for internal links):\n' + (relatedList || '(none available this run)');

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
  var parsed = toolUse && toolUse.input;
  if (!parsed || typeof parsed.edited !== 'string') throw new Error('No usable draft returned');

  parsed.notes = parsed.notes || [];
  parsed.factsToCheck = parsed.factsToCheck || [];
  parsed.relatedIndex = related.map(function(r2) { return { url: r2.url, headline: r2.headline }; });
  return parsed;
}

module.exports = { generateBreakingDraft: generateBreakingDraft };
