-- 0012_semantic_tags.sql
-- Semantic tagging via VLM (UC-8): frame paths on creative_features, and the tags table.
--
-- What this migration protects
-- -----------------------------
-- UC-8 adds a second kind of feature — not "how the video is cut" but "what is in it" —
-- without disturbing anything UC-2 through UC-7 already rely on. Two additions, and the
-- boundary between them and the existing schema is the point:
--
-- 1. `creative_features.semantic_frame_paths` — a column, not a table, because frame
--    sampling is a product of the *same extractor run at the same schema_version* as
--    every other UC-2 measurement (0006's own reasoning for `poster_storage_path`:
--    versioned together, superseded together). It inherits creative_features' existing
--    RLS policy; a column addition is not a new attack surface.
-- 2. `creative_semantic_tags` — a new table, because a VLM tag is a second, independently
--    versioned judgment about the same creative, made by a different process (a model call,
--    not a decode pass) on its own schedule. Coupling it to creative_features' schema_version
--    would force a frame-sampling change and a prompt change to share one version number,
--    when the spec is explicit that SEMANTIC_SCHEMA_VERSION bumps "when the prompt or
--    taxonomy changes — never when the model provider changes without changing what is
--    asked of it." Two independent facts need two independent version numbers.
--
-- The unique key on creative_semantic_tags is (creative_id, schema_version), same shape as
-- creative_features, same reason: keeping the superseded row is what makes a taxonomy change
-- auditable, not just applied.

------------------------------------------------------------
-- Frame paths (creative_features addition)
------------------------------------------------------------
-- Three frames per creative — the existing hook-window frame, one at the temporal midpoint,
-- one near the end — saved during the decode pass UC-2 already runs for OCR sampling. No
-- second video read (spec rule 1). Null, with an entry in the existing `skipped_features`,
-- on any video the extractor could not decode — the same degrade-gracefully rule as every
-- other feature, not a new one, which is why this needs no new "skipped" column of its own.

alter table public.creative_features
  add column semantic_frame_paths text[];

comment on column public.creative_features.semantic_frame_paths is
  'Storage keys of three JPEGs (hook @0.5s, midpoint, near-end) cut during the same decode '
  'pass as OCR sampling, or null when extraction was skipped (see skipped_features). Gates '
  'app.enqueue_pending_semantic_tags: tagging cannot run ahead of frames that do not exist.';

