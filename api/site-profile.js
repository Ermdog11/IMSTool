// /api/site-profile — the newsroom profile behind the setup wizard (/setup).
//
//   GET                                          -> { profile, houseStyle }   (any member)
//   POST { profile: {...} }                      -> merge-save (publisher)
//   POST { action:'suggest-names', ... }         -> AI-suggested people to watch (publisher)
//   POST { action:'build-house-style', samples } -> AI-written house style guide from
//                                                   sample articles, saved as the site's
//                                                   house style (publisher)
//
// Fails open like the rest of the app: with Supabase not configured, GET
// returns an empty profile and saves are refused with a clear message.

var S = require('./_supabase');
var Store = require('./_settings-store');

var MODEL = 'claude-sonnet-4-6';

// Forced tool-use for structured output (see api/copyedit.js for why we
// don't parse raw JSON out of a text reply).
async function callClaude(prompt, tool, maxTokens) {
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Missing ANTHROPIC_API_KEY.');
  var r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: maxTokens || 4000,
      tools: [tool], tool_choice: { type: 'tool', name: tool.name },
      messages: [{ role: 'user', content: prompt }]
    })
  });
  var d = await r.json();
  if (d.error) throw new Error('Claude error: ' + (d.error.message || JSON.stringify(d.error)));
  var block = (d.content || []).filter(function (b) { return b.type === 'tool_use'; })[0];
  if (!block) throw new Error('Claude returned no result.');
  return block.input;
}

async function suggestNames(body) {
  var team = String(body.teamName || '').slice(0, 200);
  if (!team) throw new Error('Tell us which team or beat you cover first.');
  var level = String(body.level || 'college');
  var sports = (Array.isArray(body.sports) ? body.sports : []).slice(0, 12).join(', ') || 'its main sports';
  var prompt = 'A newsroom covers this beat: ' + team + ' (' + level + '), focusing on ' + sports + '.\n\n' +
    'List the people a beat reporter on this team would want news alerts about: head and key assistant coaches, ' +
    'the athletic director or general manager, notable current players, and notable recent alumni now playing professionally. ' +
    'Only include people you are confident are currently or recently connected to this team; leave someone out rather than guess. ' +
    'Your knowledge may be out of date, so the publisher will review and edit this list.';
  var out = await callClaude(prompt, {
    name: 'suggest_people',
    description: 'Return people to watch, grouped.',
    input_schema: {
      type: 'object',
      properties: {
        groups: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'e.g. Coaches, Football players, Alumni in the NFL' },
              names: { type: 'array', items: { type: 'string' } }
            },
            required: ['label', 'names']
          }
        }
      },
      required: ['groups']
    }
  }, 3000);
  return { groups: (out.groups || []).slice(0, 12) };
}

async function buildHouseStyle(body) {
  var samples = String(body.samples || '').slice(0, 60000);
  if (samples.replace(/\s+/g, ' ').length < 1500) throw new Error('Paste at least two or three full articles so there is enough to learn from.');
  var outlet = String(body.outletName || 'this outlet').slice(0, 200);
  var prompt = 'Below are sample articles published by ' + outlet + '. Write the house style guide an editor would use to edit new drafts so they read like these.\n\n' +
    'Cover, as short rules with a quick example where useful: voice and tone; lede style; sentence and paragraph length; ' +
    'how people are named on first and later references; titles, numbers, dates, school and team names; how quotes are introduced and attributed; ' +
    'how stats and recruiting rankings are cited; headline style; words or habits to avoid. ' +
    'Describe only what the samples actually show. Do not copy sentences from them. Write in plain language a writer can follow.\n\n' +
    'SAMPLE ARTICLES:\n' + samples;
  var out = await callClaude(prompt, {
    name: 'house_style',
    description: 'Return the house style guide as plain text with short headed sections.',
    input_schema: {
      type: 'object',
      properties: { guide: { type: 'string' } },
      required: ['guide']
    }
  }, 4000);
  return { guide: String(out.guide || '').slice(0, 20000) };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    if (!S.isConfigured()) return res.status(200).json({ profile: {}, houseStyle: null });
    try { await S.requireUser(req); }
    catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
    try {
      var sb = S.admin();
      return res.status(200).json({ profile: await Store.getProfile(sb), houseStyle: await Store.getHouseStyle(sb) });
    } catch (e) {
      return res.status(200).json({ profile: {}, houseStyle: null });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });
  if (!S.isConfigured()) return res.status(503).json({ error: 'Sign-in is not set up yet, so settings cannot be saved.' });

  var ctx;
  try { ctx = await S.requireRole(req, 'publisher'); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message }); }

  var body = req.body || {};
  try {
    if (body.action === 'suggest-names') return res.status(200).json(await suggestNames(body));
    if (body.action === 'build-house-style') {
      var built = await buildHouseStyle(body);
      await Store.saveHouseStyle(ctx.supabase, built.guide);
      return res.status(200).json({ ok: true, guide: built.guide });
    }
    if (body.houseStyle !== undefined) {
      await Store.saveHouseStyle(ctx.supabase, String(body.houseStyle || '').slice(0, 20000));
    }
    if (body.profile && typeof body.profile === 'object') {
      var saved = await Store.saveProfile(ctx.supabase, body.profile);
      return res.status(200).json({ ok: true, profile: saved });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
