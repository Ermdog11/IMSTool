// "A writer starts an article" alert (alert-prefs.js `article_started`, on by
// default for the publisher). The switch was on the preferences page, but
// nothing ever sent it. Jeff's rule (2026-09-10): alert on the FIRST save of
// a new article only, never on later edits, so callers use this only when a
// draft is created by a person:
//   - Copydesk "Save draft" (submit-article.js, action 'save'; "Send to
//     publisher" already sends its own "Article submitted" email)
//   - Write it on a story card (write-story.js), From social (write-from-post.js)
// Not for scheduled auto-drafts, duplicates, or a rewrite of an existing draft.
//
// Goes to everyone with the alert on (per newsroom, honoring each person's
// days/hours and email/text choice in _mailer.js), minus the person who
// started it. Best-effort: never throws, so the draft always saves.
var S = require('./_supabase');

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Who started it, from the signed-in request (requireUserOrCron's result).
function starterOf(auth) {
  var u = auth && auth.user;
  if (!u) return null;
  var md = u.user_metadata || {};
  return { email: String(u.email || '').toLowerCase(), name: md.full_name || md.name || (auth.membership && auth.membership.byline) || u.email || 'Someone' };
}

// doc: the saved draft. how: 'copydesk' | 'write-it' | 'from-social'.
// extra: { from } — the story or post it was written from, if any.
async function notify(doc, auth, how, extra) {
  try {
    var who = starterOf(auth);
    if (!who || !doc || !doc.id) return { skipped: 'no signed-in starter' };
    var Site = require('./_site');
    var to = (await S.recipientsFor('article_started', Site.slug()))
      .filter(function (e) { return String(e).toLowerCase() !== who.email; });
    if (!to.length) return { skipped: 'nobody else has this alert on' };

    var headline = doc.headline || '(no headline yet)';
    var kind = how === 'write-it' ? 'started an AI draft (Write it) from a story'
      : how === 'from-social' ? 'started an AI draft from a social post'
      : 'started an article in the Content Editor';
    var byline = doc.writerName && !/^AI draft/.test(doc.writerName) && doc.writerName !== who.name && doc.writerName !== 'Unknown writer'
      ? ' (byline: ' + doc.writerName + ')' : '';
    var from = extra && extra.from;
    if (from && !/^https?:\/\//i.test(from.url || '')) from = { title: from.title };
    var link = 'https://ims-tool.vercel.app/editor#3/' + encodeURIComponent(doc.id);
    return await require('./_mailer').sendMail({
      to: to, alertType: 'article_started',
      subject: '✍️ ' + who.name + ' is writing: ' + headline,
      sms: who.name + ' is writing: ' + headline + '\n' + link,
      html: '<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:14px;max-width:640px">' +
        '<p><b>' + esc(who.name) + '</b>' + esc(byline) + ' ' + esc(kind) + ':</p>' +
        '<p style="font-size:16px;margin:8px 0"><b>' + esc(headline) + '</b></p>' +
        (from && from.url ? '<p style="color:#555">From: <a href="' + esc(from.url) + '">' + esc(from.title || from.url) + '</a></p>'
          : from && from.title ? '<p style="color:#555">From: ' + esc(from.title) + '</p>' : '') +
        '<p><a href="' + link + '">Open the draft &rarr;</a></p>' +
        '<p style="font-size:12px;color:#888">You get this because "A writer starts an article" is on for you. Change it, or its days and hours, in <a href="https://ims-tool.vercel.app/preferences#alerts">Permissions &amp; preferences</a>.</p>' +
        '</div>'
    });
  } catch (e) {
    console.error('Article-started alert failed (non-fatal):', e.message);
    return { error: e.message };
  }
}

module.exports = { notify: notify, starterOf: starterOf };
