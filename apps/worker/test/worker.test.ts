import { newTraceId, scheduleActor } from '@mini-crux/core'
import { enqueueJob } from '@mini-crux/db'
import { createTestDb, seedWorkspace } from '@mini-crux/db/testing'
import type { TestDb } from '@mini-crux/db/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createJobStore } from '../src/store.ts'
import type { JobRow } from '../src/store.ts'
import { BACKOFF_BASE_MS, createWorker, PermanentJobError } from '../src/worker.ts'
import type { Handlers } from '../src/worker.ts'

/**
 * The loop, on its own.
 *
 * Every assertion here is about claiming, dispatching, heartbeating and retrying — the four
 * things this file owns and nothing else in the repo does. The handlers are stubs on purpose:
 * `runCrawl` / `runParse` / `runAnalysis` are covered where they live, and a test that drove
 * real ones would be slower, would couple this file to a provider fixture, and would still
 * not be testing the loop.
 *
 * The chain — cron tick through to a populated panel with the real handlers — is
 * `chain.test.ts`. Both are needed: this file proves the loop is correct, that one proves the
 * loop is *connected*, and the severed chain that motivated UC-6 was a case of every
 * component being correct and none of them being connected.
 */

let db: TestDb
let workspaceId: string

beforeEach(async () => {
  db = await createTestDb()
  const seeded = await seedWorkspace(db, {
    slug: 'acme',
    name: 'Acme',
    clerkOrgId: 'org_acme',
    clerkUserId: 'user_acme',
  })
  workspaceId = seeded.workspaceId
})

afterEach(async () => {
  await db.close()
})

interface JobState {
  id: string
  status: string
  attempts: number
  last_error: string | null
  run_after_s: number
  heartbeat_age_s: number | null
  finished: boolean
}

/**
 * Read a job's lifecycle state, with the two timestamps already turned into numbers.
 *
 * Shaping in SQL rather than reading `Date`s back: `run_after` is compared against a backoff
 * measured in seconds, and letting two drivers decode the timestamp two ways is the exact
 * hazard CLAUDE.md's decoding table warns about.
 */
async function jobState(jobId: string): Promise<JobState> {
  const rows = await db.query<JobState>(
    `select id,
            status::text                                          as status,
            attempts::int                                         as attempts,
            last_error,
            extract(epoch from (run_after - now()))::float8        as run_after_s,
            extract(epoch from (now() - heartbeat_at))::float8     as heartbeat_age_s,
            (finished_at is not null)                              as finished
     from public.jobs where id = $1`,
    [jobId],
  )
  return rows[0]!
}

async function enqueue(type: string, payload: Record<string, unknown> = {}): Promise<string> {
  const { jobId } = await enqueueJob(db, {
    workspaceId,
    type,
    traceId: newTraceId(),
    actor: scheduleActor('test'),
    payload,
  })
  return jobId
}

/** Handlers that record what they were dispatched, and do whatever the test tells them to. */
function stubHandlers(overrides: Partial<Handlers> = {}): {
  handlers: Handlers
  seen: JobRow[]
} {
  const seen: JobRow[] = []
  const record =
    (): ((job: JobRow) => Promise<void>) =>
    async (job) => {
      seen.push(job)
    }
  return {
    handlers: {
      crawl: record(),
      parse: record(),
      analysis: record(),
      proxy_validation: record(),
      ...overrides,
    },
    seen,
  }
}

function workerFor(handlers: Handlers, options: { onError?: () => void } = {}) {
  return createWorker({
    store: createJobStore(db),
    handlers,
    // Swallow the expected console noise from the failure-path tests; a test that prints a
    // stack trace on success trains everyone to ignore stack traces.
    onError: options.onError ?? ((): void => {}),
  })
}

