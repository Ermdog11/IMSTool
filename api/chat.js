// /api/chat — Team chat, persisted (replaces the old pure-client-side chat
// that nobody else on the team could actually see).
//
//   GET ?since=<ISO>   -> { messages: [...] }  (all messages, or only newer than `since` for polling)
//   POST { text }      -> send a message as the signed-in user
//   POST { action:'avatar', image } -> your chat photo (a small data: URL; image null removes it)
//   POST { action:'delete', ids:[...] } -> publisher only: delete those messages
//                      (Jeff, 2026-10-06: "publisher needs checkboxes to mass delete messages from chat")

var S = require('./_supabase');
var Store = require('./_chat-store');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!S.isConfigured()) return res.status(503).json({ error: 'Login not configured' });

  var ctx;
  try { ctx = await S.requireUser(req); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
  if (!(await require('./_access').allowed(ctx, 'mon_chat'))) return require('./_access').deny(res);

  if (req.method === 'GET') {
    try {
      var since = req.query && req.query.since;
      var messages = await Store.recent(ctx.supabase, ctx.site.id, since);
      // Photos for the people in these messages (all of them on a full load).
      var all = await Store.avatars(), avatars = {};
      messages.forEach(function (m) { if (m.sender_user_id && all[m.sender_user_id]) avatars[m.sender_user_id] = all[m.sender_user_id]; });
      if (!since && all[ctx.user.id]) avatars[ctx.user.id] = all[ctx.user.id];
      return res.status(200).json({ messages: messages, avatars: avatars, me: ctx.user.id });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });

  if (req.body && req.body.action === 'avatar') {
    try { await Store.setAvatar(ctx.user.id, req.body.image || null); return res.status(200).json({ ok: true }); }
    catch (e) { return res.status(400).json({ error: e.message }); }
  }

  if (req.body && req.body.action === 'delete') {
    if (!ctx.membership || ctx.membership.role !== 'publisher') return res.status(403).json({ error: 'Only the publisher can delete chat messages.' });
    try { return res.status(200).json({ ok: true, deleted: await Store.remove(ctx.supabase, ctx.site.id, req.body.ids) }); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }

  var text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: 'Empty message' });

  var senderName = (ctx.user.user_metadata && (ctx.user.user_metadata.full_name || ctx.user.user_metadata.name))
    || ctx.membership.byline || ctx.user.email || 'Someone';

  try {
    var saved = await Store.post(ctx.supabase, ctx.site.id, { senderUserId: ctx.user.id, senderName: senderName, text: text, kind: 'user' });
    return res.status(200).json({ ok: true, id: saved.id, createdAt: saved.created_at });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
