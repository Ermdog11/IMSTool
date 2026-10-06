// /api/site-profile — the newsroom profile behind the setup wizard (/setup).
//
//   GET                                          -> { profile, houseStyle }   (any member)
//   POST { profile: {...} }                      -> merge-save (publisher)
//   POST { action:'suggest-names', ... }         -> AI-suggested people to watch (publisher)
//   POST { action:'suggest-x', teamName, level } -> AI-suggested X accounts, checked against
//                                                   X when it's connected (publisher)
//   POST { action:'suggest-beat', teamName, level, website, outletName }
//                                                -> AI-drafted beat profile (team names,
//                                                   outlets with checked feeds, communities,
//                                                   key figures), each item with a suggested
//                                                   1-5 importance (publisher)
//   POST { action:'suggest-terms', teamName, level, sports }
//                                                -> the 100 most popular/relevant names and
//                                                   terms for the beat, current and historical
//                                                   combined, ranked (publisher)
//   POST { beat: {...} }                         -> merge-save the beat profile (publisher)
//   POST { action:'build-house-style', samples } -> AI-written house style guide from
//                                                   sample articles, saved as the site's
//                                                   house style (publisher)
//
// Fails open like the rest of the app: with Supabase not configured, GET
// returns an empty profile and saves are refused with a clear message.

var S = require('./_supabase');
var Beat = require('./_beat');
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

// Suggested X accounts for the beat. Claude proposes handles; when the
// newsroom has connected X, each one is looked up so only real, existing
// accounts come back (with name, bio and follower count). Without X
// connected they come back marked unverified.
async function suggestXAccounts(body, sb) {
  var team = String(body.teamName || '').slice(0, 200);
  if (!team) throw new Error('Tell us which team or beat you cover first.');
  var out = await callClaude(
    'A newsroom covers this beat: ' + team + ' (' + String(body.level || 'college') + ').\n\n' +
    'Suggest up to 20 X (Twitter) accounts a beat reporter would follow to catch news first: beat reporters and insiders who cover this team, ' +
    'recruiting and transfer-portal reporters for it, the official team and athletics accounts, and local outlets that cover it. ' +
    'Only include handles you are confident exist and belong to that person or outlet. Leave an account out rather than guess a handle.',
    {
      name: 'suggest_accounts',
      description: 'Return suggested X accounts.',
      input_schema: {
        type: 'object',
        properties: {
          accounts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                handle: { type: 'string', description: 'X handle without the @' },
                who: { type: 'string', description: 'Who this is, e.g. "Baltimore Sun Terps beat writer"' }
              },
              required: ['handle', 'who']
            }
          }
        },
        required: ['accounts']
      }
    }, 2000);
  var seen = {};
  var list = (out.accounts || []).map(function (a) {
    return { handle: String(a.handle || '').replace(/^@/, '').trim(), who: String(a.who || '').slice(0, 160) };
  }).filter(function (a) {
    if (!/^[A-Za-z0-9_]{1,15}$/.test(a.handle) || seen[a.handle.toLowerCase()]) return false;
    seen[a.handle.toLowerCase()] = 1;
    return true;
  }).slice(0, 20);
  if (!list.length) return { accounts: [], verified: false };

  var creds = await Store.getXSearch(sb);
  if (!creds) return { accounts: list.map(function (a) { return Object.assign(a, { verified: false }); }), verified: false };

  var r = await fetch('https://api.x.com/2/users/by?usernames=' + encodeURIComponent(list.map(function (a) { return a.handle; }).join(',')) +
    '&user.fields=description,public_metrics,verified', { headers: { Authorization: 'Bearer ' + creds.bearerToken } });
  var d = await r.json();
  if (!d.data && d.errors && !d.errors.every(function (e) { return /not find|suspended/i.test(e.detail || e.title || ''); })) {
    return { accounts: list.map(function (a) { return Object.assign(a, { verified: false }); }), verified: false, warning: 'Could not check the accounts with X right now.' };
  }
  var found = {};
  (d.data || []).forEach(function (u) { found[u.username.toLowerCase()] = u; });
  return {
    verified: true,
    accounts: list.filter(function (a) { return found[a.handle.toLowerCase()]; }).map(function (a) {
      var u = found[a.handle.toLowerCase()];
      return {
        handle: u.username, name: u.name, who: a.who,
        bio: String(u.description || '').slice(0, 200),
        followers: (u.public_metrics || {}).followers_count || 0,
        verified: true
      };
    })
  };
}

