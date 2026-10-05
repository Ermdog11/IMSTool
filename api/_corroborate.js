// Two-source check for anything about to go out as breaking (Jeff,
// 2026-10-04, after an old Chris Durr commitment went out as a breaking
// auto-draft: "these sorts of mistakes will hurt our credibility").
//
// Before a breaking auto-draft is emailed, pushed or posted to Team Chat,
// this looks for other outlets reporting the same event: the scan's own
// rated stories plus a fresh Google News search on the story's names. One
// Claude call (forced tool use) then decides:
//   - which of those report the SAME event, and which are independent
//     reporting (a different outlet, not a syndicated copy or a post just
//     quoting the original), so the email can say "Confirmed by On3, The
//     Athletic" or "Single source";
//   - whether the search shows the event was already reported long ago
//     (oldNews), in which case the caller doesn't send it at all;
//   - for each key fact in the draft (position, school, star rating...),
//     whether those sources confirm it, conflict with it, or don't say.
//
// Best-effort like every helper the crons use: any failure returns
// status 'unknown' and the alert still goes out, labeled unchecked.

var B = require('./_beat.js');

var TOOL = {
  name: 'submit_corroboration',
  description: 'Report which candidate stories independently confirm the breaking story, and check the draft\'s facts against them.',
  input_schema: {
    type: 'object',
    properties: {
      matches: {
        type: 'array',
        description: 'Candidates reporting the SAME specific event as the breaking story.',
        items: {
          type: 'object',
          properties: {
            n: { type: 'number', description: 'The candidate number shown.' },
            independent: { type: 'boolean', description: 'True only for a different outlet doing its own reporting. False for the same outlet or reporter, a syndicated copy (MSN, Yahoo and similar re-hosting another outlet\'s article), or a post that only cites or links the original.' }
          },
          required: ['n', 'independent']
        }
      },
      oldNews: { type: 'boolean', description: 'True only if dated candidates show this same event was already reported more than about 7 days before today, i.e. it is not new.' },
      oldNewsDetail: { type: 'string', description: 'If oldNews: when it was first reported and by whom, one sentence. Otherwise empty.' },
      factChecks: {
        type: 'array',
        description: 'Key facts stated in the draft (who, what, positions, schools, numbers, ratings, dates), checked against the matching candidates only.',
        items: {
          type: 'object',
          properties: {
            claim: { type: 'string' },
            status: { type: 'string', enum: ['confirmed', 'conflict', 'unverified'] },
            detail: { type: 'string', description: 'For confirmed: which source. For conflict: what the source says instead. For unverified: empty.' }
          },
          required: ['claim', 'status', 'detail']
        }
      }
    },
    required: ['matches', 'oldNews', 'oldNewsDetail', 'factChecks']
  }
};

