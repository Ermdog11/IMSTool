// Email an article in and it lands in the Content Editor's Drafts (Jeff,
// 2026-10-06: "the ability to email or text an article to the content
// editor, where it then can be stored as a draft or edited").
//
// The address is the newsroom's own Gmail (GMAIL_USER, the account the app
// already sends from) with "+drafts" added, e.g. copublisher+drafts@gmail.com:
// Gmail delivers plus-addressed mail to the same inbox, so there is no new
// service, domain or DNS to set up. api/email-drafts.js (cron, every 5 min,
// or "Check now" on the Drafts tab) reads unread mail sent to that address
// over IMAP with the same app password, turns each into a draft and marks it
// read.
//
// Who can send: a team member (their sign-in email) or anyone on the digest
// list, and Gmail must have verified the sender (DKIM or SPF pass, DMARC not
// failed), so a forged From line doesn't get in. Anything else is marked
// read and skipped, with no reply (no backscatter to strangers).
//
// What becomes the article: an attached Word file (.docx) first, then an
// attached .txt/.md/.html file, then the email's own body. The subject is
// the headline ("Fwd:" and the like removed). The sender gets a short reply
// with a link to the draft.

var S = require('./_supabase');
var Drafts = require('./_drafts');

var SITE_SLUG = 'insidemdsports';
var TAG = 'drafts';
var MAX_PER_RUN = 10;

function inboxInfo() {
  var user = String(process.env.GMAIL_USER || '').trim();
  var m = /^([^@+]+)(?:\+[^@]*)?@(.+)$/.exec(user);
  if (!m || !process.env.GMAIL_APP_PASSWORD) return { configured: false, address: null, calendarAddress: null };
  // +calendar mail is read in the same pass and goes to the calendar (_calendar.js).
  return { configured: true, address: m[1] + '+' + TAG + '@' + m[2], calendarAddress: m[1] + '+calendar@' + m[2] };
}

function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// Plain text -> paragraphs.
function textToHtml(t) {
  return String(t || '').replace(/\r/g, '').split(/\n\s*\n/).map(function (p) {
    p = p.trim(); return p ? '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>' : '';
  }).filter(Boolean).join('\n');
}

