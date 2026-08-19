import { newTraceId, operatorActor } from '@mini-crux/core'
import { enqueueJob } from '@mini-crux/db'
import { createTestDb, seedWorkspace } from '@mini-crux/db/testing'
import type { TestDb } from '@mini-crux/db/testing'
import { createFixtureProvider, createMemoryStore, fixtureAd } from '@mini-crux/ingestion'
import type { AdLibraryAd, FixtureDay, ObjectStore } from '@mini-crux/ingestion'
import { seedWatchlist, tick } from '@mini-crux/ingestion/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createHandlers } from '../src/handlers.ts'
import { createJobStore } from '../src/store.ts'
import { createWorker } from '../src/worker.ts'
import type { Worker } from '../src/worker.ts'

/**
 * The test that would have failed while the chain was severed.
 *
 * Every other suite in this repo calls a handler directly: `runCrawl(deps, {crawlRunId})`,
 * `runParse(...)`, `runAnalysis(...)`. That is why nothing went red for five use cases while
 * `app.enqueue_daily_crawls` wrote a job every morning that no process would ever claim — a
 * test that constructs its own caller cannot tell you whether a caller exists.
 *
 * So the rule for this file: **nothing below calls a handler**. The only entry points are the
 * two things pg_cron calls (`app.enqueue_daily_crawls`, `app.enqueue_daily_analysis`) and
 * `worker.runOnce()`, which is what the Fly machine runs. Everything in between has to happen
 * by itself or the assertions fail. Deleting `createHandlers` from `main.ts` must break this
 * file and only this file.
 */

const DAY_1 = '2026-03-01'
const DAY_2 = '2026-03-02'

let db: TestDb
let store: ObjectStore
let workspaceId: string

/** Two ads on day one; on day two the second is gone, which is the panel's whole point. */
const DAY_1_ADS: AdLibraryAd[] = [
  fixtureAd({ adArchiveId: 'ad_1', adCopy: 'Tu tarjeta sin buró.' }),
  fixtureAd({ adArchiveId: 'ad_2', adCopy: 'Abre tu cuenta en minutos.' }),
]
const DAY_2_ADS: AdLibraryAd[] = [fixtureAd({ adArchiveId: 'ad_1', adCopy: 'Tu tarjeta sin buró.' })]

function workerWith(days: FixtureDay[]): Worker {
  return createWorker({
    store: createJobStore(db),
    handlers: createHandlers({
      db,
      store,
      provider: createFixtureProvider(days),
    }),
    onError: (): void => {},
  })
}

/** Run until the queue is empty, exactly as `runForever` does between sleeps. */
async function drain(worker: Worker): Promise<number> {
  let processed = 0
  // Bounded so a job that keeps returning to `pending` cannot hang the suite. Any real chain
  // here is a handful of jobs; twenty is generous and still terminates.
  for (let i = 0; i < 20; i += 1) {
    if (!(await worker.runOnce())) return processed
    processed += 1
  }
  throw new Error('the queue did not drain — a job is cycling')
}

interface JobSummary {
  type: string
  status: string
  trace_id: string
  last_error: string | null
}

async function jobs(): Promise<JobSummary[]> {
  return db.query<JobSummary>(
    `select type, status::text as status, trace_id, last_error
     from public.jobs order by created_at, type`,
  )
}

beforeEach(async () => {
  db = await createTestDb()
  store = createMemoryStore()
  const seeded = await seedWorkspace(db, {
    slug: 'acme',
    name: 'Acme',
    clerkOrgId: 'org_acme',
    clerkUserId: 'user_acme',
  })
  workspaceId = seeded.workspaceId
  await seedWatchlist(db, { workspaceId, query: 'stori' })
})

afterEach(async () => {
  await db.close()
})

