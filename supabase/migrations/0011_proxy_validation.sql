-- 0011_proxy_validation.sql
-- The Spanish EU Ad Library validation corpus and its stored regression runs (UC-7).
--
-- What this migration protects
-- -----------------------------
-- UC-7 tests the premise the whole MX panel rests on — that survival tracks advertiser
-- behavior — against real delivery data from a market that is not Mexico. Two tables, and
-- the boundary between them and everything built through UC-6 is the point of the migration.
--
-- Quarantine (spec rule 5)
-- -------------------------
-- Neither table below carries a `creative_hash`, and neither references — nor is referenced
-- by — `creatives`, `creative_observations`, `creative_survival`, `advertisers`,
-- `watchlists` or `crawl_runs`. The only foreign key either table holds is to `workspaces`.
-- A Spanish ad reaching the MX panel would corrupt the outcome variable of the actual
-- product to answer a question about it; the absence of a join path is what makes that
-- structurally impossible rather than merely against the rules.
--
-- Corpus vs. run, the same split as crawl_runs/creative_observations vs. analysis_runs
-- --------------------------------------------------------------------------------------
-- `proxy_validation_ads` is the corpus: one row per ES ad, upserted as the crawl learns
-- more about it (a still-running ad gets its stop time and final reach once it ends). It is
-- not append-only, because there is nothing longitudinal to preserve — unlike the MX panel,
-- an ad's EU Ad Library record already carries its whole life in one place (spec, "Why it
-- is possible now, and cheaply"), so a second crawl of the same ad corrects the same row
-- rather than adding a second observation of it.
--
-- `proxy_validation_runs` is a stored analysis, exactly like `analysis_runs` in 0007: a
-- record of what the regression said about the corpus at the moment it ran, append-only for
-- the same reason — the question "which run produced this number, over what corpus" must
-- have an answer months later, and a figure recomputed on render cannot supply one.

------------------------------------------------------------
-- The corpus
------------------------------------------------------------
-- One row per ES ad the validation crawl has seen. `ad_archive_id` is Meta's own identifier
-- for the ad — not a creative_hash, and not deduplicated across ads the way the MX panel
-- deduplicates across `ad_archive_id`s, because UC-7 is testing whether an *ad's* delivery
-- tracks its runtime, not building a competitive panel.

