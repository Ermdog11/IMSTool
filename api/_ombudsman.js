// Ombudsman: five story ideas for every update email (Jeff, 2026-10-06:
// "Ombudsman should suggest five story ideas in each news email"). First cut
// of the coverage-ideas agent in TODO.md: instead of only riffing on the
// latest alerts (the Story backlog tab), it reads across what the newsroom
// already knows:
//   - the stories in this update (the rated scan rolling-digest just ran)
//   - what we've published lately (our own recent headlines), so it doesn't
//     pitch what we already did, and finds follow-ups to what we did
//   - Opp Watch: what competitors ran in the last 3 days that we haven't
//   - the calendar's next 7 days (games, pressers, deadlines, heat spots)
//   - "Fewer like this" feedback from the Story backlog tab
// One Claude call (forced tool use), best-effort: any failure means the email
// goes out without ideas. The latest five are saved so the Story backlog tab
// can show them too.

var Beat = require('./_beat');
var LATEST = 'ombudsman-latest.json';

var TOOL = {
  name: 'submit_ideas',
  description: 'Exactly five story ideas, best first.',
  input_schema: {
    type: 'object',
    properties: {
      ideas: {
        type: 'array', minItems: 5, maxItems: 5,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'A working headline, specific (names, numbers).' },
            angle: { type: 'string', description: 'One or two sentences: the story and how to report it (who to call, what to look up).' },
            why: { type: 'string', description: 'Why now, in a short clause: the gap, the follow-up, the upcoming event, or the reader interest it rides.' },
            kind: { type: 'string', enum: ['gap', 'follow-up', 'preview', 'enterprise', 'data', 'feature', 'accountability', 'reader-question'] }
          },
          required: ['title', 'angle', 'why', 'kind']
        }
      }
    },
    required: ['ideas']
  }
};

async function readBlob(name, fallback) {
  try {
    var got = await require('@vercel/blob').get(name, { access: 'private', useCache: false });
    if (got && got.statusCode === 200) return await new Response(got.stream).json();
  } catch (e) { /* fallback */ }
  return fallback;
}

function line(s, n) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n || 200); }

// alerts: the rated stories from this run (headline, summary, rating, source).
async function suggest(alerts, opts) {
  opts = opts || {};
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) return [];
  var S = require('./_supabase');
  var sb = S.isConfigured() ? S.admin() : null;
  var beat = await Beat.getBeat(sb);

  var news = (alerts || []).filter(function (a) { return a && !a.irrelevant; })
    .sort(function (a, b) { return (b.rating || 0) - (a.rating || 0); }).slice(0, 25)
    .map(function (a) { return '- [' + (a.rating || '?') + '/5] ' + line(a.headline, 160) + (a.summary ? ': ' + line(a.summary, 200) : '') + ' (' + line(a.source, 40) + ')'; });

  var ours = [];
  try { ours = (await require('./copyedit.js').relatedArticleIndex()).slice(0, 25).map(function (a) { return '- ' + line(a.headline, 160); }); } catch (e) { /* none */ }

  var gaps = [];
  try {
    var st = await readBlob('opps-spy-state.json', { items: [] });
    var since = Date.now() - 3 * 86400000;
    gaps = (st.items || []).filter(function (i) { return i.at >= since && !i.covered; }).slice(0, 15)
      .map(function (i) { return '- ' + line(i.outlet, 40) + ': ' + line(i.title, 160); });
  } catch (e) { /* none */ }

  var cal = [];
  try {
    var C = require('./_calendar');
    var data = await C.load(), now = Date.now();
    cal = data.events.filter(function (e) { var t = Date.parse(e.start); return t > now && t < now + 7 * 86400000; }).slice(0, 15)
      .map(function (e) { return '- ' + new Date(e.start).toLocaleString('en-US', { timeZone: C.TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ': ' + line(e.title, 120); });
  } catch (e) { /* none */ }

  var disliked = [];
  try {
    var fb = await readBlob('story-ideas-feedback.json', {});
    disliked = (fb.insidemdsports || []).slice(0, 20).map(function (d) { return '- ' + line(d.title, 140); });
  } catch (e) { /* none */ }

  var today = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  var prompt = 'You are the ombudsman and ideas editor for ' + beat.outletName + ', which covers ' + beat.coverage + '. Today is ' + today + '.\n' +
    'Suggest exactly FIVE story ideas the newsroom should do next. Mix them: at least one gap (something competitors have that we don\'t, or a story in the news we haven\'t touched), at least one follow-up to something we published, and at least one tied to an upcoming event on the calendar if there is one. Include one accountability idea when there is something to hold to account (a promise, a budget, a decision, a public record) and, when readers are clearly asking something we haven\'t answered, a reader-question idea. The rest can be enterprise, data or feature ideas that only a beat this close could do.\n' +
    'Rules: never pitch a story we already published (see OUR RECENT HEADLINES); never invent facts, names or numbers beyond what is below and what you reliably know; make each one specific and reportable today; stay on the beat (' + (beat.subject || beat.coverage) + '); avoid anything like the DISLIKED ideas.\n\n' +
    'NEWS IN THIS UPDATE:\n' + (news.join('\n') || '(none)') + '\n\n' +
    'OUR RECENT HEADLINES:\n' + (ours.join('\n') || '(unavailable)') + '\n\n' +
    'COMPETITOR STORIES WE HAVEN\'T COVERED (last 3 days):\n' + (gaps.join('\n') || '(none)') + '\n\n' +
    'NEXT 7 DAYS ON OUR CALENDAR:\n' + (cal.join('\n') || '(nothing on the calendar)') + '\n\n' +
    'DISLIKED IDEAS (avoid similar):\n' + (disliked.join('\n') || '(none)') + '\n\nCall submit_ideas.';

  var r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1800, tools: [TOOL], tool_choice: { type: 'tool', name: TOOL.name }, messages: [{ role: 'user', content: prompt.toWellFormed() }] })
  });
  var d = await r.json();
  if (d.error) throw new Error('Ombudsman: ' + (d.error.message || JSON.stringify(d.error)));
  var out = ((d.content || []).filter(function (b) { return b.type === 'tool_use'; })[0] || {}).input || {};
  var ideas = (out.ideas || []).slice(0, 5).map(function (i) {
    return { title: line(i.title, 200), angle: line(i.angle, 500), why: line(i.why, 200), kind: i.kind || 'feature' };
  }).filter(function (i) { return i.title; });
  if (ideas.length) {
    try {
      await require('@vercel/blob').put(LATEST, JSON.stringify({ at: new Date().toISOString(), slot: opts.slot || null, ideas: ideas }), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
    } catch (e) { console.error('Ombudsman save failed:', e.message); }
  }
  return ideas;
}

