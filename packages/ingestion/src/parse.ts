import type { Actor, MessageId, TraceId } from '@mini-crux/core'
import type { SqlExecutor } from '@mini-crux/db'
import { appendAuditEvent, withIdempotency } from '@mini-crux/db'

import { classifyRun } from './crawl.ts'
import { creativeIdentityFromAd } from './creative-hash.ts'
import type { AdLibraryAd } from './providers/ad-library/index.ts'
import { normalizeAd } from './providers/ad-library/index.ts'
import type { ObjectStore } from './storage.ts'
import { getSnapshot } from './storage.ts'

/**
 * The parse half of UC-1: stored bytes in, panel rows out.
 *
 * Everything here reads from Storage, never from the network. Re-running parse against the
 * same snapshot must produce the same rows, which is what makes a parser bug a recoverable
 * mistake rather than a lost day.
 */

export interface ParseDeps {
  /** MUST be a BYPASSRLS worker connection. */
  db: SqlExecutor
  store: ObjectStore
  now?: () => Date
}

export interface RunParseInput {
  crawlRunId: string
  /** The parse job's `message_id`. Guards the panel against double-writing on redelivery. */
  messageId: MessageId
  jobId?: string
}

export interface ParseSummary {
  status: 'succeeded' | 'suspect'
  creatives: number
  present: number
  absent: number
  /** Set when the run was suspect: absences were withheld rather than written. */
  withheldAbsences: number
}

export type RunParseOutcome =
  | ({ applied: true } & ParseSummary)
  | { applied: false; reason: 'already-processed' }

interface ParseRunRow {
  id: string
  workspace_id: string
  watchlist_id: string
  run_date: string
  status: string
  trace_id: string
  actor: Actor
  raw_storage_path: string | null
  previous_count: number | null
}

/** Ads collapsed onto one creative. The panel counts creatives, never archive ids. */
interface CreativeGroup {
  hash: string
  advertiserKey: string
  pageName: string
  adArchiveIds: string[]
  mediaType: AdLibraryAd['mediaType']
  mediaUrl: string | null
  adCopy: string | null
  publisherPlatforms: string[]
  variantCount: number
  adDeliveryStartTime: string | null
}

export async function runParse(
  deps: ParseDeps,
  input: RunParseInput,
): Promise<RunParseOutcome> {
  const now = deps.now ?? (() => new Date())
  const run = await loadRun(deps.db, input.crawlRunId)
  const traceId = run.trace_id as TraceId

  if (run.raw_storage_path === null) {
    throw new Error(
      `crawl_run ${run.id} has no snapshot; parse must never run before raw is landed.`,
    )
  }

  const envelope = await getSnapshot(deps.store, run.raw_storage_path)
  if (envelope === null) {
    throw new Error(`Snapshot missing at ${run.raw_storage_path} for crawl_run ${run.id}`)
  }

  const ads = extractAds(envelope.payload)
  const verdict = classifyRun(ads.length, run.previous_count)

  // The ledger row and every panel write share one transaction (DashOne §3). A crash
  // between them would otherwise either replay the day or suppress one that never landed.
  const outcome = await withIdempotency(
    deps.db,
    {
      messageId: input.messageId,
      workspaceId: run.workspace_id,
      traceId,
      ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
    },
    async (tx) => writePanel(tx, run, traceId, ads, verdict, now()),
  )

  if (!outcome.applied) return { applied: false, reason: 'already-processed' }

  const summary = outcome.result!
  await appendAuditEvent(deps.db, {
    workspaceId: run.workspace_id,
    traceId,
    actor: run.actor,
    type: verdict === 'suspect' ? 'crawl.suspect' : 'crawl.parsed',
    subjectType: 'crawl_run',
    subjectId: run.id,
    payload: {
      run_date: run.run_date,
      creatives: summary.creatives,
      present: summary.present,
      absent: summary.absent,
      withheld_absences: summary.withheldAbsences,
      previous_count: run.previous_count,
    },
  })

  return { applied: true, ...summary }
}

