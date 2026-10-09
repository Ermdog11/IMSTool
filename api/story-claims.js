// Story claims (Alerts cards). "Claim" marks a story as taken by one person so
// the rest of the newsroom sees "📌 Sam is on it" on the same card and nobody
// writes it twice. Replaces the old Claim button, which asked for a name,
// defaulted to the publisher's, and only showed a note in the clicker's own
// browser.
//
//   GET                                          -> { claims:{ <key>:{ key, headline, url, name, userId, at } }, me:{ userId, name } }
//   POST { action:'claim', key, headline, url, name? }  -> { ok:true, claim, claims }
//                                                   409 { error, claim } when someone else already has it
//   POST { action:'release', key }                -> { ok:true, claims }
//                                                   only the claimant or an editor/publisher (anyone when login is off)
//
// `key` is the page's storyKey() (the story URL without its query, else the
// lowercased headline). Small Vercel Blob map per site (story-claims.json);
// claims older than 4 days drop off, since the story has been written or has
// gone stale by then. Each claim/release also posts a line in Team Chat so it
// shows up there too. Best-effort like the other Blob state.
var { get, put } = require('@vercel/blob');
var S = require('./_supabase.js');
var Chat = require('./_chat-store.js');

var PATH = 'story-claims.json';
var SITE = 'insidemdsports';
var MAX_AGE_MS = 4 * 24 * 3600 * 1000;
var RANK = { writer: 1, editor: 2, publisher: 3 };

async function loadAll() {
  try {
    var r = await get(PATH, { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200) return {};
    var d = await new Response(r.stream).json();
    return (d && typeof d === 'object') ? d : {};
  } catch (e) { return {}; }
}

function fresh(map) {
  var out = {};
  var cutoff = Date.now() - MAX_AGE_MS;
  Object.keys(map || {}).forEach(function (k) {
    var c = map[k];
    if (c && Date.parse(c.at) > cutoff) out[k] = c;
  });
  return out;
}

function whoAmI(ctx, body) {
  if (ctx && ctx.user) {
    var md = ctx.user.user_metadata || {};
    return {
      userId: ctx.user.id,
      name: md.full_name || md.name || (ctx.membership && ctx.membership.byline) || ctx.user.email || 'Someone',
      role: (ctx.membership && ctx.membership.role) || 'writer'
    };
  }
  // Login switched off: the page asks for a name once and remembers it.
  var n = String((body && body.name) || '').trim().slice(0, 60);
  return { userId: null, name: n || 'Someone', role: 'publisher' };
}

async function chatLine(ctx, me, text) {
  if (!ctx || !ctx.user || !ctx.supabase) return;
  try {
    await Chat.post(ctx.supabase, ctx.site.id, { senderUserId: me.userId, senderName: me.name, text: text, kind: 'system' });
  } catch (e) { console.error('Story claim chat post failed (non-fatal):', e.message); }
}

module.exports = async function handler(req, res) {
  var ctx;
  try { ctx = await S.requireUserOrCron(req, res); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message || 'Not signed in' }); }
  res.setHeader('Cache-Control', 'no-store');

  try {
    var body = req.body || {};
    var me = whoAmI(ctx, body);
    var all = await loadAll();
    var claims = fresh(all[SITE]);

    if (req.method === 'GET') {
      return res.status(200).json({ claims: claims, me: { userId: me.userId, name: ctx && ctx.user ? me.name : null } });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });
    if (ctx && ctx.cron) return res.status(403).json({ error: 'Claims are made by people' });

    var key = String(body.key || '').trim().slice(0, 400);
    if (!key) return res.status(400).json({ error: 'key required' });
    var existing = claims[key];
    var headline = String(body.headline || (existing && existing.headline) || '').trim().slice(0, 300);

    if (body.action === 'claim') {
      var mine = existing && (me.userId ? existing.userId === me.userId : existing.name === me.name);
      if (existing && !mine) return res.status(409).json({ error: existing.name + ' already has this story', claim: existing, claims: claims });
      var claim = existing || {
        key: key,
        headline: headline,
        url: String(body.url || '').trim().slice(0, 600),
        name: me.name,
        userId: me.userId,
        at: new Date().toISOString()
      };
      claims[key] = claim;
      all[SITE] = claims;
      await put(PATH, JSON.stringify(all), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
      if (!existing) await chatLine(ctx, me, '📌 ' + me.name + ' claimed: "' + headline + '"');
      return res.status(200).json({ ok: true, claim: claim, claims: claims });
    }

    if (body.action === 'release') {
      if (!existing) return res.status(200).json({ ok: true, claims: claims });
      var own = me.userId ? existing.userId === me.userId : true;
      if (!own && (RANK[me.role] || 0) < RANK.editor) {
        return res.status(403).json({ error: 'Only ' + existing.name + ' or an editor can release this story' });
      }
      delete claims[key];
      all[SITE] = claims;
      await put(PATH, JSON.stringify(all), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
      await chatLine(ctx, me, '↩️ ' + (own ? me.name + ' released' : me.name + ' released ' + existing.name + "'s claim on") + ': "' + existing.headline + '" — open for anyone');
      return res.status(200).json({ ok: true, claims: claims });
    }

    return res.status(400).json({ error: "action must be 'claim' or 'release'" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
