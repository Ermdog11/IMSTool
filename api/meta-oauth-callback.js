// /api/meta-oauth-callback — GET: Facebook redirects here after the user
// approves (or denies) the connect dialog. Exchanges the code for a
// long-lived Page access token, picks the first Page the user manages
// (single-page newsroom setup — add a picker step here if that changes),
// and stores the connection the same way api/analytics-connections.js does
// for a manual paste-in source.

var S = require('./_supabase');
var Store = require('./_analytics-store');
var Meta = require('./_meta');

var DONE_PATH = '/analytics';

module.exports = async function handler(req, res) {
  var q = req.query || {};
  if (q.error) {
    return res.redirect(302, DONE_PATH + '?meta_error=' + encodeURIComponent(q.error_description || q.error));
  }

  var payload = Meta.verifyState(q.state);
  if (!payload) {
    return res.redirect(302, DONE_PATH + '?meta_error=' + encodeURIComponent('That connect link expired — try again.'));
  }

  try {
    var sb = S.admin();
    var shortLived = await Meta.exchangeCode(q.code);
    var longLived = await Meta.exchangeLongLived(shortLived.access_token);
    var pages = await Meta.getPages(longLived.access_token);
    if (!pages.length) {
      return res.redirect(302, DONE_PATH + '?meta_error=' + encodeURIComponent('No Facebook Pages found — you need to be an admin of at least one Page.'));
    }

    var page = pages[0];
    var igAccountId = await Meta.getInstagramBusinessAccount(page.id, page.access_token);

    await Store.saveConnection(sb, payload.siteId, 'meta', {
      pageAccessToken: page.access_token,
      pageId: page.id,
      pageName: page.name,
      igBusinessAccountId: igAccountId || ''
    }, payload.userId);

    return res.redirect(302, DONE_PATH + '?meta_connected=1');
  } catch (e) {
    return res.redirect(302, DONE_PATH + '?meta_error=' + encodeURIComponent(e.message));
  }
};
