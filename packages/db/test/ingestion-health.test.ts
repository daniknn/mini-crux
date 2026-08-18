import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  getIngestionHealth,
  summarizeIngestionHealth,
  type IngestionHealthRow,
} from '../src/health.ts'
import { asAuthenticated, createTestDb, seedWorkspace, type TestDb } from '../src/testing.ts'

/**
 * The alarm.
 *
 * Two halves, tested two ways, because they fail in different directions.
 *
 * The view half is about *absence*: the interesting assertion is that a watchlist with no
 * crawl row still produces a row. A test that only ever seeds crawls would pass against a
 * plain inner join and prove nothing about the one case the feature exists for.
 *
 * The summarizer half is about *judgement*, and it takes its clock as a parameter, so the
 * grace window can be crossed in a fixture instead of waited out.
 */

interface Fixture {
  db: TestDb
  workspaceId: string
  clerkOrgId: string
  clerkUserId: string
}

async function seedWatchlist(
  db: TestDb,
  workspaceId: string,
  input: { query: string; label: string; isActive?: boolean },
): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `insert into public.watchlists (workspace_id, kind, query, country, label, is_active)
     values ($1, 'keyword', $2, 'MX', $3, $4)
     returning id`,
    [workspaceId, input.query, input.label, input.isActive ?? true],
  )
  return rows[0]!.id
}

/**
 * `runDate` defaults to the market's today — spelled as `app.market_date()` rather than a
 * JS date so the fixture cannot disagree with the view about which day it means.
 */
async function seedCrawl(
  db: TestDb,
  fixture: { workspaceId: string; watchlistId: string },
  input: {
    status: 'running' | 'succeeded' | 'suspect' | 'failed'
    runDateSql?: string
    error?: string | null
    startedAt?: string
  },
): Promise<void> {
  await db.query(
    `insert into public.crawl_runs
       (workspace_id, watchlist_id, run_date, status, attempt, trace_id, actor, error, started_at)
     values ($1, $2, ${input.runDateSql ?? 'app.market_date()'}, $3::crawl_status, 2,
             'trc_test', '{"type":"schedule","id":"w"}'::jsonb, $4,
             coalesce($5::timestamptz, now()))`,
    [
      fixture.workspaceId,
      fixture.watchlistId,
      input.status,
      input.error ?? null,
      input.startedAt ?? null,
    ],
  )
}

