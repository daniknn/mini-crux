import { isActor, isMessageId, type Actor, type MessageId, type TraceId } from '@mini-crux/core'
import { withIdempotency, type SqlExecutor } from '@mini-crux/db'
// Subpath, not the root barrel: `@mini-crux/db/analysis` is where UC-5 lives, and keeping it
// off the root is what stops every consumer of `fromPgClient` from also pulling in the stats
// package. The worker is the one process that legitimately wants both.
import { runAnalysis } from '@mini-crux/db/analysis'
import {
  runCrawl,
  runParse,
  runProxyValidation,
  type AdLibraryProvider,
  type ObjectStore,
  type WatchlistKind,
} from '@mini-crux/ingestion'

import { PermanentJobError } from './worker.ts'
import type { JobRow } from './store.ts'
import type { Handlers } from './worker.ts'

/**
 * Job type → the function that already does the work.
 *
 * Every handler here is an adapter: read the payload, validate it, call into code that is
 * covered elsewhere. The temptation is to let a handler "just" do one small thing inline;
 * resist it, because the inline thing is the one that ends up with no test.
 *
 * The chain, for reference, since it is the point of the UC:
 *
 *   cron → `crawl` job → runCrawl → (enqueues) `parse` job → runParse → panel
 *   cron → `analysis` job → runAnalysis → analysis_runs
 *   operator → `proxy_validation` job → runProxyValidation → proxy_validation_runs (UC-7)
 *
 * `runCrawl` already enqueues the parse job with the crawl's own `trace_id`, so the worker
 * does not chain anything itself. That is why the chaining assertion in the tests reads the
 * `jobs` table rather than a worker return value: the guarantee lives in `crawl.ts`, and a
 * test here that mocked it would prove nothing about production.
 *
 * `proxy_validation` has no cron entry (spec: a research instrument run deliberately, not a
 * daily tick) — it is enqueued by the `proxy-validation:once` operator CLI, same shape as
 * `crawl:once` enqueuing a `crawl` job by hand.
 */

export interface HandlerDeps {
  /** MUST be a BYPASSRLS worker connection — every handler writes across the tenant set. */
  db: SqlExecutor
  store: ObjectStore
  provider: AdLibraryProvider
}

/** Reads a required string out of a job payload, or refuses the job for good. */
function requiredString(job: JobRow, key: string): string {
  const value = job.payload[key]
  if (typeof value !== 'string' || value === '') {
    // Permanent on purpose. A payload missing its subject will be missing it on every
    // retry, and three attempts against a malformed row is three delays before anyone
    // sees the reason.
    throw new PermanentJobError(`${job.type} job ${job.id} has no ${key} in its payload`)
  }
  return value
}

function jobActor(job: JobRow): Actor {
  if (!isActor(job.actor)) {
    throw new PermanentJobError(`job ${job.id} has no valid actor`)
  }
  return job.actor
}

function jobMessageId(job: JobRow): MessageId {
  if (!isMessageId(job.messageId)) {
    throw new PermanentJobError(`job ${job.id} has a malformed message_id`)
  }
  return job.messageId
}

function jobWatchlistKind(job: JobRow, key: string): WatchlistKind {
  const value = requiredString(job, key)
  if (value !== 'keyword' && value !== 'page') {
    throw new PermanentJobError(`${job.type} job ${job.id} has invalid ${key} "${value}"`)
  }
  return value
}

/** Undefined when absent so `runProxyValidation` falls back to `DEFAULT_REACH_BOUND`. */
function jobReachBound(job: JobRow): 'min' | 'max' | undefined {
  const value = job.payload['reach_bound_used']
  if (value === undefined) return undefined
  if (value !== 'min' && value !== 'max') {
    throw new PermanentJobError(
      `${job.type} job ${job.id} has invalid reach_bound_used "${String(value)}"`,
    )
  }
  return value
}

export function createHandlers(deps: HandlerDeps): Handlers {
  return {
    async crawl(job: JobRow): Promise<void> {
      const crawlRunId = requiredString(job, 'crawl_run_id')

      // Not wrapped in `withIdempotency`: the crawl calls a provider over the network, and
      // holding a transaction open across that call would pin a connection for the length
      // of an Apify run. It has its own guard — `crawl_runs.status` — which returns
      // `already-landed` for a redelivery and is the stronger guarantee anyway, because it
      // survives the message ledger being cleared.
      const outcome = await runCrawl(
        { db: deps.db, store: deps.store, provider: deps.provider },
        { crawlRunId },
      )

      if (outcome.status === 'failed') {
        // Retryable. A provider outage at 08:00 can still be recovered inside the same
        // panel date, which is the entire reason the tick fires early.
        throw new Error(`crawl ${crawlRunId} failed: ${outcome.error}`)
      }
    },

    async parse(job: JobRow): Promise<void> {
      const crawlRunId = requiredString(job, 'crawl_run_id')

      // `runParse` takes the message id and does its own ledger write in the same
      // transaction as the panel rows. Passing the job's id rather than minting one is
      // what makes a redelivered parse a no-op instead of a doubled observation.
      await runParse(
        { db: deps.db, store: deps.store },
        { crawlRunId, messageId: jobMessageId(job), jobId: job.id },
      )
    },

    async analysis(job: JobRow): Promise<void> {
      // Wrapped, unlike the other two: `runAnalysis` has no natural idempotency key of its
      // own — it appends a run row every time it is called. The partial unique index added
      // in 0009 stops two *pending* jobs existing at once, but a job the reaper requeued
      // after a stall is the same row claimed twice, and that is what this guards.
      await withIdempotency(
        deps.db,
        {
          messageId: job.messageId,
          workspaceId: job.workspaceId,
          traceId: job.traceId as TraceId,
          jobId: job.id,
        },
        (tx) =>
          runAnalysis(
            { db: tx },
            {
              workspaceId: job.workspaceId,
              traceId: job.traceId as TraceId,
              actor: jobActor(job),
            },
          ),
      )
    },

    async proxy_validation(job: JobRow): Promise<void> {
      // Land-raw and corpus-upsert are naturally idempotent (write-once snapshot path,
      // upsert keyed by ad_archive_id) and run outside any transaction, same reasoning as
      // `crawl` above — they call the provider over the network. Only the final
      // read-corpus/classify/gate/regress/insert-run segment needs a guard, and
      // `runProxyValidation` wraps that part itself via `withIdempotency`, so the handler
      // does not double-wrap it.
      await runProxyValidation(
        { db: deps.db, store: deps.store, provider: deps.provider },
        {
          workspaceId: job.workspaceId,
          traceId: job.traceId as TraceId,
          actor: jobActor(job),
          messageId: jobMessageId(job),
          jobId: job.id,
          query: {
            kind: jobWatchlistKind(job, 'kind'),
            query: requiredString(job, 'query'),
            // Hardcoded, not read from the payload: the quarantined corpus (migration
            // 0011) only ever accepts 'ES', and `runProxyValidation` itself refuses any
            // other country — a payload field here would just be a second place that
            // constraint could drift from.
            country: 'ES',
          },
          reachBoundUsed: jobReachBound(job),
        },
      )
    },
  }
}