function decode(s) {
  return String(s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

// Google News search, past few days, for the people in the headline.
async function searchNews(query) {
  try {
    var url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(query) + '&hl=en-US&gl=US&ceid=US:en';
    var r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return [];
    var xml = await r.text();
    return (xml.match(/<item>[\s\S]*?<\/item>/g) || []).slice(0, 15).map(function(item) {
      var source = decode((item.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1]);
      var title = decode((item.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
      if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
      return {
        headline: title,
        source: source || 'Google News',
        url: decode((item.match(/<link>([\s\S]*?)<\/link>/) || [])[1]),
        date: decode((item.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1])
      };
    });
  } catch (e) { return []; }
}

// Names in the headline ("Chris Durr"), minus the team's own name, as a
// search query. Falls back to the headline's first words.
function queryFor(headline, beat) {
  var team = [beat.team.short, beat.team.name].concat(beat.team.nicknames || []).join(' ').toLowerCase();
  var names = (String(headline || '').match(/\b[A-Z][a-zA-Z'.-]+ [A-Z][a-zA-Z'.-]+\b/g) || [])
    .filter(function(n) { return team.indexOf(n.toLowerCase()) === -1; })
    .slice(0, 3);
  // OR, not AND: a capitalized pair can be a headline phrase ("Wyoming
  // Transfer"), not a name, and requiring it would miss the real coverage.
  if (names.length) return '(' + names.map(function(n) { return '"' + n + '"'; }).join(' OR ') + ') ' + beat.team.short;
  return String(headline || '').split(/\s+/).slice(0, 8).join(' ');
}

function sameUrl(a, b) { return a && b && a.replace(/[?#].*$/, '') === b.replace(/[?#].*$/, ''); }

// story: the rated alert (headline, summary, source, url, time).
// draftText: the auto-draft's Markdown, to fact-check (optional).
// pool: other rated stories from the same scan ({headline|title, source, url, time|age}).
async function check(story, draftText, pool, sb) {
  var empty = { status: 'unknown', sources: [], factChecks: [], oldNews: false, oldNewsDetail: '' };
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key || !story) return empty;
  try {
    var beat = await B.getBeat(sb || null);
    // Two searches: the past few days (other outlets confirming it now) and
    // no date limit (earlier coverage that would show it's old news).
    var q = queryFor(story.headline, beat);
    var both = await Promise.all([searchNews(q + ' when:3d'), searchNews(q)]);
    var searched = both[0].concat(both[1]);

    var candidates = [];
    var seen = {};
    function add(c) {
      if (!c.url || !c.headline || sameUrl(c.url, story.url) || seen[c.url]) return;
      seen[c.url] = 1;
      candidates.push(c);
    }
    (pool || []).forEach(function(p) {
      add({ headline: p.headline || p.title, source: p.source, url: p.url, date: p.time || (p.age != null ? p.age + 'h ago' : '') });
    });
    searched.forEach(add);
    candidates = candidates.slice(0, 60);
    if (!candidates.length) return Object.assign(empty, { status: 'single' });

    var today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    var user =
      'Today is ' + today + '. You check breaking stories for ' + beat.outletName + ', which covers ' + beat.coverage + ', before they go out.\n\n' +
      'BREAKING STORY\nHEADLINE: ' + (story.headline || '') + '\nSUMMARY: ' + (story.summary || '') +
      '\nSOURCE: ' + (story.source || '') + '\nREPORTED: ' + (story.time || '') + (story.url ? '\nURL: ' + story.url : '') + '\n\n' +
      (draftText ? 'DRAFT ARTICLE WRITTEN FROM IT\n' + String(draftText).slice(0, 4000) + '\n\n' : '') +
      'CANDIDATE STORIES (other outlets, from our scan and a news search)\n' +
      candidates.map(function(c, i) { return (i + 1) + '. [' + (c.source || '?') + '] ' + c.headline + (c.date ? ' (' + c.date + ')' : ''); }).join('\n') +
      '\n\nMatch only candidates about the SAME specific event (same person, same action), not the same person in a different story. ' +
      'Judge facts only from what the headlines and the breaking story actually say; do not use outside knowledge to confirm a fact. ' +
      (draftText ? 'Check every key fact in the draft.' : 'There is no draft; return an empty factChecks list.');

    var r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 1500,
        tools: [TOOL], tool_choice: { type: 'tool', name: 'submit_corroboration' },
        messages: [{ role: 'user', content: user.toWellFormed() }]
      })
    });
    var d = await r.json();
    if (d.error) throw new Error('Claude error: ' + JSON.stringify(d.error));
    var out = ((d.content || []).filter(function(b) { return b.type === 'tool_use'; })[0] || {}).input;
    if (!out) return empty;

    var independent = [];
    var bySource = {};
    (out.matches || []).forEach(function(m) {
      var c = candidates[(m.n || 0) - 1];
      if (!c || !m.independent) return;
      var name = String(c.source || '').trim();
      if (!name || name.toLowerCase() === String(story.source || '').trim().toLowerCase() || bySource[name.toLowerCase()]) return;
      bySource[name.toLowerCase()] = 1;
      independent.push({ source: name, url: c.url, headline: c.headline });
    });
    return {
      status: independent.length ? 'confirmed' : 'single',
      sources: independent.slice(0, 5),
      factChecks: (out.factChecks || []).slice(0, 12),
      oldNews: out.oldNews === true,
      oldNewsDetail: out.oldNewsDetail || ''
    };
  } catch (e) {
    console.error('Corroboration check failed (non-fatal):', e.message);
    return empty;
  }
}

function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// Short label for subjects, push notifications and Team Chat.
function label(result) {
  if (result.status === 'confirmed') return 'Confirmed by ' + result.sources.map(function(s) { return s.source; }).slice(0, 3).join(', ');
  if (result.status === 'single') return 'Single source, unconfirmed';
  return 'Not cross-checked';
}

// The box at the top of a breaking email.
function emailBlock(result) {
  var box = function(color, bg, html) { return '<div style="border-left:4px solid ' + color + ';background:' + bg + ';padding:10px 12px;margin:10px 0;font-size:14px">' + html + '</div>'; };
  var head;
  if (result.status === 'confirmed') {
    head = box('#15803d', '#f0fdf4', '<b style="color:#15803d">&#10003; Confirmed by ' + result.sources.length + ' other outlet' + (result.sources.length === 1 ? '' : 's') + ':</b> ' +
      result.sources.map(function(s) { return '<a href="' + esc(s.url) + '">' + esc(s.source) + '</a>'; }).join(', '));
  } else if (result.status === 'single') {
    head = box('#b45309', '#fffbeb', '<b style="color:#b45309">&#9888; Single source.</b> No other outlet has reported this yet. Treat it as unconfirmed until someone else does or you confirm it yourself.');
  } else {
    head = box('#6b7280', '#f9fafb', '<b>Not cross-checked.</b> The two-source check couldn\'t run this time.');
  }
  var checks = (result.factChecks || []).filter(function(f) { return f.status !== 'confirmed'; });
  if (!checks.length) return head;
  return head + '<p style="margin:6px 0 2px"><b>Facts in the draft other outlets don\'t back up:</b></p><ul style="margin-top:2px">' +
    checks.map(function(f) {
      return '<li>' + (f.status === 'conflict' ? '<b style="color:#b91c1c">Conflict:</b> ' : '<span style="color:#6b7280">Unverified:</span> ') +
        esc(f.claim) + (f.detail ? ' <i>(' + esc(f.detail) + ')</i>' : '') + '</li>';
    }).join('') + '</ul>';
}

// Lines added to the draft's "facts to check" list in the Content Editor.
function factsToCheckLines(result) {
  var lines = [];
  if (result.status === 'single') lines.push('Single source: no other outlet had reported this when the draft was written.');
  (result.factChecks || []).forEach(function(f) {
    if (f.status === 'conflict') lines.push('Sources conflict: ' + f.claim + (f.detail ? ' (' + f.detail + ')' : ''));
  });
  return lines;
}

module.exports = { check: check, label: label, emailBlock: emailBlock, factsToCheckLines: factsToCheckLines, queryFor: queryFor };
