// POST /api/account-delete { confirm: 'DELETE' }: deletes the signed-in
// person's own account (Apple App Store guideline 5.1.1(v) requires in-app
// account deletion; also listed on /privacy and /support).
//
// Removes the sign-in (Supabase auth user; the profile, newsroom memberships
// and alert switches cascade from it in db/schema.sql) and the personal
// settings kept outside the database: chat photo, hot-spot alert and calendar
// reminder defaults, alert days/hours. Work saved to the newsroom (drafts,
// published articles, transcripts, chat messages) stays with the newsroom.
// The newsroom's only publisher can't delete their account until someone
// else is publisher, so a newsroom is never left without one.
var S = require('./_supabase');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!S.isConfigured()) return res.status(503).json({ error: 'Sign-in isn\'t switched on, so there\'s no account to delete.' });
  var ctx;
  try { ctx = await S.requireUser(req); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message || 'Not signed in' }); }
  if (!req.body || req.body.confirm !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm.' });

  var sb = ctx.supabase, uid = ctx.user.id, email = String(ctx.user.email || '').toLowerCase();
  try {
    if (ctx.membership.role === 'publisher') {
      var pubs = await sb.from('memberships').select('user_id').eq('site_id', ctx.site.id).eq('role', 'publisher');
      if (!pubs.error && (pubs.data || []).filter(function (m) { return m.user_id !== uid; }).length === 0) {
        return res.status(409).json({ error: 'You\'re this newsroom\'s only publisher. Make someone else publisher first (Settings › Team), then delete your account.' });
      }
    }
    // Personal settings outside the database (best-effort).
    try { await require('./_chat-store').setAvatar(uid, null); } catch (e) {}
    try { if (email) await require('./_alert-schedule').clearAll(email); } catch (e) {}
    try { if (email) await require('./_calendar').forgetPerson(email); } catch (e) {}

    var del = await sb.auth.admin.deleteUser(uid);
    if (del.error) throw new Error(del.error.message);
    console.log('Account deleted:', uid);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'Couldn\'t delete the account: ' + e.message });
  }
};
