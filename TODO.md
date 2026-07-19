# IMS Tool — Running To-Do List

## Pending
- [ ] **Reddit fix** — Reddit blocks Vercel's servers (403). Needs free Reddit API credentials:
  - Jeff: create app at old.reddit.com/prefs/apps (type: script, redirect: http://localhost)
  - Add `REDDIT_CLIENT_ID` and `REDDIT_SECRET` to Vercel env vars
  - Claude: rewrite Reddit integration with OAuth + site-wide search (all subreddits, not just r/MarylandTerrapins, r/CFB, r/CollegeBasketball)
- [ ] **YouTube integration** — search YouTube for Terps content. Needs `YOUTUBE_API_KEY` in Vercel (free Google Cloud key).
- [ ] **Fix morning-brief.js and digest.js** — still use the old broken web_search approach; need same RSS rewrite as scan.js.
- [ ] **Delete debug endpoints** — api/debug-rss.js, api/debug-podcasts.js, api/debug-reddit.js once everything is stable.
- [ ] **ListenNotes (optional)** — free quota (300/mo) exhausted this month. Could re-add next month as supplement; currently replaced by free iTunes/RSS approach.

## Done
- [x] 20 OR-grouped Google News feeds covering all 250 search terms
- [x] 36-hour story window
- [x] Trending topic cap (3 per name, rated by newsworthiness) + 🔥 Trending overflow tab with hotlinks
- [x] 🎙️ Podcasts tab — free iTunes/RSS approach: ~20 curated shows + episode discovery across all podcasts
- [x] Cannabis podcast filtering, Dolphins Malik Washington filtering
- [x] Inside The Black And Gold RSS feed added to scanner
- [x] Prioritize breaking/commits/committed stories (auto 4-5 rating)
- [x] Reddit noise filters (media posts, game threads, discussion rated low)
- [x] Diamond Stone removed from search terms (vinyl decal spam)
- [x] Republished article detection + ♻️ Republished tab
- [x] Jeff's own content (InsideMDSports/247Sports Maryland) excluded everywhere
- [x] HTML caching disabled so UI updates reach browsers immediately
