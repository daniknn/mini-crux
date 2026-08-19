import type { Actor, TraceId } from '@mini-crux/core'
import { appendAuditEvent, type SqlExecutor } from '@mini-crux/db'

import type { MediaUrlSigner } from './media-urls.ts'
import {
  HOOK_TYPES,
  ProviderError,
  TONES,
  type HookType,
  type Tone,
  type VlmProvider,
  type VlmRawResponse,
} from './providers/vlm/index.ts'

/**
 * UC-8's job: tag one creative's frames and transcript, land the raw model response, parse it
 * tolerantly, store once.
 *
 * TAG ONCE PER (creative_id, schema_version) — COST DISCIPLINE, NOT JUST IDEMPOTENCY
 *
 * `runCrawl`/`runParse`/`runProxyValidation` all guard against a *duplicate write*; a
 * redelivered crawl re-hits the provider too, but a wasted Apify call is cheap and the crawl
 * clock (rule 1) makes retrying non-optional anyway. A VLM call is different: it is a paid
 * call per creative, and nothing about tagging is time-sensitive the way a daily crawl is. So
 * this job checks `creative_semantic_tags` for an existing `(creative_id, schema_version)` row
 * *before* calling the provider, not just before writing — the ordinary idempotency check
 * happens too late to save the call it exists to avoid.
 *
 * WHICH IDEMPOTENCY SHAPE THIS IS (see `proxy-validation.ts`'s own note on the same question)
 *
 * `creative_semantic_tags` carries a real unique key — `unique (creative_id, schema_version)`,
 * migration 0012 — the same shape as `proxy_validation_ads`'s `(workspace_id, ad_archive_id)`.
 * That means it belongs to the "naturally idempotent" category: a query-based precheck plus
 * `insert … on conflict do nothing` as the race-safety net, not `withIdempotency`'s
 * `processed_messages` ledger. The ledger is for append-only tables with no natural key
 * (`proxy_validation_runs`, `analysis_runs`); this table is the opposite of append-only by
 * design — migration 0012's comment: a row is written once per version and only ever mutated
 * by flipping `is_stale`, never replaced in place.
 *
 * LAND RAW, PARSE LATER — APPLIED TO A MODEL RESPONSE (rule 2, spec §3)
 *
 * `provider.tagCreative` returns the HTTP response body verbatim; `raw_response` stores that
 * verbatim before a single typed column is derived from it. A parsing bug found next month is
 * then a reprocess against a stored column, not a second, paid call to OpenAI — the same
 * asymmetry `normalizeAd` is split from `AdLibraryProvider.crawl()` for.
 *
 * NEVER A GUESS AND NEVER A FAILED JOB (spec rule 2)
 *
 * `parseTagResponse` cannot throw. Malformed JSON, a missing `choices[0].message.content`, a
 * field set to `"unclear"` or omitted or the wrong type — every one of those degrades to that
 * field landing `null` with an entry in `skipped_tags`, never a guessed value and never an
 * exception that would fail the job over a shape OpenAI is free to change without warning.
 */

/** The `jobs.type` this handler answers to. */
export const SEMANTIC_TAG_JOB_TYPE = 'semantic_tag'

/**
 * Bumps only when the prompt or taxonomy changes (migration 0012's own note) — never when the
 * model provider changes without changing what is asked of it. Re-tagging the whole panel
 * after a bump costs one VLM call per creative (rule 4), so this is not a knob to turn lightly.
 */
export const SEMANTIC_SCHEMA_VERSION = 1

export interface SemanticTagDeps {
  /** MUST be a BYPASSRLS worker connection — every handler in this system writes cross-tenant. */
  db: SqlExecutor
  provider: VlmProvider
  mediaUrlSigner: MediaUrlSigner
}

export interface RunSemanticTagInput {
  workspaceId: string
  traceId: TraceId
  actor: Actor
  creativeId: string
  /** Defaults to {@link SEMANTIC_SCHEMA_VERSION} — a job payload can pin an older version. */
  schemaVersion?: number
}

export type RunSemanticTagOutcome =
  | { status: 'tagged'; tagId: string; skippedTags: string[] }
  /** A row for this `(creative_id, schema_version)` already existed — no VLM call was made. */
  | { status: 'already-tagged'; tagId: string }

