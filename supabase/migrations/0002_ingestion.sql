-- 0002_ingestion.sql
-- The daily crawl and the survival panel it feeds.
--
-- What this migration is really protecting
-- ----------------------------------------
-- `creative_observations` is the product's irreplaceable asset. Longitudinal data cannot be
-- backfilled: a day not crawled is gone forever. Two consequences are enforced structurally
-- here rather than left to application discipline.
--
-- 1. The panel is APPEND-ONLY. update and delete are revoked outright, and there is no
--    permissive policy for either. A parsing bug costs a reprocess into new rows, never a
--    silent rewrite of history.
-- 2. "We did not see it" and "we did not look" are different facts and must stay
--    distinguishable. A creative missing from a healthy crawl gets an explicit
--    `is_present = false` row. A crawl that failed writes NO observation rows at all and
--    records `crawl_runs.status = 'failed'` instead. Collapsing these two into "no row"
--    would fabricate deaths in the outcome variable.
--
-- Ordering note (see CLAUDE.md): helpers whose bodies read a table are defined after it.
-- This migration adds no new table-reading helpers; it reuses app.current_workspace_id().

------------------------------------------------------------
-- Advertisers
------------------------------------------------------------
-- The competitor whose ads we watch. Scoped per workspace: two tenants tracking the same
-- Meta page each get their own row, so their panels can never join across.

create table public.advertisers (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  meta_page_id  text not null,
  name          text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (workspace_id, meta_page_id)
);

create trigger advertisers_set_updated_at
  before update on public.advertisers
  for each row execute function app.set_updated_at();

alter table public.advertisers enable row level security;

create policy advertisers_tenant_read on public.advertisers
  for select to authenticated
  using (workspace_id = app.current_workspace_id());

------------------------------------------------------------
-- Watchlists
------------------------------------------------------------
-- What to crawl daily. A watchlist is either a keyword query or a specific page, never
-- both — Meta's Ad Library treats them as different endpoints, and a row that set both
-- would leave the adapter guessing.
--
-- `country` defaults to MX and is deliberately NOT free text at the call site: the whole
-- product is scoped to a single market (ARCHITECTURE.md §10.5).

create type watchlist_kind as enum ('keyword', 'page');

create table public.watchlists (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  kind          watchlist_kind not null,
  -- The search term for `keyword`, the Meta page id for `page`.
  query         text not null,
  country       text not null default 'MX',
  label         text not null,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (workspace_id, kind, query, country),
  constraint watchlists_query_not_blank check (length(trim(query)) > 0),
  -- ISO-3166 alpha-2, uppercase. Cheap guard against 'mx' silently becoming a second market.
  constraint watchlists_country_iso check (country ~ '^[A-Z]{2}$')
);

create index watchlists_active_idx on public.watchlists (workspace_id)
  where is_active;

create trigger watchlists_set_updated_at
  before update on public.watchlists
  for each row execute function app.set_updated_at();

alter table public.watchlists enable row level security;

create policy watchlists_tenant_read on public.watchlists
  for select to authenticated
  using (workspace_id = app.current_workspace_id());

create policy watchlists_tenant_write on public.watchlists
  for insert to authenticated
  with check (workspace_id = app.current_workspace_id());

create policy watchlists_tenant_update on public.watchlists
  for update to authenticated
  using (workspace_id = app.current_workspace_id())
  with check (workspace_id = app.current_workspace_id());

------------------------------------------------------------
-- Crawl runs
------------------------------------------------------------
-- One row per watchlist per day. This table is the honest record of what we attempted,
-- which is what makes a gap in the panel interpretable months later.
--
-- Statuses:
--   running   — attempt in flight
--   succeeded — payload landed and parsed; absences ARE written from it
--   suspect   — payload landed but is implausibly small versus the prior run. Present
--               creatives are recorded; absences are NOT. Writing absences off a truncated
--               crawl would invent deaths, corrupting exactly the variable we exist to
--               measure.
--   failed    — all attempts exhausted. Writes no observations at all. The day is recorded
--               as a known gap rather than being indistinguishable from "nothing ran".

create type crawl_status as enum ('running', 'succeeded', 'suspect', 'failed');

create table public.crawl_runs (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,
  watchlist_id      uuid not null references public.watchlists(id) on delete cascade,
  -- The crawl's logical day in the watchlist's market, not a timestamp. One per day is
  -- enforced here so a retry storm cannot produce two panels for the same date.
  run_date          date not null,
  status            crawl_status not null default 'running',
  attempt           integer not null default 1,
  trace_id          text not null,
  actor             jsonb not null,
  apify_run_id      text,
  raw_storage_path  text,
  schema_version    integer not null default 1,
  result_count      integer,
  -- Carried so the suspect verdict stays auditable after the fact: months later you can
  -- see what the run was compared against without reconstructing it from neighbours.
  previous_count    integer,
  error             text,
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  unique (watchlist_id, run_date)
);