describe('cron tick → worker → panel', () => {
  it('turns a scheduled tick into a populated panel with nobody calling a handler', async () => {
    expect(await tick(db, DAY_1)).toBe(1)

    // Before the worker runs: a job exists and the panel is empty. This is the exact state
    // the system was in every morning for five use cases.
    expect((await jobs()).map((j) => `${j.type}:${j.status}`)).toEqual(['crawl:pending'])
    expect(await observationCount()).toBe(0)

    const processed = await drain(workerWith([{ ads: DAY_1_ADS }]))

    // Two jobs ran off one tick: the crawl, and the parse the crawl enqueued for itself.
    expect(processed).toBe(2)
    expect((await jobs()).map((j) => `${j.type}:${j.status}`).sort()).toEqual([
      'crawl:succeeded',
      'parse:succeeded',
    ])

    const observations = await db.query<{ ad_archive_id: string; is_present: boolean }>(
      `select c.creative_hash, o.is_present, c.id
       from public.creative_observations o
       join public.creatives c on c.id = o.creative_id`,
    )
    expect(observations).toHaveLength(2)
    expect(observations.every((o) => o.is_present)).toBe(true)
  })

  it('carries one trace_id from the tick through to the parse it caused', async () => {
    // The `trace_id` contract is join-key-across-the-whole-chain, and the crawl→parse hop is
    // the only place in this system where one job creates another. If it minted a fresh id,
    // an operator debugging a bad panel day could not get from the crawl to the parse.
    await tick(db, DAY_1)
    const [crawlJob] = await jobs()

    await drain(workerWith([{ ads: DAY_1_ADS }]))

    const all = await jobs()
    const parseJob = all.find((j) => j.type === 'parse')
    expect(parseJob).toBeDefined()
    expect(parseJob!.trace_id).toBe(crawlJob!.trace_id)

    // And the same id reaches the crawl_runs row and the audit trail, which is where an
    // operator actually starts.
    const runs = await db.query<{ trace_id: string }>('select trace_id from public.crawl_runs')
    expect(runs[0]!.trace_id).toBe(crawlJob!.trace_id)
    const audit = await db.query<{ n: number }>(
      'select count(*)::int as n from public.audit_events where trace_id = $1',
      [crawlJob!.trace_id],
    )
    expect(audit[0]!.n).toBeGreaterThan(0)
  })

  it('records an absence on the second day, which needs both days to have run', async () => {
    // The outcome variable the whole product measures is "how long did the advertiser keep
    // paying", and it exists only as the difference between two crawls. One day of chain is
    // not a panel.
    const worker = workerWith([{ ads: DAY_1_ADS }, { ads: DAY_2_ADS }])

    await tick(db, DAY_1)
    await drain(worker)
    await tick(db, DAY_2)
    await drain(worker)

    const rows = await db.query<{ run_date: string; is_present: boolean; copy: string }>(
      `select to_char(r.run_date, 'YYYY-MM-DD') as run_date,
              o.is_present,
              left(c.ad_copy, 12) as copy
       from public.creative_observations o
       join public.creatives c on c.id = o.creative_id
       join public.crawl_runs r on r.id = o.crawl_run_id
       order by r.run_date, copy`,
    )

    // Four rows, not three: the ad that stopped is recorded as absent, never omitted.
    expect(rows).toHaveLength(4)
    const dayTwo = rows.filter((r) => r.run_date === DAY_2)
    expect(dayTwo.map((r) => r.is_present).sort()).toEqual([false, true])
  })

  it('leaves the panel untouched when the provider is down, and retries the crawl', async () => {
    // A failed crawl must write no observations at all — not even absences. If the chain
    // turned an outage into a mass die-off, every provider blip would look like the market
    // rotating its creative overnight.
    await tick(db, DAY_1)
    const worker = workerWith([{ ads: [], fail: { message: 'apify 503', retryable: true } }])

    await drain(worker)

    expect(await observationCount()).toBe(0)
    const all = await jobs()
    expect(all).toHaveLength(1)
    expect(all[0]!.status).toBe('pending')
    expect(all[0]!.last_error).toContain('failed')
    // No parse job: a crawl that landed nothing has nothing to parse, and one enqueued here
    // would fail three times against a snapshot that does not exist.
    expect(all.filter((j) => j.type === 'parse')).toHaveLength(0)
  })

  it('does not re-crawl a day it has already landed', async () => {
    // The reaper requeues a job whose worker died mid-flight, so a second claim of the same
    // crawl is ordinary. `crawl_runs.status` is what makes it a no-op — one crawl per day is
    // a promise to the provider's rate limit as much as to the panel.
    await tick(db, DAY_1)
    const worker = workerWith([{ ads: DAY_1_ADS }])
    await drain(worker)
    const before = await observationCount()

    await db.query(
      `update public.jobs set status = 'pending', run_after = now(), finished_at = null
       where type = 'crawl'`,
    )
    await drain(worker)

    expect(await observationCount()).toBe(before)
    const runs = await db.query<{ n: number }>('select count(*)::int as n from public.crawl_runs')
    expect(runs[0]!.n).toBe(1)
  })
})

describe('the analysis tick → worker → analysis_runs', () => {
  it('runs an analysis off the scheduled tick and records its verdict', async () => {
    const worker = workerWith([{ ads: DAY_1_ADS }])
    await tick(db, DAY_1)
    await drain(worker)

    const created = await db.query<{ n: number }>(
      'select app.enqueue_daily_analysis($1::date)::int as n',
      [DAY_1],
    )
    expect(created[0]!.n).toBe(1)

    expect(await drain(worker)).toBe(1)

    const runs = await db.query<{ outcome: string; failed_gate: string | null }>(
      `select outcome::text as outcome, failed_gate::text as failed_gate
       from public.analysis_runs where workspace_id = $1`,
      [workspaceId],
    )
    expect(runs).toHaveLength(1)
    // Refused, and refused for the right reason. A one-day panel cannot support a survival
    // contrast, and the run row saying so *is* the correct output — an analysis that spoke
    // here would be the failure. Asserting the gate rather than just `refused` keeps this
    // from passing on some unrelated refusal.
    expect(runs[0]!.outcome).toBe('refused')
    expect(runs[0]!.failed_gate).not.toBeNull()
  })

  it('does not write a second run when the same analysis job is redelivered', async () => {
    // `runAnalysis` appends a row every time it is called — it has no natural idempotency key
    // — so the guard is `withIdempotency` on the job's `message_id`, in the same transaction
    // as the insert. A reaper-requeued analysis must not double the workspace's run history.
    const worker = workerWith([{ ads: DAY_1_ADS }])
    await tick(db, DAY_1)
    await drain(worker)
    await db.query('select app.enqueue_daily_analysis($1::date)', [DAY_1])
    await drain(worker)

    await db.query(
      `update public.jobs set status = 'pending', run_after = now(), finished_at = null
       where type = 'analysis'`,
    )
    await drain(worker)

    const runs = await db.query<{ n: number }>(
      'select count(*)::int as n from public.analysis_runs where workspace_id = $1',
      [workspaceId],
    )
    expect(runs[0]!.n).toBe(1)
  })
})

