-- 0007_analysis.sql
-- Cohort contrast analysis: stored runs and their per-feature results (UC-5).
--
-- Why the analysis is stored at all
-- ---------------------------------
-- The arithmetic is milliseconds, so this is not a cache. It is a record.
--
-- A number that changes between two page loads with no record of why is not a finding an
-- operator can act on or argue with. The first time a result looks wrong — and it will, the
-- first week a result is surprising — the question asked is "which analysis produced this,
-- over which panel, under which feature definitions", and a figure recomputed on render
-- cannot answer it. A stored run can, and the history of what the analysis said on each day
-- becomes its own audit trail.
--
-- Why a refusal is a row and not an absence
-- ------------------------------------------
-- This is the same distinction the crawler makes between "we looked and it was gone" and
-- "we did not look" (CLAUDE.md rule 3), applied one layer up. "We ran the analysis and it
-- refused, because the panel is 12 days old and long_lived needs 61" and "nobody has ever
-- run this" are different facts about the product, and collapsing them into a blank screen
-- loses the one that is actionable. So `outcome = 'refused'` is a first-class row carrying
-- which gate failed and by how much, and the UI renders it as "faltan 49 días".
--
-- Why append-only
-- ---------------
-- A re-run writes a new row; nothing is ever updated in place. Enforced structurally rather
-- than by discipline — update and delete are revoked from every role including
-- `service_role`, so the job that writes these rows is physically incapable of rewriting
-- yesterday's answer. There is no `updated_at` column for the same reason: a column that
-- can never change would be a lie about the table's contract.

------------------------------------------------------------
-- Analysis runs
------------------------------------------------------------
create table public.analysis_runs (
  id                     uuid primary key default gen_random_uuid(),
  workspace_id           uuid not null references public.workspaces(id) on delete cascade,

  -- What the run read. `panel_date` is the logical day of the panel, taken from
  -- `crawl_runs.run_date` and never from a timestamp cast — the entire UC-3 timezone
  -- argument applies unchanged here, and this is the column an operator will use to line a
  -- finding up against a crawl.
  panel_date             date    not null,
  panel_age_days         integer not null,

  -- The three versions, pinned per run.
  --
  -- `feature_schema_version` is the one that matters: it pins what the numbers *mean*. A
  -- run that found feature rows at two versions must fail rather than pool them (spec rule
  -- 3), which is why this is a scalar and not an array — there is no valid run with two.
  --
  -- `extractor_versions` is an array precisely because there *is* a valid run with two.
  -- That version records which build produced a measurement, not what it means, and a
  -- panel that spans a bug fix in the sampler legitimately carries both. Collapsing it to
  -- one value would either discard provenance or imply a uniformity the data does not have.
  --
  -- Nullable for exactly one case, tied down by `analysis_runs_published_pins_version`
  -- below: a run whose panel produced no cohort members at all has no version to pin,
  -- because the version is read off the members' feature rows and there are none. That run
  -- always refuses. Writing 0 or -1 instead would put a version number that never existed
  -- into the column an operator uses to line a finding up against a feature definition.
  feature_schema_version integer,
  extractor_versions     text[]  not null default '{}',
  analysis_version       text    not null,

  -- 'published' or 'refused'. There is no third state: a run that errored writes nothing,
  -- because "the analysis crashed" is a fact about the code, not about the panel, and
  -- storing it here would put it in the same list an operator reads as findings.
  outcome                text    not null
    constraint analysis_runs_outcome_known check (outcome in ('published', 'refused')),

  -- Which gate refused, and what the panel would need. Null exactly when published; the
  -- check below ties the two together so neither can drift.
  failed_gate            text,
  gate_detail            jsonb   not null default '{}',

  -- Cohort sizes for the run as a whole. Per-feature n lives on the results table, because
  -- a feature in `skipped_features` for some creatives has a smaller n than its neighbours
  -- and one number for the whole run would overstate exactly the features we measured
  -- least well.
  n_long                 integer not null,
  n_short                integer not null,

  -- The four exclusions, counted separately because they mean different things and the fix
  -- for each is different. `n_excluded_middle` is the ambiguous middle and shrinks as the
  -- panel ages; `n_excluded_gaps` is creatives whose span crosses a crawl we cannot
  -- recover, so it tracks crawler outages; `n_excluded_no_start` is creatives Meta gave no
  -- `ad_delivery_start_time` for, which is a provider problem; `n_excluded_not_extracted`
  -- is creatives with no current feature row, which is an extraction backlog and the only
  -- one of the four an operator can clear by running more jobs.
  --
  -- A single "excluded" total would hide a crawler outage inside a normal-looking number,
  -- and would make a refusal impossible to act on: the operator needs to know whether to
  -- wait, fix the crawler, or drain the extraction queue.
  --
  -- Together with `n_long` and `n_short` these sum to the panel — an invariant asserted on
  -- the assembly that produces them, in `packages/analysis/test/cohorts.test.ts`.
  n_excluded_middle        integer not null default 0,
  n_excluded_gaps          integer not null default 0,
  n_excluded_no_start      integer not null default 0,
  n_excluded_not_extracted integer not null default 0,

  -- Share of `long_lived` still running. Null when the cohort is empty — 0/0 is not 0, and
  -- writing 0 would report "nothing is still running" for a cohort with no members.
  censoring_rate_long    double precision check (censoring_rate_long between 0 and 1),

  -- Advertisers seen, advertisers that contributed to both cohorts, advertisers dropped for
  -- landing entirely in one. On a thin panel the third number is usually the largest, and a
  -- run that reported only the first would look far better powered than it is.
  strata_total           integer not null default 0,
  strata_used            integer not null default 0,
  strata_dropped         integer not null default 0,

  trace_id               text    not null,
  actor                  jsonb   not null,
  created_at             timestamptz not null default now(),

  -- A published run has no failed gate and a refused one must name it. Without this, a
  -- refusal with a null gate renders as "no se pudo ejecutar" with no reason, which is the
  -- blank screen this table exists to prevent.
  --
  -- Written as an equivalence rather than the more obvious
  --   (outcome = 'published' and failed_gate is null) or
  --   (outcome = 'refused'   and failed_gate is not null)
  -- which is logically the same for the two legal outcomes but *also* rejects every
  -- illegal one, overlapping `analysis_runs_outcome_known` completely. Two constraints
  -- that always fire together are two constraints neither of which can be tested: an
  -- insert of `outcome = 'errored'` tripped this one first, so deleting the outcome domain
  -- check entirely left the suite green. This form constrains only the *relationship* and
  -- leaves the domain to the constraint whose job that is.
  constraint analysis_runs_gate_matches_outcome check (
    (failed_gate is null) = (outcome = 'published')
  ),

  -- A published run always pins a version; a refused one may have had no members to read one
  -- from. Deliberately an implication and not an equivalence: a refused run *usually* does
  -- have a version — it assembled cohorts and then failed a gate — so requiring null on
  -- refusal would reject the common case. This is the weakest statement that still makes the
  -- nullability above impossible to abuse.
  constraint analysis_runs_published_pins_version check (
    outcome <> 'published' or feature_schema_version is not null
  )
);

