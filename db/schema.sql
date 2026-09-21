-- IMSTool — database schema (Supabase / Postgres)
-- =================================================
-- Run this once in the Supabase project: SQL Editor -> New query -> paste -> Run.
-- Safe to re-run: every statement is idempotent (IF NOT EXISTS / CREATE OR REPLACE).
--
-- Model: one `sites` row per newsroom (InsideMDSports is the first). Everything
-- newsroom-specific hangs off site_id, so adding a second publisher is data, not code.

-- Extensions ------------------------------------------------------------------
create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "vector";     -- embeddings for the knowledge base (used later)

-- Sites ---------------------------------------------------------------------
create table if not exists public.sites (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,
  name        text not null,
  domain      text,
  created_at  timestamptz not null default now()
);

-- Profiles (1:1 with Supabase auth.users) ----------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  created_at  timestamptz not null default now()
);

-- Auto-create a profile row whenever a new auth user is created
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Memberships (user <-> site <-> role) ------------------------------------
do $$ begin
  create type public.member_role as enum ('publisher', 'editor', 'writer');
exception when duplicate_object then null; end $$;

create table if not exists public.memberships (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  site_id     uuid not null references public.sites(id) on delete cascade,
  role        public.member_role not null default 'writer',
  byline      text,                       -- the name this writer publishes under
  invited_email text,                     -- set on an invite before the user exists
  created_at  timestamptz not null default now(),
  unique (user_id, site_id)
);
create index if not exists memberships_site_idx on public.memberships (site_id);

-- Pending invites (before the person has signed in the first time) ---------
create table if not exists public.invites (
  id          uuid primary key default gen_random_uuid(),
  site_id     uuid not null references public.sites(id) on delete cascade,
  email       text not null,
  role        public.member_role not null default 'writer',
  byline      text,
  invited_by  uuid references public.profiles(id) on delete set null,
  accepted_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (site_id, email)
);

-- Alert preferences (who receives what) ----------------------------------
-- alert_type: 'breaking' | 'article_started' | 'digest_nightly' | 'digest_rolling' | 'roster_change'
create table if not exists public.alert_prefs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  site_id     uuid not null references public.sites(id) on delete cascade,
  alert_type  text not null,
  enabled     boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (user_id, site_id, alert_type)
);
create index if not exists alert_prefs_lookup_idx on public.alert_prefs (site_id, alert_type, enabled);

-- Newsroom knowledge base ------------------------------------------------
-- Every article that passes through the Content Editor, plus imported back
-- catalogue. Private per site. Powers style profiles, added context, and
-- internal linking.
create table if not exists public.content_items (
  id            uuid primary key default gen_random_uuid(),
  site_id       uuid not null references public.sites(id) on delete cascade,
  writer_user_id uuid references public.profiles(id) on delete set null,
  writer_name   text,                     -- denormalised byline (imports may have no account)
  source        text not null default 'copydesk',  -- 'copydesk' | 'import' | 'manual'
  headline      text,
  body          text not null,
  url           text,
  published_at  timestamptz,
  metadata      jsonb not null default '{}'::jsonb, -- category, sport, tier, ...
  -- full-text search (v1 retrieval)
  fts           tsvector generated always as
                  (to_tsvector('english', coalesce(headline,'') || ' ' || coalesce(body,''))) stored,
  -- semantic search (added later; nullable until we backfill embeddings)
  embedding     vector(1024),
  created_at    timestamptz not null default now()
);
create index if not exists content_items_site_idx    on public.content_items (site_id, created_at desc);
create index if not exists content_items_writer_idx  on public.content_items (site_id, writer_user_id);
create index if not exists content_items_fts_idx     on public.content_items using gin (fts);

-- Migration (2026-09-11): correlate a content_items row with the Blob draft it
-- came from, so saving/submitting/editing the same draft updates one row
-- instead of piling up duplicates. Nullable — imported/manual rows have none.
alter table public.content_items add column if not exists draft_id text;
alter table public.content_items add column if not exists updated_at timestamptz not null default now();
create unique index if not exists content_items_draft_idx on public.content_items (site_id, draft_id) where draft_id is not null;

