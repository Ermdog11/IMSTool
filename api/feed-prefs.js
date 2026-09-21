// /api/feed-prefs — blocked sources, flagged junk, own-outlet excludes,
// hidden items.
//
// These used to live only in the browser's localStorage, which meant they
// never followed the editor between browsers (e.g. sources blocked in
// Chrome kept resurfacing in Brave, since Brave's localStorage starts
// empty). Shared per newsroom (site_settings, same as house style / search
// keys), so any signed-in team member sees the same cleaned-up feed
// everywhere.
//
//   GET                                          -> { blockedSources, flaggedStories, ownSiteExclude, hiddenVideos }
//   POST { <one or more of the 4 keys>: [...] }  -> upserts just the fields provided
//
// The client keeps localStorage as its instant, offline-safe copy and treats
// this endpoint as a best-effort sync — a failed call here never blocks the
// UI (see IMSAuth.authFetch usage in index.html). Open to any member, not
// gated to editor/publisher — blocking a junk source is routine curation,
// not a credential like the search API keys.

var S = require('./_supabase');
var Store = require('./_settings-store');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!S.isConfigured()) return res.status(503).json({ error: 'Login not configured' });

  var ctx;
  try { ctx = await S.requireUser(req); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message }); }

  if (req.method === 'GET') {
    var prefs = await Store.getFeedPrefs(ctx.supabase);
    return res.status(200).json(prefs);
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });

  try {
    await Store.saveFeedPrefs(ctx.supabase, req.body || {});
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
};
