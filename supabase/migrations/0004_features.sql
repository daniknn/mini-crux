-- 0004_features.sql
-- Structural features extracted from creative media (UC-2).
--
-- What this migration is protecting
-- ---------------------------------
-- Feature *definitions* are load-bearing for the analysis in UC-5. A change to a
-- cut-detection threshold or an OCR confidence floor changes what the numbers mean, and
-- therefore what the product concludes — silently, with every test still green. So the
-- definition set is versioned (`schema_version`) and rows from an older definition are
-- marked stale rather than overwritten or quietly mixed in.
--
-- The unique key is (creative_id, schema_version), not creative_id alone. Keeping the old
-- row is what makes a version bump auditable: you can see what v1 said about a creative
-- after v2 has re-measured it, which is the only way to tell a definition change from a
-- real change in the media.
--
-- Nothing here re-keys creative identity. `media_sha256` is recorded once the bytes exist
-- (ARCHITECTURE.md §6 names byte-hashing as the eventual dedup basis), but it is stored as
-- an observation, not promoted to `creatives.creative_hash`. Re-keying identity after the
-- panel has started would fork every creative on the day of the switch — the exact failure
-- the media-URL guardrail in CLAUDE.md exists to prevent.

------------------------------------------------------------
-- Creative features
------------------------------------------------------------
-- One row per (creative, feature schema version). Every measurement is nullable on
-- purpose: a static image has no cuts, a silent video has no audio energy, and OCR can
-- fail on a legible frame. Rule 1 of the spec is that these degrade to null plus an entry
-- in `skipped_features` — a partial row is a result, not an error.
--
-- Which is why `skipped_features` is not decoration. A null with no reason recorded is
-- indistinguishable from "we never tried", and downstream cohort math would silently drop
-- the creative from an n it should be counted in.