-- Roster watch history ----------------------------------------------------
-- Every add/drop api/roster-check.js catches (3x/week cron), so the in-app
-- Roster Watch view can show a dated history per team, not just the latest
-- snapshot (which lives in Vercel Blob, not here).
create table if not exists public.roster_events (
  id            uuid primary key default gen_random_uuid(),
  site_id       uuid not null references public.sites(id) on delete cascade,
  team_slug     text not null,
  team_label    text not null,
  player_name   text not null,
  change_type   text not null check (change_type in ('added', 'removed')),
  detected_at   timestamptz not null default now(),
  created_at    timestamptz not null default now()
);
create index if not exists roster_events_site_team_idx on public.roster_events (site_id, team_slug, detected_at desc);

-- Audience analytics connections ------------------------------------------
-- One row per site+source (chartbeat, parsely, ga4, ...). `config` holds
-- whatever that source needs — secrets (API keys) are AES-256-GCM encrypted
-- by api/_crypto.js before they ever reach this table, so a DB read alone
-- never exposes a usable credential.
create table if not exists public.analytics_connections (
  id            uuid primary key default gen_random_uuid(),
  site_id       uuid not null references public.sites(id) on delete cascade,
  source        text not null,
  config        jsonb not null default '{}'::jsonb,
  connected_by  uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (site_id, source)
);
create index if not exists analytics_connections_site_idx on public.analytics_connections (site_id);

-- Audience analytics snapshots ---------------------------------------------
-- Point-in-time captures of each connected source's key metrics, taken on a
-- cron (api/analytics-snapshot.js). A single "right now" reading (what
-- api/chartbeat.js shows live) can't answer "what's our best time to
-- publish" — that needs a time series, which is what this table piles up
-- into. Source-agnostic (metrics shape is source-specific) so Parse.ly/GA4/
-- Meta slot into the same trend computation once they're connected.
create table if not exists public.analytics_snapshots (
  id            uuid primary key default gen_random_uuid(),
  site_id       uuid not null references public.sites(id) on delete cascade,
  source        text not null,
  captured_at   timestamptz not null default now(),
  metrics       jsonb not null default '{}'::jsonb
);
create index if not exists analytics_snapshots_site_source_idx on public.analytics_snapshots (site_id, source, captured_at);

-- Scrape sessions -----------------------------------------------------------
-- A publisher's own logged-in session cookie for a paywalled outlet (247Sports
-- today), so api/_publish-match.js can read full article bodies instead of
-- whatever's visible before the meter cuts in. One-time paste, not per-article
-- work. AES-256-GCM encrypted (api/_crypto.js); never decrypted anywhere but
-- server-side inside the scraper, and never returned by the API once saved —
-- no "member reads" policy at all, unlike every other per-site table.
create table if not exists public.scrape_sessions (
  id            uuid primary key default gen_random_uuid(),
  site_id       uuid not null references public.sites(id) on delete cascade,
  source        text not null,             -- '247sports' today; room for other paywalled outlets later
  cookie        text not null,             -- encrypted
  connected_by  uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (site_id, source)
);
create index if not exists scrape_sessions_site_idx on public.scrape_sessions (site_id);

-- Style drift: published vs. submitted ------------------------------------
-- Automatically matches a submitted content_items row to its live URL (no
-- manual paste — api/publish-watch.js scrapes the outlet's own recent-articles
-- page on a cron and fuzzy-matches by headline), pulls whatever text is
-- publicly reachable, and has Claude note what changed between the Content
-- Editor's output and what actually got published. Feeds the style profiles
-- with real human corrections instead of just the initial writing samples.
create table if not exists public.content_revisions (
  id                uuid primary key default gen_random_uuid(),
  site_id           uuid not null references public.sites(id) on delete cascade,
  content_item_id   uuid not null references public.content_items(id) on delete cascade,
  published_url     text not null,
  published_excerpt text,               -- best-effort extracted text; partial when paywalled
  paywalled         boolean not null default false,
  diff_summary      text,                -- Claude's note on what changed and why it's worth learning from
  matched_at        timestamptz not null default now(),
  unique (content_item_id)
);
create index if not exists content_revisions_site_idx on public.content_revisions (site_id, matched_at desc);

