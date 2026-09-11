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

-- Seed: the first newsroom -------------------------------------------------
insert into public.sites (slug, name, domain)
values ('insidemdsports', 'InsideMDSports', '247sports.com/college/maryland')
on conflict (slug) do nothing;