describe('proxy validation job → worker → proxy_validation_runs (UC-7)', () => {
  // A crawl-and-parse day never touches this corpus (quarantine, migration 0011), so the
  // wiring proof here does not reuse `workerWith`'s watchlist-derived setup — the job is
  // enqueued by hand, exactly as `proxy-validation:once` enqueues nothing and calls
  // `runProxyValidation` directly, and exactly as an operator triggers it in production.
  const ES_ADS: AdLibraryAd[] = [
    fixtureAd({
      adArchiveId: 'es_ad_1',
      pageId: 'page_es_1',
      pageName: 'Moda ES 1',
      adDeliveryStartTime: '2026-01-01T00:00:00.000Z',
      adDeliveryStopTime: '2026-01-10T00:00:00.000Z',
      euTotalReachMin: 1000,
      euTotalReachMax: 2000,
    }),
    fixtureAd({
      adArchiveId: 'es_ad_2',
      pageId: 'page_es_2',
      pageName: 'Moda ES 2',
      adDeliveryStartTime: '2026-01-01T00:00:00.000Z',
      adDeliveryStopTime: '2026-01-15T00:00:00.000Z',
      euTotalReachMin: 500,
      euTotalReachMax: 1500,
    }),
  ]

  async function enqueueProxyValidation(): Promise<string> {
    const { jobId } = await enqueueJob(db, {
      workspaceId,
      type: 'proxy_validation',
      traceId: newTraceId(),
      actor: operatorActor('user_acme', 'chain-test'),
      payload: { kind: 'keyword', query: 'moda' },
    })
    return jobId
  }

  it('runs the ES crawl off a manually enqueued job and records a run row', async () => {
    // Two ads is nowhere near the gate's >= 30 finished / >= 5 advertisers, so this proves
    // the chain — enqueue, claim, dispatch, crawl, land, upsert, classify, gate, store — is
    // connected, the same way the analysis chain test above uses a one-day panel's correct
    // refusal rather than assembling a corpus large enough to publish.
    const jobId = await enqueueProxyValidation()
    const worker = workerWith([{ ads: ES_ADS }])

    expect(await drain(worker)).toBe(1)

    const jobRow = await db.query<{ status: string }>(
      `select status::text as status from public.jobs where id = $1`,
      [jobId],
    )
    expect(jobRow[0]!.status).toBe('succeeded')

    const runs = await db.query<{
      outcome: string
      failed_gate: string | null
      corpus_size: number
    }>(
      `select outcome::text as outcome, failed_gate::text as failed_gate, corpus_size
       from public.proxy_validation_runs where workspace_id = $1`,
      [workspaceId],
    )
    expect(runs).toHaveLength(1)
    expect(runs[0]!.outcome).toBe('refused')
    expect(runs[0]!.failed_gate).not.toBeNull()
    expect(runs[0]!.corpus_size).toBe(2)

    const corpus = await db.query<{ n: number }>(
      `select count(*)::int as n from public.proxy_validation_ads where workspace_id = $1`,
      [workspaceId],
    )
    expect(corpus[0]!.n).toBe(2)
  })

  it('does not double the corpus or the run history when the job is redelivered', async () => {
    // Mirrors "does not re-crawl a day it has already landed" above: a reaper-requeued job
    // is ordinary, and the same guarantees — write-once snapshot, upsert-keyed corpus,
    // idempotency-ledgered run insert — must hold here even though nothing in this UC has a
    // `crawl_runs.status` column to lean on.
    await enqueueProxyValidation()
    const worker = workerWith([{ ads: ES_ADS }])
    await drain(worker)

    await db.query(
      `update public.jobs set status = 'pending', run_after = now(), finished_at = null
       where type = 'proxy_validation'`,
    )
    await drain(worker)

    const corpus = await db.query<{ n: number }>(
      `select count(*)::int as n from public.proxy_validation_ads where workspace_id = $1`,
      [workspaceId],
    )
    expect(corpus[0]!.n).toBe(2)

    const runs = await db.query<{ n: number }>(
      `select count(*)::int as n from public.proxy_validation_runs where workspace_id = $1`,
      [workspaceId],
    )
    expect(runs[0]!.n).toBe(1)
  })
})

async function observationCount(): Promise<number> {
  const rows = await db.query<{ n: number }>(
    'select count(*)::int as n from public.creative_observations',
  )
  return rows[0]!.n
}