async function latest() { return await readBlob(LATEST, null); }

// ── Quality review: what a real ombudsman does (Jeff, 2026-10-06: "it needs
// more quality control and the functions a real ombudsman would do") ─────
// A newsroom ombudsman (public editor) holds the outlet's own published work
// to account on the readers' behalf. Once a day (Coverage Desk) or on demand
// (Story backlog → Ombudsman → Check our coverage), this reads our articles
// from the last 3 days (the knowledge base: everything saved, submitted or
// imported; AI drafts excluded) and checks each for:
//   accuracy      a name, title, number or date that looks wrong or
//                 contradicts the story itself or our earlier coverage
//   headline      a headline (or lede) that promises more than the story shows
//   sourcing      claims with no source, anonymous sources with no reason given
//   speculation   rumor or opinion presented as fact
//   fairness      someone criticized with no response sought ("did not
//                 respond to a request for comment")
//   context       a key fact readers need that's missing
//   tone          loaded or unfair language in a news story
//   consistency   contradicts what we reported before
//   disclosure    affiliate links, sponsors or ties that aren't disclosed
//   clarity       confusing or misleading wording
// plus a short column on the coverage as a whole: balance across sports and
// people, over-reliance on one source or angle, what readers may object to.
// It flags things to check; it never asserts an error it can't support, and
// labels what needs verifying as such. One Claude call; saved for the tab.

var REVIEW = 'ombudsman-review.json';
var REVIEW_TOOL = {
  name: 'submit_review',
  description: 'The ombudsman review of our recent articles.',
  input_schema: {
    type: 'object',
    properties: {
      column: { type: 'string', description: 'The ombudsman column: 3-5 plain sentences on the coverage as a whole, fairness, balance (sports, people, positive vs negative), sourcing habits, and anything readers may reasonably object to. Specific, not generic.' },
      articles: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            n: { type: 'integer', description: 'The article number given below.' },
            verdict: { type: 'string', enum: ['clean', 'fix', 'correction'], description: 'correction: a likely factual error readers would need corrected; fix: should be improved before/after publishing; clean: nothing worth raising.' },
            findings: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['accuracy', 'headline', 'sourcing', 'speculation', 'fairness', 'context', 'tone', 'consistency', 'disclosure', 'clarity'] },
                  severity: { type: 'string', enum: ['correction', 'fix', 'note'] },
                  quote: { type: 'string', description: 'The exact words from the article this is about (short).' },
                  issue: { type: 'string', description: 'What is wrong or questionable, in one sentence. Say "verify" when it needs checking rather than being clearly wrong.' },
                  suggestion: { type: 'string', description: 'The fix: suggested wording, or what to check and with whom.' }
                },
                required: ['type', 'severity', 'quote', 'issue', 'suggestion']
              }
            }
          },
          required: ['n', 'verdict', 'findings']
        }
      }
    },
    required: ['column', 'articles']
  }
};