describe('public.ingestion_health (the view)', () => {
  let fixture: Fixture

  beforeEach(async () => {
    const db = await createTestDb()
    const { workspaceId } = await seedWorkspace(db, {
      slug: 'acme',
      name: 'Acme',
      clerkOrgId: 'org_acme',
      clerkUserId: 'user_acme',
    })
    fixture = { db, workspaceId, clerkOrgId: 'org_acme', clerkUserId: 'user_acme' }
  })

  afterEach(async () => {
    await fixture.db.close()
  })

  it('reports a succeeded crawl for today', async () => {
    const watchlistId = await seedWatchlist(fixture.db, fixture.workspaceId, {
      query: 'stori',
      label: 'Fintech MX',
    })
    await seedCrawl(fixture.db, { workspaceId: fixture.workspaceId, watchlistId }, {
      status: 'succeeded',
    })

    const rows = await getIngestionHealth(fixture.db)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ label: 'Fintech MX', state: 'succeeded', attempt: 2 })
    expect(rows[0]!.crawlRunId).not.toBeNull()
  })

  it('turns a missing crawl into a `never-started` row rather than no row', async () => {
    await seedWatchlist(fixture.db, fixture.workspaceId, { query: 'nu', label: 'Nu MX' })

    const rows = await getIngestionHealth(fixture.db)

    // The entire feature in one assertion. An inner join returns zero rows here, and zero
    // rows is what a healthy instance with no watchlists also returns.
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ label: 'Nu MX', state: 'never-started' })
    expect(rows[0]!.crawlRunId).toBeNull()
  })

  it('surfaces a failed crawl with its error', async () => {
    const watchlistId = await seedWatchlist(fixture.db, fixture.workspaceId, {
      query: 'stori',
      label: 'Fintech MX',
    })
    await seedCrawl(fixture.db, { workspaceId: fixture.workspaceId, watchlistId }, {
      status: 'failed',
      error: 'provider timeout after 3 attempts',
    })

    const rows = await getIngestionHealth(fixture.db)

    expect(rows[0]).toMatchObject({
      state: 'failed',
      error: 'provider timeout after 3 attempts',
    })
  })

  it("ignores inactive watchlists — a decision not to crawl is not a failure to", async () => {
    await seedWatchlist(fixture.db, fixture.workspaceId, {
      query: 'paused',
      label: 'Paused',
      isActive: false,
    })
    await seedWatchlist(fixture.db, fixture.workspaceId, { query: 'live', label: 'Live' })

    const rows = await getIngestionHealth(fixture.db)

    expect(rows.map((r) => r.label)).toEqual(['Live'])
  })

  it("does not let yesterday's success stand in for today's", async () => {
    const watchlistId = await seedWatchlist(fixture.db, fixture.workspaceId, {
      query: 'stori',
      label: 'Fintech MX',
    })
    await seedCrawl(fixture.db, { workspaceId: fixture.workspaceId, watchlistId }, {
      status: 'succeeded',
      runDateSql: "app.market_date() - interval '1 day'",
    })

    const rows = await getIngestionHealth(fixture.db)

    // The join is date-scoped. Without the `and r.run_date = ...` clause this reads
    // `succeeded` forever after the first good day, which is the most dangerous possible
    // failure of an alarm: permanently green.
    expect(rows[0]!.state).toBe('never-started')
  })

  it("uses the market's day under session timezones that cannot both agree with it", async () => {
    const watchlistId = await seedWatchlist(fixture.db, fixture.workspaceId, {
      query: 'stori',
      label: 'Fintech MX',
    })
    await seedCrawl(fixture.db, { workspaceId: fixture.workspaceId, watchlistId }, {
      status: 'succeeded',
    })

    // Mexico City is UTC-6. Kiritimati is +14 (20 hours ahead of the market) and Pago Pago
    // is -11 (5 hours behind it). Work through the local hours and no instant exists where
    // both of those share the market's calendar date: for the first ~4 hours of a market
    // day Pago Pago is still on the previous one, and for the remaining ~20 Kiritimati has
    // already rolled to the next.
    //
    // That is the point. `app.market_date()` and a bare `(now())::date` agree for eighteen
    // hours out of twenty-four under UTC, which is exactly how the inline conversion in
    // 0003 stayed untested — a fixture where two candidate expressions coincide tests
    // neither. Asserting under both of these zones leaves a bare cast nowhere to hide.
    const seen: { zone: string; marketDate: string; sessionDate: string; state: string }[] = []
    try {
      for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
        await fixture.db.exec(`set time zone '${zone}'`)
        const [session] = await fixture.db.query<{ d: string }>('select (now())::date::text as d')
        const rows = await getIngestionHealth(fixture.db)
        seen.push({
          zone,
          marketDate: rows[0]!.marketDate,
          sessionDate: session!.d,
          state: rows[0]!.state,
        })
      }
    } finally {
      await fixture.db.exec("set time zone 'UTC'")
    }

    // The crawl was seeded at `app.market_date()`, so the join finds it only if the view
    // agrees about which day that is. A bare cast disagrees under at least one of these.
    expect(seen.map((s) => s.state)).toEqual(['succeeded', 'succeeded'])
    // And the reported date is a property of the market, not of whoever is reading.
    expect(seen[0]!.marketDate).toBe(seen[1]!.marketDate)
    // Guard against the fixture decaying into a tautology if a zone's offset ever changes:
    // if both sessions happened to agree with the market, the two assertions above would
    // pass for a bare cast too, and this test would be worthless without saying so.
    expect(seen.some((s) => s.sessionDate !== s.marketDate)).toBe(true)
  })

  it('is filtered by RLS for an authenticated reader', async () => {
    const mine = await seedWatchlist(fixture.db, fixture.workspaceId, {
      query: 'stori',
      label: 'Mine',
    })
    await seedCrawl(fixture.db, { workspaceId: fixture.workspaceId, watchlistId: mine }, {
      status: 'succeeded',
    })

    const other = await seedWorkspace(fixture.db, {
      slug: 'rival',
      name: 'Rival',
      clerkOrgId: 'org_rival',
      clerkUserId: 'user_rival',
    })
    await seedWatchlist(fixture.db, other.workspaceId, { query: 'nu', label: 'Theirs' })

    // Privileged (BYPASSRLS) — what the uptime endpoint sees.
    const asService = await getIngestionHealth(fixture.db)
    expect(asService.map((r) => r.label).sort()).toEqual(['Mine', 'Theirs'])

    // As the operator — what the dashboard sees. `security_invoker` is the only reason
    // these two differ; without it the view runs as its owner and hands every workspace's
    // competitor list to whoever asks.
    const asOperator = await asAuthenticated(
      fixture.db,
      { sub: fixture.clerkUserId, org_id: fixture.clerkOrgId },
      (db) => getIngestionHealth(db),
    )
    expect(asOperator.map((r) => r.label)).toEqual(['Mine'])
  })
})