create table public.creative_features (
  id                     uuid primary key default gen_random_uuid(),
  workspace_id           uuid not null references public.workspaces(id) on delete cascade,
  creative_id            uuid not null references public.creatives(id) on delete cascade,
  schema_version         integer not null,

  -- Where the downloaded media landed, and what it hashed to. Immutable once written, for
  -- the same reason raw crawl snapshots are: re-extraction must run against the stored
  -- bytes, never against a fresh fetch from a signed URL that may already point elsewhere.
  media_storage_path     text,
  media_sha256           text,
  media_bytes            bigint,

  -- Structural measurements. See extractor/features.py for each definition; the thresholds
  -- live there and any change to one is a schema_version bump.
  duration_s             numeric(10, 3),
  first_cut_time_s       numeric(10, 3),
  cuts_per_second        numeric(10, 4),
  text_in_first_2s       boolean,
  text_density           numeric(5, 4),
  first_line_transcript  text,
  full_transcript        text,
  audio_energy_variance  double precision,

  -- Populated when the media ran longer than the sampling cap. Recorded rather than
  -- implied: a `text_density` computed over the first 60s of a 3-minute ad is a different
  -- quantity from one computed over the whole thing, and the analysis has to know which.
  analysis_cap_s         numeric(10, 3),
  truncated              boolean not null default false,

  skipped_features       text[] not null default '{}',
  -- Set when a newer definition set supersedes this row. The row stays readable; it just
  -- stops being the current answer.
  is_stale               boolean not null default false,

  extractor_version      text,
  trace_id               text,
  extracted_at           timestamptz not null default now(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (creative_id, schema_version)
);

-- The reconciler's lookup: creatives with no row at the current version.
create index creative_features_version_idx
  on public.creative_features (schema_version, is_stale);
create index creative_features_workspace_idx
  on public.creative_features (workspace_id, extracted_at desc);
create index creative_features_trace_idx on public.creative_features (trace_id);

create trigger creative_features_set_updated_at
  before update on public.creative_features
  for each row execute function app.set_updated_at();

alter table public.creative_features enable row level security;

create policy creative_features_tenant_read on public.creative_features
  for select to authenticated
  using (workspace_id = app.current_workspace_id());

grant select on public.creative_features to authenticated;

------------------------------------------------------------
-- Extraction backlog
------------------------------------------------------------
-- Enqueues one `extract` job per creative that has no features row at `target_version`.
--
-- A reconciler rather than a hook on parse. Two reasons, and the second is the real one:
--
-- 1. A version bump and a newly-parsed creative are the same situation — "this creative
--    has no current features" — so they should not be two code paths that can disagree.
-- 2. An enqueue-on-parse hook loses work whenever the enqueue itself fails, and the loss
--    is invisible: the creative simply never gets features and nothing reports it. A
--    reconciler that runs on a schedule is self-healing, which matters more here than
--    latency. Features are not time-critical; the crawl is.
--
-- `where not exists` against the jobs table keeps a second tick from stacking duplicate
-- work for a creative whose first job is still pending or running.

create or replace function app.enqueue_pending_extractions(
  target_version integer,
  batch_limit    integer default 500
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_creative record;
  v_created  integer := 0;
begin
  for v_creative in
    select c.id, c.workspace_id
    from public.creatives c
    where c.media_url is not null
      and c.media_type in ('video', 'image')
      and not exists (
        select 1
        from public.creative_features f
        where f.creative_id = c.id
          and f.schema_version = target_version
      )
      and not exists (
        select 1
        from public.jobs j
        where j.type = 'extract'
          and j.status in ('pending', 'running')
          and j.payload ->> 'creative_id' = c.id::text
          and (j.payload ->> 'schema_version')::integer = target_version
      )
    order by c.first_seen_at
    limit batch_limit
  loop
    insert into public.jobs (workspace_id, message_id, type, payload, trace_id, actor)
    values (
      v_creative.workspace_id,
      app.new_ulid('msg_'),
      'extract',
      jsonb_build_object(
        'creative_id', v_creative.id,
        'schema_version', target_version
      ),
      app.new_ulid('trc_'),
      jsonb_build_object('type', 'schedule', 'id', 'extract-reconciler', 'label', 'extract-backlog')
    );

    v_created := v_created + 1;
  end loop;

  return v_created;
end
$fn$;

revoke execute on function app.enqueue_pending_extractions(integer, integer)
  from public, anon, authenticated;

------------------------------------------------------------
-- Version bump
------------------------------------------------------------
-- Marks every row from an older definition set stale, then lets the reconciler above
-- re-enqueue them. Split in two on purpose: staleness is a fact about existing rows and
-- must be recorded even if the re-extraction never runs. Collapsing them would mean a
-- worker outage leaves superseded rows presenting as current.

create or replace function app.mark_features_stale(target_version integer)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_marked integer;
begin
  update public.creative_features
  set is_stale = true
  where schema_version < target_version
    and not is_stale;

  get diagnostics v_marked = row_count;
  return v_marked;
end
$fn$;

revoke execute on function app.mark_features_stale(integer) from public, anon, authenticated;

------------------------------------------------------------
-- Job liveness
------------------------------------------------------------
-- Extraction is the first genuinely long-running job in the system. A crawl is an HTTP
-- call; transcribing a 2-minute ad on a CPU-only Fly machine is minutes of blocking work.
-- Without a liveness signal there are only two options, and both are wrong: a timeout
-- short enough to catch a dead worker also kills healthy extractions, and one long enough
-- to spare them leaves a crashed worker's job stuck for hours.
--
-- So a running job reports that it is still alive, and the reaper below only requeues jobs
-- that have stopped reporting. This is also what makes spec rule 5 enforceable: blocking
-- CV work run inside the event loop stops the heartbeat task from being scheduled, the
-- reaper requeues a job that is in fact progressing, and the same creative gets extracted
-- twice. The symptom presents as a spurious timeout, which is why the rule exists.

alter table public.jobs add column heartbeat_at timestamptz;

create index jobs_stalled_idx on public.jobs (heartbeat_at)
  where status = 'running';

-- Claims one due job of the given types. `for update skip locked` is the whole point:
-- several workers poll the same table, and without it they would serialize behind each
-- other or, worse, claim the same row.
--
-- `returns setof` rather than a bare composite, and it matters. A composite-returning
-- function written as `select (app.claim_job(...)).*` is re-evaluated once per output
-- column — Postgres expands the record before it optimizes — so a claim that looks like
-- one call is a dozen, each one claiming and abandoning a different job. With SETOF the
-- only sane call shape is `select * from app.claim_job(...)`, which evaluates once, and
-- "nothing to claim" is zero rows instead of a row of nulls.
create or replace function app.claim_job(job_types text[])
returns setof public.jobs
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_id uuid;
begin
  select id into v_id
  from public.jobs
  where status = 'pending'
    and type = any(job_types)
    and run_after <= now()
  order by run_after
  limit 1
  for update skip locked;

  if v_id is null then
    return;
  end if;

  return query
  update public.jobs
  set status       = 'running',
      attempts     = attempts + 1,
      started_at   = coalesce(started_at, now()),
      heartbeat_at = now()
  where id = v_id
  returning *;
end
$fn$;

revoke execute on function app.claim_job(text[]) from public, anon, authenticated;

-- Returns running jobs whose worker has gone quiet. A job that has exhausted its attempts
-- is failed rather than requeued, so a creative whose media reliably crashes the extractor
-- stops consuming the queue instead of cycling through it forever.
create or replace function app.reap_stalled_jobs(stall_after interval default interval '5 minutes')
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_reaped integer;
begin
  update public.jobs
  -- Cast is required, not decorative: a CASE over string literals is `unknown`, and
  -- assigning it to a `job_status` column is a parse error rather than an inference.
  set status      = (case when attempts >= max_attempts then 'failed' else 'pending' end)::public.job_status,
      last_error  = 'worker stopped reporting; reaped after ' || stall_after,
      finished_at = case when attempts >= max_attempts then now() else null end
  where status = 'running'
    and heartbeat_at is not null
    and heartbeat_at < now() - stall_after;

  get diagnostics v_reaped = row_count;
  return v_reaped;
end
$fn$;

revoke execute on function app.reap_stalled_jobs(interval) from public, anon, authenticated;