async function recentArticles(sb, days, max) {
  var siteId = await require('./_chat-store').resolveSiteId(sb);
  var since = new Date(Date.now() - days * 86400000).toISOString();
  var q = await sb.from('content_items').select('id, headline, body, url, writer_name, created_at, published_at')
    .eq('site_id', siteId).gte('created_at', since).order('created_at', { ascending: false }).limit(40);
  return (q.data || []).filter(function (r) { return r.headline && r.body && r.body.length > 400 && !/^AI\b/.test(r.writer_name || ''); })
    .slice(0, max || 8);
}

async function review(opts) {
  opts = opts || {};
  var key = process.env.ANTHROPIC_API_KEY;
  var S = require('./_supabase');
  if (!key || !S.isConfigured()) return null;
  var sb = S.admin();
  var beat = await Beat.getBeat(sb);
  var arts = await recentArticles(sb, opts.days || 3, 8);
  if (!arts.length) {
    var empty = { at: new Date().toISOString(), column: 'No articles of ours from the last few days are in the knowledge base yet, so there was nothing to review.', articles: [] };
    await saveReview(empty); return empty;
  }
  var earlier = [];
  try {
    var siteId = await require('./_chat-store').resolveSiteId(sb);
    var e = await sb.from('content_items').select('headline, writer_name, created_at').eq('site_id', siteId)
      .lt('created_at', new Date(Date.now() - 3 * 86400000).toISOString()).order('created_at', { ascending: false }).limit(40);
    earlier = (e.data || []).filter(function (r) { return r.headline && !/^AI\b/.test(r.writer_name || ''); }).map(function (r) { return '- ' + line(r.headline, 160) + ' (' + String(r.created_at).slice(0, 10) + ')'; });
  } catch (err) { /* none */ }
  var today = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  var prompt = 'You are the ombudsman (public editor) of ' + beat.outletName + ', which covers ' + beat.coverage + '. Today is ' + today + '. ' +
    'Your job is to hold our own published work to account for readers: accuracy, fair and sourced reporting, honest headlines, and balance. Review each article below. Be specific and useful, quote the exact words you mean, and give the fix. ' +
    'Do not nitpick style or grammar (the copy desk handles that) and do not invent problems: if an article is fine, mark it clean with no findings. ' +
    'Only use severity "correction" for a likely factual error (it contradicts itself, our earlier coverage, or a fact you are sure of); anything you can\'t confirm is a "fix" or "note" that says "verify". Never state a fact about a real person you are not sure of.\n\n' +
    'OUR EARLIER HEADLINES (for consistency):\n' + (earlier.join('\n') || '(none)') + '\n\n' +
    arts.map(function (a, i) {
      return '=== ARTICLE ' + (i + 1) + ' ===\nHEADLINE: ' + line(a.headline, 250) + '\nBY: ' + line(a.writer_name, 80) + '\nDATE: ' + String(a.published_at || a.created_at).slice(0, 10) + '\n\n' + String(a.body).slice(0, 3500);
    }).join('\n\n') + '\n\nCall submit_review.';
  var r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 4000, tools: [REVIEW_TOOL], tool_choice: { type: 'tool', name: REVIEW_TOOL.name }, messages: [{ role: 'user', content: prompt.toWellFormed() }] })
  });
  var d = await r.json();
  if (d.error) throw new Error('Ombudsman review: ' + (d.error.message || JSON.stringify(d.error)));
  var out = ((d.content || []).filter(function (b) { return b.type === 'tool_use'; })[0] || {}).input || {};
  var result = {
    at: new Date().toISOString(),
    column: line(out.column, 1500),
    articles: (out.articles || []).map(function (x) {
      var a = arts[(x.n || 0) - 1]; if (!a) return null;
      return {
        headline: a.headline, url: a.url || '', writer: a.writer_name || '', date: String(a.published_at || a.created_at).slice(0, 10),
        verdict: x.verdict || 'clean',
        findings: (x.findings || []).slice(0, 8).map(function (f) { return { type: f.type, severity: f.severity, quote: line(f.quote, 300), issue: line(f.issue, 400), suggestion: line(f.suggestion, 500) }; })
      };
    }).filter(Boolean)
  };
  // Articles the model skipped count as reviewed and clean.
  arts.forEach(function (a) { if (!result.articles.some(function (x) { return x.headline === a.headline; })) result.articles.push({ headline: a.headline, url: a.url || '', writer: a.writer_name || '', date: String(a.published_at || a.created_at).slice(0, 10), verdict: 'clean', findings: [] }); });
  var order = { correction: 0, fix: 1, clean: 2 };
  result.articles.sort(function (a, b) { return order[a.verdict] - order[b.verdict]; });
  await saveReview(result);
  return result;
}
async function saveReview(r) {
  try { await require('@vercel/blob').put(REVIEW, JSON.stringify(r), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' }); }
  catch (e) { console.error('Ombudsman review save failed:', e.message); }
}
async function latestReview() { return await readBlob(REVIEW, null); }

// Coverage Desk box: the column plus anything that needs correcting or fixing.
function reviewHtml(r) {
  if (!r || !r.articles) return '';
  var e = function (x) { return String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
  var flagged = r.articles.filter(function (a) { return a.verdict !== 'clean'; });
  var corr = flagged.filter(function (a) { return a.verdict === 'correction'; }).length;
  return '<div style="border:1px solid #c7d2fe;background:#eef2ff;border-radius:8px;padding:10px 14px;margin-bottom:16px">' +
    '<div style="font-size:12px;font-weight:700;color:#4338ca;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">⚖️ Ombudsman · ' + r.articles.length + ' recent article' + (r.articles.length === 1 ? '' : 's') + ' reviewed' +
      (flagged.length ? ' · <span style="color:#b91c1c">' + (corr ? corr + ' possible correction' + (corr === 1 ? '' : 's') + ', ' : '') + flagged.length + ' to look at</span>' : ' · all clean') + '</div>' +
    (r.column ? '<div style="font-size:13px;color:#333;line-height:1.5;margin-bottom:6px">' + e(r.column) + '</div>' : '') +
    flagged.slice(0, 5).map(function (a) {
      return '<div style="padding:6px 0;border-top:1px solid #dfe3fb;font-size:12.5px"><b>' + (a.verdict === 'correction' ? '🔴 ' : '🟡 ') + e(a.headline) + '</b>' +
        a.findings.filter(function (f) { return f.severity !== 'note'; }).slice(0, 3).map(function (f) {
          return '<div style="margin-top:3px;color:#444"><i>' + e(f.type) + ':</i> “' + e(f.quote) + '” · ' + e(f.issue) + ' <span style="color:#065f46">→ ' + e(f.suggestion) + '</span></div>';
        }).join('') + '</div>';
    }).join('') +
    '<div style="font-size:11px;margin-top:6px"><a href="https://ims-tool.vercel.app/backlog" style="color:#2563eb">Full review in CoPublisher</a></div></div>';
}

var KIND_LABEL = { gap: 'Gap', 'follow-up': 'Follow-up', preview: 'Preview', enterprise: 'Enterprise', data: 'Data', feature: 'Feature', accountability: 'Accountability', 'reader-question': 'Reader question' };

// "💡 Five story ideas" box for the update email.
function emailHtml(ideas) {
  if (!ideas || !ideas.length) return '';
  var e = function (x) { return String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
  return '<div style="margin-bottom:22px;border:1px solid #c7d2fe;background:#eef2ff;border-radius:8px;padding:12px 14px;">' +
    '<div style="font-size:12px;font-weight:700;color:#4338ca;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;">💡 Ombudsman <span style="font-weight:400;text-transform:none;letter-spacing:0;color:#555;">· ' + (ideas.length === 5 ? 'five' : ideas.length) + ' story idea' + (ideas.length === 1 ? '' : 's') + '</span></div>' +
    ideas.map(function (i, n) {
      return '<div style="padding:7px 0;border-top:1px solid #dfe3fb;">' +
        '<div style="font-size:14px;font-weight:600;color:#1a1a1a;">' + (n + 1) + '. ' + e(i.title) + ' <span style="font-size:11px;font-weight:600;color:#4338ca;background:#fff;border:1px solid #c7d2fe;border-radius:10px;padding:0 6px;">' + e(KIND_LABEL[i.kind] || i.kind) + '</span></div>' +
        '<div style="font-size:12.5px;color:#444;line-height:1.5;margin-top:2px;">' + e(i.angle) + (i.why ? ' <i style="color:#666">(' + e(i.why) + ')</i>' : '') + '</div></div>';
    }).join('') +
    '<div style="font-size:12px;margin-top:6px;"><a href="https://ims-tool.vercel.app/backlog" style="color:#2563eb;">Write one up in CoPublisher</a></div></div>';
}

module.exports = { suggest: suggest, latest: latest, emailHtml: emailHtml, review: review, latestReview: latestReview, reviewHtml: reviewHtml };
