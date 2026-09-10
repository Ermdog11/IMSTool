// /api/team — newsroom roster management. Publisher only (except GET, which any
// member can call to see who's on the team).
//
//   GET                       -> { members:[...], invites:[...] }
//   POST { action:'invite',   email, role, byline }
//   POST { action:'setRole',  userId|inviteId, role }
//   POST { action:'setByline', userId, byline }
//   POST { action:'remove',   userId|inviteId }
//
// Roles: publisher | editor | writer. A publisher cannot remove or demote the
// last remaining publisher.

var S = require('./_supabase');
var ROLES = ['publisher', 'editor', 'writer'];

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
    if (up.error) return res.status(500).json({ error: up.error.message });
    return res.status(200).json({ ok: true, invite: up.data, note: 'They get access the first time they sign in at /login with this email.' });
  }

  if (action === 'setRole') {
    var role2 = ROLES.indexOf(body.role) !== -1 ? body.role : null;
    if (!role2) return res.status(400).json({ error: 'Unknown role.' });
    if (body.inviteId) {
      var u1 = await sb.from('invites').update({ role: role2 }).eq('id', body.inviteId).eq('site_id', siteId).select().single();
      return u1.error ? res.status(500).json({ error: u1.error.message }) : res.status(200).json({ ok: true });
    }
    if (body.userId) {
      if (body.userId === ctx.user.id && role2 !== 'publisher' && (await publisherCount()) <= 1) {
        return res.status(400).json({ error: "You're the only publisher — promote someone else first." });
      }
      var u2 = await sb.from('memberships').update({ role: role2 }).eq('user_id', body.userId).eq('site_id', siteId).select().single();
      return u2.error ? res.status(500).json({ error: u2.error.message }) : res.status(200).json({ ok: true });
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
      await sb.from('memberships').delete().eq('user_id', body.userId).eq('site_id', siteId);
      await sb.from('alert_prefs').delete().eq('user_id', body.userId).eq('site_id', siteId);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'Need userId or inviteId.' });
  }

  return res.status(400).json({ error: 'Unknown action.' });
};
