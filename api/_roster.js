// Roster Watch engine, shared by api/roster-check.js (the cron that detects
// changes) and api/roster-view.js (the in-app view).
//
// WHAT it watches comes from the newsroom's beat profile (beat.rosterWatch,
// edited in the setup wizard's "Roster watch" step), never from code:
//
//   rosterWatch: {
//     teams: [{ label, slug, url, staffUrl }],   // url = player roster page,
//                                                // staffUrl = coaches & staff page
//     department: { url, enabled }               // the athletic department's staff
//   }                                            // directory (college) or the
//                                                // front office page (pro)
//
// Three kinds of page, each its own snapshot:
//   players     a team's roster            -> adds and drops
//   staff       a team's coaches and staff -> adds, drops and title changes
//   department  the athletic department or front office directory -> same
//
// HOW it reads a page:
//   - Player rosters on Sidearm Sports sites (most college athletics sites) are
//     parsed with a regex, as before. No AI call, no cost.
//   - Everything else (coaches pages, staff directories, pro team sites, any
//     layout we have never seen) is read by Claude from the page's plain text,
//     so a new newsroom's pages work without new parsing code.
//   - Claude's list is never trusted on its own. Someone is "off the page"
//     only when their name is literally gone from the page text, and someone
//     is "added" only when their name is literally on it. A name Claude skips
//     or invents can't cause an alert.
//   - A page whose text hasn't changed since the last check is skipped without
//     an AI call, so the cost is only paid when something on the page moved.

var crypto = require('crypto');
var { get, put } = require('./_site-blob');

var MODEL = 'claude-sonnet-4-6';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

// A player roster this small is almost certainly a broken parse, not a real
// team. Guards against overwriting a good snapshot with garbage from a
// template change. Staff pages can legitimately be short, so they use the
// shrink guard in diffPeople() instead.
var MIN_SANE_ROSTER = 10;
var MAX_PAGE_CHARS = 150000;

// ── What to watch ─────────────────────────────────────────────────────────
function departmentLabel(level) {
  if (level === 'pro') return 'Front office';
  if (level === 'local') return 'Staff directory';
  return 'Athletic department';
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

// One entry per page to check. Player slugs are the team slug itself, so
// snapshots and history saved before staff watching existed carry on.
function watchTargets(beat) {
  var rw = (beat && beat.rosterWatch) || {};
  var level = (beat && beat.team && beat.team.level) || 'college';
  var out = [];
  (rw.teams || []).forEach(function (t) {
    var slug = t.slug || slugify(t.label);
    if (!slug) return;
    if (t.url) out.push({ scope: 'teams', kind: 'players', slug: slug, team: slug, label: t.label, url: t.url });
    if (t.staffUrl) out.push({ scope: 'teams', kind: 'staff', slug: slug + '-staff', team: slug, label: t.label + ' coaches and staff', url: t.staffUrl });
  });
  var d = rw.department || {};
  if (d.url && d.enabled !== false) {
    out.push({ scope: 'department', kind: 'department', slug: 'department', label: departmentLabel(level), url: d.url });
  }
  return out;
}

// ── Reading a page ────────────────────────────────────────────────────────
// The URLs come from the publisher's settings, so refuse anything that isn't a
// plain public web address before the server fetches it.
function safeUrl(u) {
  var p;
  try { p = new URL(String(u)); } catch (e) { return null; }
  if (p.protocol !== 'https:' && p.protocol !== 'http:') return null;
  var h = p.hostname.toLowerCase();
  if (h === 'localhost' || h.indexOf('.') === -1 || /\.(local|internal|lan)$/.test(h)) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.indexOf(':') !== -1) return null;
  return p.toString();
}

async function fetchPage(url) {
  var safe = safeUrl(url);
  if (!safe) throw new Error('not a public web address');
  var r = await fetch(safe, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error('fetch-failed:' + r.status);
  return await r.text();
}

function decodeEntities(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&rsquo;|&#8217;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&ndash;|&#8211;/g, '-').replace(/&mdash;|&#8212;/g, '-')
    .replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(+n); });
}

// Page text, one line per block element. Every tag becomes a break or a space
// so a name split across two elements ("<span>Buzz</span><span>Williams</span>")
// still reads as two words.
function htmlToText(html) {
  var body = String(html || '');
  var m = body.match(/<body[\s\S]*<\/body>/i);
  if (m) body = m[0];
  body = body.replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?(div|p|li|ul|ol|tr|td|th|table|section|article|header|footer|nav|h[1-6]|br|a|dd|dt|dl|figure|figcaption)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(body).split('\n').map(function (l) { return l.replace(/[\s ]+/g, ' ').trim(); })
    .filter(Boolean).join('\n');
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[\s ]+/g, ' ').trim();
}
function hashText(text) { return crypto.createHash('sha1').update(norm(text)).digest('hex'); }

