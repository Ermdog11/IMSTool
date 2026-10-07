// /api/team — newsroom roster management. Publisher only (except GET, which any
// member can call to see who's on the team).
//
//   GET                       -> { members:[...], invites:[...] }
//   POST { action:'invite',   email, role, byline }
//   POST { action:'setRole',  userId|inviteId, role }
//   POST { action:'setByline', userId, byline }
//   POST { action:'remove',   userId|inviteId }
//   POST { action:'resendInvite', inviteId }   -> emails the invite again
//
// Roles: publisher | editor | writer. A publisher cannot remove or demote the
// last remaining publisher.

var S = require('./_supabase');
var ROLES = ['publisher', 'editor', 'writer', 'contributor', 'viewer'];
// The contributor and viewer roles need one database update (db/schema.sql).
function friendly(msg) {
  return /invalid input value for enum/i.test(msg || '')
    ? 'The contributor and viewer roles need a one-time database update: run db/schema.sql in the Supabase SQL editor, then try again.'
    : msg;
}

// The invitation email (Jeff, 2026-10-06: two people never got one; inviting
// only saved them to the list). Best-effort: the invite stands even if the
// email fails, and the page says so.
var ROLE_WORDS = {
  publisher: 'run the newsroom (everything)',
  editor: 'edit the team\'s drafts and run the desk',
  writer: 'write and edit your own drafts',
  contributor: 'access the Content Editor for your own drafts',
  viewer: 'follow the news, alerts and calendar (read-only)'
};
function escHtml(x) { return String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
async function emailInvite(req, ctx, email, role) {
  try {
    var beat = await require('./_beat').getBeat(ctx.supabase).catch(function () { return {}; });
    var outlet = (ctx.site && ctx.site.name) || beat.outletName || 'our newsroom';
    var inviter = (ctx.user.user_metadata && (ctx.user.user_metadata.full_name || ctx.user.user_metadata.name)) || ctx.user.email;
    var host = (req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || 'ims-tool.vercel.app';
    var link = 'https://' + host + '/login';
    await require('./_mailer').sendMail({
      to: email,
      fromName: outlet + ' via CoPublisher',
      replyTo: ctx.user.email || undefined,
      subject: inviter + ' invited you to ' + outlet + ' on CoPublisher',
      html: '<div style="font-family:Arial,sans-serif;max-width:520px;font-size:15px;line-height:1.5;color:#1a1a1a">' +
        '<p><b>' + escHtml(inviter) + '</b> invited you to join <b>' + escHtml(outlet) + '</b> on CoPublisher as ' + (/^[aeiou]/.test(role) ? 'an ' : 'a ') + '<b>' + escHtml(role) + '</b>, so you can ' + escHtml(ROLE_WORDS[role] || 'work with the team') + '.</p>' +
        '<p><a href="' + link + '" style="display:inline-block;background:#c8102e;color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:8px">Sign in to join</a></p>' +
        '<p style="color:#555;font-size:13px">Sign in with this email address (<b>' + escHtml(email) + '</b>): we\'ll email you a sign-in link, or use Google with the same address. On your phone you can add it to your home screen to use it like an app.</p>' +
        '<p style="color:#888;font-size:12px">Not expecting this? You can ignore it.</p></div>',
      text: inviter + ' invited you to join ' + outlet + ' on CoPublisher as ' + role + '. Sign in with ' + email + ' at ' + link
    });
    return true;
  } catch (e) {
    console.error('team: invite email to ' + email + ' failed:', e.message);
    return false;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!S.isConfigured()) return res.status(503).json({ error: 'Login not configured' });

  var ctx;
  try {
    ctx = await S.requireUser(req);
  } catch (e) {
    return res.status(e.status || 401).json({ error: e.message });
  }
  var sb = ctx.supabase, siteId = ctx.site.id;

  // ---- GET: anyone on the team ----
  if (req.method === 'GET') {
    var mem = await sb.from('memberships')
      .select('user_id, role, byline, created_at, profiles(email, full_name)')
      .eq('site_id', siteId).order('created_at', { ascending: true });
    var inv = await sb.from('invites')
      .select('id, email, role, byline, created_at, accepted_at')
      .eq('site_id', siteId).is('accepted_at', null).order('created_at', { ascending: true });
    return res.status(200).json({
      members: (mem.data || []).map(function (m) {
        return {
          userId: m.user_id, role: m.role, byline: m.byline,
          email: m.profiles && m.profiles.email, name: m.profiles && m.profiles.full_name,
          joinedAt: m.created_at, isSelf: m.user_id === ctx.user.id
        };
      }),
      invites: inv.data || [],
      youAre: ctx.membership.role
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });

  // ---- everything below is publisher-only ----
  if (ctx.membership.role !== 'publisher') {
    return res.status(403).json({ error: 'Only the publisher can change the team.' });
  }

  var body = req.body || {};
  var action = body.action;

  async function publisherCount() {
    var c = await sb.from('memberships')
      .select('user_id', { count: 'exact', head: true })
      .eq('site_id', siteId).eq('role', 'publisher');
    return c.count || 0;
  }

  if (action === 'invite') {
    var email = String(body.email || '').trim().toLowerCase();
    var role = ROLES.indexOf(body.role) !== -1 ? body.role : 'writer';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });

    // Already a member?
    var existing = await sb.from('memberships')
      .select('user_id, profiles(email)').eq('site_id', siteId);
    if ((existing.data || []).some(function (m) { return m.profiles && m.profiles.email === email; })) {
      return res.status(409).json({ error: email + ' is already on the team.' });
    }
    var up = await sb.from('invites').upsert({
      site_id: siteId, email: email, role: role, byline: body.byline || null, invited_by: ctx.user.id, accepted_at: null
    }, { onConflict: 'site_id,email' }).select().single();
    if (up.error) return res.status(500).json({ error: friendly(up.error.message) });
    var sent = await emailInvite(req, ctx, email, role);
    return res.status(200).json({ ok: true, invite: up.data, emailed: sent,
      note: sent ? 'Invite emailed to ' + email + '. They join the first time they sign in with that address.'
        : 'Invite saved, but the email didn\'t go out. Send them the sign-in link yourself: they join the first time they sign in at /login with ' + email + '.' });
  }

  if (action === 'resendInvite') {
    var ivr = await sb.from('invites').select('id, email, role').eq('id', body.inviteId).eq('site_id', siteId).is('accepted_at', null).maybeSingle();
    if (!ivr.data) return res.status(404).json({ error: 'That invite is gone or already accepted.' });
    var ok = await emailInvite(req, ctx, ivr.data.email, ivr.data.role);
    return res.status(200).json({ ok: ok, emailed: ok, note: ok ? 'Invite emailed again to ' + ivr.data.email + '.' : 'The email didn\'t go out. Send them the link yourself: ' + ((req.headers && req.headers.host) ? 'https://' + req.headers.host : '') + '/login' });
  }

  if (action === 'setRole') {
    var role2 = ROLES.indexOf(body.role) !== -1 ? body.role : null;
    if (!role2) return res.status(400).json({ error: 'Unknown role.' });
    if (body.inviteId) {
      var u1 = await sb.from('invites').update({ role: role2 }).eq('id', body.inviteId).eq('site_id', siteId).select().single();
      return u1.error ? res.status(500).json({ error: friendly(u1.error.message) }) : res.status(200).json({ ok: true });
    }
    if (body.userId) {
      if (body.userId === ctx.user.id && role2 !== 'publisher' && (await publisherCount()) <= 1) {
        return res.status(400).json({ error: "You're the only publisher — promote someone else first." });
      }
      var u2 = await sb.from('memberships').update({ role: role2 }).eq('user_id', body.userId).eq('site_id', siteId).select().single();
      return u2.error ? res.status(500).json({ error: friendly(u2.error.message) }) : res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'Need userId or inviteId.' });
  }

  if (action === 'setByline') {
    if (!body.userId) return res.status(400).json({ error: 'Need userId.' });
    var b = await sb.from('memberships').update({ byline: String(body.byline || '').slice(0, 120) || null })
      .eq('user_id', body.userId).eq('site_id', siteId).select().single();
    return b.error ? res.status(500).json({ error: b.error.message }) : res.status(200).json({ ok: true });
  }

  if (action === 'remove') {
    if (body.inviteId) {
      await sb.from('invites').delete().eq('id', body.inviteId).eq('site_id', siteId);
      return res.status(200).json({ ok: true });
    }
    if (body.userId) {
      var targetRole = await sb.from('memberships').select('role').eq('user_id', body.userId).eq('site_id', siteId).single();
      if (targetRole.data && targetRole.data.role === 'publisher' && (await publisherCount()) <= 1) {
        return res.status(400).json({ error: "Can't remove the only publisher." });
      }
      if (body.userId === ctx.user.id) return res.status(400).json({ error: 'You can\'t remove yourself here. Use Delete my account instead.' });
      // Removing someone ends their access to this newsroom right away (Jeff,
      // 2026-10-07: "if I fire a writer, I need to be able to delete their
      // account so they do not have access anymore"). Their work stays.
      var prof = await sb.from('profiles').select('email').eq('id', body.userId).maybeSingle();
      var gone = prof && prof.data && prof.data.email;
      await sb.from('memberships').delete().eq('user_id', body.userId).eq('site_id', siteId);
      await sb.from('alert_prefs').delete().eq('user_id', body.userId).eq('site_id', siteId);
      if (gone) {
        // An unused invite would let them back in by signing in again.
        await sb.from('invites').delete().eq('site_id', siteId).ilike('email', gone).is('accepted_at', null);
        try { await require('./_alert-schedule').clearAll(gone); } catch (e) { /* best-effort */ }
      }
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'Need userId or inviteId.' });
  }

  return res.status(400).json({ error: 'Unknown action.' });
};

// Per-newsroom: this request runs as the signed-in person's newsroom (_site.js).
module.exports = require('./_site').wrap(module.exports);
