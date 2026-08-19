import { isActor } from '@mini-crux/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createTestDb, seedWorkspace, type TestDb } from '../src/testing.ts'

/**
 * The scheduler's second and third ticks.
 *
 * `app.enqueue_daily_crawls` has been scheduled since 0003. `app.enqueue_daily_analysis` and
 * `app.reap_stalled_jobs` were not scheduled at all until 0009 — the analysis one because it
 * had never been written, the reaper because it was written, tested, and never wired to
 * anything. This file covers the enqueue logic; whether cron actually calls it is a property
 * of the migration's `do` block, asserted at the bottom.
 *
 * Each test gets a fresh database. The tick's whole contract is about what already exists in
 * the tables when it fires, so a shared database would make the tests order-dependent in
 * exactly the dimension under test.
 */

const PANEL_DATE = '2026-03-10'

interface Fixture {
  db: TestDb
  workspaceId: string
  watchlistId: string
}

/** `query` is unique per (workspace, kind, country), so callers seeding two must differ. */
async function seedWatchlist(db: TestDb, workspaceId: string, query = 'stori'): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `insert into public.watchlists (workspace_id, kind, query, country, label)
     values ($1, 'keyword', $2, 'MX', 'Fintech MX')
     returning id`,
    [workspaceId, query],
  )
  return rows[0]!.id
}

async function seedCrawl(
  fixture: Fixture,
  input: { runDate: string; status: 'running' | 'succeeded' | 'suspect' | 'failed' },
): Promise<void> {
  await fixture.db.query(
    `insert into public.crawl_runs (workspace_id, watchlist_id, run_date, status, trace_id, actor)
     values ($1, $2, $3::date, $4::crawl_status, 'trc_test', '{"type":"schedule"}'::jsonb)`,
    [fixture.workspaceId, fixture.watchlistId, input.runDate, input.status],
  )
}

/** A minimal refused run — enough columns to satisfy the table's checks, nothing more. */
async function seedAnalysisRun(fixture: Fixture, panelDate: string): Promise<void> {
  await fixture.db.query(
    `insert into public.analysis_runs
       (workspace_id, panel_date, panel_age_days, analysis_version, outcome, failed_gate,
        n_long, n_short, trace_id, actor)
     values ($1, $2::date, 12, 'v1', 'refused', 'panel_age', 0, 0, 'trc_test',
             '{"type":"schedule"}'::jsonb)`,
    [fixture.workspaceId, panelDate],
  )
}

async function tick(db: TestDb, panelDate: string | null): Promise<number> {
  const rows = await db.query<{ n: number }>(
    'select app.enqueue_daily_analysis($1::date) as n',
    [panelDate],
  )
  return Number(rows[0]!.n)
}

async function analysisJobs(
  db: TestDb,
): Promise<
  {
    id: string
    payload: { panel_date?: string }
    trace_id: string
    actor: { type?: string; id?: string; label?: string }
    status: string
  }[]
> {
  return db.query(
    `select id, payload, trace_id, actor, status::text as status
     from public.jobs where type = 'analysis' order by created_at`,
  )
}