export async function runSemanticTag(
  deps: SemanticTagDeps,
  input: RunSemanticTagInput,
): Promise<RunSemanticTagOutcome> {
  const schemaVersion = input.schemaVersion ?? SEMANTIC_SCHEMA_VERSION

  // The precheck the whole module doc comment is about: before anything that costs money.
  const existing = await currentTagRow(deps.db, input.creativeId, schemaVersion)
  if (existing !== null) return { status: 'already-tagged', tagId: existing }

  const features = await loadTaggableFeatures(deps.db, input.workspaceId, input.creativeId)
  if (features === null) {
    // The reconciler (`app.enqueue_pending_semantic_tags`, migration 0012) only enqueues a
    // creative once its features are current and carry frame paths — reaching here means a
    // race (features went stale, or re-extraction is mid-flight) between enqueue and run.
    // Plain `Error`, not a permanent one: the same creative is very likely taggable on the
    // worker's own retry a few minutes later, once the race resolves.
    throw new Error(
      `semantic_tag: creative ${input.creativeId} has no current creative_features row with ` +
        'semantic_frame_paths; cannot tag ahead of frames that do not exist yet.',
    )
  }

  const signed = await deps.mediaUrlSigner.sign(features.framePaths)
  const frameUrls = features.framePaths
    .map((path) => signed.get(path))
    .filter((url): url is string => url !== undefined)

  if (frameUrls.length === 0) {
    // Distinct from `VlmProvider.tagCreative`'s own empty-frames refusal: that one guards a
    // caller bug (no frame paths at all — never reachable here, `loadTaggableFeatures` already
    // required at least one). This is Storage failing to sign paths that do exist, which is
    // exactly the kind of transient failure a retry is for.
    throw new Error(
      `semantic_tag: none of creative ${input.creativeId}'s ${features.framePaths.length} frame ` +
        'path(s) could be signed; Storage may be unreachable.',
    )
  }

  let raw: VlmRawResponse
  try {
    raw = await deps.provider.tagCreative({ frameUrls, transcript: features.fullTranscript })
  } catch (error) {
    throw error instanceof ProviderError
      ? new Error(`VLM tagCreative failed for creative ${input.creativeId}: ${error.message}`, {
          cause: error,
        })
      : error
  }

  const parsed = parseTagResponse(raw)

  const tagId = await insertSemanticTag(deps.db, {
    workspaceId: input.workspaceId,
    creativeId: input.creativeId,
    schemaVersion,
    traceId: input.traceId,
    provider: deps.provider.name,
    raw,
    parsed,
  })

  // A race lost against another worker tagging the same creative: the row already exists,
  // there is nothing new to audit, and the VLM call this attempt paid for is the acceptable
  // cost of the race — same trade `upsertProxyValidationAd`'s unique key accepts.
  if (tagId === null) {
    const raced = await currentTagRow(deps.db, input.creativeId, schemaVersion)
    if (raced === null) {
      throw new Error(
        `semantic_tag: insert for creative ${input.creativeId} conflicted but no row was found ` +
          'on re-read — this should be unreachable.',
      )
    }
    return { status: 'already-tagged', tagId: raced }
  }

  await appendAuditEvent(deps.db, {
    workspaceId: input.workspaceId,
    traceId: input.traceId,
    actor: input.actor,
    type: 'creative.semantic_tagged',
    subjectType: 'creative_semantic_tags',
    subjectId: tagId,
    payload: {
      creative_id: input.creativeId,
      schema_version: schemaVersion,
      vlm_provider: deps.provider.name,
      vlm_model: parsed.vlmModel,
      skipped_tags: parsed.skippedTags,
    },
  })

  return { status: 'tagged', tagId, skippedTags: parsed.skippedTags }
}

async function currentTagRow(
  db: SqlExecutor,
  creativeId: string,
  schemaVersion: number,
): Promise<string | null> {
  const rows = await db.query<{ id: string }>(
    `select id from public.creative_semantic_tags
     where creative_id = $1 and schema_version = $2`,
    [creativeId, schemaVersion],
  )
  return rows[0]?.id ?? null
}

interface TaggableFeatures {
  framePaths: string[]
  fullTranscript: string | null
}

/**
 * The current, non-stale features row's frame paths and transcript — the same "current row"
 * definition `app.enqueue_pending_semantic_tags` uses (`not is_stale`), so a job dispatched by
 * the reconciler and a job run by hand agree on which features row is authoritative.
 */
async function loadTaggableFeatures(
  db: SqlExecutor,
  workspaceId: string,
  creativeId: string,
): Promise<TaggableFeatures | null> {
  const rows = await db.query<{
    semantic_frame_paths: string[] | null
    full_transcript: string | null
  }>(
    `select semantic_frame_paths, full_transcript
     from public.creative_features
     where workspace_id = $1 and creative_id = $2 and not is_stale
     order by extracted_at desc
     limit 1`,
    [workspaceId, creativeId],
  )
  const row = rows[0]
  if (row === undefined) return null
  if (row.semantic_frame_paths === null || row.semantic_frame_paths.length === 0) return null

  return { framePaths: row.semantic_frame_paths, fullTranscript: row.full_transcript }
}

interface ParsedTags {
  hasPeopleOnScreen: boolean | null
  hookType: HookType | null
  tone: Tone | null
  skippedTags: string[]
  /** Echoed back from the response body's own `model` field, when present — provenance without
   *  widening {@link VlmProvider.tagCreative}'s interface beyond what the spec declares. */
  vlmModel: string | null
}