// Draft a beat profile for a new newsroom. Claude proposes; every outlet's
// RSS feed is then fetched so a dead or made-up feed URL is dropped (the
// outlet stays, searched through Google News by its domain instead).
// Check each suggested podcast against Apple's podcast directory (free, no
// key) and each YouTube channel against the YouTube API, so the wizard never
// lists a show that doesn't exist. A match swaps in the real title and keeps
// the feed or channel link. Lookups that fail outright (network, no API key)
// leave the suggestion as is; only a clean "no such show" drops it.
async function fetchJson(url, ms) {
  var c = new AbortController(); var t = setTimeout(function () { c.abort(); }, ms || 6000);
  try { var r = await fetch(url, { signal: c.signal }); return r.ok ? await r.json() : null; }
  finally { clearTimeout(t); }
}
function looseMatch(a, b) {
  var n = function (x) { return String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); };
  a = n(a); b = n(b);
  return !!a && !!b && (a === b || a.indexOf(b) !== -1 || b.indexOf(a) !== -1);
}
async function verifyPodcasts(list) {
  await Promise.all(list.map(async function (p) {
    try {
      var d = await fetchJson('https://itunes.apple.com/search?media=podcast&entity=podcast&limit=5&term=' + encodeURIComponent(p.name));
      if (!d) return;
      var hit = (d.results || []).filter(function (r) { return looseMatch(r.collectionName, p.name); })[0];
      if (!hit) { p.notFound = true; return; }
      p.name = String(hit.collectionName).slice(0, 80);
      if (hit.feedUrl) p.feed = hit.feedUrl;
      if (hit.collectionViewUrl) p.url = hit.collectionViewUrl;
    } catch (e) { /* lookup failed, keep the suggestion */ }
  }));
}
async function verifyYouTube(list) {
  var key = process.env.YOUTUBE_API_KEY;
  if (!key || !list.length) return;
  // 100 quota units per lookup out of the shared daily budget; without room,
  // skip checking and keep the suggestions as is.
  if (!(await require('./_yt-quota.js').take(list.length))) return;
  await Promise.all(list.map(async function (y) {
    try {
      var d = await fetchJson('https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=3&q=' + encodeURIComponent(y.name) + '&key=' + key);
      if (!d) return;
      var hit = (d.items || []).filter(function (r) { return looseMatch(r.snippet && r.snippet.channelTitle, y.name); })[0];
      if (!hit) { y.notFound = true; return; }
      y.name = String(hit.snippet.channelTitle).slice(0, 80);
      y.channelId = hit.snippet.channelId;
      y.url = 'https://www.youtube.com/channel/' + hit.snippet.channelId;
    } catch (e) { /* lookup failed, keep the suggestion */ }
  }));
}