create table public.proxy_validation_ads (
  id                      uuid primary key default gen_random_uuid(),
  workspace_id            uuid not null references public.workspaces(id) on delete cascade,

  ad_archive_id           text not null,
  -- The Meta page id, used to stratify the regression by advertiser (spec: "Advertiser
  -- fixed effects, for the same reason UC-5 stratifies"). Deliberately not a foreign key to
  -- `public.advertisers` — that table is the MX panel's, and joining to it would be exactly
  -- the cross-market corruption this migration exists to prevent. An ES advertiser is a
  -- fact about the ES corpus alone.
  advertiser_page_id      text not null,
  advertiser_name         text,

  ad_delivery_start_time  timestamptz,
  -- Null means still running. Excluded from the regression (spec: "Right-censoring: exclude,
  -- and admit what that costs") but retained here, not dropped, so the corpus can be
  -- re-evaluated once the ad ends without re-crawling it.
  ad_delivery_stop_time   timestamptz,

  -- Meta reports EU reach as a bucketed range, never a point value. Both bounds are kept
  -- (spec rule 7); collapsing to a midpoint here would make the choice of bound
  -- unrecoverable for every later run.
  eu_total_reach_min      integer check (eu_total_reach_min >= 0),
  eu_total_reach_max      integer check (eu_total_reach_max >= 0),
  constraint proxy_validation_ads_reach_bounds_ordered check (
    eu_total_reach_min is null or eu_total_reach_max is null
    or eu_total_reach_min <= eu_total_reach_max
  ),

  -- Provenance of the crawl that most recently updated this row, not a foreign key to
  -- `crawl_runs` — that table belongs to the MX panel's watchlist model, which ES ads never
  -- go through (spec rule 9 aside: same provider adapter, different downstream tables).
  source_query            text not null,
  source_country          text not null default 'ES'
    constraint proxy_validation_ads_market_es check (source_country = 'ES'),
  raw_storage_path        text,

  -- Set at write time by the ingestion code, not recomputed on read, so a run's exclusion
  -- counts stay explicable after the underlying corpus has moved on. Recomputed on every
  -- upsert from the row's own current fields, which is what "not recomputed on read" means
  -- here: it is a fact about the ad as last observed, not a derived column evaluated by SQL.
  exclusion_reason        text
    constraint proxy_validation_ads_exclusion_known check (
      exclusion_reason is null
      or exclusion_reason in ('still_running', 'zero_reach', 'sub_day_duration')
    ),

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  unique (workspace_id, ad_archive_id)
);

create index proxy_validation_ads_workspace_idx
  on public.proxy_validation_ads (workspace_id, advertiser_page_id);

create trigger proxy_validation_ads_set_updated_at
  before update on public.proxy_validation_ads
  for each row execute function app.set_updated_at();

alter table public.proxy_validation_ads enable row level security;

create policy proxy_validation_ads_tenant_read on public.proxy_validation_ads
  for select to authenticated
  using (workspace_id = app.current_workspace_id());

-- Writes go through the worker (service_role, BYPASSRLS), the same as every other ingestion
-- table. Upsertable, unlike the panel: an ES ad's row is corrected in place as its delivery
-- resolves, which is the mechanism the "corpus idempotency" acceptance criterion depends on.
grant select on public.proxy_validation_ads to authenticated;

------------------------------------------------------------
-- Stored regression runs
------------------------------------------------------------
-- One row per time the validation was computed over the corpus. Append-only for the same
-- reason as `analysis_runs` in 0007 — see that migration's header for the argument in full;
-- it applies here unchanged.

create table public.proxy_validation_runs (
  id                       uuid primary key default gen_random_uuid(),
  workspace_id             uuid not null references public.workspaces(id) on delete cascade,

  -- Corpus composition at the moment this run read it.
  corpus_size              integer not null,
  n_excluded_still_running integer not null default 0,
  n_excluded_zero_reach    integer not null default 0,
  n_excluded_sub_day       integer not null default 0,
  n_included               integer not null,

  advertisers_total        integer not null default 0,
  advertisers_used         integer not null default 0,
  advertisers_dropped      integer not null default 0,

  -- Which reach bound fed the regression (spec rule 7 — recorded, never silently collapsed).
  reach_bound_used         text not null default 'min'
    constraint proxy_validation_runs_bound_known check (reach_bound_used in ('min', 'max')),

  -- 'published' or 'refused'. Mirrors analysis_runs exactly: a thin corpus is a fact about
  -- the corpus, not an error, and is stored as a first-class refusal rather than an absence.
  outcome                  text not null
    constraint proxy_validation_runs_outcome_known check (outcome in ('published', 'refused')),
  failed_gate              text,
  gate_detail              jsonb not null default '{}',

  -- The primary estimate: within-advertiser log(reach) ~ log(days), tested against beta = 1
  -- (spec rule 1), never against 0. Null exactly when refused.
  beta                     double precision,
  beta_se                  double precision,
  beta_ci_low              double precision,
  beta_ci_high             double precision,
  t_stat                   double precision,
  p_value                  double precision check (p_value between 0 and 1),
  df                       integer,

  -- The exhibit, not a hedge (spec: "The naive estimate is computed too, and shown"). Shown
  -- beside the primary estimate on every published run.
  naive_pooled_beta        double precision,
  naive_pearson_r          double precision check (naive_pearson_r between -1 and 1),

  -- The one-sentence reading of beta vs. 1, derived once here rather than recomputed by
  -- every consumer of this row from beta/p_value — see packages/analysis/src/regression.ts.
  verdict                  text
    constraint proxy_validation_runs_verdict_known check (
      verdict is null or verdict in ('reflects_effort', 'inertia', 'throttled')
    ),

  trace_id                 text not null,
  actor                    jsonb not null,
  created_at               timestamptz not null default now(),

  -- Same equivalence as analysis_runs_gate_matches_outcome in 0007, for the same reason:
  -- constrains only the relationship and leaves the domain check above to do its own job.
  constraint proxy_validation_runs_gate_matches_outcome check (
    (failed_gate is null) = (outcome = 'published')
  ),
  -- A published run always has a coefficient to report; a refused one never does — there is
  -- no partial regression over a corpus too thin to publish.
  constraint proxy_validation_runs_published_has_beta check (
    (outcome = 'published') = (beta is not null)
  )
);

create index proxy_validation_runs_workspace_idx
  on public.proxy_validation_runs (workspace_id, created_at desc);
create index proxy_validation_runs_trace_idx on public.proxy_validation_runs (trace_id);

alter table public.proxy_validation_runs enable row level security;

create policy proxy_validation_runs_tenant_read on public.proxy_validation_runs
  for select to authenticated
  using (workspace_id = app.current_workspace_id());

grant select on public.proxy_validation_runs to authenticated;

-- Append-only, enforced twice for the reason documented at length in 0007: the revoke is
-- the real defence in production and is not testable under PGlite (no bootstrap grants to
-- revoke), so the trigger — reusing app.reject_mutation(), defined in 0007 — is what makes
-- the guarantee provable here.
revoke update, delete on public.proxy_validation_runs from anon, authenticated, service_role;

create trigger proxy_validation_runs_append_only
  before update or delete on public.proxy_validation_runs
  for each row execute function app.reject_mutation();
