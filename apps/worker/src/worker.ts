import { JOB_TYPES, type JobRow, type JobStore } from './store.ts'

/**
 * The loop that was missing.
 *
 * `app.enqueue_daily_crawls` has written a `crawl` job every morning since UC-1 and nothing
 * has ever claimed one. `runCrawl` enqueues a `parse` job on success and nothing claimed
 * those either. The handlers were all written, all tested, and all unreachable — every test
 * called its handler directly, so the suite could not tell the difference between a chain
 * that works and a chain with no caller.
 *
 * This file is deliberately thin. It owns claiming, heartbeating, retrying and dispatch, and
 * nothing else: every line of domain behavior stays in `runCrawl` / `runParse` / `runAnalysis`
 * where it is already covered. A worker that also knew how to parse an Ad Library payload
 * would be a second place for that knowledge to live.
 */

/** A failure retrying cannot fix: a malformed payload, a job type nobody handles. */
export class PermanentJobError extends Error {
  override readonly name = 'PermanentJobError'
}

/**
 * Comfortably inside `app.reap_stalled_jobs`' five-minute stall window, so one missed tick —
 * a GC pause, a slow query — does not cost a job its claim. Matches the Python worker's
 * `DEFAULT_HEARTBEAT_INTERVAL_S`; `test/statement-parity.test.ts` reads that file and fails
 * if the two drift, because a heartbeat interval only means something relative to a stall
 * window defined in a third language in a fourth directory.
 */
export const HEARTBEAT_INTERVAL_MS = 15_000

/**
 * Retry backoff, multiplied by the attempt count. Long, because the realistic causes are a
 * rate-limited provider and a transiently overloaded machine, and neither is helped by
 * trying again immediately.
 */
export const BACKOFF_BASE_MS = 30_000

export type JobHandler = (job: JobRow) => Promise<void>

/** Exhaustive over the types this worker claims — a new type will not compile until handled. */
export type Handlers = Record<(typeof JOB_TYPES)[number], JobHandler>

export interface WorkerDeps {
  store: JobStore
  handlers: Handlers
  /** Injected so tests drive the heartbeat without faking timers globally. */
  heartbeatIntervalMs?: number
  sleep?: (ms: number) => Promise<void>
  onError?: (message: string, error: unknown) => void
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export interface Worker {
  /** Claim and process at most one job. False means the queue was empty. */
  runOnce(): Promise<boolean>
  runForever(options?: { pollIntervalMs?: number; signal?: AbortSignal }): Promise<void>
}

export function createWorker(deps: WorkerDeps): Worker {
  const heartbeatMs = deps.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
  const sleep = deps.sleep ?? defaultSleep
  const onError = deps.onError ?? ((message, error) => console.error(message, error))

  async function handle(job: JobRow): Promise<void> {
    // Not a lookup that falls back to a default handler. A type with no handler is a
    // deployment mistake — a producer shipped ahead of its consumer, which is exactly the
    // bug this whole UC exists to fix — and the only safe response is to stop the job and
    // say so. Silently releasing it back to `pending` is an infinite claim loop that
    // presents as an idle worker with a growing queue.
    const handler = (deps.handlers as Record<string, JobHandler | undefined>)[job.type]
    if (handler === undefined) {
      throw new PermanentJobError(
        `no handler for job type "${job.type}" — producer is ahead of this worker`,
      )
    }
    await handler(job)
  }

  async function withHeartbeat<T>(job: JobRow, fn: () => Promise<T>): Promise<T> {
    const timer = setInterval(() => {
      // A failed heartbeat is not a failed job: the worst case is that the reaper requeues
      // us, which is recoverable. Killing a healthy crawl mid-flight is not — the panel
      // date it was collecting cannot be collected again tomorrow.
      void deps.store.heartbeat(job.id).catch((error: unknown) => {
        onError(`[worker] heartbeat failed for job ${job.id}`, error)
      })
    }, heartbeatMs)
    // Node keeps the process alive for a pending timer. A worker draining its last job on
    // shutdown would otherwise hang for the length of the interval.
    timer.unref?.()
    try {
      return await fn()
    } finally {
      clearInterval(timer)
    }
  }

  return {
    async runOnce(): Promise<boolean> {
      const job = await deps.store.claim(JOB_TYPES)
      if (job === null) return false

      try {
        await withHeartbeat(job, () => handle(job))
        await deps.store.complete(job.id)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        onError(`[worker] job ${job.id} (${job.type}) failed`, error)
        if (error instanceof PermanentJobError) {
          await deps.store.fail(job.id, message, 0, { permanent: true })
        } else {
          // Attempt count comes off the claimed row, which `app.claim_job` already
          // incremented — so the first failure backs off one interval, not zero.
          await deps.store.fail(job.id, message, (BACKOFF_BASE_MS * job.attempts) / 1000)
        }
      }
      return true
    },

    async runForever(options): Promise<void> {
      const pollIntervalMs = options?.pollIntervalMs ?? 2_000
      while (options?.signal?.aborted !== true) {
        let worked = false
        try {
          worked = await this.runOnce()
        } catch (error) {
          // Claiming itself failed — the database is unreachable or the role lost its
          // grant. Sleeping and retrying is right: crashing the process turns a transient
          // outage into a missed crawl, and the crawl is the thing that cannot be redone.
          onError('[worker] claim failed', error)
        }
        if (!worked) await sleep(pollIntervalMs)
      }
    },
  }
}