create index analysis_runs_workspace_idx
  on public.analysis_runs (workspace_id, created_at desc);
create index analysis_runs_panel_idx
  on public.analysis_runs (workspace_id, panel_date desc);
create index analysis_runs_trace_idx on public.analysis_runs (trace_id);

comment on column public.analysis_runs.panel_date is
  'Logical day of the panel this run read, from crawl_runs.run_date. Never a cast of a '
  'timestamp — see 0005 for why that would make the analysis depend on who is reading it.';

alter table public.analysis_runs enable row level security;

create policy analysis_runs_tenant_read on public.analysis_runs
  for select to authenticated
  using (workspace_id = app.current_workspace_id());

------------------------------------------------------------
-- Per-feature results
------------------------------------------------------------
-- One row per feature per *published* run. A refused run has none, and that is enforced
-- below rather than left to the writer: publishing the features that happened to clear a
-- per-feature n while suppressing the rest is a garden of forking paths with extra steps,
-- and it is the kind of thing a well-meaning bug fix reintroduces.

create table public.analysis_feature_results (
  id                       uuid primary key default gen_random_uuid(),
  workspace_id             uuid not null references public.workspaces(id) on delete cascade,
  analysis_run_id          uuid not null references public.analysis_runs(id) on delete cascade,

  -- Constrained to the measured structural features. A typo would otherwise land silently
  -- as a seventh feature that renders once and never again — and since every new feature
  -- arrives with a column on `creative_features`, it already arrives with a migration.
  feature                  text not null check (feature in (
    'duration_s',
    'first_cut_time_s',
    'cuts_per_second',
    'text_in_first_2s',
    'text_density',
    'audio_energy_variance'
  )),

  -- Per feature, not per run. A creative whose `text_density` was never measurable is
  -- dropped from this feature's test and stays in the others, so these differ row to row.
  n_long                   integer not null,
  n_short                  integer not null,

  -- Positive z means long-lived creatives score *higher* on this feature. The convention is
  -- stated here as well as in the TypeScript because it is the one detail that leaves every
  -- magnitude correct and every conclusion backwards.
  z                        double precision not null,
  p_value                  double precision not null check (p_value between 0 and 1),

  -- Benjamini-Hochberg adjusted across the features in this run. Stored rather than derived
  -- on read: q depends on the whole set of p-values in the run, so recomputing it later
  -- against a different set of features would silently change a published number.
  q_value                  double precision not null check (q_value between 0 and 1),

  -- Effect size, always (CLAUDE.md rule 8). A bare p-value is not shippable.
  probability_superiority  double precision not null check (probability_superiority between 0 and 1),
  rank_biserial            double precision not null check (rank_biserial between -1 and 1),

  strata_used              integer not null,
  strata_dropped           integer not null,

  created_at               timestamptz not null default now(),

  unique (analysis_run_id, feature)
);