describe('summarizeIngestionHealth (the judgement)', () => {
  const NOW = new Date('2026-03-10T15:00:00Z')

  function row(overrides: Partial<IngestionHealthRow> = {}): IngestionHealthRow {
    return {
      workspaceId: 'ws-1',
      watchlistId: 'wl-1',
      label: 'Fintech MX',
      query: 'stori',
      country: 'MX',
      marketDate: '2026-03-10',
      state: 'succeeded',
      crawlRunId: 'run-1',
      attempt: 1,
      error: null,
      startedAt: new Date('2026-03-10T14:00:00Z'),
      finishedAt: new Date('2026-03-10T14:05:00Z'),
      ...overrides,
    }
  }

  it('is ok with no watchlists at all', () => {
    const summary = summarizeIngestionHealth([], { now: NOW })

    // "Nothing to do" is not "something nobody did". Paging an instance that has not
    // finished onboarding is how the pager gets ignored.
    expect(summary.status).toBe('ok')
    expect(summary.marketDate).toBeNull()
    expect(summary.counts.watchlists).toBe(0)
  })

  it('is ok when every watchlist succeeded', () => {
    const summary = summarizeIngestionHealth(
      [row(), row({ watchlistId: 'wl-2', label: 'Nu MX' })],
      { now: NOW },
    )

    expect(summary.status).toBe('ok')
    expect(summary.counts).toEqual({ watchlists: 2, succeeded: 2, inFlight: 0, offenders: 0 })
    expect(summary.marketDate).toBe('2026-03-10')
  })

  it('names a failed crawl and carries its error', () => {
    const summary = summarizeIngestionHealth(
      [row({ state: 'failed', error: 'provider 503', attempt: 3 })],
      { now: NOW },
    )

    expect(summary.status).toBe('degraded')
    expect(summary.offenders).toEqual([
      {
        workspaceId: 'ws-1',
        watchlistId: 'wl-1',
        label: 'Fintech MX',
        reason: 'failed',
        error: 'provider 503',
        attempt: 3,
        startedAt: new Date('2026-03-10T14:00:00Z'),
      },
    ])
  })

  it('distinguishes never-started from failed', () => {
    const summary = summarizeIngestionHealth(
      [
        row({ state: 'failed', error: 'provider 503' }),
        row({ watchlistId: 'wl-2', label: 'Nu MX', state: 'never-started', crawlRunId: null }),
      ],
      { now: NOW },
    )

    // Rule 9 of the spec: different runbook entries, and only one is fixed by retrying.
    // Collapsing them into a single "unhealthy" is the failure this whole file guards.
    expect(summary.offenders.map((o) => o.reason)).toEqual(['failed', 'never-started'])
  })

  it('treats a suspect crawl as an offender', () => {
    const summary = summarizeIngestionHealth([row({ state: 'suspect' })], { now: NOW })

    // Data landed, so nothing looks broken — but the analysis tick refuses a suspect panel
    // date, so the dashboard silently stops updating. Silence is the thing being alarmed on.
    expect(summary.status).toBe('degraded')
    expect(summary.offenders[0]!.reason).toBe('suspect')
  })

  it('leaves a crawl still running inside the grace window alone', () => {
    const summary = summarizeIngestionHealth(
      [row({ state: 'running', startedAt: new Date('2026-03-10T14:30:00Z'), finishedAt: null })],
      { now: NOW, inFlightGraceMs: 60 * 60 * 1000 },
    )

    // 30 minutes in. Returning 503 here means red every morning while the crawl legitimately
    // works, and an alarm that is red every morning is muted within a week.
    expect(summary.status).toBe('ok')
    expect(summary.counts).toEqual({ watchlists: 1, succeeded: 0, inFlight: 1, offenders: 0 })
  })

  it('calls a crawl stalled once it runs past the grace window', () => {
    const summary = summarizeIngestionHealth(
      [row({ state: 'running', startedAt: new Date('2026-03-10T13:00:00Z'), finishedAt: null })],
      { now: NOW, inFlightGraceMs: 60 * 60 * 1000 },
    )

    // Two hours in. The worker that claimed it is gone, and without this branch that looks
    // exactly like a healthy morning for the rest of the day.
    expect(summary.status).toBe('degraded')
    expect(summary.offenders[0]!.reason).toBe('stalled')
  })

  it('treats an unknown start time as stalled, not as healthy', () => {
    const summary = summarizeIngestionHealth(
      [row({ state: 'running', startedAt: null, finishedAt: null })],
      { now: NOW },
    )

    expect(summary.offenders[0]!.reason).toBe('stalled')
  })

  it('does not attach an error to an offence that did not produce one', () => {
    const summary = summarizeIngestionHealth(
      [row({ state: 'never-started', error: 'stale message from a previous attempt' })],
      { now: NOW },
    )

    // An operator reading a wrong error is worse off than one reading none.
    expect(summary.offenders[0]!.error).toBeNull()
  })

  it('counts every category exactly once', () => {
    const summary = summarizeIngestionHealth(
      [
        row({ watchlistId: 'a', state: 'succeeded' }),
        row({ watchlistId: 'b', state: 'failed' }),
        row({ watchlistId: 'c', state: 'never-started' }),
        row({ watchlistId: 'd', state: 'suspect' }),
        row({ watchlistId: 'e', state: 'running', startedAt: new Date('2026-03-10T14:55:00Z') }),
      ],
      { now: NOW },
    )

    expect(summary.counts).toEqual({ watchlists: 5, succeeded: 1, inFlight: 1, offenders: 3 })
    expect(summary.counts.succeeded + summary.counts.inFlight + summary.counts.offenders).toBe(
      summary.counts.watchlists,
    )
  })
})