// Sidearm player rosters, regex only.
function extractPlayers(html) {
  // Sidearm "Next Gen" template (s-person-card) — name + jersey number both
  // land in one aria-label, e.g. 'DeJuan Williams jersey number 0 full bio'.
  var nextGen = html.match(/aria-label="([^"]+?) jersey number (\d+) full bio"/g) || [];
  if (nextGen.length >= MIN_SANE_ROSTER) {
    var seen = {};
    nextGen.forEach(function (m) {
      var mm = m.match(/aria-label="([^"]+?) jersey number (\d+) full bio"/);
      if (mm) seen[mm[1].trim()] = mm[2];
    });
    return Object.keys(seen).sort().map(function (name) { return { name: name, jersey: seen[name] }; });
  }
  // Fallback: Sidearm "classic" template — name/number in separate tagged spans.
  var classic = html.match(/<span[^>]*class="[^"]*sidearm-roster-player-name[^"]*"[^>]*>[\s\S]*?<\/span>/g) || [];
  if (classic.length >= MIN_SANE_ROSTER) {
    var names = classic.map(function (c) {
      return c.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }).filter(Boolean);
    return names.sort().map(function (name) { return { name: name, jersey: '' }; });
  }
  return [];
}

// Claude reads the people off a page's text. Returned as compact lines rather
// than objects so a 400-person directory fits in one reply.
async function extractPeopleAI(text, target, beat) {
  var key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Missing ANTHROPIC_API_KEY.');
  var team = (beat && beat.team && beat.team.name) || 'the team';
  var players = target.kind === 'players';
  var prompt = 'Below is the text of a web page: "' + target.label + '" for ' + team + ' (' + target.url + ').\n\n' +
    (players
      ? 'List every PLAYER on the roster. One line per player, in this exact form:\nName | jersey number (blank if none) | position\n' +
        'Do not list coaches or staff.'
      : 'List every PERSON the page lists as a coach, staff member or executive. One line per person, in this exact form:\nName | job title | section\n' +
        '"section" is the heading the person appears under (a department such as "Compliance", or "Coaching Staff"); leave it blank if there is none.') +
    '\n\nRules:\n- Copy each name EXACTLY as it is written on the page, including any credentials written after it.\n' +
    '- Copy the title exactly as written. Do not shorten, tidy or guess a title; leave it blank if the page gives none.\n' +
    '- Include everyone, in page order. Do not skip anyone and do not add anyone who is not on the page.\n' +
    '- Ignore navigation menus, news headlines, sponsors and footers.\n\nPAGE TEXT:\n' + text.slice(0, MAX_PAGE_CHARS);
  var r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 16000,
      tools: [{
        name: 'list_people', description: 'Return the people on the page, one string per person.',
        input_schema: { type: 'object', properties: { people: { type: 'array', items: { type: 'string' } } }, required: ['people'] }
      }],
      tool_choice: { type: 'tool', name: 'list_people' },
      messages: [{ role: 'user', content: prompt }]
    }),
    signal: AbortSignal.timeout(240000)
  });
  var d = await r.json();
  if (d.error) throw new Error('Claude error: ' + (d.error.message || JSON.stringify(d.error)));
  if (d.stop_reason === 'max_tokens') throw new Error('page too long to read in one pass');
  var block = (d.content || []).filter(function (b) { return b.type === 'tool_use'; })[0];
  if (!block || !Array.isArray(block.input.people)) throw new Error('Claude returned no list.');
  return parsePeopleLines(block.input.people, text, players);
}

