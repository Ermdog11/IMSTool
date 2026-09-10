# IMSTool — Feature Log

Running record of what the product does and what's planned, kept for business-plan
and marketing material. Plain-language, benefit-first. Updated as we build.

**One-line pitch:** An AI newsroom assistant for team-beat and local-news publishers —
it watches every free source for news on your beat, rates and organizes it, and helps
your writers turn it into publish-ready copy without leaving the tool.

Two product surfaces, one login (login system in progress):
1. **News Monitor** — for the editor. Aggregates and rates everything happening on your beat.
2. **Content Editor** — for every writer. Turns a rough draft into a house-style, publish-ready article.

Last updated: 2026-09-10

---

## Shipped

### News Monitor

| Feature | What it does for the customer |
|---|---|
| All-source aggregation | Pulls from ~60 free feeds — Google News, Bing News, Reddit, team/beat blogs, official athletics site, regional papers, national outlets — with no paid API costs passed on. |
| Watch-list-driven coverage | Tracks ~250 named people (players, recruits, targets, coaches, staff, alumni, beat reporters) — not just the team name — so niche news isn't missed. |
| AI rating & triage | One pass rates every story 1–5, assigns a category and sport, flags irrelevant items, recycled/republished stories, and stories that need a deeper read. |
| Name-collision handling | Knows the difference between your alum and an unrelated athlete with the same name. |
| Deep-read pass | For ambiguous stories, the tool opens the actual article and re-rates from the full text (used in the digest). |
| Podcasts | Finds recent podcast episodes mentioning your beat, and scans inside national-show episodes for buried mentions. |
| YouTube | Surfaces relevant videos, rated the same way as articles; filters out AI-spam and content-farm channels. |
| Bluesky | Monitors social chatter, sorted by engagement. |
| Digest emails | Morning brief, 8 PM nightly digest, and rolling updates — organized by day / sport / rating. |
| Breaking-news email | Rating-5 stories email immediately, 24/7. |
| Roster-change watch | Checks official team rosters 3×/week and emails when a player is added or drops off — often before the transfer/injury is reported anywhere. (Dedicated in-app view coming.) |
| Noise controls | Per-topic caps with an overflow view (demote, don't drop), low-priority-sport suppression, stat-page filtering, "block this source" list. |
| Own-outlet exclusion | Never shows the customer their own site's stories back to them. |
| Team chat | High-rated alerts auto-drop into a shared channel for the newsroom to claim and discuss. |
| Story backlog | Auto-generates story angles from the current news. |
| Desktop notifications | Optional browser push for breaking news. |
| Real section URLs | Every section is its own bookmarkable, shareable address; browser back/forward works. |

### Content Editor

| Feature | What it does for the customer |
|---|---|
| Copydesk | Paste a writer's draft → returns it rewritten in the publication's house style, **in that writer's voice**, with reader context added (anything unverified flagged), facts-to-check listed, and 3 headline options (straight / punchy / SEO). |
| Per-writer style profiles | Learns each writer's voice from ~15 samples so edits polish rather than flatten them. |
| House style guide | The editable rulebook every edit is measured against — per publication. |
| Related-article links | Automatically hotlinks relevant phrases in the copy to the publication's own recent articles. |
| Promo blocks | Publisher defines promo/subscription blocks once; the right ones auto-insert by article tier and placement. |
| Draft workflow | Save-as-draft vs. send-to-publisher; publisher gets an email on submission; drafts list with view/edit/delete. |

---

## In progress

| Feature | Status |
|---|---|
| **Login system** | Approved. Real accounts + roles (publisher / editor / writer) for the newsroom, built to generalize to multiple publishers later. Magic-link + Google sign-in. Unlocks per-person permissions and alert control. |
| **Publisher-controlled alerts** | Publisher decides exactly who receives which alerts (breaking news, article-saved, digests). Depends on login. |
| **"Article started" alert** | Publisher is notified the first time a writer saves a new article. Depends on login. |

---

## Roadmap

### Near term
- **Roster watch view** — an in-app page showing each team's current roster and a dated history of every add/drop the watcher has caught.
- **Publish connector** — file a finished article straight into the customer's CMS as a draft (never auto-live). One-click for WordPress and Ghost; clean formatted export for Substack, Squarespace, and closed CMSes.
- **Deeper related-links index** — index the publication's full archive, not just its front page, and add a writer-driven "pick one of 3 suggested links" control.
- **Photo upload tool** — writers attach images to a draft in the Content Editor.
- **Video auto-suggest** — publisher configures where their videos live (YouTube channel / Vimeo / feed); the Content Editor drops a relevant video into the draft.
- **Faster scans** — reduce scan time without cutting coverage.

### Mid term
- **Multi-tenant onboarding** — a new publisher self-configures their beat (watch list, feeds, house style) via a guided, AI-assisted wizard in minutes — no code changes.
- **Scheduled agents** — proactive assistants that run on a cadence and push results: competitive-coverage scan, coverage-gap audit, evergreen-refresh finder, recruiting-board watch.
- **Shared newsroom settings** — style guide, writer profiles, and block lists shared across the team instead of per-browser.

### Longer term
- White-label (customer logo / colors / name).
- Chrome extension as a lightweight companion (breaking-news badge, quick headlines).
- Per-customer usage metering and billing (per-newsroom + per-writer-seat).

---

## Positioning notes

- **The moat is the free-source aggregation.** Assembling real-time beat coverage out of
  free feeds and search operators — no $200/mo Twitter API, no per-seat news-API fees — is
  the hard part to replicate and the core value.
- **The Content Editor is likely the stronger recurring-revenue hook** (per-writer-seat,
  used daily) vs. the Monitor (per-newsroom).
- **Human stays in control** everywhere it matters: nothing publishes itself, alerts are
  opt-in per person, AI-added context is flagged for verification.
- Built vertical-agnostic under the hood — Maryland Terrapins is the first beat, not a
  hardcoded assumption.