describe('claiming and dispatch', () => {
  it('claims a pending job, runs its handler, and marks it succeeded', async () => {
    const jobId = await enqueue('crawl', { crawl_run_id: 'run-1' })
    const { handlers, seen } = stubHandlers()

    expect(await workerFor(handlers).runOnce()).toBe(true)

    expect(seen.map((j) => j.type)).toEqual(['crawl'])
    expect(seen[0]!.payload).toEqual({ crawl_run_id: 'run-1' })
    const state = await jobState(jobId)
    expect(state.status).toBe('succeeded')
    expect(state.finished).toBe(true)
    // Cleared, not merely ignored: a succeeded row that still carries a heartbeat is a row
    // the reaper has to reason about.
    expect(state.heartbeat_age_s).toBeNull()
    expect(state.last_error).toBeNull()
  })

  it('dispatches each type to its own handler', async () => {
    await enqueue('crawl')
    await enqueue('parse')
    await enqueue('analysis')
    await enqueue('proxy_validation')

    const dispatched: string[] = []
    const tag =
      (name: string): ((job: JobRow) => Promise<void>) =>
      async () => {
        dispatched.push(name)
      }
    const worker = workerFor({
      crawl: tag('crawl'),
      parse: tag('parse'),
      analysis: tag('analysis'),
      proxy_validation: tag('proxy_validation'),
    })

    while (await worker.runOnce());

    expect(dispatched.sort()).toEqual(['analysis', 'crawl', 'parse', 'proxy_validation'])
  })

  it('returns false and touches nothing when the queue is empty', async () => {
    const { handlers, seen } = stubHandlers()
    expect(await workerFor(handlers).runOnce()).toBe(false)
    expect(seen).toEqual([])
  })

  it('leaves the Python worker its jobs', async () => {
    // Two runtimes claim from one table. `extract` belongs to apps/extractor, which has the
    // OpenCV stack this process does not; claiming one here would fail it three times and
    // then bury a creative's features permanently, with the extractor none the wiser.
    const extractId = await enqueue('extract', { creative_id: 'c-1' })
    const crawlId = await enqueue('crawl')

    const { handlers, seen } = stubHandlers()
    const worker = workerFor(handlers)
    expect(await worker.runOnce()).toBe(true)
    expect(await worker.runOnce()).toBe(false)

    expect(seen.map((j) => j.id)).toEqual([crawlId])
    expect((await jobState(extractId)).status).toBe('pending')
    expect((await jobState(extractId)).attempts).toBe(0)
  })

  it('claims in run_after order, so a backed-off job does not jump the queue', async () => {
    const later = await enqueue('crawl', { which: 'later' })
    await db.query("update public.jobs set run_after = now() + interval '1 second' where id = $1", [
      later,
    ])
    const sooner = await enqueue('parse', { which: 'sooner' })

    const { handlers, seen } = stubHandlers()
    await workerFor(handlers).runOnce()

    expect(seen.map((j) => j.id)).toEqual([sooner])
  })
})

