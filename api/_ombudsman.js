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
            kind: { type: 'string', enum: ['gap', 'follow-up', 'preview', 'enterprise', 'data', 'feature'] }
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
    'Suggest exactly FIVE story ideas the newsroom should do next. Mix them: at least one gap (something competitors have that we don\'t, or a story in the news we haven\'t touched), at least one follow-up to something we published, and at least one tied to an upcoming event on the calendar if there is one. The rest can be enterprise, data or feature ideas that only a beat this close could do.\n' +
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

var KIND_LABEL = { gap: 'Gap', 'follow-up': 'Follow-up', preview: 'Preview', enterprise: 'Enterprise', data: 'Data', feature: 'Feature' };

// "💡 Five story ideas" box for the update email.
function emailHtml(ideas) {
  if (!ideas || !ideas.length) return '';
  var e = function (x) { return String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
  return '<div style="margin-bottom:22px;border:1px solid #c7d2fe;background:#eef2ff;border-radius:8px;padding:12px 14px;">' +
    '<div style="font-size:12px;font-weight:700;color:#4338ca;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;">💡 ' + (ideas.length === 5 ? 'Five' : ideas.length) + ' story ideas from the Ombudsman</div>' +
    ideas.map(function (i, n) {
      return '<div style="padding:7px 0;border-top:1px solid #dfe3fb;">' +
        '<div style="font-size:14px;font-weight:600;color:#1a1a1a;">' + (n + 1) + '. ' + e(i.title) + ' <span style="font-size:11px;font-weight:600;color:#4338ca;background:#fff;border:1px solid #c7d2fe;border-radius:10px;padding:0 6px;">' + e(KIND_LABEL[i.kind] || i.kind) + '</span></div>' +
        '<div style="font-size:12.5px;color:#444;line-height:1.5;margin-top:2px;">' + e(i.angle) + (i.why ? ' <i style="color:#666">(' + e(i.why) + ')</i>' : '') + '</div></div>';
    }).join('') +
    '<div style="font-size:12px;margin-top:6px;"><a href="https://ims-tool.vercel.app/backlog" style="color:#2563eb;">Write one up in CoPublisher</a></div></div>';
}

module.exports = { suggest: suggest, latest: latest, emailHtml: emailHtml };