// Lines -> people, keeping only names that are really on the page.
function parsePeopleLines(lines, text, players) {
  var flat = norm(text.replace(/\n/g, ' '));
  var seen = {}, out = [];
  lines.forEach(function (line) {
    var parts = String(line).split('|').map(function (x) { return x.trim(); });
    var name = parts[0];
    if (!name || name.length > 90 || flat.indexOf(norm(name)) === -1) return;
    var k = norm(name);
    if (seen[k]) return;
    seen[k] = 1;
    out.push(players
      ? { name: name, jersey: (parts[1] || '').replace(/^#/, '').slice(0, 4), title: (parts[2] || '').slice(0, 40) }
      : { name: name, title: (parts[1] || '').slice(0, 160), group: (parts[2] || '').slice(0, 100) });
  });
  return out;
}

// ── Comparing with the last snapshot ──────────────────────────────────────
// The roles a reporter would break news on. Used to put those changes first
// and mark them in the alert.
function isKeyRole(title) {
  var t = String(title || '').toLowerCase();
  if (!t) return false;
  if (/\bto the (head\b[\w' ]{0,25}\bcoach|general manager|athletic director|director of athletics|president|owner)\b|head coach operations/.test(t)) return false;
  if (/\b(associate|assistant)\b[^/,]*\b(athletic director|director of athletics|ad)\b/.test(t)) return false;
  if (/vice president/.test(t) && !/(football|basketball|baseball|hockey|soccer|player) (operations|personnel)/.test(t)) return false;
  return /\bhead\b[\w' ]{0,25}\bcoach\b|general manager|\bowner\b|\b(offensive|defensive|special teams) coordinator\b|director of athletics|athletic director|\bpresident\b|chief executive/.test(t);
}

// Is `b` the same title as `a`, just tidied up? (Jeff, 2026-10-09: a typo
// fix, "Recruitng" -> "Recruiting", was alerted as a title change.) Same
// when, ignoring case, punctuation and spacing, the words are the same (in
// any order, "and"/"of"/"the" aside), or the same words except for small spelling fixes inside long
// words (at most 2 letters different in a word of 6+ letters, same first
// two letters). Any added or
// dropped word ("Interim", "Co-", "Associate"), or a different word, is a
// real change.
function editDistance(a, b) {
  var d = [], i, j;
  for (i = 0; i <= a.length; i++) d[i] = [i];
  for (j = 0; j <= b.length; j++) d[0][j] = j;
  for (i = 1; i <= a.length; i++) for (j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
function titleWords(t) { return String(t || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean); }
function sameTitle(a, b) {
  var x = titleWords(a), y = titleWords(b);
  if (x.join(' ') === y.join(' ')) return true;
  var key = function (ws) { return ws.filter(function (w) { return ['and', 'of', 'the'].indexOf(w) === -1; }).sort().join(' '); };
  if (key(x) === key(y)) return true;
  if (x.length !== y.length) return false;
  // A spelling fix keeps the start of the word ("Offensive" -> "Defensive" is not one).
  return x.every(function (w, i) {
    var v = y[i];
    return w === v || (Math.min(w.length, v.length) >= 6 && w.slice(0, 2) === v.slice(0, 2) && editDistance(w, v) <= 2);
  });
}

// prev/next: [{name, title?, group?, jersey?}]. `text` is the new page text;
// when given, a previous person only counts as removed if their name is gone
// from it, and anyone the new list missed but who is still on the page is
// carried over.
function diffPeople(prev, next, text, opts) {
  opts = opts || {};
  var flat = text ? norm(text.replace(/\n/g, ' ')) : null;
  var nextBy = {}, prevBy = {};
  next.forEach(function (p) { nextBy[norm(p.name)] = p; });
  prev.forEach(function (p) { prevBy[norm(p.name)] = p; });

  var removed = [], retitled = [], people = next.slice();
  prev.forEach(function (p) {
    var k = norm(p.name), now = nextBy[k];
    if (!now) {
      if (flat && flat.indexOf(k) !== -1) people.push(p);   // still on the page; the reader just missed them
      else removed.push(p);
      return;
    }
    if (opts.titles && now.title && p.title && !sameTitle(p.title, now.title)) {
      retitled.push({ name: now.name, from: p.title, to: now.title, group: now.group || '' });
    }
    if (!now.title && p.title) now.title = p.title;
    if (!now.group && p.group) now.group = p.group;
  });
  var added = next.filter(function (p) { return !prevBy[norm(p.name)]; });
  return { added: added, removed: removed, retitled: retitled, people: people };
}

// ── Snapshots (Vercel Blob) ───────────────────────────────────────────────
// Earlier snapshots stored plain name strings under `players`.
function normalizePeople(list) {
  return (list || []).map(function (p) {
    if (typeof p === 'string') return { name: p, jersey: '' };
    var o = { name: p.name };
    if (p.jersey != null) o.jersey = p.jersey || '';
    if (p.title) o.title = p.title;
    if (p.group) o.group = p.group;
    return o;
  }).filter(function (p) { return p.name; });
}

async function getSnapshot(slug) {
  try {
    var result = await get('roster-snapshots/' + slug + '.json', { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200) return null;
    var snap = await new Response(result.stream).json();
    var list = snap && (snap.people || snap.players);
    if (!list) return null;
    var people = normalizePeople(list);
    return { people: people, players: people, checkedAt: snap.checkedAt || null, hash: snap.hash || null, pendingDrop: !!snap.pendingDrop };
  } catch (e) { return null; }
}

async function saveSnapshot(slug, snapshot) {
  await put('roster-snapshots/' + slug + '.json', JSON.stringify(snapshot), {
    access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json'
  });
}

// ── One page, start to finish ─────────────────────────────────────────────
// Returns { status, count?, added[], removed[], retitled[] }. Never throws.
async function checkTarget(target, beat) {
  var none = { added: [], removed: [], retitled: [] };
  try {
    var html = await fetchPage(target.url);
    var text = htmlToText(html);
    var hash = hashText(text);
    var prev = await getSnapshot(target.slug);
    var checkedAt = new Date().toISOString();
    var isPlayers = target.kind === 'players';

    // Player rosters: the free regex first.
    var regexPlayers = isPlayers ? extractPlayers(html) : [];
    var usedRegex = regexPlayers.length >= MIN_SANE_ROSTER;
    if (text.length < 200 && !usedRegex) return Object.assign({ status: 'parse-failed', found: 0 }, none);

    // Nothing on the page moved since last time: no AI call, nothing to report.
    if (prev && prev.people.length && prev.hash && prev.hash === hash && !prev.pendingDrop) {
      await saveSnapshot(target.slug, { people: prev.people, checkedAt: checkedAt, hash: hash });
      return Object.assign({ status: 'no-change', count: prev.people.length }, none);
    }

    var next = null, readError = null;
    if (usedRegex) next = regexPlayers;
    else {
      try { next = await extractPeopleAI(text, target, beat); }
      catch (e) { readError = e.message; }
    }

    if (!prev || !prev.people.length) {
      if (!next || !next.length) return Object.assign({ status: readError ? 'read-failed' : 'parse-failed', error: readError || undefined, found: 0 }, none);
      if (isPlayers && next.length < MIN_SANE_ROSTER) return Object.assign({ status: 'parse-failed', found: next.length }, none);
      await saveSnapshot(target.slug, { people: next, checkedAt: checkedAt, hash: hash });
      return Object.assign({ status: 'baseline-created', count: next.length }, none);
    }

    // With no fresh list (the AI read failed), names that vanished from the
    // page text are still a real, checkable signal, so report those and try
    // the full read again next time (the old hash is kept on purpose).
    var d = diffPeople(prev.people, next || [], usedRegex ? null : text, { titles: !isPlayers });
    if (!next) { d.added = []; d.retitled = []; }

    // A page that suddenly lost most of its names is more often a broken or
    // half-loaded page than a purge. Hold it for one check; if the next check
    // agrees, it is real and goes out.
    var bigDrop = prev.people.length >= 6 && d.removed.length > prev.people.length / 2;
    if (usedRegex ? false : bigDrop && !prev.pendingDrop) {
      await saveSnapshot(target.slug, { people: prev.people, checkedAt: checkedAt, hash: prev.hash, pendingDrop: true });
      return Object.assign({ status: 'held-large-drop', wouldRemove: d.removed.length, count: prev.people.length }, none);
    }

    await saveSnapshot(target.slug, { people: d.people, checkedAt: checkedAt, hash: next ? hash : prev.hash });
    var changed = d.added.length || d.removed.length || d.retitled.length;
    return {
      status: changed ? 'changed' : (next ? 'no-change' : 'read-failed'),
      error: readError || undefined, count: d.people.length,
      added: d.added, removed: d.removed, retitled: d.retitled
    };
  } catch (e) {
    return Object.assign({ status: 'error', error: e.message }, none);
  }
}

module.exports = {
  MIN_SANE_ROSTER: MIN_SANE_ROSTER,
  departmentLabel: departmentLabel,
  slugify: slugify,
  watchTargets: watchTargets,
  safeUrl: safeUrl,
  htmlToText: htmlToText,
  extractPlayers: extractPlayers,
  parsePeopleLines: parsePeopleLines,
  isKeyRole: isKeyRole,
  diffPeople: diffPeople,
  getSnapshot: getSnapshot,
  saveSnapshot: saveSnapshot,
  checkTarget: checkTarget
};