describe('app.enqueue_daily_analysis', () => {
  let fixture: Fixture

  beforeEach(async () => {
    const db = await createTestDb()
    const { workspaceId } = await seedWorkspace(db, {
      slug: 'acme',
      name: 'Acme',
      clerkOrgId: 'org_acme',
      clerkUserId: 'user_acme',
    })
    fixture = { db, workspaceId, watchlistId: await seedWatchlist(db, workspaceId) }
  })

  afterEach(async () => {
    await fixture.db.close()
  })

  it('enqueues one job for a workspace whose crawl succeeded today', async () => {
    await seedCrawl(fixture, { runDate: PANEL_DATE, status: 'succeeded' })

    expect(await tick(fixture.db, PANEL_DATE)).toBe(1)

    const jobs = await analysisJobs(fixture.db)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.payload.panel_date).toBe(PANEL_DATE)
    // Checked with `isActor`, not field by field. Measured: this test originally asserted
    // `type` and `label` — the two fields the migration happened to set — and passed while
    // the actor was missing the required `id`. The analysis handler calls `isActor` and
    // raises a PermanentJobError when it fails, so every scheduled analysis would have died
    // on its first attempt with no retry, and only the end-to-end chain test found it.
    // Assert against the contract, never against the implementation you just wrote.
    expect(isActor(jobs[0]!.actor)).toBe(true)
    expect(jobs[0]!.actor.type).toBe('schedule')
    expect(jobs[0]!.actor.id).toBe('mini-crux-daily-analysis')
    expect(jobs[0]!.actor.label).toBe('daily-analysis')
    // The job is ingress for its own trace: nothing upstream handed it one, because the
    // crawl that produced the panel finished hours ago on a different trace.
    expect(jobs[0]!.trace_id).toMatch(/^trc_[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it.each(['failed', 'suspect', 'running'] as const)(
    'enqueues nothing when today\'s crawl is %s',
    async (status) => {
      await seedCrawl(fixture, { runDate: PANEL_DATE, status })

      expect(await tick(fixture.db, PANEL_DATE)).toBe(0)
      expect(await analysisJobs(fixture.db)).toHaveLength(0)
    },
  )

  it('enqueues nothing when there was no crawl at all today', async () => {
    await seedCrawl(fixture, { runDate: '2026-03-09', status: 'succeeded' })

    expect(await tick(fixture.db, PANEL_DATE)).toBe(0)
    expect(await analysisJobs(fixture.db)).toHaveLength(0)
  })

  it('enqueues nothing when this panel date has already been analyzed', async () => {
    await seedCrawl(fixture, { runDate: PANEL_DATE, status: 'succeeded' })
    await seedAnalysisRun(fixture, PANEL_DATE)

    expect(await tick(fixture.db, PANEL_DATE)).toBe(0)
    expect(await analysisJobs(fixture.db)).toHaveLength(0)
  })

  it('still enqueues when the only analysis run is for a different panel date', async () => {
    await seedCrawl(fixture, { runDate: PANEL_DATE, status: 'succeeded' })
    await seedAnalysisRun(fixture, '2026-03-09')

    expect(await tick(fixture.db, PANEL_DATE)).toBe(1)
  })

  it('is a no-op on a second tick while the first job is still in flight', async () => {
    await seedCrawl(fixture, { runDate: PANEL_DATE, status: 'succeeded' })

    expect(await tick(fixture.db, PANEL_DATE)).toBe(1)
    // No `analysis_runs` row yet — the job has not run. This is the window the `not exists`
    // guard cannot see, and the only thing standing in it is the partial unique index.
    expect(await tick(fixture.db, PANEL_DATE)).toBe(0)

    expect(await analysisJobs(fixture.db)).toHaveLength(1)
  })

  it('does not count a job the conflict clause suppressed', async () => {
    await seedCrawl(fixture, { runDate: PANEL_DATE, status: 'succeeded' })
    await tick(fixture.db, PANEL_DATE)

    // The return value is what an operator reads out of the cron log. Reporting the loop's
    // iteration count instead of its insert count would say "enqueued 1" on a day nothing
    // was enqueued.
    expect(await tick(fixture.db, PANEL_DATE)).toBe(0)
  })

  it('re-enqueues after a job failed permanently and wrote no run', async () => {
    await seedCrawl(fixture, { runDate: PANEL_DATE, status: 'succeeded' })
    await tick(fixture.db, PANEL_DATE)

    await fixture.db.query(
      `update public.jobs set status = 'failed' where type = 'analysis'`,
    )

    // A failed job leaves the partial index, and no run was written, so the workspace is
    // eligible again. The alternative — an index over every status — would wedge the
    // workspace out of analysis permanently on one bad night.
    expect(await tick(fixture.db, PANEL_DATE)).toBe(1)
    expect(await analysisJobs(fixture.db)).toHaveLength(2)
  })

  it('enqueues one job per workspace, not one per succeeded crawl', async () => {
    // Two watchlists in the same workspace both crawled today. The analysis reads the
    // workspace's whole panel, so two jobs would be two identical runs racing each other.
    const second = await seedWatchlist(fixture.db, fixture.workspaceId, 'nu')
    await seedCrawl(fixture, { runDate: PANEL_DATE, status: 'succeeded' })
    await fixture.db.query(
      `insert into public.crawl_runs (workspace_id, watchlist_id, run_date, status, trace_id, actor)
       values ($1, $2, $3::date, 'succeeded', 'trc_test', '{"type":"schedule"}'::jsonb)`,
      [fixture.workspaceId, second, PANEL_DATE],
    )

    expect(await tick(fixture.db, PANEL_DATE)).toBe(1)
  })

  it('separates workspaces', async () => {
    const other = await seedWorkspace(fixture.db, {
      slug: 'globex',
      name: 'Globex',
      clerkOrgId: 'org_globex',
      clerkUserId: 'user_globex',
    })
    const otherWatchlist = await seedWatchlist(fixture.db, other.workspaceId)

    await seedCrawl(fixture, { runDate: PANEL_DATE, status: 'succeeded' })
    await fixture.db.query(
      `insert into public.crawl_runs (workspace_id, watchlist_id, run_date, status, trace_id, actor)
       values ($1, $2, $3::date, 'failed', 'trc_test', '{"type":"schedule"}'::jsonb)`,
      [other.workspaceId, otherWatchlist, PANEL_DATE],
    )

    expect(await tick(fixture.db, PANEL_DATE)).toBe(1)

    const jobs = await analysisJobs(fixture.db)
    expect(jobs).toHaveLength(1)
  })

  it('takes its default from the market calendar', async () => {
    // The default is `app.market_date()`, which is covered directly below against injected
    // instants. What is asserted here is only that the tick *uses* it — that passing null
    // reaches the same date the helper reports, rather than some second opinion.
    await seedCrawl(fixture, { runDate: PANEL_DATE, status: 'succeeded' })

    const [today] = await fixture.db.query<{ d: string }>(
      `select to_char(app.market_date(), 'YYYY-MM-DD') as d`,
    )
    expect(await tick(fixture.db, null)).toBe(0)

    await seedCrawl(fixture, { runDate: today!.d, status: 'succeeded' })
    expect(await tick(fixture.db, null)).toBe(1)
  })
})

describe('app.market_date', () => {
  let db: TestDb

  beforeEach(async () => {
    db = await createTestDb()
  })

  afterEach(async () => {
    await db.close()
  })

  const marketDate = async (instant: string): Promise<string> => {
    const rows = await db.query<{ d: string }>(
      `select to_char(app.market_date($1::timestamptz), 'YYYY-MM-DD') as d`,
      [instant],
    )
    return rows[0]!.d
  }

  it('rolls the day at midnight in Mexico City, not at midnight UTC', async () => {
    // 05:30 UTC on the 11th is 23:30 on the 10th in the market. This is the case a bare
    // `now()::date` gets wrong, and it is wrong for six hours out of every twenty-four —
    // which is exactly why a test that reads the wall clock passes most of the time.
    expect(await marketDate('2026-03-11T05:30:00Z')).toBe('2026-03-10')
    expect(await marketDate('2026-03-11T06:30:00Z')).toBe('2026-03-11')
  })

  it('disagrees with a naive cast at the hours that matter', async () => {
    // Guards the fixture: if the session timezone made these agree, the test above would be
    // green against a mutant. See the head of `src/testing.ts` — this has happened.
    const [row] = await db.query<{ naive: string }>(
      `select to_char((timestamptz '2026-03-11T05:30:00Z')::date, 'YYYY-MM-DD') as naive`,
    )
    expect(row!.naive).toBe('2026-03-11')
    expect(await marketDate('2026-03-11T05:30:00Z')).not.toBe(row!.naive)
  })

  it('reads the timezone database rather than assuming a fixed offset', async () => {
    // Mexico abolished DST in 2022, so for every date this product will ever crawl the
    // market sits at a flat -06:00 — which means `at time zone 'America/Mexico_City'` and
    // `- interval '6 hours'` agree on every instant a contemporary fixture can supply.
    // Measured: a mutation swapping one for the other survived a test built from 2026
    // dates, in both April and November.
    //
    // April 2021 is before the abolition, so the market was on CDT (-05:00) and the two
    // expressions part company. The assertion is not about 2021 — nothing will ever be
    // crawled for that date. It is the only available proof that the conversion consults
    // the zone rather than a constant, and a constant is what breaks on the day Mexico
    // reinstates DST or a second market is added.
    expect(await marketDate('2021-04-05T05:30:00Z')).toBe('2021-04-05')

    const [row] = await db.query<{ flat: string }>(
      `select to_char((timestamptz '2021-04-05T05:30:00Z' - interval '6 hours')::date,
                      'YYYY-MM-DD') as flat`,
    )
    expect(row!.flat).toBe('2021-04-04')

    // And the contemporary case still lands where the market says, DST or not.
    expect(await marketDate('2026-11-01T05:30:00Z')).toBe('2026-10-31')
  })

  it('is the only way any app function derives a calendar day from the clock', async () => {
    // A guardrail rather than a behavior test, and deliberately structural: the failure it
    // catches — a future function casting `now()` straight to a date — is invisible for
    // eighteen hours a day and produces a panel filed under the wrong date for the other
    // six. `market_date` itself is excluded; it is the one place the conversion belongs.
    // `materialized` is load-bearing, not style. Inlined, the planner is free to evaluate
    // `pg_get_functiondef` before the namespace filter, and it then hits an aggregate
    // somewhere in pg_catalog and errors out — the test fails for a reason that has nothing
    // to do with what it asserts. The CTE fences the filter ahead of the call.
    const offenders = await db.query<{ proname: string }>(
      `with app_functions as materialized (
         select p.oid, p.proname
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'app'
           and p.prokind = 'f'
           and p.proname <> 'market_date'
       )
       select proname from app_functions
       where pg_get_functiondef(oid) ~ 'now\\(\\)\\s*\\)?\\s*::\\s*date'
       order by 1`,
    )
    expect(offenders.map((o) => o.proname)).toEqual([])
  })
})

describe('scheduled ticks', () => {
  let db: TestDb

  beforeEach(async () => {
    db = await createTestDb()
  })

  afterEach(async () => {
    await db.close()
  })

  it('defines every function the cron entries call', async () => {
    // The migration's `do` block is a no-op under PGlite, which has no pg_cron — so the
    // schedule itself is unassertable here. What *is* assertable is that each `cron.schedule`
    // body names a function that exists with that exact signature. A typo there is a cron
    // job that errors nightly in production and nowhere else, and this is the last place it
    // can be caught before it gets there.
    const rows = await db.query<{ sig: string }>(
      `select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app'
         and p.proname in ('enqueue_daily_crawls', 'enqueue_daily_analysis', 'reap_stalled_jobs')
       order by 1`,
    )

    // Parameter names are included because `pg_get_function_identity_arguments` reports
    // them, and keeping them is the stricter assertion: renaming a parameter breaks any
    // caller that passes it by name, and there is one — `crawl:once` does not, but the
    // operator debugging at 2am with psql will.
    expect(rows.map((r) => r.sig)).toEqual([
      'enqueue_daily_analysis(target_date date)',
      'enqueue_daily_crawls(target_date date)',
      'reap_stalled_jobs(stall_after interval)',
    ])
  })

  it('knows every SQL function that mints a job, so none skips the actor check', async () => {
    // The `actor` contract is enforced in TypeScript by `isActor`, which means a producer
    // written in SQL can mint a malformed one and nothing notices until a handler refuses
    // the job in production. This list is the mechanism: adding a new job producer in SQL
    // fails here, and the fix is to add it to the actor assertion below rather than to widen
    // the list. Same shape as the `market_date` guardrail above — the catalog is the only
    // place that knows what actually exists.
    const rows = await db.query<{ proname: string }>(
      `with app_functions as materialized (
         select p.oid, p.proname
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'app' and p.prokind = 'f'
       )
       select proname from app_functions
       where pg_get_functiondef(oid) ~* 'insert\\s+into\\s+public\\.jobs'
       order by 1`,
    )

    expect(rows.map((r) => r.proname)).toEqual([
      'enqueue_daily_analysis',
      'enqueue_daily_crawls',
      'enqueue_pending_extractions',
      'enqueue_pending_semantic_tags',
    ])
  })

  it('mints an actor the handlers will accept, from every SQL producer', async () => {
    // All three producers, driven for real, and every actor they wrote checked against the
    // same predicate the workers use. `enqueue_daily_analysis` shipped without `id` and this
    // is the assertion that would have caught it without needing the whole chain — the other
    // two already had it, which is exactly why nobody looked.
    const { workspaceId } = await seedWorkspace(db, {
      slug: 'acme',
      name: 'Acme',
      clerkOrgId: 'org_acme',
      clerkUserId: 'user_acme',
    })

    // Two watchlists: the seeded crawl_run occupies the first for this date, so the crawl
    // tick's `on conflict (watchlist_id, run_date) do nothing` would otherwise make it a
    // no-op and this test would assert over one actor while claiming to cover three.
    const analyzed = await seedWatchlist(db, workspaceId, 'stori')
    await seedWatchlist(db, workspaceId, 'nu')
    await db.query(
      `insert into public.crawl_runs (workspace_id, watchlist_id, run_date, status, trace_id, actor)
       values ($1, $2, $3::date, 'succeeded', 'trc_test', '{"type":"schedule","id":"seed"}'::jsonb)`,
      [workspaceId, analyzed, PANEL_DATE],
    )

    const advertiser = await db.query<{ id: string }>(
      `insert into public.advertisers (workspace_id, meta_page_id, name)
       values ($1, 'page_1', 'Stori') returning id`,
      [workspaceId],
    )
    const creative = await db.query<{ id: string }>(
      `insert into public.creatives (workspace_id, advertiser_id, creative_hash, media_type, media_url)
       values ($1, $2, 'hash_1', 'video', 'https://cdn.example.test/a.mp4') returning id`,
      [workspaceId, advertiser[0]!.id],
    )
    await db.query('select app.enqueue_daily_crawls($1::date)', [PANEL_DATE])
    await db.query('select app.enqueue_daily_analysis($1::date)', [PANEL_DATE])
    // Takes an explicit feature schema version — it is the extractor's backlog reconciler,
    // not a cron tick, which is why it is absent from the schedule assertions above. Must run
    // before the features row below exists, or its own "no current row" gate finds nothing.
    await db.query('select app.enqueue_pending_extractions(1)')
    // Tagging is gated on a current features row with frames already sampled (spec §5) —
    // inserted only now, after the extraction reconciler above has already seen the gap it
    // needs to see. Without this row, enqueue_pending_semantic_tags below would correctly
    // find nothing and the fourth actor would go unexercised.
    await db.query(
      `insert into public.creative_features
         (workspace_id, creative_id, schema_version, semantic_frame_paths)
       values ($1, $2, 1, array['frame_a.jpg', 'frame_b.jpg', 'frame_c.jpg'])`,
      [workspaceId, creative[0]!.id],
    )
    // Same posture: the tagging backlog reconciler, also not cron-scheduled (RUNBOOK-invoked).
    await db.query('select app.enqueue_pending_semantic_tags(1)')

    const jobs = await db.query<{ type: string; actor: unknown }>(
      'select type, actor from public.jobs order by type',
    )
    // All four fired, so the loop below is over four actors and not vacuous over an empty
    // table — which is how this class of test usually passes while proving nothing.
    expect(jobs.map((j) => j.type)).toEqual(['analysis', 'crawl', 'extract', 'semantic_tag'])
    for (const job of jobs) {
      expect(isActor(job.actor), `${job.type} actor: ${JSON.stringify(job.actor)}`).toBe(true)
    }
  })

  it('lets every scheduled call run with no arguments', async () => {
    // Each cron body is `select app.f()`. A function whose only parameter lacked a default
    // would parse fine in the migration and fail at 16:00 UTC.
    for (const fn of [
      'app.enqueue_daily_crawls()',
      'app.enqueue_daily_analysis()',
      'app.reap_stalled_jobs()',
    ]) {
      await expect(db.query(`select ${fn}`)).resolves.toBeDefined()
    }
  })

  it('refuses the ticks to authenticated', async () => {
    await db.exec("set role authenticated")
    try {
      await expect(db.query('select app.enqueue_daily_analysis()')).rejects.toThrow(
        /permission denied/i,
      )
    } finally {
      await db.exec('reset role')
    }
  })
})
