# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

IMSTool is a SaaS product for sports newsrooms, first deployed for InsideMDSports (Maryland Terrapins beat). It's two apps sharing one repo and one Vercel deployment:

- **News Monitor** (`public/index.html`) — scans dozens of sources for beat-relevant news, rates every story 1-5, and pushes it out through digests, breaking alerts, roster-change watches, audience analytics, and a scheduled "Coverage Desk" editor's memo.
- **Content Editor** (`public/editor.html`) — takes a writer's draft and returns it copyedited in house style and the writer's own voice, with internal links, headlines, SEO metadata, and fact-check flags.

`FEATURES.md` is the shipped feature list (organized by which of the two apps). `TODO.md` is the running log of pending work, decisions made, and a dated "Done" changelog — check it before starting anything that might already be decided, and add an entry when you finish anything non-trivial. Both are living documents, not historical snapshots — keep them current as part of the change, not as an afterthought.

## Commands

There is no build step, bundler, test suite, or linter in this repo. It's plain Node (serverless functions) and vanilla HTML/JS (no framework, no compilation) deployed directly to Vercel.

- **Validate a change:** `node --check path/to/file.js` — catches syntax errors before pushing. For inline `<script>` blocks in the `.html` files, extract the script content to a temp file first and `node --check` that.
- **Validate `vercel.json`:** `node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8'))"`
- **Deploy:** push to `main` — Vercel auto-deploys on every push (no separate build/deploy command). There's no staging environment in normal use; verify locally (syntax checks, reading the diff carefully) before pushing, since a push to `main` goes straight to the live product.
- **No local dev server** is configured — endpoints are exercised against the live Vercel deployment. `web_fetch_vercel_url` (or an equivalent that goes through Vercel's own network) can call a deployed endpoint directly to test a cron/API route without waiting for a scheduled trigger.

## Architecture

**Serverless functions, one file per route.** Every file in `api/` directly under that folder maps to `/api/<filename>` on Vercel (Node runtime, `module.exports = async function handler(req, res) {...}`). Files prefixed with `_` (e.g. `_supabase.js`, `_mailer.js`, `_roster.js`) are shared helper modules, not routes — Vercel doesn't serve them directly. Follow that convention for new shared logic.

**`vercel.json` is the control plane.** Function timeouts (`maxDuration`), all cron schedules, the clean-URL rewrites that make each News Monitor section a real bookmarkable path, and cache headers all live here. A new cron job or a new top-level section needs an entry here or it silently won't run / won't route.

**Beat profile, not hard-coded teams.** Anything about which team or topic a newsroom covers (feeds, watchlist, relevance words, rating-prompt wording, own site) belongs in that newsroom's beat profile (`api/_beat.js`, saved at `site_settings.profile.beat`, seeded from `api/_beats/<slug>.json`), never in code. Maryland is just InsideMDSports' profile. If you change the rating prompt, change the template in `_beat.js`.

**Jeff's rules are product rules.** When Jeff (the publisher) gives an editorial or product rule while using InsideMDSports ("never include a recruit unless the beat school is recruiting them", "a recruit visiting another school isn't news", "coach hires/firings are the priority for records requests"), build it for every newsroom: write it against the beat profile (`team.short`, watch lists, `records`, etc.), never as a Maryland special case. Maryland-specific facts belong only in InsideMDSports' profile data (`api/_beats/insidemdsports.json` / saved settings).

**Multi-newsroom.** Supabase (Postgres + Auth) models one `sites` row per newsroom, with `memberships` giving each user a role (`publisher` / `editor` / `writer` / `contributor` / `viewer`) per site. Each request runs as one newsroom via `api/_site.js` (AsyncLocalStorage; every route's export is wrapped with `Site.wrap`): `requireUser` picks the signed-in person's newsroom (the page's `X-Site` header if they belong to several, else InsideMDSports for its members, else their only one) and calls `Site.set`. Server code gets the current newsroom from `Site.slug()` / `Site.siteId(sb)` — never hard-code a slug. Blob storage goes through `api/_site-blob.js` (same API as `@vercel/blob`), which files other newsrooms' data under `sites/<slug>/`; InsideMDSports (`Site.DEFAULT`) keeps its original paths. Requests with no signed-in person (Vercel Cron, open public routes) run as InsideMDSports; scheduled jobs don't yet loop over other newsrooms. People with no invite start their own newsroom (`/api/newsroom-create`, then `/setup`). `api/_supabase.js` is the shared server-side client plus `requireUser`/`requireRole` auth helpers, and `requireUserOrCron` for scheduled routes (accepts in-process calls, Vercel Cron's `CRON_SECRET` bearer, or a signed-in member). Every new route that spends Claude credits, sends email or touches newsroom data must call one of them; the pages send the token automatically via the `fetch` wrapper in `public/_auth.js`; it **fails open** when Supabase env vars aren't set (the whole app runs with login effectively disabled), which is deliberate and should be preserved in any new endpoint that touches user data.

**Three places data lives, chosen by shape:**
- **Supabase Postgres** (`db/schema.sql`, idempotent — safe to re-run) for structured/relational data: content archive, roster-change history, analytics connections, style-drift comparisons, scrape sessions. Row Level Security policies exist as defense-in-depth, but the API layer always talks to Postgres with the service-role key (bypasses RLS) and enforces roles itself in code.
- **Vercel Blob** for small, ephemeral, non-relational JSON — roster snapshots, hot-story alert cooldown state, saved drafts, push subscriptions. Not a database; treat it as a key-value blob store for things that don't need querying.
- **Encrypted secrets** (Chartbeat/Parse.ly API keys, Meta OAuth tokens, the 247Sports session cookie) are AES-256-GCM encrypted via `api/_crypto.js` (key: `ANALYTICS_ENCRYPTION_KEY`) before they ever reach a table. `_analytics-store.js` and `_scrape-store.js` wrap that — never store a third-party credential in plaintext.

**Cron jobs are the scheduled-agent layer.** Each one in `vercel.json`'s `crons` array is a best-effort, non-blocking background job (roster diffing, the daily Coverage Desk memo, rolling digests, style-drift matching against the outlet's own published pages, live-traffic hot-story alerts, the daily engineering-progress digest). A failure in one must never break another or the live app — this is why the shared helpers swallow and log errors rather than throwing past their boundary.

**External-service integrations get their own `_<service>.js`.** When both an on-demand endpoint and a cron need the same third-party data (e.g. Chartbeat), the fetch/parse logic lives once in a shared helper (`_chartbeat.js`, `_meta.js`) so the two callers can't drift out of sync.

**Claude API calls go straight to `fetch('https://api.anthropic.com/v1/messages')`**, not the SDK, using `claude-sonnet-4-6`. Structured output uses forced tool-use (`tool_choice`) rather than asking the model for raw JSON in a text response — `api/copyedit.js`'s header comment explains why (raw-JSON parsing broke on the quote- and newline-heavy article bodies this app handles).

**247Sports scraping is regex-based HTML scraping against a page IMSTool doesn't control** (`api/_publish-match.js`, `relatedArticleIndex()` in `copyedit.js`) — no HTML parser library, just targeted regexes. Expect it to need adjustment if the target site's markup changes; it's inherently best-effort, not a stable API integration.

**Frontend has no build step and no framework.** Each `public/*.html` file is a complete self-contained app: inline `<style>` (CSS custom properties for theming) and inline `<script>` (vanilla JS). `index.html`'s sections (Alerts, Roster watch, Analytics, Settings, etc.) all live in one file with client-side show/hide (`.page.active` / `switchTab()`) and a lightweight router (`TAB_PATHS` + `history.pushState`) that `vercel.json` rewrites back to `/` so each section still gets a real, shareable URL.