// Keep the article's structure (paragraphs, bold, links, lists, headings,
// embeds) and drop everything else an email client adds: styles, scripts,
// tracking pixels, signatures' table layout, event handlers.
var KEEP = { p: 1, br: 1, b: 1, strong: 1, i: 1, em: 1, u: 1, a: 1, ul: 1, ol: 1, li: 1, h1: 1, h2: 1, h3: 1, h4: 1, blockquote: 1, img: 1, iframe: 1, hr: 1 };
function cleanHtml(html) {
  var s = String(html || '')
    .replace(/<(script|style|head|title|xml)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<div[^>]*>/gi, '<p>').replace(/<\/div>/gi, '</p>');
  s = s.replace(/<\/?([a-z0-9]+)([^>]*)>/gi, function (all, tag, attrs) {
    tag = tag.toLowerCase();
    if (!KEEP[tag]) return '';
    if (all[1] === '/') return '</' + tag + '>';
    var keep = '';
    var want = tag === 'a' ? ['href'] : (tag === 'img' || tag === 'iframe') ? ['src', 'width', 'height', 'alt'] : [];
    want.forEach(function (name) {
      var m = new RegExp('\\s' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(attrs);
      var v = m ? (m[2] != null ? m[2] : m[3] != null ? m[3] : m[4]) : null;
      if (v == null || /^\s*(javascript|data|vbscript):/i.test(v)) return;
      if (tag === 'img' && /^\s*cid:/i.test(v)) return;
      keep += ' ' + name + '="' + v.replace(/"/g, '&quot;') + '"';
    });
    if (tag === 'img' && !/src=/.test(keep)) return '';
    if (tag === 'img' && /(width|height)="[0-2]"/.test(keep)) return ''; // tracking pixel
    return '<' + tag + keep + '>';
  });
  // Collapse the empty paragraphs email clients leave behind.
  return s.replace(/<p>\s*(<br>\s*)*<\/p>/gi, '').replace(/(<p>\s*){2,}/gi, '<p>').replace(/(<\/p>\s*){2,}/gi, '</p>').replace(/\n{3,}/g, '\n\n').trim();
}

function cleanSubject(s) {
  var t = String(s || '').trim();
  for (var i = 0; i < 4; i++) t = t.replace(/^\s*(fwd?|fw|re|aw)\s*:\s*/i, '');
  return t.trim().slice(0, 300);
}

// Gmail's own verdict on whether the From address is real.
function senderVerified(parsed, fromAddr) {
  var raw = parsed.headers && parsed.headers.get('authentication-results');
  var ar = (Array.isArray(raw) ? raw.join(' ') : String(raw || '')).toLowerCase();
  if (!ar) return fromAddr === String(process.env.GMAIL_USER || '').toLowerCase(); // sent from the newsroom account itself
  if (/dmarc=fail/.test(ar)) return false;
  return /dkim=pass/.test(ar) || /spf=pass/.test(ar);
}

// Team members' sign-in emails -> their byline, plus the digest list.
async function allowedSenders() {
  var map = {};
  require('./_mailer').digestList().forEach(function (e) { map[e.toLowerCase()] = ''; });
  if (!S.isConfigured()) return map;
  try {
    var sb = S.admin();
    var site = await sb.from('sites').select('id').eq('slug', SITE_SLUG).single();
    if (!site.data) return map;
    var mem = await sb.from('memberships').select('byline, profiles(email, full_name)').eq('site_id', site.data.id);
    (mem.data || []).forEach(function (m) {
      var e = m.profiles && m.profiles.email;
      if (e) map[e.toLowerCase()] = m.byline || (m.profiles && m.profiles.full_name) || '';
    });
  } catch (e) { console.error('email-drafts: team lookup failed:', e.message); }
  return map;
}

async function articleFrom(parsed) {
  var atts = parsed.attachments || [];
  var docx = atts.filter(function (a) { return /\.docx$/i.test(a.filename || '') || /wordprocessingml/.test(a.contentType || ''); })[0];
  if (docx) {
    var out = await require('mammoth').convertToHtml({ buffer: docx.content });
    return { html: cleanHtml(out.value), from: docx.filename || 'Word file' };
  }
  var txt = atts.filter(function (a) { return /\.(txt|md|markdown|html?)$/i.test(a.filename || ''); })[0];
  if (txt) {
    var body = txt.content.toString('utf8');
    return { html: /\.html?$/i.test(txt.filename) ? cleanHtml(body) : textToHtml(body), from: txt.filename };
  }
  if (parsed.html) return { html: cleanHtml(parsed.html), from: 'email' };
  return { html: textToHtml(parsed.text || ''), from: 'email' };
}

// One pass over the inbox. Returns { checked, saved: [{id, headline, from}], skipped: [{from, why}] }.
async function run() {
  var info = inboxInfo();
  if (!info.configured) return { configured: false, checked: 0, saved: [], skipped: [] };
  var { ImapFlow } = require('imapflow');
  var { simpleParser } = require('mailparser');
  var client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true, logger: false,
    auth: { user: process.env.GMAIL_USER, pass: String(process.env.GMAIL_APP_PASSWORD).replace(/\s/g, '') }
  });
  var out = { configured: true, address: info.address, calendarAddress: info.calendarAddress, checked: 0, saved: [], calendar: [], skipped: [] };
  await client.connect();
  var lock = await client.getMailboxLock('INBOX');
  try {
    // Gmail's own search (X-GM-RAW) also catches mail sent by Bcc or
    // forwarded, where our address isn't in the To line.
    var uids;
    try { uids = await client.search({ seen: false, gmraw: 'deliveredto:' + info.address + ' OR deliveredto:' + info.calendarAddress }, { uid: true }); }
    catch (e) { uids = await client.search({ seen: false, or: [{ to: info.address }, { to: info.calendarAddress }] }, { uid: true }); }
    uids = uids || [];
    uids = uids.slice(0, MAX_PER_RUN);
    if (!uids.length) return out;
    var senders = await allowedSenders();
    for (var i = 0; i < uids.length; i++) {
      var uid = uids[i];
      out.checked++;
      try {
        var msg = await client.fetchOne(uid, { source: true }, { uid: true });
        var parsed = await simpleParser(msg.source);
        var fromAddr = ((parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].address) || '').toLowerCase();
        if (!(fromAddr in senders)) { out.skipped.push({ from: fromAddr, why: 'not on the team' }); continue; }
        if (!senderVerified(parsed, fromAddr)) { out.skipped.push({ from: fromAddr, why: 'sender not verified' }); continue; }
        // Sent to +calendar: dates go on the calendar instead of a draft.
        var rcpts = [].concat(parsed.to ? parsed.to.value || [] : [], parsed.cc ? parsed.cc.value || [] : []).map(function (a) { return String(a.address || '').toLowerCase(); });
        var dto = parsed.headers && parsed.headers.get('delivered-to');
        dto = (Array.isArray(dto) ? dto.join(' ') : String(dto && dto.text || dto || '')).toLowerCase();
        if (rcpts.indexOf(info.calendarAddress.toLowerCase()) !== -1 || dto.indexOf('+calendar@') !== -1) {
          var calText = parsed.text || String(parsed.html || '').replace(/<[^>]+>/g, ' ');
          var cal = await require('./_calendar').fromEmail(calText, { from: fromAddr, subject: cleanSubject(parsed.subject), sentAt: parsed.date });
          out.calendar.push({ subject: cleanSubject(parsed.subject), events: cal.events.length, from: fromAddr });
          continue;
        }
        var art = await articleFrom(parsed);
        var plain = art.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (plain.length < 40) { out.skipped.push({ from: fromAddr, why: 'no article text' }); continue; }
        var headline = cleanSubject(parsed.subject) || plain.slice(0, 90);
        var now = new Date().toISOString();
        var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        var fromName = senders[fromAddr] || (parsed.from.value[0].name || fromAddr);
        await Drafts.saveDraft({
          id: id, writerName: fromName, tier: 'free', headline: headline, html: art.html,
          status: 'draft', source: 'email', emailedBy: fromAddr, emailedFrom: art.from,
          createdAt: now, updatedAt: now
        });
        out.saved.push({ id: id, headline: headline, from: fromAddr });
        try {
          await require('./_mailer').sendMail({
            to: fromAddr,
            subject: 'Draft saved: ' + headline,
            html: '<p>Your article <b>' + esc(headline) + '</b> is saved as a draft in the Content Editor' +
              (art.from !== 'email' ? ' (from ' + esc(art.from) + ')' : '') + '.</p>' +
              '<p><a href="https://ims-tool.vercel.app/editor#3/' + id + '">Open the draft &rarr;</a></p>'
          });
        } catch (e) { console.error('email-drafts: confirmation failed:', e.message); }
      } catch (e) {
        out.skipped.push({ uid: uid, why: e.message });
      } finally {
        // Read either way, so a bad message isn't retried every 5 minutes.
        try { await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); } catch (e) {}
      }
    }
  } finally {
    lock.release();
    try { await client.logout(); } catch (e) {}
  }
  return out;
}

module.exports = { inboxInfo: inboxInfo, run: run, cleanHtml: cleanHtml, cleanSubject: cleanSubject, textToHtml: textToHtml, senderVerified: senderVerified, articleFrom: articleFrom };