-- No new policy. creative_features already carries workspace_id with a tenant read policy
-- from 0004; a column addition inherits it (same note as 0006's poster_storage_path).

------------------------------------------------------------
-- Semantic tags
------------------------------------------------------------
-- One row per (creative, tag schema version). `has_people_on_screen` is boolean and joins
-- UC-5's contrast engine directly as 0/1 (design §6) — the only tag correlated in v1.
-- `hook_type` and `tone` are small, unordered, fixed-taxonomy categories, shown descriptively
-- only (rule 5): forcing them through a rank test would assume an ordering that does not
-- exist ("testimonial" is not more or less than "demo"). The taxonomy is pinned by
-- SEMANTIC_SCHEMA_VERSION in the same sense the feature thresholds are pinned by
-- creative_features.schema_version — a taxonomy change is a version bump, not an edit in
-- place, so a row always says which definition set produced it.

create table public.creative_semantic_tags (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references public.workspaces(id) on delete cascade,
  creative_id           uuid not null references public.creatives(id) on delete cascade,
  schema_version        integer not null,

  -- Three kinds of null, same discipline as creative_features (design §4): a field the
  -- model declined to answer is null plus a skipped_tags entry; a field the model actively
  -- answered "no" to is a real false, never collapsed into the same null.
  has_people_on_screen  boolean,
  hook_type             text
    constraint creative_semantic_tags_hook_type_known check (
      hook_type is null or hook_type in (
        'testimonial', 'demo', 'problem_solution', 'ugc', 'offer', 'other'
      )
    ),
  tone                  text
    constraint creative_semantic_tags_tone_known check (
      tone is null or tone in (
        'humoristico', 'emocional', 'informativo', 'urgente', 'aspiracional', 'other'
      )
    ),
  skipped_tags          text[] not null default '{}',

  -- Land raw, parse later (domain rule 2, applied to a model response rather than a crawl
  -- payload — spec §3). Stored before the typed columns above are derived from it, so a
  -- prompt-shape or parsing bug is a reprocess against this column, not a second VLM call —
  -- which matters here specifically because, unlike a crawl snapshot, a second call costs
  -- money (rule 4).
  raw_response          jsonb,

  vlm_provider          text,
  vlm_model             text,

  -- Set when a newer taxonomy/prompt version supersedes this row. The row stays readable;
  -- it just stops being the current answer — same lifecycle as creative_features.is_stale.
  is_stale              boolean not null default false,

  trace_id              text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  unique (creative_id, schema_version)
);

-- The reconciler's lookup: creatives with no row at the current version.
create index creative_semantic_tags_version_idx
  on public.creative_semantic_tags (schema_version, is_stale);
create index creative_semantic_tags_workspace_idx
  on public.creative_semantic_tags (workspace_id, created_at desc);
create index creative_semantic_tags_trace_idx
  on public.creative_semantic_tags (trace_id);

create trigger creative_semantic_tags_set_updated_at
  before update on public.creative_semantic_tags
  for each row execute function app.set_updated_at();

alter table public.creative_semantic_tags enable row level security;

create policy creative_semantic_tags_tenant_read on public.creative_semantic_tags
  for select to authenticated
  using (workspace_id = app.current_workspace_id());

grant select on public.creative_semantic_tags to authenticated;

------------------------------------------------------------
-- Tagging backlog
------------------------------------------------------------
-- Enqueues one `semantic_tag` job per creative that has no tags row at `target_version`.
-- Same shape and same reasoning as app.enqueue_pending_extractions (0004): a version bump
-- and a newly-extracted creative are the same fact — "this creative has no current tags" —
-- so they must not be two code paths that can disagree, and a reconciler is self-healing
-- against a lost enqueue in a way an on-write hook is not.
--
-- Gated on creative_features having a *current*, non-stale row with semantic_frame_paths
-- not null: tagging cannot run ahead of frames that do not exist yet, and a creative whose
-- media never decoded (frames null) is correctly never enqueued rather than retried forever.
--
-- Not cron-scheduled, mirroring app.enqueue_pending_extractions: invoked deliberately by an
-- operator (RUNBOOK), because spend is bounded to panel size and re-running it costs a VLM
-- call per newly-eligible creative, not zero.
--
-- `where not exists` against the jobs table keeps a second invocation from stacking
-- duplicate work for a creative whose first job is still pending or running.

create or replace function app.enqueue_pending_semantic_tags(
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
    select f.creative_id, f.workspace_id
    from public.creative_features f
    where not f.is_stale
      and f.semantic_frame_paths is not null
      and not exists (
        select 1
        from public.creative_semantic_tags t
        where t.creative_id = f.creative_id
          and t.schema_version = target_version
      )
      and not exists (
        select 1
        from public.jobs j
        where j.type = 'semantic_tag'
          and j.status in ('pending', 'running')
          and j.payload ->> 'creative_id' = f.creative_id::text
          and (j.payload ->> 'schema_version')::integer = target_version
      )
    order by f.extracted_at
    limit batch_limit
  loop
    insert into public.jobs (workspace_id, message_id, type, payload, trace_id, actor)
    values (
      v_creative.workspace_id,
      app.new_ulid('msg_'),
      'semantic_tag',
      jsonb_build_object(
        'creative_id', v_creative.creative_id,
        'schema_version', target_version
      ),
      app.new_ulid('trc_'),
      jsonb_build_object(
        'type', 'schedule', 'id', 'semantic-tag-reconciler', 'label', 'semantic-tag-backlog'
      )
    );

    v_created := v_created + 1;
  end loop;

  return v_created;
end
$fn$;

revoke execute on function app.enqueue_pending_semantic_tags(integer, integer)
  from public, anon, authenticated;

------------------------------------------------------------
-- Version bump
------------------------------------------------------------
-- Marks every row from an older taxonomy/prompt version stale, then lets the reconciler
-- above re-enqueue them. Split in two on purpose, same as mark_features_stale (0004):
-- staleness is a fact about existing rows and must be recorded even if re-tagging never
-- runs. Collapsing them would mean a worker outage leaves superseded tags presenting as
-- current.

create or replace function app.mark_semantic_tags_stale(target_version integer)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_marked integer;
begin
  update public.creative_semantic_tags
  set is_stale = true
  where schema_version < target_version
    and not is_stale;

  get diagnostics v_marked = row_count;
  return v_marked;
end
$fn$;

revoke execute on function app.mark_semantic_tags_stale(integer)
  from public, anon, authenticated;
