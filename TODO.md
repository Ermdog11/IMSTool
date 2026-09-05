# IMS Tool — Running To-Do List

## Pending
- [ ] **Twitter/X scan** — parked. API costs $200/mo minimum for meaningful read access; free workarounds (Nitter) are dead. Bluesky scan added as free alternative; big tweets get picked up via news sites anyway.
- [ ] **Instagram scan** — parked. Requires Instagram Business/Creator account + Meta developer app; limited to 30 hashtag searches/week (#terps, #marylandterrapins). Revisit if Jeff sets up a Business account.
- [x] **Reddit fix — dead end, dropped (2026-09-05).** Reddit blocks Vercel's servers (403) for anonymous JSON access, and as of 2026 Reddit has also locked self-serve API app creation for new developers — old.reddit.com/prefs/apps "create app" no longer works (shows a broken "read our full policies here" message with no way to accept). Getting API access now requires a manual developer-request form to Reddit with a high solo-developer rejection rate. Jeff has no pre-existing (grandfathered) Reddit app/key, so there's no workaround. Not revisiting unless Reddit changes this policy or Jeff acquires a grandfathered app later.
- [ ] **YouTube integration** — search YouTube for Terps content. Needs `YOUTUBE_API_KEY` in Vercel (free Google Cloud key).
- [ ] **Fix morning-brief.js and digest.js** — still use the old broken web_search approach; need same RSS rewrite as scan.js.
- [ ] **Delete debug endpoints** — api/debug-rss.js, api/debug-podcasts.js, api/debug-reddit.js once everything is stable.
- [ ] **ListenNotes (optional)** — free quota (300/mo) exhausted this month. Could re-add next month as supplement; currently replaced by free iTunes/RSS approach.

- [ ] **Podcast transcript search** — scan YouTube auto-captions for shows that post there (catches Maryland mentions buried inside episodes)
- [ ] **Wikipedia edit watch** — watch ~30 Terps pages for edits (free API, catches coaching changes/commitments fast)
- [ ] **Message board activity spike detector** — only free boards are Testudo Times comments (JS-heavy, not simply scrapeable) and Reddit (blocked until API credentials). Revisit after Reddit API is set up.
- [ ] **Local TV RSS** — WBAL, WJZ, WUSA9 sports feeds
- [ ] **MaxPreps/HS sports** — recruit performances before national radar
- [ ] **Shared/server-side source blocklist** — source blocking is per-browser only right now (localStorage `blockedSources`). If the team wants a shared blocklist, move it to a stored config the scan/podcasts endpoints read.
- [ ] **SEO tool on Editorial Desk (Jeff, 2026-09-05)** — a dedicated SEO feature on `/editor` that inserts related-article links for InsideMDSports into a draft. Note: Copydesk already does internal-link insertion as part of its rewrite (scrapes the 247 Maryland landing page for slugs — see `api/copyedit.js`); confirm with Jeff whether he wants this as its own standalone tool (nav already has a disabled "Headline/SEO" stub slot in `public/editor.html`) or just wants Copydesk's existing linking made more prominent/thorough, before building a separate feature that duplicates it.

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
- [x] Blocked low-quality aggregator podcast shows by name ("Maryland Terrapins Football News Today", "Maryland Basketball Football News Today") — filtered out of both the curated feed parse and the iTunes discovery results in api/podcasts.js
- [x] "Block this source" button added to article cards (public/index.html) — hides all current + future stories from that source, stored per-browser in localStorage (`blockedSources`), same pattern as the existing Flag button. Blocked sources are also sent to api/scan.js (folded into its `excluded` list) and api/podcasts.js (`?blocked=` query param) so filtering happens server-side too.
- [x] "Block show" button on podcast cards + Settings → "Sites you blocked" list with per-entry unblock (public/index.html) — gives a way to view and undo blocks.

## Context for future sessions
- **Alumni story cap (no duplicate alumni coverage):** api/scan.js has a post-rating cap step — any story Claude categorizes as "alumni" gets a hard limit of 1 main-feed slot regardless of which alumnus it's about (general Terps topics get 3). This exists so the main feed doesn't fill up with 4-5 stories about the same former player's NFL/NBA game. Overflow stories aren't dropped — they go to the 🔥 Trending overflow tab. This is intentional, established behavior — don't "fix" it as a bug if it looks like stories are being hidden.
- **Editorial voice/style rules** (for anything that touches article generation, not the news scanner itself): AP style, no bold/headers unless asked, no filler phrases or sports clichés, cite 247Sports ratings only (never Rivals/ESPN), research before writing.
- **Jeff is non-technical** — walk through git/terminal steps explicitly when they come up, don't assume familiarity with command line basics.
- **Source blocking is per-browser** (localStorage `blockedSources`) — there's no server-side/shared blocklist. There IS now a UI to view and unblock (Settings → "Sites you blocked"). A shared blocklist would need the endpoints to read from stored config instead of the request body — see Pending.
