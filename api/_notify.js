// Shared "notify the publisher an article is ready for review" email —
// used both when a writer clicks Send to Publisher directly, and when a
// previously-saved draft gets sent later from the Drafts tab.
var { sendMail } = require('./_mailer');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function notifyPublisherOfSubmission(doc) {
  var headline = doc.headline || (doc.headlines && doc.headlines[0] && doc.headlines[0].text) || '';
  var html = '<div style="font-family:Arial,sans-serif;max-width:640px">';
  html += '<p style="color:#555">An article is ready for your review:</p>';
  html += '<p><b>Writer:</b> ' + esc(doc.writerName || '') + ' &middot; <b>Tier:</b> ' + esc(doc.tier === 'vip' ? 'VIP' : 'Free') + '</p>';
  if (doc.headlines && doc.headlines.length) {
    html += '<h3 style="margin:16px 0 6px">Headline options</h3><ul>';
    doc.headlines.forEach(function(h) { html += '<li>' + (h.label ? '<b>' + esc(h.label) + ':</b> ' : '') + esc(h.text) + '</li>'; });
    html += '</ul>';
  }
  html += '<h3 style="margin:16px 0 6px">Article (promo copy already inserted)</h3>';
  html += '<div style="border:1px solid #ddd;border-radius:8px;padding:16px;background:#fafafa">' + (doc.html || '') + '</div>';
  if (doc.factsToCheck && doc.factsToCheck.length) {
    html += '<h3 style="margin:16px 0 6px;color:#b91c1c">Facts to check / missing</h3><ul>';
    doc.factsToCheck.forEach(function(f) { html += '<li>' + esc(f) + '</li>'; });
    html += '</ul>';
  }
  if (doc.notes && doc.notes.length) {
    html += '<h3 style="margin:16px 0 6px">Editor\'s notes</h3><ul>';
    doc.notes.forEach(function(n) { html += '<li>' + esc(n) + '</li>'; });
    html += '</ul>';
  }
  html += '<p style="margin-top:16px"><a href="https://ims-tool.vercel.app/editor.html#3">Open in Editorial Desk drafts &rarr;</a></p>';
  html += '</div>';

  return sendMail({
    subject: '📝 Article submitted (' + (doc.tier === 'vip' ? 'VIP' : 'Free') + ') — ' + (doc.writerName || 'Unknown writer') + (headline ? ': ' + headline : ''),
    html: html
  });
}

module.exports = { notifyPublisherOfSubmission: notifyPublisherOfSubmission };
