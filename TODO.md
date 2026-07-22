# IMS Tool — Running To-Do List

## Pending
- [ ] **Twitter/X scan** — parked. API costs $200/mo minimum for meaningful read access; free workarounds (Nitter) are dead. Bluesky scan added as free alternative; big tweets get picked up via news sites anyway.
- [ ] **Instagram scan** — parked. Requires Instagram Business/Creator account + Meta developer app; limited to 30 hashtag searches/week (#terps, #marylandterrapins). Revisit if Jeff sets up a Business account.
- [ ] **Reddit fix** — Reddit blocks Vercel's servers (403). Needs free Reddit API credentials:
  - Jeff: create app at old.reddit.com/prefs/apps (type: script, redirect: http://localhost)
  - Add `REDDIT_CLIENT_ID` and `REDDIT_SECRET` to Vercel env vars
  - Claude: rewrite Reddit integration with OAuth + site-wide search (all subreddits, not just r/MarylandTerrapins, r/CFB, r/CollegeBasketball)
- [ ] **YouTube integration** — search YouTube for Terps content. Needs `YOUTUBE_API_KEY` in Vercel (free Google Cloud key).
- [ ] **Fix morning-brief.js and digest.js** — still use the old broken web_search approach; need same RSS rewrite as scan.js.
- [ ] **Delete debug endpoints** — api/debug-rss.js, api/debug-podcasts.js, api/debug-reddit.js once everything is stable.
- [ ] **ListenNotes (optional)** — free quota (300/mo) exhausted this month. Could re-add next month as supplement; currently replaced by free iTunes/RSS approach.

- [ ] **Podcast transcript search** — scan YouTube auto-captions for shows that post there (catches Maryland mentions buried inside episodes)
- [ ] **Wikipedia edit watch** — watch ~30 Terps pages for edits (free API, catches coaching changes/commitments fast)
- [ ] **Message board activity spike detector** — Testudo Times comments, CSN boards
- [ ] **Local TV RSS** — WBAL, WJZ, WUSA9 sports feeds
- [ ] **MaxPreps/HS sports** — recruit performances before national radar

## Done
- [x] Bing News RSS (3 queries — independent index from Google)
- [x] Direct feeds: Testudo Times, The Diamondback, PressBox, UMTerps.com official
- [x] Regional site queries: Baltimore Sun, Washington Post, Baltimore Banner
- [x] Rival recruiting battle queries ("beats out Maryland", visit/decision news)
- [x] The Athletic (nytimes.com) targeted queries
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
