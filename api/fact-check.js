// /api/fact-check — the opt-in "Extra fact-check" (see _fact-check.js).
//
//   POST { article, headline? }   -> { claims:[{claim,status,detail,source,url}], summary, checkedAt }
//   POST { draftId }              -> same, checking that saved draft; the result is
//                                    stored on the draft and any conflicts are added
//                                    to its "Verify before publishing" list.

var S = require('./_supabase');
var Access = require('./_access');
var Drafts = require('./_drafts');
var FC = require('./_fact-check');

module.exports = async function handler(req, res) {
  var who;
  try { who = await S.requireUserOrCron(req, res); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message || 'Not signed in' }); }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!(await Access.allowed(who, 'act_fact_check'))) return Access.deny(res);

  var body = req.body || {};
  try {
    var draft = null;
    if (body.draftId) {
      draft = await Drafts.loadDraft(String(body.draftId));
      if (!draft) return res.status(404).json({ error: 'Draft not found' });
      if (who && who.membership) who.drafts_all = await Access.allowed(who, 'drafts_all');
      if (!Drafts.canSee(who, draft)) return res.status(403).json({ error: 'That draft isn\'t yours.' });
    }
    var article = body.article || (draft && draft.html) || '';
    var headline = body.headline || (draft && draft.headline) || '';
    var result = await FC.factCheck(article, headline, S.isConfigured() ? S.admin() : null);
    if (draft) {
      var kept = (draft.factsToCheck || []).filter(function (f) { return String(f).indexOf('Fact-check conflict:') !== 0; });
      draft.factsToCheck = kept.concat(FC.toFactsToCheck(result));
      draft.factCheck = result;
      await Drafts.saveDraft(draft); // updatedAt kept: checking isn't an edit
    }
    return res.status(200).json(result);
  } catch (e) {
    console.error('Fact-check failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
};

// Per-newsroom: this request runs as the signed-in person's newsroom (_site.js).
module.exports = require('./_site').wrap(module.exports);
