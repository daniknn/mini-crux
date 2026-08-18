import type { Actor, TraceId } from '@mini-crux/core'
import type { SqlExecutor } from '@mini-crux/db'
import { appendAuditEvent, enqueueJob } from '@mini-crux/db'

import type { AdLibraryProvider, CrawlQuery } from './providers/ad-library/index.ts'
import { ProviderError } from './providers/ad-library/index.ts'
import type { ObjectStore } from './storage.ts'
import { SNAPSHOT_SCHEMA_VERSION, SnapshotExistsError, putSnapshot, snapshotPath } from './storage.ts'

/**
 * The crawl half of UC-1: call the provider, land the payload, hand off to parse.
 *
 * This function deliberately writes NO panel rows. Its only durable outputs are the
 * snapshot in Storage and the state of the `crawl_runs` row. That split is what makes
 * CLAUDE.md rule 2 real — parsing runs against stored bytes, so a parser bug is fixed by
 * re-running parse, never by crawling Meta a second time for a day that has already moved.
 */

/** Below this share of the previous run's volume, the payload is treated as truncated. */
export const SUSPECT_VOLUME_RATIO = 0.5

/** Attempts within the same day. A missed day is unrecoverable, so failing fast is wrong. */
export const MAX_CRAWL_ATTEMPTS = 3

export interface CrawlRunRow {
  id: string
  workspace_id: string
  watchlist_id: string
  run_date: string
  status: string
  trace_id: string
  actor: Actor
  raw_storage_path: string | null
  kind: 'keyword' | 'page'
  query: string
  country: string
}

export interface CrawlDeps {
  /** MUST be a BYPASSRLS worker connection: the crawl writes across the whole tenant set. */
  db: SqlExecutor
  store: ObjectStore
  provider: AdLibraryProvider
  /** Injected so tests can control the panel's clock without faking timers globally. */
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  /** A failed crawl is a P0 alert, not a silent retry (UC-1 §Failure handling). */
  onAlert?: (alert: CrawlAlert) => void | Promise<void>
}

export interface CrawlAlert {
  severity: 'p0'
  crawlRunId: string
  workspaceId: string
  watchlistId: string
  runDate: string
  traceId: TraceId
  message: string
}

export interface RunCrawlInput {
  crawlRunId: string
  maxAttempts?: number
}

export type RunCrawlOutcome =
  | { status: 'landed'; snapshotPath: string; resultCount: number; parseMessageId: string }
  | { status: 'already-landed'; snapshotPath: string }
  | { status: 'failed'; error: string }

export async function runCrawl(
  deps: CrawlDeps,
  input: RunCrawlInput,
): Promise<RunCrawlOutcome> {
  // A provider that carries an authenticated Meta session would invalidate the legal
  // posture the whole product rests on (ARCHITECTURE.md §9). Checked here, at the only
  // place a provider is ever invoked, rather than trusted to code review.
  if (deps.provider.collectionMode !== 'logged-off') {
    throw new Error(
      `Provider "${deps.provider.name}" does not declare logged-off collection. ` +
        'Scraping with an authenticated session is prohibited (ARCHITECTURE.md §9).',
    )
  }

  const now = deps.now ?? (() => new Date())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const maxAttempts = input.maxAttempts ?? MAX_CRAWL_ATTEMPTS

  const run = await loadCrawlRun(deps.db, input.crawlRunId)
  const traceId = run.trace_id as TraceId

  // Redelivery: the snapshot is already on disk, so re-crawling would both cost money and
  // replace a good payload with a different one. Storage is the source of truth here.
  if (run.raw_storage_path !== null) {
    return { status: 'already-landed', snapshotPath: run.raw_storage_path }
  }

  const query: CrawlQuery = { kind: run.kind, query: run.query, country: run.country }

  let lastError: ProviderError | Error | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await deps.provider.crawl(query)
      const path = snapshotPath({
        workspaceId: run.workspace_id,
        watchlistId: run.watchlist_id,
        runDate: run.run_date,
        crawlRunId: run.id,
      })

      // Land raw BEFORE anything else touches the payload (CLAUDE.md rule 2).
      try {
        await putSnapshot(deps.store, path, {
          schema_version: SNAPSHOT_SCHEMA_VERSION,
          trace_id: traceId,
          actor: run.actor,
          workspace_id: run.workspace_id,
          watchlist_id: run.watchlist_id,
          crawl_run_id: run.id,
          run_date: run.run_date,
          provider: deps.provider.name,
          provider_run_id: result.providerRunId,
          captured_at: now().toISOString(),
          payload: result.raw,
        })
      } catch (error) {
        // A snapshot already at this path means a previous attempt landed it and only the
        // bookkeeping failed. Immutability holds; carry on and record the path.
        if (!(error instanceof SnapshotExistsError)) throw error
      }

      const previousCount = await previousResultCount(deps.db, run.watchlist_id, run.id)

      await deps.db.query(
        `update public.crawl_runs
           set attempt = $2, apify_run_id = $3, raw_storage_path = $4,
               result_count = $5, previous_count = $6
         where id = $1`,
        [run.id, attempt, result.providerRunId, path, result.ads.length, previousCount],
      )

      // Parse is a separate job so a slow parse cannot hold the crawl's retry budget, and
      // so a parser fix can be replayed against these exact bytes.
      const enqueued = await enqueueJob(deps.db, {
        workspaceId: run.workspace_id,
        type: 'parse',
        traceId,
        actor: run.actor,
        payload: { crawl_run_id: run.id, snapshot_path: path },
      })

      await appendAuditEvent(deps.db, {
        workspaceId: run.workspace_id,
        traceId,
        actor: run.actor,
        type: 'crawl.landed',
        subjectType: 'crawl_run',
        subjectId: run.id,
        payload: {
          provider: deps.provider.name,
          provider_run_id: result.providerRunId,
          snapshot_path: path,
          result_count: result.ads.length,
          previous_count: previousCount,
          attempt,
        },
      })

      return {
        status: 'landed',
        snapshotPath: path,
        resultCount: result.ads.length,
        parseMessageId: enqueued.messageId,
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      // A non-retryable provider error (bad actor id, malformed input) will fail
      // identically on every attempt; burning the budget on it only delays the alert.
      if (error instanceof ProviderError && !error.retryable) break
      if (attempt < maxAttempts) await sleep(backoffMs(attempt))
    }
  }

  const message = lastError?.message ?? 'crawl failed for an unknown reason'
  await failCrawlRun(deps, run, traceId, message)
  return { status: 'failed', error: message }
}

