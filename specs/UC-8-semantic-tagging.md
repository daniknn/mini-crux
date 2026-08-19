# UC-8 — Semantic tagging via VLM

**Status:** `done` · **Depends on:** UC-2, UC-5 · **Blocks:** nothing

## Goal

Give the correlational layer a second kind of feature: not "how the video is cut" but "what
is in it." `ARCHITECTURE.md` §10.2 names this directly and defers it on purpose:

> **Structural features only.** No semantic tagging (hook type, people on screen, tone). v1
> derives message-level insight from the whisper transcript and the Ad Library ad copy. A VLM
> tagging pass is the planned depth upgrade.

UC-5's own "Deferred past UC-5" list repeats it, second only to the proxy-validation debt —
which UC-7 has now paid. This is the next named, planned piece of work in the repo, not a new
idea: the three tags below (`hook_type`, `has_people_on_screen`, `tone`) are exactly the three
ARCHITECTURE.md already promised, no more.

## Scope

**In:** sampling representative frames per creative (extractor); a swappable VLM provider
adapter; a `semantic_tag` job that calls it and stores the result; one boolean tag wired into
UC-5's existing contrast engine; two categorical tags shown descriptively.

**Out:** a general tagging taxonomy, per-tag confidence scores, categorical hypothesis testing
(chi-square/Fisher — noted as upgrade path, same posture as UC-5's Kaplan-Meier note), any
tagging of static-image creatives beyond a single-frame best effort, cost/budget controls
beyond schema-version idempotency.

## Why this stays in TypeScript, not `apps/extractor`

`CLAUDE.md`'s documented deviation scopes Python to `apps/extractor` *only*, justified there
because OpenCV/EasyOCR/faster-whisper/librosa have no credible TS equivalent. A VLM call is an
HTTP request with a JSON body and a JSON response — no different in kind from the Apify calls
`packages/ingestion/src/providers/ad-library` already makes. Tagging is also product logic
(feeds UC-5, is tenant-scoped in its provenance, needs the same idempotency and retry
discipline as every other job): it belongs on the TS side of the boundary the deviation draws.

What *does* need Python is decoding the video to pull still frames — that stays in the
extractor, as a small addition to work it already does (see below), not a new pipeline.

## Design

### 1. Frame sampling (extractor addition, not a new pipeline)

The extractor already decodes every video for OCR sampling. `UC2Pipeline.extract` gains one
more cheap step: save three frames as JPEGs to Storage — the existing hook-window frame
(`@0.5s`, already read for `text_in_first_2s`), one at the temporal midpoint, and one near the
end (capped the same way OCR/transcript sampling is, `analysis_cap_s`). Three frames, not one,
because "hook type" and "tone" are claims about the ad's arc, and a single poster frame (UC-4)
is not enough evidence for either.

Stored on `creative_features.semantic_frame_paths text[]`, alongside the existing
`poster_storage_path` — same table, because frame sampling is a product of the same extractor
run at the same `schema_version`, for the same reason the poster is (0006's own reasoning:
versioned together, superseded together). Null, with an entry in `skipped_features`, on any
video the extractor could not decode — the existing degrade-gracefully rule (UC-2 rule 1),
not a new one.

### 2. The VLM provider adapter

`packages/ingestion/src/providers/vlm/` — same shape as `providers/ad-library`: a `VlmProvider`
interface, a real implementation behind it, and a `fixture.ts` for tests. Swappable so the
underlying model is not load-bearing in the codebase (domain rule 11's reasoning, applied to a
second provider).

```ts
interface VlmProvider {
  readonly name: string
  tagCreative(input: {
    frameUrls: readonly string[]
    transcript: string | null
  }): Promise<VlmRawResponse>
}
```

One call per creative, three frames plus the transcript UC-2 already extracted (message-level
context a single frame cannot carry — the transcript is why `tone` is answerable at all).

### 3. Land raw, parse later — applied to a model response, not a crawl payload

Domain rule 2 was written for Apify payloads, but the reasoning transfers exactly: the raw VLM
response is stored (`creative_semantic_tags.raw_response jsonb`) before it is parsed into typed
columns. A prompt-shape or parsing bug is then a reprocess against the stored response, not a
second VLM call — which matters here specifically because, unlike a re-parse of a crawl
snapshot, a second call costs money.

### 4. Three kinds of null, again

A VLM can decline to call a field (the model says "unclear" or omits it) as easily as OCR can
fail on a legible frame. Same discipline as `skipped_features`: a field the model would not
commit to is `null` **with** an entry in `skipped_tags`. A field the model actively answered
"no" to (e.g. no person visible) is `false` — a real, present observation, not an absence.
Collapsing the two would, as always, move creatives between cohorts silently.

### 5. Schema versioning, extraction-once, and the reconciler

Same three mechanisms as UC-2, because this is the same shape of problem one layer up:

- `SEMANTIC_SCHEMA_VERSION`, pinned per row, bumped when the prompt or taxonomy changes —
  never when the model provider changes without changing what is asked of it.
- Tag once per `(creative_id, schema_version)`. A creative already tagged at the current
  version is never re-sent to the VLM — this is what keeps spend bounded to panel size, not
  panel size × re-runs.
- `app.enqueue_pending_semantic_tags(target_version, batch_limit)` — a Postgres reconciler,
  same shape and same reasoning as `app.enqueue_pending_extractions` (0004): a version bump
  and a newly-extracted creative are the same fact ("no current tag row"), so they must not be
  two code paths that can disagree, and a scheduled reconciler is self-healing against a lost
  enqueue in a way an on-write hook is not. Gated on `creative_features` having a **current**,
  non-stale row with `semantic_frame_paths is not null` — tagging cannot run ahead of frames
  that do not exist yet.

### 6. What gets statistically tested, and what does not

`has_people_on_screen` is boolean and joins `ANALYSIS_FEATURES` exactly like
`text_in_first_2s` — 0/1 through the same van Elteren + Benjamini-Hochberg pipeline UC-5
already built, with zero new statistics code. `hook_type` and `tone` are small unordered
categories; forcing them through a rank test would assume an ordering that does not exist
("testimonial" is not more or less than "demo"). They are surfaced as a descriptive
distribution per cohort — counted, captioned with their n, never given a p-value — and a
chi-square/Fisher test over them is named explicitly as future work (same posture as UC-5's
"Kaplan-Meier once n supports it": honest about what v1 does not attempt, rather than silently
misapplying the tool it already has).

## Data model

**`creative_features`** (migration) gains `semantic_frame_paths text[]` — nullable, same
lifecycle as `poster_storage_path`.

**`creative_semantic_tags`** (new table, `workspace_id` + RLS, same posture as
`creative_features`):

| Column | Notes |
|---|---|
| `schema_version` | pins the prompt/taxonomy version |
| `has_people_on_screen` | boolean, nullable |
| `hook_type` | text, check-constrained to a fixed small set, nullable |
| `tone` | text, check-constrained to a fixed small set, nullable |
| `skipped_tags` | `text[]`, mirrors `skipped_features` |
| `raw_response` | `jsonb`, the unparsed VLM output — land raw, parse later |
| `vlm_provider`, `vlm_model` | provenance, mirrors `extractor_version` |
| `is_stale` | set on a schema-version bump, row stays readable |
| `trace_id`, `created_at`, `updated_at` | standard |

`unique (creative_id, schema_version)` — same key shape as `creative_features`, same reason:
keeping the superseded row is what makes a taxonomy change auditable.

## Rules

1. Frame sampling reuses the existing decode pass — no second video read.
2. Extraction of tags is best-effort per field: a field the model would not commit to is
   `null` plus a `skipped_tags` entry, never a guess and never a failed job.
3. The raw VLM response is stored before parsing (rule 2's "land raw" applied to a model call).
4. Tag once per `(creative_id, schema_version)` — cost discipline, not just idempotency.
5. `has_people_on_screen` is the only tag correlated in v1; `hook_type`/`tone` are descriptive
   only, and the page says so next to them.
6. Never call it performance (`CLAUDE.md` rule 7) — a tag describes content, not outcome, and
   the copy layer is checked for the same banned vocabulary as UC-5 and UC-7.
7. Every number ships with its n (`CLAUDE.md` rule 8) — the descriptive breakdown states how
   many creatives in each cohort carry each tag value, and how many are untagged.

## Acceptance criteria

- [ ] A decodable video yields three frame paths on `creative_features`; an undecodable one
      yields null frames and a `skipped_features` entry, same job outcome as today
- [ ] A `semantic_tag` job calls the VLM once, stores the raw response, and writes typed
      columns derived from it
- [ ] A field the model declines lands as null with a `skipped_tags` entry, not a guess
- [ ] Re-running `semantic_tag` for an already-tagged creative at the current version is a
      no-op (no second VLM call)
- [ ] Bumping `SEMANTIC_SCHEMA_VERSION` marks existing rows stale and the reconciler
      re-enqueues them
- [ ] `has_people_on_screen` appears in the UC-5 contrast output with n, effect size and q,
      exactly like the existing boolean feature
- [ ] `hook_type`/`tone` render as a captioned distribution per cohort, with no p-value and no
      q-value attached
- [ ] No string the copy layer can emit for a tag implies performance
- [ ] Tenant isolation: `creative_semantic_tags` carries RLS, proved via `asAuthenticated`

## Test plan

| What | Fixture | Expected |
|---|---|---|
| Frame sampling happy path | known fixture video | 3 frame paths, all resolve in Storage |
| Frame sampling failure | corrupt/unreadable media | null paths, `skipped_features` entry, job not failed |
| VLM happy path | fixture provider, full response | 3 tags populated, raw response stored |
| VLM partial decline | fixture provider, one field "unclear" | that field null + `skipped_tags`, others populated |
| Idempotency | tag twice at the same schema version | second run makes no provider call |
| Schema bump | bump version, re-run reconciler | prior row stale, new job enqueued |
| Contrast integration | panel with a mix of `has_people_on_screen` | same van Elteren/BH pipeline, q-value present |
| Descriptive tags | panel with mixed `hook_type` | per-cohort counts sum to tagged n, no p/q rendered |
| Banned vocabulary | every string the tag copy layer can emit | no performance word |
| Isolation | two workspaces | no cross-read on `creative_semantic_tags` |

**Quick CLI check:**
```bash
psql -c "select schema_version, count(*), count(has_people_on_screen), count(hook_type), count(tone)
         from creative_semantic_tags group by schema_version;"
```

## Upgrade path

- Chi-square/Fisher's exact for `hook_type`/`tone` once there is a reason to test them rather
  than just report them.
- Per-tag confidence, if the fixed taxonomy proves too coarse.
- A second VLM provider behind the same adapter, for cost or quality comparison — the adapter
  exists specifically so this is a config change, not a rewrite.