async function writePanel(
  tx: SqlExecutor,
  run: ParseRunRow,
  traceId: TraceId,
  ads: AdLibraryAd[],
  verdict: 'succeeded' | 'suspect',
  observedAt: Date,
): Promise<ParseSummary> {
  const groups = groupIntoCreatives(ads)
  const presentCreativeIds = new Set<string>()

  for (const group of groups) {
    const advertiserId = await upsertAdvertiser(tx, run.workspace_id, group)
    const creativeId = await upsertCreative(tx, run.workspace_id, advertiserId, group, observedAt)
    presentCreativeIds.add(creativeId)

    await tx.query(
      `insert into public.creative_observations
         (workspace_id, creative_id, crawl_run_id, observed_at, is_present, variant_count)
       values ($1, $2, $3, $4, true, $5)
       on conflict (creative_id, crawl_run_id) do nothing`,
      [run.workspace_id, creativeId, run.id, observedAt.toISOString(), group.variantCount],
    )
  }

  // Creatives whose latest observation on this watchlist said "present". Using the latest
  // observation rather than literally the previous run means a failed day in between does
  // not resurrect a creative that had already disappeared.
  const previouslyPresent = await tx.query<{ creative_id: string }>(
    `select distinct on (o.creative_id) o.creative_id, o.is_present
     from public.creative_observations o
     join public.crawl_runs r on r.id = o.crawl_run_id
     where r.watchlist_id = $1 and o.crawl_run_id <> $2
     order by o.creative_id, o.observed_at desc, o.id desc`,
    [run.watchlist_id, run.id],
  )
  const missing = previouslyPresent
    .filter((row) => !presentCreativeIds.has(row.creative_id))
    .map((row) => row.creative_id)

  let absent = 0

  // The suspect guard. A truncated payload is indistinguishable from a real die-off, so a
  // suspect run is allowed to say "these existed" but never "these are gone".
  if (verdict === 'succeeded') {
    for (const creativeId of missing) {
      await tx.query(
        `insert into public.creative_observations
           (workspace_id, creative_id, crawl_run_id, observed_at, is_present, variant_count)
         values ($1, $2, $3, $4, false, 0)
         on conflict (creative_id, crawl_run_id) do nothing`,
        [run.workspace_id, creativeId, run.id, observedAt.toISOString()],
      )
      absent += 1
    }
  }

  await tx.query(
    `update public.crawl_runs set status = $2, finished_at = $3 where id = $1`,
    [run.id, verdict, observedAt.toISOString()],
  )

  return {
    status: verdict,
    creatives: groups.length,
    present: presentCreativeIds.size,
    absent,
    withheldAbsences: verdict === 'suspect' ? missing.length : 0,
  }
}

/**
 * Collapse ads onto creatives.
 *
 * The hash cannot be computed before the advertiser row exists (it is part of the key), so
 * grouping keys on `pageId` first and the real hash is derived per group afterwards.
 */
function groupIntoCreatives(ads: AdLibraryAd[]): CreativeGroup[] {
  const groups = new Map<string, CreativeGroup>()

  for (const ad of ads) {
    // Provisional key: the identity function needs an advertiser id we do not have yet,
    // but page id maps one-to-one onto advertiser, so it partitions identically.
    const identity = creativeIdentityFromAd(ad, ad.pageId)
    const existing = groups.get(identity.hash)

    if (existing === undefined) {
      groups.set(identity.hash, {
        hash: identity.hash,
        advertiserKey: ad.pageId,
        pageName: ad.pageName,
        adArchiveIds: [ad.adArchiveId],
        mediaType: ad.mediaType,
        mediaUrl: ad.mediaUrl,
        adCopy: ad.adCopy,
        publisherPlatforms: [...ad.publisherPlatforms],
        variantCount: ad.variantCount,
        adDeliveryStartTime: ad.adDeliveryStartTime,
      })
      continue
    }

    if (!existing.adArchiveIds.includes(ad.adArchiveId)) {
      existing.adArchiveIds.push(ad.adArchiveId)
      // Variants are per archive id; the creative's count is their sum, which is the
      // point of deduping — one asset collated across many ads is one row, many variants.
      existing.variantCount += ad.variantCount
    }
    for (const platform of ad.publisherPlatforms) {
      if (!existing.publisherPlatforms.includes(platform)) {
        existing.publisherPlatforms.push(platform)
      }
    }
    // Meta's own start date, earliest wins. Never our own first-seen (CLAUDE.md rule 5).
    if (
      ad.adDeliveryStartTime !== null &&
      (existing.adDeliveryStartTime === null ||
        ad.adDeliveryStartTime < existing.adDeliveryStartTime)
    ) {
      existing.adDeliveryStartTime = ad.adDeliveryStartTime
    }
  }

  // Sorted so a reprocess writes rows in a deterministic order.
  return [...groups.values()].sort((a, b) => a.hash.localeCompare(b.hash))
}