describe('failure handling', () => {
  it('returns a thrown job to pending with the error and a backoff', async () => {
    const jobId = await enqueue('crawl')
    const { handlers } = stubHandlers({
      crawl: async () => {
        throw new Error('provider returned 503')
      },
    })

    await workerFor(handlers).runOnce()

    const state = await jobState(jobId)
    expect(state.status).toBe('pending')
    expect(state.attempts).toBe(1)
    expect(state.last_error).toBe('provider returned 503')
    // Not finished — `finished_at` is what separates "gave up" from "will try again", and a
    // retryable failure that sets it makes the health check report a dead job that is alive.
    expect(state.finished).toBe(false)
    // One attempt in, so one backoff interval. Asserted as a value, not as `> 0`: a backoff
    // multiplied by the wrong number is still positive and still looks like it works.
    expect(state.run_after_s).toBeGreaterThan(BACKOFF_BASE_MS / 1000 - 5)
    expect(state.run_after_s).toBeLessThanOrEqual(BACKOFF_BASE_MS / 1000)
  })

  it('backs off further on each attempt', async () => {
    const jobId = await enqueue('crawl')
    const { handlers } = stubHandlers({
      crawl: async () => {
        throw new Error('still down')
      },
    })
    const worker = workerFor(handlers)

    await worker.runOnce()
    const first = (await jobState(jobId)).run_after_s
    // The backoff is what stops the retry from being claimable, so a second attempt has to
    // be made due by hand — otherwise this test measures the sleep and not the arithmetic.
    await db.query('update public.jobs set run_after = now() where id = $1', [jobId])
    await worker.runOnce()
    const second = (await jobState(jobId)).run_after_s

    expect((await jobState(jobId)).attempts).toBe(2)
    expect(second).toBeGreaterThan(first + 20)
  })

  it('fails for good once attempts are exhausted', async () => {
    const jobId = await enqueue('crawl')
    const { handlers } = stubHandlers({
      crawl: async () => {
        throw new Error('permanently sad')
      },
    })
    const worker = workerFor(handlers)

    for (let i = 0; i < 3; i += 1) {
      await db.query('update public.jobs set run_after = now() where id = $1', [jobId])
      await worker.runOnce()
    }

    const state = await jobState(jobId)
    expect(state.attempts).toBe(3)
    expect(state.status).toBe('failed')
    expect(state.finished).toBe(true)
    // And it stays failed: a fourth pass must find nothing to claim.
    expect(await worker.runOnce()).toBe(false)
  })

  it('stops immediately on a PermanentJobError instead of burning the retry budget', async () => {
    const jobId = await enqueue('parse')
    const { handlers } = stubHandlers({
      parse: async (job) => {
        throw new PermanentJobError(`parse job ${job.id} has no crawl_run_id in its payload`)
      },
    })

    await workerFor(handlers).runOnce()

    const state = await jobState(jobId)
    expect(state.status).toBe('failed')
    expect(state.attempts).toBe(1)
    expect(state.last_error).toContain('no crawl_run_id')
    expect(state.finished).toBe(true)
    // No backoff was written: the row is done, and a `run_after` in the future on a failed
    // job is a misleading thing for an operator to find.
    expect(state.run_after_s).toBeLessThanOrEqual(0)
  })

  it('fails a job whose type it has no handler for, naming the type', async () => {
    // This is the severed chain, inverted. `Handlers` is exhaustive over `JOB_TYPES` by
    // construction, so the only way to reach this branch is a producer that shipped ahead of
    // its consumer — which is not a type error, it is a deploy, and it is what UC-6 exists
    // to fix. The cast reproduces that deploy.
    // reason: a partial handler map cannot be expressed in a type that is exhaustive by design.
    const jobId = await enqueue('analysis')
    const { handlers } = stubHandlers()
    const partial = { crawl: handlers.crawl, parse: handlers.parse } as unknown as Handlers

    await workerFor(partial).runOnce()

    const state = await jobState(jobId)
    expect(state.status).toBe('failed')
    expect(state.last_error).toContain('analysis')
    // Named, not just failed. "no handler for job type" with the type elided sends whoever
    // is on call reading source instead of the deploy log.
    expect(state.last_error).toContain('no handler')
    expect(state.finished).toBe(true)
  })

  it('reports the failure rather than swallowing it', async () => {
    await enqueue('crawl')
    const reported: string[] = []
    const { handlers } = stubHandlers({
      crawl: async () => {
        throw new Error('boom')
      },
    })
    await createWorker({
      store: createJobStore(db),
      handlers,
      onError: (message) => reported.push(message),
    }).runOnce()

    expect(reported.some((m) => m.includes('failed'))).toBe(true)
  })
})

