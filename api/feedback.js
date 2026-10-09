// /api/feedback — the 💬 Feedback button on every page (public/_auth.js;
// Jeff, 2026-10-09: "Need a feedback tool. Put wherever it makes sense").
// Anyone signed in can send a bug, an idea or anything else; it's saved for
// CoPublisher AI and emailed to the operators, with Reply-To set to the
// sender so a reply goes straight back to them.
//
//   POST { kind: 'bug'|'idea'|'other', message, page }      -> { ok }
//   GET  (operators)                                          -> { items: [...], open }
//   POST (operators) { action: 'done', id, done: true|false } -> { ok }
//
// Operators = PLATFORM_ADMIN_EMAILS, or, while that isn't set, the
// InsideMDSports publisher. One list for the whole platform (Blob
// platform/feedback.json, newest 500), not per newsroom: it's feedback about
// the product. No credits spent. Fails open: with login off, anyone can send.

var S = require('./_supabase');
var blob = require('@vercel/blob');
var Site = require('./_site');

var PATH = 'platform/feedback.json';
var MAX_ITEMS = 500, MAX_LEN = 4000, PER_DAY = 30;
var KINDS = { bug: '🐞 Something\'s broken', idea: '💡 Idea', other: '💬 Feedback' };

async function load() {
  try {
    var r = await blob.get(PATH, { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200) return [];
    var d = await new Response(r.stream).json();
    return Array.isArray(d) ? d : [];
  } catch (e) { return []; }
}
async function save(list) {
  await blob.put(PATH, JSON.stringify(list.slice(0, MAX_ITEMS)), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
}

function admins() {
  return String(process.env.PLATFORM_ADMIN_EMAILS || '').toLowerCase().split(',').map(function (x) { return x.trim(); }).filter(Boolean);
}
function isOperator(ctx) {
  if (!ctx) return !S.isConfigured();
  var list = admins(), email = String((ctx.user && ctx.user.email) || '').toLowerCase();
  if (list.length) return list.indexOf(email) !== -1;
  return !!(ctx.membership && ctx.membership.role === 'publisher' && ctx.site && ctx.site.slug === Site.DEFAULT);
}
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  var ctx = null;
  if (S.isConfigured()) {
    try { ctx = await S.requireUser(req); }
    catch (e) { return res.status(e.status || 401).json({ error: 'Sign in to send feedback.' }); }
  }
  var body = req.body || {};

  if (req.method === 'GET' || body.action === 'done') {
    if (!isOperator(ctx)) return res.status(403).json({ error: 'Only CoPublisher AI sees the feedback inbox.' });
    var items = await load();
    if (req.method === 'GET') return res.status(200).json({ items: items.slice(0, 200), open: items.filter(function (x) { return !x.done; }).length });
    var it = items.filter(function (x) { return x.id === body.id; })[0];
    if (!it) return res.status(404).json({ error: 'Not found' });
    if (body.done) it.done = new Date().toISOString(); else delete it.done;
    await save(items);
    return res.status(200).json({ ok: true });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });

  var message = String(body.message || '').trim().slice(0, MAX_LEN);
  if (message.length < 3) return res.status(400).json({ error: 'Write a little more first.' });
  var kind = KINDS[body.kind] ? body.kind : 'other';
  var email = ctx ? String(ctx.user.email || '').toLowerCase() : '';
  var item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    at: new Date().toISOString(), kind: kind, message: message,
    page: String(body.page || '').slice(0, 300),
    email: email,
    name: ctx ? String((ctx.user.user_metadata && ctx.user.user_metadata.full_name) || ctx.membership.byline || '').slice(0, 120) : '',
    role: ctx ? ctx.membership.role : '',
    site: ctx ? ctx.site.slug : Site.slug(),
    siteName: ctx ? ctx.site.name : '',
    ua: String(req.headers['user-agent'] || '').slice(0, 200)
  };

  var list = await load();
  var dayAgo = Date.now() - 86400000;
  if (email && list.filter(function (x) { return x.email === email && Date.parse(x.at) > dayAgo; }).length >= PER_DAY) {
    return res.status(429).json({ error: 'That\'s a lot of feedback for one day. Thank you! Try again tomorrow.' });
  }
  list.unshift(item);
  await save(list);

  // Email the operators. Best-effort: it's saved either way.
  try {
    var to = admins();
    if (!to.length) to = require('./_mailer').digestList();
    if (to.length) {
      var who = (item.name ? item.name + ' ' : '') + (email ? '<' + email + '>' : '(not signed in)');
      await require('./_mailer').sendMail({
        to: to,
        replyTo: email || undefined,
        subject: KINDS[kind] + ' from ' + (item.name || email || 'someone') + (item.siteName ? ' (' + item.siteName + ')' : ''),
        html: '<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:14px;color:#1a1a1a;max-width:620px;">' +
          '<div style="font-size:12px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:.06em;">' + esc(KINDS[kind]) + '</div>' +
          '<div style="white-space:pre-wrap;margin:10px 0 16px;font-size:15px;line-height:1.5;">' + esc(message) + '</div>' +
          '<div style="font-size:12px;color:#666;line-height:1.6;">From ' + esc(who) + (item.role ? ' · ' + esc(item.role) : '') + (item.siteName ? ' · ' + esc(item.siteName) : '') +
          (item.page ? '<br>Page: <a href="' + esc(item.page) + '">' + esc(item.page) + '</a>' : '') + '<br>' + esc(item.ua) +
          '<br>Reply to this email to answer them. Every message is in the Feedback inbox (💬 Feedback › Inbox).</div></div>'
      });
    }
  } catch (e) { console.error('feedback: email failed:', e.message); }

  return res.status(200).json({ ok: true });
};

module.exports = Site.wrap(module.exports);