-- Team chat ----------------------------------------------------------------
-- Real persisted messages for the "Team chat" tab, which used to be pure
-- client-side DOM state (nothing shared between team members, nothing
-- surviving a refresh). `kind` distinguishes a person's own message from an
-- automated drop — 'alert-drop' for the existing rating-4+ scan behavior,
-- 'breaking' for the auto-drafted breaking-news pieces (api/rolling-digest.js),
-- each optionally carrying a `tag` (e.g. "Breaking News Alert") and `meta`
-- (headline/url/rating/draftId) for the frontend to render richly.
create table if not exists public.chat_messages (
  id              uuid primary key default gen_random_uuid(),
  site_id         uuid not null references public.sites(id) on delete cascade,
  sender_user_id  uuid references public.profiles(id) on delete set null,
  sender_name     text not null,
  text            text not null,
  kind            text not null default 'user', -- 'user' | 'alert-drop' | 'breaking'
  tag             text,
  meta            jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists chat_messages_site_idx on public.chat_messages (site_id, created_at desc);

-- Site settings --------------------------------------------------------
-- The house style guide used to live ONLY in browser localStorage — every
-- edit request sent it fresh from whichever browser had it open, and
-- nothing server-side (a cron, the breaking-news auto-draft) could ever
-- read it. One row per site now, so it's a real shared source of truth.
create table if not exists public.site_settings (
  site_id             uuid primary key references public.sites(id) on delete cascade,
  house_style_guide   text,
  updated_at          timestamptz not null default now()
);

-- Web search (Brave Search API) for the news scanner — a real, open-ended
-- search alongside the fixed set of curated RSS feeds. Kept opt-in per
-- caller (scan.js's `webSearch` flag) rather than run on every scan, since
-- it's metered (Brave dropped its free tier) and the client-side scan can
-- fire far more often than the 3x/day cron this is meant for.
-- (Started as Google Programmable Search — dropped after Google killed
-- "search the entire web" for that product; migration below undoes it.)
alter table public.site_settings drop column if exists google_search_api_key;
alter table public.site_settings drop column if exists google_search_engine_id;
alter table public.site_settings add column if not exists web_search_api_key text; -- encrypted (api/_crypto.js)

-- X (Twitter) recent-search API — a fast, social-first signal RSS/Brave both
-- miss (a rival player's viral quote, a recruiting bombshell that breaks on
-- X before any site covers it). Own dedicated cron (api/x-scan.js, ~30 min)
-- rather than tied to scan.js's other callers, so cost stays predictable
-- regardless of who has the dashboard open. api/_x-search.js, encrypted.
alter table public.site_settings add column if not exists x_bearer_token text;

-- X accounts to watch directly (2026-09-21, Jeff: "add up to a certain number
-- of twitter feeds to check every time... the other people covering Maryland").
-- Additive to the broad/storyline search queries above, not a replacement —
-- each handle gets its own from:<handle> query every run, no engagement floor
-- (a publisher-picked beat reporter's routine update matters even if it
-- doesn't go viral, unlike an unknown account). Capped at 15 server-side to
-- keep X's pay-per-use read cost bounded.
alter table public.site_settings add column if not exists x_watch_handles jsonb not null default '[]'::jsonb;

-- Feed prefs: blocked sources, flagged junk, own-outlet excludes, hidden
-- items (2026-09-20). Used to live ONLY in browser localStorage, which meant
-- it never followed the editor between browsers (e.g. sources blocked in
-- Chrome kept resurfacing in Brave, since Brave's localStorage starts empty).
-- Shared per newsroom like the rest of site_settings, not per-user — any
-- team member curating the feed benefits everyone, same as today's behavior.
alter table public.site_settings add column if not exists blocked_sources jsonb not null default '[]'::jsonb;
alter table public.site_settings add column if not exists flagged_stories jsonb not null default '[]'::jsonb;
alter table public.site_settings add column if not exists own_site_exclude jsonb not null default '[]'::jsonb;
alter table public.site_settings add column if not exists hidden_videos jsonb not null default '[]'::jsonb;

-- Google Programmable Search, take two (2026-09-20) — site-restricted mode.
-- Google killed whole-web search for new engines (see the migration above
-- that dropped these same two columns), but a search restricted to a
-- publisher-curated list of sites is still available and still real search,
-- not an RSS query — it complements Brave (whole-web) and the News/Bing RSS
-- feeds rather than replacing either. The site list itself lives in Google's
-- own Programmable Search Engine console, not here — we only store the two
-- credentials needed to query it.
alter table public.site_settings add column if not exists google_search_api_key text; -- encrypted (api/_crypto.js)
alter table public.site_settings add column if not exists google_search_engine_id text;

-- Row Level Security ----------------------------------------------------
-- The API layer talks to Postgres with the service_role key, which bypasses
-- RLS. These policies are defence-in-depth for any future direct-from-browser
-- access: a signed-in user can only ever see rows for a site they belong to.
alter table public.sites          enable row level security;
alter table public.profiles       enable row level security;
alter table public.memberships    enable row level security;
alter table public.invites        enable row level security;
alter table public.alert_prefs    enable row level security;
alter table public.content_items  enable row level security;
alter table public.roster_events  enable row level security;
alter table public.analytics_connections enable row level security;
alter table public.analytics_snapshots enable row level security;
alter table public.content_revisions enable row level security;
alter table public.chat_messages enable row level security;
alter table public.site_settings enable row level security;
alter table public.scrape_sessions enable row level security;

create or replace function public.is_member(target_site uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships m
    where m.site_id = target_site and m.user_id = auth.uid()
  );
$$;

create or replace function public.is_publisher(target_site uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships m
    where m.site_id = target_site and m.user_id = auth.uid() and m.role = 'publisher'
  );
$$;

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles
  for select using (id = auth.uid());

drop policy if exists "member reads site" on public.sites;
create policy "member reads site" on public.sites
  for select using (public.is_member(id));

drop policy if exists "member reads memberships" on public.memberships;
create policy "member reads memberships" on public.memberships
  for select using (public.is_member(site_id));

drop policy if exists "publisher manages memberships" on public.memberships;
create policy "publisher manages memberships" on public.memberships
  for all using (public.is_publisher(site_id)) with check (public.is_publisher(site_id));

drop policy if exists "publisher manages invites" on public.invites;
create policy "publisher manages invites" on public.invites
  for all using (public.is_publisher(site_id)) with check (public.is_publisher(site_id));

drop policy if exists "user reads own prefs" on public.alert_prefs;
create policy "user reads own prefs" on public.alert_prefs
  for select using (user_id = auth.uid() or public.is_publisher(site_id));

drop policy if exists "publisher manages prefs" on public.alert_prefs;
create policy "publisher manages prefs" on public.alert_prefs
  for all using (public.is_publisher(site_id)) with check (public.is_publisher(site_id));

drop policy if exists "member reads content" on public.content_items;
create policy "member reads content" on public.content_items
  for select using (public.is_member(site_id));

drop policy if exists "member reads roster events" on public.roster_events;
create policy "member reads roster events" on public.roster_events
  for select using (public.is_member(site_id));

drop policy if exists "publisher manages analytics connections" on public.analytics_connections;
create policy "publisher manages analytics connections" on public.analytics_connections
  for all using (public.is_publisher(site_id)) with check (public.is_publisher(site_id));

drop policy if exists "member reads content revisions" on public.content_revisions;
create policy "member reads content revisions" on public.content_revisions
  for select using (public.is_member(site_id));

drop policy if exists "member reads chat" on public.chat_messages;
create policy "member reads chat" on public.chat_messages
  for select using (public.is_member(site_id));
drop policy if exists "member sends chat" on public.chat_messages;
create policy "member sends chat" on public.chat_messages
  for insert with check (public.is_member(site_id));

drop policy if exists "member reads site settings" on public.site_settings;
create policy "member reads site settings" on public.site_settings
  for select using (public.is_member(site_id));
drop policy if exists "publisher manages site settings" on public.site_settings;
create policy "publisher manages site settings" on public.site_settings
  for all using (public.is_publisher(site_id)) with check (public.is_publisher(site_id));

-- No insert/update policy — only the cron's service-role client writes here.
drop policy if exists "member reads analytics snapshots" on public.analytics_snapshots;
create policy "member reads analytics snapshots" on public.analytics_snapshots
  for select using (public.is_member(site_id));

-- No select policy at all on scrape_sessions, intentionally — the app only
-- ever reads it through the service-role client inside the scraper itself.
-- These just let a publisher write/replace/remove their own session cookie.
drop policy if exists "publisher inserts scrape sessions" on public.scrape_sessions;
create policy "publisher inserts scrape sessions" on public.scrape_sessions
  for insert with check (public.is_publisher(site_id));
drop policy if exists "publisher updates scrape sessions" on public.scrape_sessions;
create policy "publisher updates scrape sessions" on public.scrape_sessions
  for update using (public.is_publisher(site_id)) with check (public.is_publisher(site_id));
drop policy if exists "publisher deletes scrape sessions" on public.scrape_sessions;
create policy "publisher deletes scrape sessions" on public.scrape_sessions
  for delete using (public.is_publisher(site_id));

-- Seed: the first newsroom -------------------------------------------------
insert into public.sites (slug, name, domain)
values ('insidemdsports', 'InsideMDSports', '247sports.com/college/maryland')
on conflict (slug) do nothing;