describe('the heartbeat', () => {
  it('keeps beating, repeatedly, while a handler is still working', async () => {
    // The stall window is five minutes and a real crawl can run longer than that. Without a
    // heartbeat the reaper requeues a job that is making perfectly good progress, and the
    // second run calls the provider again for a day already being collected.
    //
    // Two beats, not one. Measured: with a single observation, swapping `setInterval` for
    // `setTimeout` survived — the timer fired once, the test saw a fresh heartbeat, and a
    // worker that goes quiet after fifteen seconds looked identical to a healthy one. The
    // whole value of a heartbeat is in the second beat.
    const jobId = await enqueue('crawl')
    const observed: number[] = []

    const ageOut = async (): Promise<void> => {
      await db.query(
        "update public.jobs set heartbeat_at = now() - interval '9 minutes' where id = $1",
        [jobId],
      )
    }
    const currentAge = async (): Promise<number> => {
      const rows = await db.query<{ age: number }>(
        `select extract(epoch from (now() - heartbeat_at))::float8 as age
         from public.jobs where id = $1`,
        [jobId],
      )
      return Number(rows[0]!.age)
    }
    /** Poll for a beat rather than sleeping a fixed span, so a slow machine does not flake. */
    const waitForBeat = async (): Promise<number> => {
      const deadline = Date.now() + 2_000
      let age = await currentAge()
      while (age > 60 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        age = await currentAge()
      }
      return age
    }

    const { handlers } = stubHandlers({
      crawl: async () => {
        await ageOut()
        observed.push(await waitForBeat())
        await ageOut()
        observed.push(await waitForBeat())
      },
    })

    await createWorker({
      store: createJobStore(db),
      handlers,
      heartbeatIntervalMs: 10,
      onError: (): void => {},
    }).runOnce()

    // Both beats landed: the age went back to seconds twice, from nine minutes twice.
    expect(observed).toHaveLength(2)
    expect(observed[0]).toBeLessThan(60)
    expect(observed[1]).toBeLessThan(60)
  })

  it('does not resurrect a job that has already finished', async () => {
    // `HEARTBEAT_SQL` is guarded on `status = 'running'`. A beat that landed after
    // completion would put `heartbeat_at` back on a succeeded row, and the reaper reads
    // exactly that column.
    const jobId = await enqueue('crawl')
    const { handlers } = stubHandlers()
    await workerFor(handlers).runOnce()

    await createJobStore(db).heartbeat(jobId)

    const state = await jobState(jobId)
    expect(state.status).toBe('succeeded')
    expect(state.heartbeat_age_s).toBeNull()
  })

  it('survives a heartbeat that fails, because losing a claim beats losing a crawl', async () => {
    const jobId = await enqueue('crawl')
    const failures: string[] = []
    const store = createJobStore(db)
    const broken = {
      ...store,
      heartbeat: async (): Promise<void> => {
        throw new Error('connection reset')
      },
    }

    const { handlers } = stubHandlers({
      crawl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40))
      },
    })
    await createWorker({
      store: broken,
      handlers,
      heartbeatIntervalMs: 5,
      onError: (message) => failures.push(message),
    }).runOnce()

    expect(failures.some((m) => m.includes('heartbeat failed'))).toBe(true)
    expect((await jobState(jobId)).status).toBe('succeeded')
  })
})

describe('the loop', () => {
  it('drains the queue, then sleeps, until it is asked to stop', async () => {
    await enqueue('crawl')
    await enqueue('parse')

    const controller = new AbortController()
    let sleeps = 0
    const { handlers, seen } = stubHandlers()

    await createWorker({
      store: createJobStore(db),
      handlers,
      onError: (): void => {},
      sleep: async () => {
        sleeps += 1
        // Stop on the first idle poll: both jobs are done by then, and letting it spin would
        // make the test's duration a function of the poll interval.
        controller.abort()
      },
    }).runForever({ pollIntervalMs: 1, signal: controller.signal })

    expect(seen).toHaveLength(2)
    // Exactly one sleep — it must not sleep between two jobs that are both ready, or a
    // backlog drains at one job per poll interval instead of as fast as it can.
    expect(sleeps).toBe(1)
  })

  it('does not claim anything when the signal is already aborted', async () => {
    await enqueue('crawl')
    const controller = new AbortController()
    controller.abort()
    const { handlers, seen } = stubHandlers()

    await createWorker({ store: createJobStore(db), handlers, onError: (): void => {} }).runForever(
      { pollIntervalMs: 1, signal: controller.signal },
    )

    expect(seen).toEqual([])
  })

  it('keeps polling when claiming itself throws', async () => {
    // The database being unreachable is a transient event; the daily crawl window is not. A
    // process that exits on a failed claim turns a thirty-second Supabase blip into a missed
    // day, and a missed day cannot be backfilled.
    const controller = new AbortController()
    const reported: string[] = []
    let claims = 0
    const { handlers } = stubHandlers()

    await createWorker({
      store: {
        claim: async () => {
          claims += 1
          if (claims < 3) throw new Error('connection refused')
          return null
        },
        heartbeat: async (): Promise<void> => {},
        complete: async (): Promise<void> => {},
        fail: async (): Promise<void> => {},
      },
      handlers,
      onError: (message) => reported.push(message),
      sleep: async () => {
        if (claims >= 3) controller.abort()
      },
    }).runForever({ pollIntervalMs: 1, signal: controller.signal })

    expect(claims).toBe(3)
    expect(reported.filter((m) => m.includes('claim failed'))).toHaveLength(2)
  })
})
