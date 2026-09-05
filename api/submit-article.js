// Editorial Desk -> Draft store. First save of a Copydesk result — either
// "Save draft" (status: draft, no email, so a writer can keep working on it
// later) or "Send to publisher" (status: submitted, emails the publisher
// immediately). Subsequent saves of the SAME draft go through api/drafts.js
// instead, once the client has an id to update.
//
// Tier-based promotional copy: the writer picks "VIP" or "Free" for the
// piece, and the publisher's own promo HTML (configured in the Editorial
// Desk, not hardcoded — see editor.html's "Promos" tab) is auto-inserted
// by placement (top/early/middle/end). This mechanism is generic — any
// publisher can define their own promo blocks, not just InsideMDSports'.
var { saveDraft } = require('./_drafts');
var { notifyPublisherOfSubmission } = require('./_notify');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// AI output is Markdown; the promo blocks are raw HTML. Convert the article
// to an HTML paragraph array so promo HTML can be spliced in cleanly.
function mdToParagraphs(t) {
  var esc_ = esc(t || '');
  esc_ = esc_.replace(/^\s*#{1,3}\s*(.+)$/gm, '<h2>$1</h2>');
  esc_ = esc_.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  esc_ = esc_.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  return esc_.split(/\n\s*\n/).map(function(p) {
    return /^<h2>/.test(p) ? p : '<p>' + p.replace(/\n/g, '<br>') + '</p>';
  }).filter(Boolean);
}

// Where each placement lands, expressed as a paragraph index computed
// against the ORIGINAL (pre-insertion) paragraph count — 'early' means
// "somewhere in the first 3-5 paragraphs."
function placementIndex(placement, count) {
  if (placement === 'top') return 0;
  if (placement === 'early') return Math.min(3, count);
  if (placement === 'middle') return Math.floor(count / 2);
  return count; // 'end' (or anything unrecognized)
}

// Applies every matching promo at its own spot. Insertions are computed
// against the original paragraph count, then applied in ascending order
// with a running offset so multiple promos don't clobber each other's
// target position.
function composeFinalHtml(edited, promos) {
  var paragraphs = mdToParagraphs(edited);
  var count = paragraphs.length;
  var inserts = (promos || [])
    .filter(function(p) { return p && p.html; })
    .map(function(p) { return { index: placementIndex(p.placement, count), html: p.html }; })
    .sort(function(a, b) { return a.index - b.index; });

  var offset = 0;
  inserts.forEach(function(ins) {
    paragraphs.splice(ins.index + offset, 0, ins.html);
    offset++;
  });
  return paragraphs.join('\n');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  var body = req.body || {};
  var edited = (body.edited || '').toString().trim();
  if (!edited) return res.status(400).json({ error: 'No article content' });

  var action = body.action === 'save' ? 'save' : 'submit';
  var writerName = (body.writerName || 'Unknown writer').toString().slice(0, 80);
  var tier = body.tier === 'vip' ? 'vip' : 'free';
  var headlines = Array.isArray(body.headlines) ? body.headlines.slice(0, 5) : [];
  var notes = Array.isArray(body.notes) ? body.notes.slice(0, 20) : [];
  var factsToCheck = Array.isArray(body.factsToCheck) ? body.factsToCheck.slice(0, 20) : [];
  var promos = (Array.isArray(body.promos) ? body.promos : []).slice(0, 20).map(function(p) {
    return { placement: (p && p.placement || 'end').toString(), html: (p && p.html || '').toString().slice(0, 10000) };
  });

  var finalHtml = composeFinalHtml(edited, promos);
  var headline = headlines[0] ? headlines[0].text : '';

  var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  var now = new Date().toISOString();
  var doc = {
    id: id, writerName: writerName, tier: tier, headline: headline, headlines: headlines,
    html: finalHtml, notes: notes, factsToCheck: factsToCheck,
    status: action === 'save' ? 'draft' : 'submitted',
    createdAt: now, updatedAt: now
  };
  try {
    await saveDraft(doc);
  } catch (e) {
    return res.status(500).json({ error: 'Failed to save draft: ' + e.message });
  }

  if (action === 'save') return res.status(200).json({ ok: true, id: id, html: finalHtml, status: 'draft' });

  try {
    await notifyPublisherOfSubmission(doc);
  } catch (e) {
    // Draft is already saved even if the email fails — don't lose the work over a mail hiccup.
    return res.status(200).json({ ok: true, id: id, html: finalHtml, status: 'submitted', mailError: e.message });
  }
  return res.status(200).json({ ok: true, id: id, html: finalHtml, status: 'submitted' });
};