const ALL_TAG_FIELDS = ['has_people_on_screen', 'hook_type', 'tone'] as const

/**
 * Maximally tolerant on purpose (module doc comment: never a failed job). Every branch that
 * cannot confidently produce a typed value degrades to `null` plus a `skipped_tags` entry
 * instead of throwing — including a raw response this function cannot make any sense of at
 * all, which skips all three fields rather than guessing at any of them.
 */
function parseTagResponse(raw: VlmRawResponse): ParsedTags {
  const vlmModel = isRecord(raw) && typeof raw['model'] === 'string' ? raw['model'] : null
  const candidate = extractCandidate(raw)

  if (candidate === null) {
    return {
      hasPeopleOnScreen: null,
      hookType: null,
      tone: null,
      skippedTags: [...ALL_TAG_FIELDS],
      vlmModel,
    }
  }

  const skippedTags: string[] = []

  const hasPeopleOnScreen = readBoolean(candidate, 'has_people_on_screen')
  if (hasPeopleOnScreen === null) skippedTags.push('has_people_on_screen')

  const hookType = readEnum(candidate, 'hook_type', HOOK_TYPES)
  if (hookType === null) skippedTags.push('hook_type')

  const tone = readEnum(candidate, 'tone', TONES)
  if (tone === null) skippedTags.push('tone')

  return { hasPeopleOnScreen, hookType, tone, skippedTags, vlmModel }
}

/**
 * The object the three tag fields are read from — tolerant of two shapes on purpose, because
 * `VlmRawResponse` is `unknown` per provider (rule 11: the adapter, not this job, knows what a
 * given provider's wire format looks like):
 *
 * 1. OpenAI's chat-completions envelope, where the answer is a JSON *string* one level down at
 *    `choices[0].message.content` (the real `createOpenAiVlmProvider`).
 * 2. The answer already sitting at the top level as an object (the fixture provider's `raw`,
 *    and any future provider whose SDK hands back parsed JSON directly rather than a chat
 *    completion to fish a string out of).
 *
 * Falling through to "raw itself, if it is a record" rather than failing outright also means a
 * response that has *some* record shape but not the OpenAI envelope (case 3 in the tests below:
 * `{ choices: [] }`) still reaches the per-field readers, which correctly find none of the
 * three keys and skip all three — the same outcome as failing closed, without a separate branch.
 */
function extractCandidate(raw: VlmRawResponse): Record<string, unknown> | null {
  const content = extractContent(raw)
  if (content !== null) {
    const parsed = tryParseJson(content)
    return isRecord(parsed) ? parsed : null
  }
  return isRecord(raw) ? raw : null
}

/** `choices[0].message.content` — tolerant of any shape drift short of that path existing. */
function extractContent(raw: VlmRawResponse): string | null {
  if (!isRecord(raw)) return null
  const choices = raw['choices']
  if (!Array.isArray(choices) || choices.length === 0) return null
  const first = choices[0]
  if (!isRecord(first)) return null
  const message = first['message']
  if (!isRecord(message)) return null
  const content = message['content']
  return typeof content === 'string' ? content : null
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** `true`/`false` only. `"unclear"`, `undefined`, or any other shape is a decline, not a guess. */
function readBoolean(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key]
  return typeof value === 'boolean' ? value : null
}

function readEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | null {
  const value = record[key]
  if (typeof value !== 'string') return null
  return (allowed as readonly string[]).includes(value) ? (value as T) : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface InsertTagArgs {
  workspaceId: string
  creativeId: string
  schemaVersion: number
  traceId: TraceId
  provider: string
  raw: VlmRawResponse
  parsed: ParsedTags
}

/**
 * `on conflict … do nothing`: the belt to `currentTagRow`'s braces. A race between two workers
 * tagging the same creative is rare (the reconciler's `not exists` guard against a
 * pending/running job already narrows it) but not impossible, and this is what keeps it from
 * violating the unique constraint instead of being handled.
 */
async function insertSemanticTag(db: SqlExecutor, args: InsertTagArgs): Promise<string | null> {
  const rows = await db.query<{ id: string }>(
    `insert into public.creative_semantic_tags
       (workspace_id, creative_id, schema_version, has_people_on_screen, hook_type, tone,
        skipped_tags, raw_response, vlm_provider, vlm_model, trace_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (creative_id, schema_version) do nothing
     returning id`,
    [
      args.workspaceId,
      args.creativeId,
      args.schemaVersion,
      args.parsed.hasPeopleOnScreen,
      args.parsed.hookType,
      args.parsed.tone,
      args.parsed.skippedTags,
      JSON.stringify(args.raw),
      args.provider,
      args.parsed.vlmModel,
      args.traceId,
    ],
  )
  return rows[0]?.id ?? null
}
