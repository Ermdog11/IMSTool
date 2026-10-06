// Editorial Desk drafts list/detail/update. Submitted articles land here via
// api/submit-article.js; this endpoint lets the publisher reopen and edit one.
var { loadIndex, loadDraft, saveDraft, deleteDraft } = require('./_drafts');
var { notifyPublisherOfSubmission } = require('./_notify');

module.exports = async function handler(req, res) {
  var ctx;
  try { ctx = await require('./_supabase').requireUserOrCron(req, res); }
  catch (authErr) { return res.status(authErr.status || 401).json({ error: authErr.message || 'Not signed in' }); }
  // Writers and contributors see only their own drafts unless the publisher
  // switches on "See and edit everyone's drafts" for their role.
  var Dr = require('./_drafts');
  if (ctx && ctx.membership) ctx.drafts_all = await require('./_access').allowed(ctx, 'drafts_all');
  var notYours = function () { return res.status(403).json({ error: 'That draft isn\'t yours. Ask an editor, or your publisher can let your role see everyone\'s drafts.' }); };
  try {
    if (req.method === 'GET') {
      // The "email an article in" address shown on the Drafts tab.
      if (req.query && req.query.inbox) return res.status(200).json(require('./_email-drafts').inboxInfo());
      var id = req.query && req.query.id;
      if (id) {
        var doc = await loadDraft(id);
        if (!doc) return res.status(404).json({ error: 'Draft not found' });
        if (!Dr.canSee(ctx, doc)) return notYours();
        return res.status(200).json(doc);
      }
      var index = await loadIndex();
      return res.status(200).json({ drafts: index.filter(function (d) { return Dr.canSee(ctx, d); }), mineOnly: !!(ctx && ctx.membership && ctx.membership.role !== 'publisher' && !ctx.drafts_all) });
    }

    if (req.method === 'POST') {
      var body = req.body || {};
      if (!body.id) return res.status(400).json({ error: 'id required' });
      var existing = await loadDraft(body.id);
      if (!existing) return res.status(404).json({ error: 'Draft not found' });
      if (!Dr.canSee(ctx, existing)) return notYours();
      // Duplicate: a new draft with the same content (Drafts list "Duplicate").
      if (body.action === 'duplicate') {
        var now = new Date().toISOString();
        var copy = Object.assign({}, existing, {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
          headline: (existing.headline || '(no headline)') + ' (copy)',
          status: 'draft', createdAt: now, updatedAt: now, sourceUrl: null,
          source: require('./_drafts').sourceOf(existing)
        }, Dr.ownerOf(ctx));
        await saveDraft(copy);
        return res.status(200).json({ ok: true, id: copy.id });
      }
      // Quick edits from the list (headline, status, tier) and full edits
      // from the open draft (html) all land here; only what's sent changes.
      var updated = Object.assign({}, existing, {
        html: body.html != null ? body.html : existing.html,
        headline: typeof body.headline === 'string' && body.headline.trim() ? body.headline.trim().slice(0, 300) : existing.headline,
        tier: body.tier === 'vip' || body.tier === 'free' ? body.tier : existing.tier,
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

    if (req.method === 'DELETE') {
      // ?id=a or ?ids=a,b,c (bulk delete from the list).
      var ids = String((req.query && (req.query.ids || req.query.id)) || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean).slice(0, 200);
      if (!ids.length) return res.status(400).json({ error: 'id required' });
      if (ctx && ctx.membership && ctx.membership.role !== 'publisher' && !ctx.drafts_all) {
        var idx = await loadIndex();
        var byId = {}; idx.forEach(function (d) { byId[d.id] = d; });
        if (ids.some(function (x) { return byId[x] && !Dr.canSee(ctx, byId[x]); })) return notYours();
      }
      await require('./_drafts').deleteDrafts(ids);
      return res.status(200).json({ ok: true, deleted: ids.length });
    }

    return res.status(405).json({ error: 'GET, POST, or DELETE only' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
