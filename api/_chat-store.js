// Team chat persistence (Supabase `chat_messages`). Used both by api/chat.js
// (a signed-in person sending a message) and by server crons posting an
// automated drop — a rating-4+ scan hit or an auto-drafted breaking story
// (api/rolling-digest.js) — so every viewer sees the same channel instead of
// the old pure-client-side chat, which nobody else could ever see.

// The signed-in person's newsroom (_site.js), InsideMDSports for crons.
function resolveSiteId(sb) {
  return require('./_site').siteId(sb);
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

// Publisher clean-up: removes these messages (this site's only). Returns how many.
async function remove(sb, siteId, ids) {
  ids = (ids || []).map(String).filter(function (x) { return /^[0-9a-f-]{8,40}$/i.test(x); }).slice(0, 500);
  if (!ids.length) return 0;
  var del = await sb.from('chat_messages').delete().eq('site_id', siteId).in('id', ids).select('id');
  if (del.error) throw new Error(del.error.message);
  return (del.data || []).length;
}

// Chat profile photos (Jeff, 2026-10-06: "give users options to upload a
// photo that will show next to their name in chat"). Each is a small square
// JPEG the browser resizes before upload (about 5-15 KB as a data URL),
// kept in one private Blob map, user id -> data URL. Small enough to send
// with the chat itself, so no public file hosting is needed.
var AVATARS = 'chat-avatars.json';
async function avatars() {
  try {
    var got = await require('./_site-blob').get(AVATARS, { access: 'private', useCache: false });
    if (got && got.statusCode === 200) return (await new Response(got.stream).json()) || {};
  } catch (e) { /* none */ }
  return {};
}
async function setAvatar(userId, dataUrl) {
  if (!userId) throw new Error('Sign in first.');
  if (dataUrl && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) throw new Error('That isn\'t an image.');
  if (dataUrl && dataUrl.length > 80000) throw new Error('That photo is too big; try a smaller one.');
  var all = await avatars();
  if (dataUrl) all[userId] = dataUrl; else delete all[userId];
  await require('./_site-blob').put(AVATARS, JSON.stringify(all), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
  return true;
}

module.exports = { resolveSiteId: resolveSiteId, recent: recent, post: post, postSystemMessage: postSystemMessage, remove: remove, avatars: avatars, setAvatar: setAvatar };