create index crawl_runs_workspace_date_idx on public.crawl_runs (workspace_id, run_date desc);
create index crawl_runs_trace_idx on public.crawl_runs (trace_id);

alter table public.crawl_runs enable row level security;

create policy crawl_runs_tenant_read on public.crawl_runs
  for select to authenticated
  using (workspace_id = app.current_workspace_id());

------------------------------------------------------------
-- Creatives
------------------------------------------------------------
-- The unit of analysis is the CREATIVE, not the ad (CLAUDE.md rule 4). One creative is
-- reused across many `ad_archive_id`s; counting ads would count the same asset repeatedly
-- and inflate whatever it is correlated against.
--
-- `creative_hash` is the dedup key. v1 computes it from the media bytes when they are
-- available (SHA-256) and otherwise from (advertiser, normalized copy, media type) — at
-- ingestion time no media has been downloaded yet, so the tuple fallback is what actually
-- runs here. Perceptual hashing is the documented upgrade for re-encoded duplicates.
--
-- `ad_delivery_start_time` comes from Meta and is the ONLY admissible start date
-- (CLAUDE.md rule 5). `first_seen_at` records when WE noticed, which is a fact about our
-- crawl, not about the ad; using it as a start would left-censor every ad that predates us.

create type creative_media_type as enum ('video', 'image', 'unknown');

create table public.creatives (
  id                      uuid primary key default gen_random_uuid(),
  workspace_id            uuid not null references public.workspaces(id) on delete cascade,
  advertiser_id           uuid not null references public.advertisers(id) on delete cascade,
  creative_hash           text not null,
  ad_archive_ids          text[] not null default '{}',
  media_type              creative_media_type not null default 'unknown',
  -- Signed and short-lived. Stored for the UC-2 download attempt, never as an identity.
  media_url               text,
  ad_copy                 text,
  publisher_platforms     text[] not null default '{}',
  ad_delivery_start_time  timestamptz,
  first_seen_at           timestamptz not null default now(),
  last_seen_at            timestamptz not null default now(),
  schema_version          integer not null default 1,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (workspace_id, creative_hash)
);

create index creatives_advertiser_idx on public.creatives (advertiser_id);
create index creatives_archive_ids_idx on public.creatives using gin (ad_archive_ids);

create trigger creatives_set_updated_at
  before update on public.creatives
  for each row execute function app.set_updated_at();

alter table public.creatives enable row level security;

create policy creatives_tenant_read on public.creatives
  for select to authenticated
  using (workspace_id = app.current_workspace_id());

------------------------------------------------------------
-- Creative observations (the panel)
------------------------------------------------------------
-- Append-only, one row per (creative, crawl_run). This is the product's real asset.
--
-- `is_present = false` is a POSITIVE observation of absence: we looked, on a healthy crawl,
-- and this creative was gone. It is what turns the panel into a survival dataset. The
-- unique constraint keeps a redelivered parse from double-counting a day.

create table public.creative_observations (
  id             bigserial primary key,
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  creative_id    uuid not null references public.creatives(id) on delete cascade,
  crawl_run_id   uuid not null references public.crawl_runs(id) on delete cascade,
  observed_at    timestamptz not null default now(),
  is_present     boolean not null,
  variant_count  integer not null default 1,
  schema_version integer not null default 1,
  unique (creative_id, crawl_run_id)
);

create index creative_observations_creative_idx
  on public.creative_observations (creative_id, observed_at);
create index creative_observations_run_idx
  on public.creative_observations (crawl_run_id);
create index creative_observations_workspace_idx
  on public.creative_observations (workspace_id, observed_at desc);

alter table public.creative_observations enable row level security;

create policy creative_observations_tenant_read on public.creative_observations
  for select to authenticated
  using (workspace_id = app.current_workspace_id());

-- Append-only, enforced the same way as audit_events: no update/delete policy AND the
-- privilege revoked, so a future permissive policy cannot quietly re-open history.
revoke update, delete on public.creative_observations from anon, authenticated, service_role;

------------------------------------------------------------
-- Grants
------------------------------------------------------------
-- Writes go through the worker (service_role, BYPASSRLS). Clients read the panel and
-- manage their own watchlists; nothing else.

grant select                 on public.advertisers           to authenticated;
grant select, insert, update on public.watchlists            to authenticated;
grant select                 on public.crawl_runs            to authenticated;
grant select                 on public.creatives             to authenticated;
grant select                 on public.creative_observations to authenticated;
