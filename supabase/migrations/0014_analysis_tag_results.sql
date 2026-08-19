-- 0014_analysis_tag_results.sql
-- Stores the UC-8 descriptive breakdown of `hook_type`/`tone` per analysis run.
--
-- Why a new table and not two more rows in analysis_feature_results
-- --------------------------------------------------------------------
-- `analysis_feature_results` is statistical by construction: every column but `feature`,
-- `n_long` and `n_short` is a number `vanElteren`/`benjaminiHochberg` produced, and the
-- `feature` column is check-constrained to the names ANALYSIS_FEATURES knows how to compute
-- a *contrast* for. `hook_type` and `tone` never reach that pipeline (spec §6): they are
-- counted, not tested, so a row for them has no z, no p, no q to store — every one of those
-- columns would sit `not null` and empty, which is exactly the kind of table shape that
-- invites a future reader to assume a statistic exists where none was computed.
--
-- The shape here matches the arithmetic instead: one row per (run, tag, value), each row
-- the count of cohort members carrying that value, long and short side by side. The
-- `untagged` bucket is one more row per tag rather than a special column, so `n_long`/
-- `n_short` mean the same thing on every row in the table and a reader never has to branch
-- on which column holds the "no value" case.
--
-- `value`'s check constraint is compound and per-tag on purpose: `hook_type` and `tone` have
-- different taxonomies (0012's `creative_semantic_tags_hook_type_known` /
-- `..._tone_known`), so a flat `value in (...)` across both lists would let a `tone` row
-- carry a `hook_type`-only value like `'ugc'` and nothing would catch it.

create table public.analysis_tag_results (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,
  analysis_run_id   uuid not null references public.analysis_runs(id) on delete cascade,

  tag               text not null check (tag in ('hook_type', 'tone')),

  -- 'untagged' is a real taxonomy member here, not a null. A unique constraint treats every
  -- null as distinct from every other null, so two 'untagged' rows for the same run and tag
  -- would both pass `unique (analysis_run_id, tag, value)` silently — the same class of trap
  -- CLAUDE.md's driver-decoding table warns about one layer down. A literal value keeps the
  -- constraint meaningful.
  value             text not null check (
    (tag = 'hook_type' and value in (
      'testimonial', 'demo', 'problem_solution', 'ugc', 'offer', 'other', 'untagged'
    ))
    or
    (tag = 'tone' and value in (
      'humoristico', 'emocional', 'informativo', 'urgente', 'aspiracional', 'other', 'untagged'
    ))
  ),

  -- Per value, not per run: how many cohort members carried this value (or, on the
  -- 'untagged' row, carried none). CLAUDE.md rule 8 — every number ships with its n.
  n_long            integer not null check (n_long >= 0),
  n_short           integer not null check (n_short >= 0),

  created_at        timestamptz not null default now(),

  unique (analysis_run_id, tag, value)
);

create index analysis_tag_results_run_idx
  on public.analysis_tag_results (analysis_run_id);
create index analysis_tag_results_workspace_idx
  on public.analysis_tag_results (workspace_id, created_at desc);

alter table public.analysis_tag_results enable row level security;

create policy analysis_tag_results_tenant_read on public.analysis_tag_results
  for select to authenticated
  using (workspace_id = app.current_workspace_id());

------------------------------------------------------------
-- Rule 7's neighbour: no tag breakdown from a run that failed a gate
------------------------------------------------------------
-- Same reasoning as `app.assert_run_published` (0007), reapplied rather than duplicated —
-- the trigger is generic over the table it fires on (`tg_table_name`, `new.analysis_run_id`),
-- so this table attaches the existing function instead of defining a second copy that could
-- drift from the first.

create trigger analysis_tag_results_require_published
  before insert on public.analysis_tag_results
  for each row execute function app.assert_run_published();

------------------------------------------------------------
-- Append-only, same posture as analysis_feature_results
------------------------------------------------------------
-- A re-run writes a new run and new rows under it; nothing edits a stored breakdown. The
-- revokes are the real defence in production (Supabase's default-privileges bootstrap grants
-- update/delete on every new table); the trigger is what makes the guarantee true under
-- PGlite, which never grants them in the first place — see 0007's header for the long form.

create trigger analysis_tag_results_append_only
  before update or delete on public.analysis_tag_results
  for each row execute function app.reject_mutation();

grant select on public.analysis_tag_results to authenticated;

revoke update, delete on public.analysis_tag_results from anon, authenticated, service_role;