async function upsertAdvertiser(
  tx: SqlExecutor,
  workspaceId: string,
  group: CreativeGroup,
): Promise<string> {
  const rows = await tx.query<{ id: string }>(
    `insert into public.advertisers (workspace_id, meta_page_id, name)
     values ($1, $2, $3)
     on conflict (workspace_id, meta_page_id)
       do update set name = excluded.name
     returning id`,
    [workspaceId, group.advertiserKey, group.pageName || group.advertiserKey],
  )
  return rows[0]!.id
}

async function upsertCreative(
  tx: SqlExecutor,
  workspaceId: string,
  advertiserId: string,
  group: CreativeGroup,
  observedAt: Date,
): Promise<string> {
  const rows = await tx.query<{ id: string }>(
    `insert into public.creatives
       (workspace_id, advertiser_id, creative_hash, ad_archive_ids, media_type, media_url,
        ad_copy, publisher_platforms, ad_delivery_start_time, first_seen_at, last_seen_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
     on conflict (workspace_id, creative_hash) do update
       set ad_archive_ids = (
             select array(
               select distinct unnest(public.creatives.ad_archive_ids || excluded.ad_archive_ids)
               order by 1
             )
           ),
           publisher_platforms = (
             select array(
               select distinct
                 unnest(public.creatives.publisher_platforms || excluded.publisher_platforms)
               order by 1
             )
           ),
           -- Refreshed because the URL is signed and rotates; it is storage for UC-2's
           -- download, never an identity (see creative-hash.ts).
           media_url = excluded.media_url,
           -- least() ignores nulls, so a crawl that loses the field cannot erase a known
           -- start date, and an earlier start always wins.
           ad_delivery_start_time = least(
             public.creatives.ad_delivery_start_time,
             excluded.ad_delivery_start_time
           ),
           last_seen_at = excluded.last_seen_at
     returning id`,
    [
      workspaceId,
      advertiserId,
      group.hash,
      group.adArchiveIds,
      group.mediaType,
      group.mediaUrl,
      group.adCopy,
      group.publisherPlatforms,
      group.adDeliveryStartTime,
      observedAt.toISOString(),
    ],
  )
  return rows[0]!.id
}

/**
 * Pull the ad array back out of a landed envelope.
 *
 * Accepts both the normalized shape written by the fixture provider and a bare provider
 * array, because the whole point of landing raw is that a snapshot outlives the code that
 * wrote it. `normalizeAd` re-runs here rather than at crawl time so a normalization fix
 * can be replayed over months of stored payloads.
 */
export function extractAds(payload: unknown): AdLibraryAd[] {
  const items = Array.isArray(payload)
    ? payload
    : typeof payload === 'object' && payload !== null && Array.isArray((payload as { ads?: unknown }).ads)
      ? (payload as { ads: unknown[] }).ads
      : []

  return items
    .map((item) => (isNormalizedAd(item) ? item : normalizeAd(item)))
    .filter((ad): ad is AdLibraryAd => ad !== null)
}

function isNormalizedAd(value: unknown): value is AdLibraryAd {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AdLibraryAd).adArchiveId === 'string' &&
    typeof (value as AdLibraryAd).variantCount === 'number' &&
    Array.isArray((value as AdLibraryAd).publisherPlatforms)
  )
}

async function loadRun(db: SqlExecutor, crawlRunId: string): Promise<ParseRunRow> {
  const rows = await db.query<ParseRunRow>(
    `select id, workspace_id, watchlist_id, run_date::text as run_date, status,
            trace_id, actor, raw_storage_path, previous_count
     from public.crawl_runs
     where id = $1`,
    [crawlRunId],
  )
  const run = rows[0]
  if (run === undefined) throw new Error(`No crawl_run with id ${crawlRunId}`)
  return run
}
