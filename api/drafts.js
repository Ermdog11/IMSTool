// Editorial Desk drafts list/detail/update. Submitted articles land here via
// api/submit-article.js; this endpoint lets the publisher reopen and edit one.
var { loadIndex, loadDraft, saveDraft } = require('./_drafts');
var { notifyPublisherOfSubmission } = require('./_notify');

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      var id = req.query && req.query.id;
      if (id) {
        var doc = await loadDraft(id);
        if (!doc) return res.status(404).json({ error: 'Draft not found' });
        return res.status(200).json(doc);
      }
      var index = await loadIndex();
      return res.status(200).json({ drafts: index });
    }

    if (req.method === 'POST') {
      var body = req.body || {};
      if (!body.id) return res.status(400).json({ error: 'id required' });
      var existing = await loadDraft(body.id);
      if (!existing) return res.status(404).json({ error: 'Draft not found' });
      var updated = Object.assign({}, existing, {
        html: body.html != null ? body.html : existing.html,
        status: body.status || existing.status,
        updatedAt: new Date().toISOString()
      });
      await saveDraft(updated);
      // Explicit "send to publisher" from the Drafts tab (or re-sending after edits).
      if (body.notify) {
        try { await notifyPublisherOfSubmission(updated); }
        catch (e) { return res.status(200).json({ ok: true, mailError: e.message }); }
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'GET or POST only' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
