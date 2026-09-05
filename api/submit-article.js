// Editorial Desk -> Publisher notification. Fires when a writer clicks
// "Submit to Publisher" on a Copydesk result, emailing Jeff the finished
// piece so he knows something is waiting for review before it's published.
var { sendMail } = require('./_mailer');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Minimal Markdown -> HTML, matching editor.html's own renderer closely enough for email.
function mdToHtml(t) {
  t = esc(t);
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  return t.split(/\n\s*\n/).map(function(p) { return '<p style="margin:0 0 12px">' + p.replace(/\n/g, '<br>') + '</p>'; }).join('');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  var body = req.body || {};
  var edited = (body.edited || '').toString().trim();
  if (!edited) return res.status(400).json({ error: 'No article content' });

  var writerName = (body.writerName || 'Unknown writer').toString().slice(0, 80);
  var headlines = Array.isArray(body.headlines) ? body.headlines.slice(0, 5) : [];
  var notes = Array.isArray(body.notes) ? body.notes.slice(0, 20) : [];
  var factsToCheck = Array.isArray(body.factsToCheck) ? body.factsToCheck.slice(0, 20) : [];

  var html = '<div style="font-family:Arial,sans-serif;max-width:640px">';
  html += '<p style="color:#555">A new article was submitted from the Editorial Desk, ready for your review:</p>';
  html += '<p><b>Writer:</b> ' + esc(writerName) + '</p>';

  if (headlines.length) {
    html += '<h3 style="margin:16px 0 6px">Headline options</h3><ul>';
    headlines.forEach(function(h) {
      html += '<li>' + (h.label ? '<b>' + esc(h.label) + ':</b> ' : '') + esc(h.text) + '</li>';
    });
    html += '</ul>';
  }

  html += '<h3 style="margin:16px 0 6px">Article</h3>';
  html += '<div style="border:1px solid #ddd;border-radius:8px;padding:16px;background:#fafafa">' + mdToHtml(edited) + '</div>';

  if (factsToCheck.length) {
    html += '<h3 style="margin:16px 0 6px;color:#b91c1c">Facts to check / missing</h3><ul>';
    factsToCheck.forEach(function(f) { html += '<li>' + esc(f) + '</li>'; });
    html += '</ul>';
  }
  if (notes.length) {
    html += '<h3 style="margin:16px 0 6px">Editor\'s notes</h3><ul>';
    notes.forEach(function(n) { html += '<li>' + esc(n) + '</li>'; });
    html += '</ul>';
  }
  html += '</div>';

  try {
    await sendMail({
      subject: '📝 Article submitted for review — ' + writerName + (headlines[0] ? ': ' + headlines[0].text : ''),
      html: html
    });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