create index analysis_feature_results_run_idx
  on public.analysis_feature_results (analysis_run_id);
create index analysis_feature_results_workspace_idx
  on public.analysis_feature_results (workspace_id, created_at desc);

alter table public.analysis_feature_results enable row level security;

create policy analysis_feature_results_tenant_read on public.analysis_feature_results
  for select to authenticated
  using (workspace_id = app.current_workspace_id());

------------------------------------------------------------
-- Rule 7, in the database
------------------------------------------------------------
-- "No feature result is published from a run that failed any gate."
--
-- The job enforces this too, but the job is where the mistake would be made. A foreign key
-- cannot express it — it constrains which run a result points at, not which *kind* of run —
-- so it is a trigger.
--
-- The workspace check rides along for a different reason. Both tables carry `workspace_id`
-- so each can be filtered by RLS on its own, and that denormalization is exactly what lets
-- a writer file a result under workspace A against a run belonging to workspace B. Both
-- rows then pass their own policy and the analysis surface shows another tenant's finding.
-- The FK does not catch it; nothing else would.
--
-- `security definer` because the function reads a table under RLS from inside a trigger. An
-- invoker-rights function here is subject to the reader's own policies, so it would find no
-- parent run for a caller in a different workspace and raise "run does not exist" — turning
-- a tenancy violation into a confusing not-found. `search_path = ''` with fully-qualified
-- names, without which `security definer` is a privilege escalation.

create or replace function app.assert_run_published()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_run public.analysis_runs;
begin
  select * into v_run from public.analysis_runs where id = new.analysis_run_id;

  if not found then
    raise exception 'analysis run % does not exist', new.analysis_run_id;
  end if;

  if v_run.outcome <> 'published' then
    raise exception
      'analysis run % was % (gate %); a run that refused publishes no feature results',
      v_run.id, v_run.outcome, coalesce(v_run.failed_gate, 'unknown');
  end if;

  if v_run.workspace_id <> new.workspace_id then
    raise exception
      'feature result workspace % does not match analysis run workspace %',
      new.workspace_id, v_run.workspace_id;
  end if;

  return new;
end;
$fn$;

create trigger analysis_feature_results_require_published
  before insert on public.analysis_feature_results
  for each row execute function app.assert_run_published();

------------------------------------------------------------
-- Grants
------------------------------------------------------------
-- Read-only for the dashboard. The analysis job writes through the service role, which is
-- how every other background writer in this system works.
grant select on public.analysis_runs            to authenticated;
grant select on public.analysis_feature_results to authenticated;

-- Append-only, enforced for every role including the one that does the writing. A re-run
-- writes a new row; there is no path that edits what the analysis said yesterday.
revoke update, delete on public.analysis_runs            from anon, authenticated, service_role;
revoke update, delete on public.analysis_feature_results from anon, authenticated, service_role;

------------------------------------------------------------
-- Append-only, belt and braces
------------------------------------------------------------
-- The revokes above are the real defence in production and they are **not testable here**,
-- which is why the trigger exists.
--
-- Supabase's bootstrap runs `alter default privileges … grant all on tables to anon,
-- authenticated, service_role`, so a new table arrives with UPDATE and DELETE already
-- granted and the revoke is what takes them away. PGlite has no such bootstrap: those
-- privileges were never granted, so the revoke is a no-op and a test asserting "no update
-- grant exists" passes whether or not the revoke is in the file. Measured, not assumed —
-- deleting both revoke lines left the suite green.
--
-- A trigger does not care about grants. It holds for the table owner, for a future
-- migration that re-grants by accident, and for a psql session belonging to whoever is
-- debugging at 2am, and it can be proved in PGlite by granting the privileges back and
-- watching the write fail anyway. The revokes stay because refusing the privilege is
-- better than allowing the attempt and erroring; the trigger is what makes the guarantee
-- true rather than configured.

create or replace function app.reject_mutation()
returns trigger
language plpgsql
as $fn$
begin
  raise exception
    '% is append-only: a re-run writes a new row, it never edits an earlier one',
    tg_table_name;
end;
$fn$;

create trigger analysis_runs_append_only
  before update or delete on public.analysis_runs
  for each row execute function app.reject_mutation();

create trigger analysis_feature_results_append_only
  before update or delete on public.analysis_feature_results
  for each row execute function app.reject_mutation();