async function suggestBeat(body) {
  var team = String(body.teamName || '').slice(0, 200);
  if (!team) throw new Error('Tell us which team or beat you cover first.');
  var level = String(body.level || 'college');
  var out = await callClaude(
    'A newsroom' + (body.outletName ? ' called ' + String(body.outletName).slice(0, 100) : '') + (body.website ? ' (' + String(body.website).slice(0, 200) + ')' : '') +
    ' covers this beat: ' + team + ' (' + level + ').\n\n' +
    'Draft the beat profile a news-monitoring tool needs to find every story about it:\n' +
    '- team: the full name, the school or city, the short name used in headlines (e.g. "Maryland", "Ravens"), nicknames fans and headlines use, conference or league, home city.\n' +
    '- primarySports: the sports this outlet would mainly cover, lowercase.\n' +
    '- keyFigures: head coaches, the athletic director or general manager, and the biggest current names. Only people you are confident about.\n' +
    '- outlets: up to 20 news sources that regularly cover this team: beat writers\' outlets, local newspapers and TV, the official team or athletics site, the student paper, fan sites, recruiting sites, and the national outlets most relevant to it. Give each its website domain and, only if you are confident of it, its RSS feed URL. Do not include the newsroom\'s own outlet.\n' +
    '- subreddits: where fans discuss this team.\n' +
    '- podcasts: the 4-6 biggest podcasts for this beat, by exact show title as it appears in Apple Podcasts: shows dedicated to this team (beat writers\' and fan-site shows, the official team podcast), then the national shows that cover it most (conference or sport-wide).\n' +
    '- youtube: the 4-6 biggest YouTube channels for this beat, by exact channel name: the official team or athletics channel, beat outlets\' channels, the biggest fan and recruiting channels, then national channels that cover it most.\n' +
    '- nameCollisions: one sentence naming well-known people who share a name with someone on this beat, if any.\n' +
    'For every outlet, subreddit, podcast and channel, give importance 1-5: 5 = must-watch, often first with news; 4 = important; 3 = useful; 2 = occasional; 1 = rarely relevant. ' +
    'Your knowledge may be out of date; the publisher reviews everything. Leave something out rather than guess.',
    {
      name: 'beat_profile',
      description: 'Return the drafted beat profile.',
      input_schema: {
        type: 'object',
        properties: {
          team: { type: 'object', properties: {
            name: { type: 'string' }, school: { type: 'string' }, short: { type: 'string' },
            nicknames: { type: 'array', items: { type: 'string' } }, conference: { type: 'string' }, city: { type: 'string' }
          }, required: ['name', 'short'] },
          primarySports: { type: 'array', items: { type: 'string' } },
          keyFigures: { type: 'array', items: { type: 'string' } },
          outlets: { type: 'array', items: { type: 'object', properties: {
            name: { type: 'string' }, domain: { type: 'string' }, rss: { type: 'string' },
            kind: { type: 'string', enum: ['beat', 'local', 'official', 'student', 'fan', 'recruiting', 'national'] },
            importance: { type: 'integer', minimum: 1, maximum: 5 }, why: { type: 'string' }
          }, required: ['name', 'domain', 'importance'] } },
          subreddits: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, importance: { type: 'integer' } }, required: ['name', 'importance'] } },
          podcasts: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, importance: { type: 'integer' } }, required: ['name', 'importance'] } },
          youtube: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, importance: { type: 'integer' } }, required: ['name', 'importance'] } },
          nameCollisions: { type: 'string' }
        },
        required: ['team', 'outlets', 'podcasts', 'youtube']
      }
    }, 5000);

  function clamp(n) { n = parseInt(n, 10); return n >= 1 && n <= 5 ? n : 3; }
  function cleanDomain(d) { return String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''); }
  var outlets = (out.outlets || []).slice(0, 20).map(function (o) {
    return { name: String(o.name || '').slice(0, 80), domain: cleanDomain(o.domain), rss: /^https?:\/\//.test(o.rss || '') ? String(o.rss) : '', kind: o.kind || '', rating: clamp(o.importance), why: String(o.why || '').slice(0, 160) };
  }).filter(function (o) { return o.name && o.domain; });

  // Check each suggested RSS feed actually returns a feed.
  await Promise.all(outlets.map(async function (o) {
    if (!o.rss) { o.checked = 'search'; return; }
    try {
      var c = new AbortController(); var t = setTimeout(function () { c.abort(); }, 6000);
      var r = await fetch(o.rss, { signal: c.signal, headers: { 'User-Agent': 'Mozilla/5.0 CoPublisher' } }).finally(function () { clearTimeout(t); });
      var txt = r.ok ? (await r.text()).slice(0, 3000) : '';
      if (/<rss|<feed|<channel/i.test(txt)) o.checked = 'feed';
      else { o.rss = ''; o.checked = 'search'; }
    } catch (e) { o.rss = ''; o.checked = 'search'; }
  }));

  function community(arr) { return (arr || []).slice(0, 10).map(function (x) { return { name: String(x.name || '').replace(/^\/?r\//i, '').slice(0, 80), rating: clamp(x.importance) }; }).filter(function (x) { return x.name; }); }
  var podcasts = community(out.podcasts), youtube = community(out.youtube);
  await Promise.all([verifyPodcasts(podcasts), verifyYouTube(youtube)]);
  var t = out.team || {};
  var own = cleanDomain(body.website);
  return {
    beat: {
      outletName: String(body.outletName || '').slice(0, 100),
      team: { name: String(t.name || team).slice(0, 100), school: String(t.school || '').slice(0, 100), short: String(t.short || '').slice(0, 40),
        nicknames: (t.nicknames || []).slice(0, 6).map(String), conference: String(t.conference || '').slice(0, 60), city: String(t.city || '').slice(0, 60), level: level },
      primarySports: (out.primarySports || []).slice(0, 6).map(function (x) { return String(x).toLowerCase(); }),
      keyFigures: (out.keyFigures || []).slice(0, 12).map(String),
      outlets: outlets.filter(function (o) { return !own || o.domain !== own; }),
      subreddits: community(out.subreddits), podcasts: podcasts.filter(function (x) { return !x.notFound; }), youtube: youtube.filter(function (x) { return !x.notFound; }),
      nameCollisions: String(out.nameCollisions || '').slice(0, 500)
    }
  };
}

// The beat's "key names and terms": the 100 most popular and relevant people,
// places and terms, current and historical combined, ranked by how much they
// drive coverage and reader interest today.
async function suggestTerms(body) {
  var team = String(body.teamName || '').slice(0, 200);
  if (!team) throw new Error('Tell us which team or beat you cover first.');
  var sports = (Array.isArray(body.sports) ? body.sports : []).slice(0, 10).join(', ');
  var out = await callClaude(
    'A newsroom covers this beat: ' + team + ' (' + String(body.level || 'college') + ')' + (sports ? ', focusing on ' + sports : '') + '.\n\n' +
    'List the 100 most popular and relevant names and terms for this beat, current and historical combined, ranked by how much each one drives news coverage and reader interest today. ' +
    'Include current coaches, executives and star players; top recruits or prospects; legendary players and coaches; venues; rivalries; nicknames, traditions and other terms fans and headlines use. ' +
    'A current head coach outranks a long-retired legend unless the legend still drives coverage. ' +
    'Mark each as a person, place or term; as current or historic; and set figure:true only for the handful of current people who matter most (head coaches, the athletic director or general manager, the biggest stars). ' +
    'Only include names you are confident are connected to this team. Your knowledge may be out of date; the publisher reviews the list.',
    {
      name: 'key_terms',
      description: 'Return the ranked list, most important first.',
      input_schema: {
        type: 'object',
        properties: {
          terms: { type: 'array', items: { type: 'object', properties: {
            term: { type: 'string' },
            kind: { type: 'string', enum: ['person', 'place', 'term'] },
            era: { type: 'string', enum: ['current', 'historic'] },
            figure: { type: 'boolean' },
            note: { type: 'string', description: 'A few words: who or what this is' }
          }, required: ['term', 'kind', 'era'] } }
        },
        required: ['terms']
      }
    }, 8000);
  var seen = {};
  return {
    terms: (out.terms || []).map(function (x) {
      return { term: String(x.term || '').trim().slice(0, 60), kind: x.kind || 'person', era: x.era === 'historic' ? 'historic' : 'current', figure: !!x.figure, note: String(x.note || '').slice(0, 80) };
    }).filter(function (x) {
      var k = x.term.toLowerCase();
      if (!x.term || seen[k]) return false;
      seen[k] = 1; return true;
    }).slice(0, 100)
  };
}

// The parts of the beat the wizard shows and edits (not the long feed lists).
function wizardBeat(b) {
  return {
    outletName: b.outletName, team: b.team, primarySports: b.primarySports, keyFigures: b.keyFigures, keyTerms: b.keyTerms,
    outlets: b.outlets, subreddits: b.subreddits, podcasts: b.podcasts, youtube: b.youtube,
    watch: b.watch, rosterWatch: b.rosterWatch, nameCollisions: b.nameCollisions || '', hasHandTunedFeeds: !!(b.feeds && b.feeds.length)
  };
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
    if (!S.isConfigured()) return res.status(200).json({ profile: {}, houseStyle: null, beat: wizardBeat(await Beat.getBeat(null)) });
    try { await S.requireUser(req); }
    catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
    try {
      var sb = S.admin();
      return res.status(200).json({ profile: await Store.getProfile(sb), houseStyle: await Store.getHouseStyle(sb), beat: wizardBeat(await Beat.getBeat(sb)), accessDefaults: require('./_access').ROLE_DEFAULTS });
    } catch (e) {
      return res.status(200).json({ profile: {}, houseStyle: null, beat: null });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });
  if (!S.isConfigured()) return res.status(503).json({ error: 'Sign-in is not set up yet, so settings cannot be saved.' });

  var body = req.body || {};
  // Wizard preview (/setup?preview=1): its AI suggestion steps only return
  // suggestions, so any newsroom member may run them (a tester invited as a
  // Viewer can try the wizard on a brand-new beat; Jeff, 2026-10-06). Nothing
  // is saved in preview; everything else here stays publisher-only.
  var PREVIEW_ACTIONS = ['suggest-names', 'suggest-x', 'suggest-beat', 'suggest-terms', 'build-house-style'];
  var preview = body.preview === true && PREVIEW_ACTIONS.indexOf(body.action) !== -1;
  var ctx;
  try { ctx = preview ? await S.requireUser(req) : await S.requireRole(req, 'publisher'); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message }); }

  try {
    if (body.action === 'suggest-names') return res.status(200).json(await suggestNames(body));
    if (body.action === 'suggest-x') return res.status(200).json(await suggestXAccounts(body, ctx.supabase));
    if (body.action === 'suggest-beat') return res.status(200).json(await suggestBeat(body));
    if (body.action === 'suggest-terms') return res.status(200).json(await suggestTerms(body));
    if (body.beat && typeof body.beat === 'object') {
      // Merge into the SAVED beat (not the seed underneath it), so each wizard
      // step only changes its own parts.
      var curProfile = await Store.getProfile(ctx.supabase);
      var nextBeat = Object.assign({}, curProfile.beat || {}, body.beat);
      if (body.beat.team) nextBeat.team = Object.assign({}, (curProfile.beat || {}).team || {}, body.beat.team);
      var fields = Object.assign({}, body.profile && typeof body.profile === 'object' ? body.profile : {}, { beat: nextBeat });
      var savedB = await Store.saveProfile(ctx.supabase, fields);
      return res.status(200).json({ ok: true, profile: savedB, beat: wizardBeat(await Beat.getBeat(ctx.supabase)) });
    }
    if (body.action === 'build-house-style') {
      var built = await buildHouseStyle(body);
      // Preview never touches the live house style.
      if (!preview) await Store.saveHouseStyle(ctx.supabase, built.guide);
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

// Per-newsroom: this request runs as the signed-in person's newsroom (_site.js).
module.exports = require('./_site').wrap(module.exports);