/**
 * Record the day as a known gap.
 *
 * Note what this does NOT do: it writes no observations, not even absences. A day we
 * failed to crawl must stay distinguishable from a day on which creatives genuinely
 * disappeared (UC-1 rule 2) — otherwise every outage would be recorded as a mass death.
 */
async function failCrawlRun(
  deps: CrawlDeps,
  run: CrawlRunRow,
  traceId: TraceId,
  message: string,
): Promise<void> {
  const now = deps.now ?? (() => new Date())

  await deps.db.query(
    `update public.crawl_runs
       set status = 'failed', error = $2, finished_at = $3
     where id = $1`,
    [run.id, message, now().toISOString()],
  )

  await appendAuditEvent(deps.db, {
    workspaceId: run.workspace_id,
    traceId,
    actor: run.actor,
    type: 'crawl.failed',
    subjectType: 'crawl_run',
    subjectId: run.id,
    payload: { error: message, run_date: run.run_date },
  })

  await deps.onAlert?.({
    severity: 'p0',
    crawlRunId: run.id,
    workspaceId: run.workspace_id,
    watchlistId: run.watchlist_id,
    runDate: run.run_date,
    traceId,
    message,
  })
}

/** 2s, 8s. Bounded by design: the retries must finish inside the same panel date. */
function backoffMs(attempt: number): number {
  return 2000 * 4 ** (attempt - 1)
}

async function loadCrawlRun(db: SqlExecutor, crawlRunId: string): Promise<CrawlRunRow> {
  const rows = await db.query<CrawlRunRow>(
    `select r.id, r.workspace_id, r.watchlist_id, r.run_date::text as run_date, r.status,
            r.trace_id, r.actor, r.raw_storage_path,
            w.kind, w.query, w.country
     from public.crawl_runs r
     join public.watchlists w on w.id = r.watchlist_id
     where r.id = $1`,
    [crawlRunId],
  )
  const run = rows[0]
  if (run === undefined) throw new Error(`No crawl_run with id ${crawlRunId}`)
  return run
}

/**
 * Volume of the most recent run for this watchlist that actually produced a payload.
 *
 * Failed runs are excluded on purpose: comparing today against a failed day (count null,
 * or zero) would make every recovery look either suspect or spectacular.
 */
async function previousResultCount(
  db: SqlExecutor,
  watchlistId: string,
  excludeRunId: string,
): Promise<number | null> {
  const rows = await db.query<{ result_count: number | null }>(
    `select result_count
     from public.crawl_runs
     where watchlist_id = $1
       and id <> $2
       and result_count is not null
       and status <> 'failed'
     order by run_date desc
     limit 1`,
    [watchlistId, excludeRunId],
  )
  return rows[0]?.result_count ?? null
}

/**
 * Is this payload plausible next to the previous one?
 *
 * A truncated crawl looks exactly like a day on which most of an advertiser's ads stopped.
 * We cannot tell them apart from the payload alone, so we refuse to guess: a suspiciously
 * small run still records everything it DID see, but is never allowed to assert an absence.
 * Fabricated deaths would corrupt the one variable the product exists to measure.
 */
export function classifyRun(
  resultCount: number,
  previousCount: number | null,
): 'succeeded' | 'suspect' {
  if (previousCount === null || previousCount === 0) return 'succeeded'
  return resultCount < previousCount * SUSPECT_VOLUME_RATIO ? 'suspect' : 'succeeded'
}
