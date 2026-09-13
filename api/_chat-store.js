// Team chat persistence (Supabase `chat_messages`). Used both by api/chat.js
// (a signed-in person sending a message) and by server crons posting an
// automated drop — a rating-4+ scan hit or an auto-drafted breaking story
// (api/rolling-digest.js) — so every viewer sees the same channel instead of
// the old pure-client-side chat, which nobody else could ever see.

var SITE_SLUG = 'insidemdsports';
var siteIdCache = null;

async function resolveSiteId(sb) {
  if (siteIdCache) return siteIdCache;
  var r = await sb.from('sites').select('id').eq('slug', SITE_SLUG).single();
  if (r.error || !r.data) throw new Error('Chat store: site row missing (run db/schema.sql)');
  siteIdCache = r.data.id;
  return siteIdCache;
}

async function recent(sb, siteId, sinceIso, limit) {
  var q = sb.from('chat_messages').select('id, sender_user_id, sender_name, text, kind, tag, meta, created_at')
    .eq('site_id', siteId).order('created_at', { ascending: true }).limit(limit || 200);
  if (sinceIso) q = q.gt('created_at', sinceIso);
  var res = await q;
  if (res.error) throw new Error(res.error.message);
  return res.data || [];
}

async function post(sb, siteId, msg) {
  var ins = await sb.from('chat_messages').insert({
    site_id: siteId,
    sender_user_id: msg.senderUserId || null,
    sender_name: msg.senderName,
    text: msg.text,
    kind: msg.kind || 'user',
    tag: msg.tag || null,
    meta: msg.meta || {}
  }).select('id, created_at').single();
  if (ins.error) throw new Error(ins.error.message);
  return ins.data;
}

// For server crons (no signed-in user) — resolves the site itself and posts
// as a system sender. Best-effort: never throws past this boundary.
async function postSystemMessage(sb, opts) {
  try {
    var siteId = await resolveSiteId(sb);
    return await post(sb, siteId, opts);
  } catch (e) {
    console.error('Chat system post failed (non-fatal):', e.message);
    return { error: e.message };
  }
}

module.exports = { resolveSiteId: resolveSiteId, recent: recent, post: post, postSystemMessage: postSystemMessage };
