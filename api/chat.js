// /api/chat — Team chat, persisted (replaces the old pure-client-side chat
// that nobody else on the team could actually see).
//
//   GET ?since=<ISO>   -> { messages: [...] }  (all messages, or only newer than `since` for polling)
//   POST { text }      -> send a message as the signed-in user

var S = require('./_supabase');
var Store = require('./_chat-store');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!S.isConfigured()) return res.status(503).json({ error: 'Login not configured' });

  var ctx;
  try { ctx = await S.requireUser(req); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message }); }

  if (req.method === 'GET') {
    try {
      var since = req.query && req.query.since;
      var messages = await Store.recent(ctx.supabase, ctx.site.id, since);
      return res.status(200).json({ messages: messages });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });

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
