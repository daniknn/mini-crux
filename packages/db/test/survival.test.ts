import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { MIGRATIONS_DIR } from '../src/index.ts'
import { asAuthenticated, createTestDb, seedWorkspace, type TestDb } from '../src/testing.ts'

/**
 * The outcome variable, proved against a real panel.
 *
 * Everything the product concludes is a statement about `days_active`, and every way of
 * getting it wrong returns a complete-looking row rather than an error. So none of these
 * assert "a row came back" — each pins the exact number, because a survival estimate biased
 * by a day is indistinguishable from a correct one at the shape level.
 *
 * Every fixture crawl is timestamped 20:00 in Mexico City, which is 02:00 UTC the *next*
 * calendar day. That is not incidental: it is the input that makes a date derived from
 * `observed_at` disagree with one derived from `run_date`. Any regression to `observed_at`
 * casting fails most of this file rather than one carefully-placed case.
 */

const ORG_A = 'org_survivalaaaaaaaaaaaa'
const ORG_B = 'org_survivalbbbbbbbbbbbb'
const USER_A = 'user_survivalaaaaaaaaaaa'
const USER_B = 'user_survivalbbbbbbbbbbb'

/** March 2026, the fixture month. `day(1)` is 2026-03-01. */
const day = (n: number): string => `2026-03-${String(n).padStart(2, '0')}`

/** An instant that lands on the given March day in the market's clock. */
const noonInMarket = (n: number): string => `${day(n)}T18:00:00Z`

type CrawlStatus = 'succeeded' | 'suspect' | 'failed'

interface DaySpec {
  day: number
  /** Omitted means no observation row — a `failed` crawl writes none at all. */
  present?: boolean
  status?: CrawlStatus
}

interface SurvivalRow {
  creative_id: string
  workspace_id: string
  creative_hash: string
  started_at: Date | null
  first_seen_at: Date
  last_seen_at: Date
  stopped_at: Date | null
  last_crawl_date: Date
  first_seen_date: Date
  stopped_date: Date | null
  end_date: Date
  days_active: number | null
  is_censored: boolean
  observation_days: number
  has_gaps: boolean
}

describe('creative_survival', () => {
  let db: TestDb
  let workspaceA: string
  let workspaceB: string
  let advertiserA: string
  let advertiserB: string
  let seq = 0

  /** Unique per call so fixtures in one test cannot collide with another's. */
  const nextHash = (): string => `hash_${++seq}`

  async function newWatchlist(workspaceId: string, query: string): Promise<string> {
    const [row] = await db.query<{ id: string }>(
      `insert into public.watchlists (workspace_id, kind, query, label)
       values ($1, 'keyword', $2, $2) returning id`,
      [workspaceId, query],
    )
    return row!.id
  }

  async function newCreative(
    workspaceId: string,
    advertiserId: string,
    hash: string,
    startedAt: string | null,
  ): Promise<string> {
    const [row] = await db.query<{ id: string }>(
      `insert into public.creatives
         (workspace_id, advertiser_id, creative_hash, media_type, ad_delivery_start_time)
       values ($1, $2, $3, 'video', $4) returning id`,
      [workspaceId, advertiserId, hash, startedAt],
    )
    return row!.id
  }

  async function crawl(
    workspaceId: string,
    watchlistId: string,
    runDate: string,
    status: CrawlStatus,
  ): Promise<string> {
    const [row] = await db.query<{ id: string }>(
      `insert into public.crawl_runs (workspace_id, watchlist_id, run_date, status, trace_id, actor)
       values ($1, $2, $3, $4, 'trc_survival_fixture', $5) returning id`,
      [workspaceId, watchlistId, runDate, status, JSON.stringify({ type: 'schedule', id: 'test' })],
    )
    return row!.id
  }

  async function observe(
    workspaceId: string,
    creativeId: string,
    runId: string,
    runDate: string,
    present: boolean,
  ): Promise<void> {
    // 20:00 in Mexico City — 02:00 UTC the following day. See the file header.
    await db.query(
      `insert into public.creative_observations
         (workspace_id, creative_id, crawl_run_id, observed_at, is_present)
       values ($1, $2, $3, ($4::date + interval '20 hours') at time zone 'America/Mexico_City', $5)`,
      [workspaceId, creativeId, runId, runDate, present],
    )
  }

  /**
   * Build one creative's whole history on a single watchlist and return its id.
   * The common case; tests needing two watchlists wire the helpers up directly.
   */
  async function panel(options: {
    workspaceId?: string
    advertiserId?: string
    startedAt?: string | null
    days: DaySpec[]
  }): Promise<string> {
    const workspaceId = options.workspaceId ?? workspaceA
    const advertiserId =
      options.advertiserId ?? (workspaceId === workspaceA ? advertiserA : advertiserB)
    const hash = nextHash()
    const creativeId = await newCreative(
      workspaceId,
      advertiserId,
      hash,
      options.startedAt === undefined ? noonInMarket(1) : options.startedAt,
    )
    const watchlistId = await newWatchlist(workspaceId, hash)

    for (const spec of options.days) {
      const runId = await crawl(workspaceId, watchlistId, day(spec.day), spec.status ?? 'succeeded')
      if (spec.present !== undefined) {
        await observe(workspaceId, creativeId, runId, day(spec.day), spec.present)
      }
    }
    return creativeId
  }

  async function survival(creativeId: string): Promise<SurvivalRow | undefined> {
    const [row] = await db.query<SurvivalRow>(
      'select * from public.creative_survival where creative_id = $1',
      [creativeId],
    )
    return row
  }

  /** Dates come back as Date objects; compare on the calendar day the view actually meant. */
  const asDate = (value: Date): string => value.toISOString().slice(0, 10)

  beforeAll(async () => {
    db = await createTestDb()

    const a = await seedWorkspace(db, {
      slug: 'acme',
      name: 'Acme',
      clerkOrgId: ORG_A,
      clerkUserId: USER_A,
    })
    const b = await seedWorkspace(db, {
      slug: 'globex',
      name: 'Globex',
      clerkOrgId: ORG_B,
      clerkUserId: USER_B,
    })
    workspaceA = a.workspaceId
    workspaceB = b.workspaceId

    const [advA] = await db.query<{ id: string }>(
      `insert into public.advertisers (workspace_id, meta_page_id, name)
       values ($1, 'page_a', 'Competitor A') returning id`,
      [workspaceA],
    )
    const [advB] = await db.query<{ id: string }>(
      `insert into public.advertisers (workspace_id, meta_page_id, name)
       values ($1, 'page_b', 'Competitor B') returning id`,
      [workspaceB],
    )
    advertiserA = advA!.id
    advertiserB = advB!.id
  })

  beforeEach(async () => {
    // asAuthenticated resets the role in a finally, but a failed assertion inside one would
    // still leave the previous test's claims set; this makes each test's start unconditional.
    await db.exec('reset role')
    // The panel is append-only to clients; the superuser connection resets it between tests.
    await db.exec('delete from public.creative_observations')
    await db.exec('delete from public.crawl_runs')
    await db.exec('delete from public.creatives')
    await db.exec('delete from public.watchlists')
  })

  afterAll(async () => {
    await db.close()
  })

  describe('censoring', () => {
    it('records a clean death from the first absence after the last sighting', async () => {
      const creativeId = await panel({
        days: [
          { day: 1, present: true },
          { day: 2, present: true },
          { day: 3, present: true },
          { day: 4, present: true },
          { day: 5, present: true },
          { day: 6, present: false },
        ],
      })

      const row = (await survival(creativeId))!
      expect(row.is_censored).toBe(false)
      expect(asDate(row.end_date)).toBe(day(6))
      // Started day 1, dead day 6 — five days, not six. Off-by-one here is the whole ballgame.
      expect(row.days_active).toBe(5)
      expect(row.observation_days).toBe(6)
      expect(row.has_gaps).toBe(false)
    })

    it('freezes a dead creative span at its death, not at the latest crawl', async () => {
      // The case the fixture above cannot see. There the last crawl *is* the death day, so
      // `stopped_date` and `last_crawl_date` coincide and taking the wrong one is invisible.
      // In production the watchlist keeps crawling long after an ad dies, and reading the
      // span's end off the latest crawl would grow every dead creative's measured lifetime
      // by one more day for every day the crawler keeps running — inflating exactly the
      // durations UC-5 correlates on, forever, with nothing in the data looking wrong.
      const creativeId = await panel({
        days: [
          { day: 1, present: true },
          { day: 2, present: true },
          { day: 3, present: true },
          { day: 4, present: false },
          { day: 5, present: false },
          { day: 6, present: false },
          { day: 7, present: false },
          { day: 8, present: false },
        ],
      })

      const row = (await survival(creativeId))!
      expect(row.is_censored).toBe(false)
      expect(asDate(row.end_date)).toBe(day(4))
      // Crawling ran four days past the death and must not have moved the number.
      expect(asDate(row.last_crawl_date)).toBe(day(8))
      expect(row.days_active).toBe(3)
      expect(row.observation_days).toBe(4)
      // The two dates UC-4's change feed filters on. Pinned here rather than only at the
      // consumer, because `end_date` coincides with `stopped_date` for every dead creative
      // and a consumer test could not tell which of the two it was actually reading.
      expect(asDate(row.first_seen_date)).toBe(day(1))
      expect(asDate(row.stopped_date!)).toBe(day(4))
    })

    it('exposes a null stopped_date for a censored creative, not its last crawl', async () => {
      // `end_date` falls back to the last crawl when nothing died; `stopped_date` must not.
      // A change feed reading "detenidos" off `end_date` would report every living creative
      // as stopped on the day of the most recent crawl — every one of them, every day.
      const creativeId = await panel({
        days: [
          { day: 1, present: true },
          { day: 2, present: true },
          { day: 3, present: true },
        ],
      })

      const row = (await survival(creativeId))!
      expect(row.is_censored).toBe(true)
      expect(row.stopped_date).toBeNull()
      expect(asDate(row.end_date)).toBe(day(3))
      expect(asDate(row.first_seen_date)).toBe(day(1))
    })

    it('marks a creative still running at the last look as censored', async () => {
      const creativeId = await panel({
        days: [
          { day: 1, present: true },
          { day: 2, present: true },
          { day: 3, present: true },
          { day: 4, present: true },
          { day: 5, present: true },
        ],
      })

      const row = (await survival(creativeId))!
      expect(row.is_censored).toBe(true)
      expect(row.stopped_at).toBeNull()
      // A lower bound, not a duration: the creative was alive when we stopped looking.
      expect(asDate(row.last_crawl_date)).toBe(day(5))
      expect(row.days_active).toBe(4)
    })

    it('does not read an absence before the last sighting as a death', async () => {
      // The creative demonstrably came back on day 3, so day 2 was a crawl that missed it.
      const creativeId = await panel({
        days: [
          { day: 1, present: true },
          { day: 2, present: false },
          { day: 3, present: true },
          { day: 4, present: true },
        ],
      })

      const row = (await survival(creativeId))!
      expect(row.stopped_at).toBeNull()
      expect(row.is_censored).toBe(true)
      expect(row.days_active).toBe(3)
    })
  })

  describe('left-censoring', () => {
    it('measures from Meta start date, not from when we first saw it', async () => {
      // 2026-01-30 is exactly 30 days before the first crawl. The whole point of rule 5:
      // an ad already running before we started watching is still measured correctly.
      const creativeId = await panel({
        startedAt: '2026-01-30T18:00:00Z',
        days: [
          { day: 1, present: true },
          { day: 3, present: true },
          { day: 5, present: true },
        ],
      })

      const row = (await survival(creativeId))!
      // 30 days before we looked + 4 days observed. Using first_seen_at as the start would
      // report 4 and silently truncate the age of every ad that predates the panel.
      expect(row.days_active).toBe(34)
      expect(row.days_active).toBeGreaterThanOrEqual(30)
      expect(row.is_censored).toBe(true)
    })

    it('reports null rather than guessing when Meta gave no start date', async () => {
      const creativeId = await panel({
        startedAt: null,
        days: [
          { day: 1, present: true },
          { day: 2, present: true },
        ],
      })

      const row = (await survival(creativeId))!
      expect(row.started_at).toBeNull()
      expect(row.days_active).toBeNull()
      // Rule 1: is_censored travels with days_active even when days_active is unmeasurable.
      expect(row.is_censored).toBe(true)
      expect(row.observation_days).toBe(2)
    })
  })

  describe('crawl health', () => {
    it('flags a span crossing a failed crawl', async () => {
      const creativeId = await panel({
        days: [
          { day: 1, present: true },
          { day: 2, present: true },
          { day: 3, status: 'failed' }, // writes no observation at all
          { day: 4, present: true },
          { day: 5, present: true },
        ],
      })

      const row = (await survival(creativeId))!
      expect(row.has_gaps).toBe(true)
      // Four healthy looks across a five-day span — the consumer can see the panel is thin.
      expect(row.observation_days).toBe(4)
      expect(row.is_censored).toBe(true)
    })

    it('flags a span crossing a suspect crawl', async () => {
      const creativeId = await panel({
        days: [
          { day: 1, present: true },
          { day: 2, present: true },
          { day: 3, status: 'suspect', present: true },
          { day: 4, present: true },
          { day: 5, present: true },
        ],
      })

      const row = (await survival(creativeId))!
      expect(row.has_gaps).toBe(true)
      expect(row.observation_days).toBe(4)
    })

    it('never lets an absence on a suspect crawl manufacture a death', async () => {
      // A suspect run withholds absences at write time, so this row should not exist. The
      // view refuses it anyway: a future writer bug must not be able to invent a death in
      // the one variable the product exists to measure.
      const creativeId = await panel({
        days: [
          { day: 1, present: true },
          { day: 2, present: true },
          { day: 3, present: true },
          { day: 4, present: true },
          { day: 5, present: true },
          { day: 6, status: 'suspect', present: false },
        ],
      })

      const row = (await survival(creativeId))!
      expect(row.stopped_at).toBeNull()
      expect(row.is_censored).toBe(true)
      // The span ends at the last healthy look, so the suspect day falls outside it.
      expect(asDate(row.end_date)).toBe(day(5))
      expect(row.days_active).toBe(4)
    })

    it('does not flag a gap that another covering watchlist crawled healthily', async () => {
      // Two watchlists both pick this creative up. One fails on day 3; the other succeeds
      // and observes it. The day's history is not lost, so the creative stays in the cohort.
      const hash = nextHash()
      const creativeId = await newCreative(workspaceA, advertiserA, hash, noonInMarket(1))
      const first = await newWatchlist(workspaceA, `${hash}_one`)
      const second = await newWatchlist(workspaceA, `${hash}_two`)

      for (const n of [1, 2, 3]) {
        const failing = await crawl(workspaceA, first, day(n), n === 3 ? 'failed' : 'succeeded')
        if (n !== 3) await observe(workspaceA, creativeId, failing, day(n), true)

        const healthy = await crawl(workspaceA, second, day(n), 'succeeded')
        await observe(workspaceA, creativeId, healthy, day(n), true)
      }

      const row = (await survival(creativeId))!
      expect(row.has_gaps).toBe(false)
      // Distinct days, not distinct runs — two watchlists on the same day is still one look.
      expect(row.observation_days).toBe(3)
    })

    it('flags the day when every covering watchlist failed on it', async () => {
      const hash = nextHash()
      const creativeId = await newCreative(workspaceA, advertiserA, hash, noonInMarket(1))
      const first = await newWatchlist(workspaceA, `${hash}_one`)
      const second = await newWatchlist(workspaceA, `${hash}_two`)

      // Day 4 matters: the span ends at the last healthy look, so without it day 3 would fall
      // outside the span entirely and be correctly ignored rather than flagged.
      for (const n of [1, 2, 3, 4]) {
        for (const watchlist of [first, second]) {
          const runId = await crawl(workspaceA, watchlist, day(n), n === 3 ? 'failed' : 'succeeded')
          if (n !== 3) await observe(workspaceA, creativeId, runId, day(n), true)
        }
      }

      const row = (await survival(creativeId))!
      expect(row.has_gaps).toBe(true)
      expect(row.observation_days).toBe(3)
    })

    it('ignores a failed crawl that lands after the span has ended', async () => {
      // The mirror of the case above. The creative was last seen on day 2 and the panel ends
      // there; a later outage says nothing about the stretch actually being measured, and
      // flagging it would drop a fully-observed creative out of the cohort.
      const creativeId = await panel({
        days: [
          { day: 1, present: true },
          { day: 2, present: true },
          { day: 3, status: 'failed' },
        ],
      })

      const row = (await survival(creativeId))!
      expect(row.has_gaps).toBe(false)
      expect(asDate(row.end_date)).toBe(day(2))
      expect(row.is_censored).toBe(true)
    })
  })

  describe('determinism', () => {
    it('reproduces identical rows after the view is dropped and rebuilt', async () => {
      await panel({
        days: [
          { day: 1, present: true },
          { day: 2, present: true },
          { day: 3, present: false },
        ],
      })
      await panel({
        startedAt: '2026-02-01T18:00:00Z',
        days: [
          { day: 1, present: true },
          { day: 2, status: 'failed' },
          { day: 3, present: true },
        ],
      })

      const query = 'select * from public.creative_survival order by creative_hash'
      const before = await db.query<SurvivalRow>(query)
      expect(before).toHaveLength(2)

      // Rebuild from the migration on disk, not from a copy pasted into the test — otherwise
      // this proves the test file is deterministic rather than the migration.
      const sql = await readFile(join(MIGRATIONS_DIR, '0005_survival.sql'), 'utf8')
      await db.exec('drop view public.creative_survival')
      await db.exec(sql)

      const after = await db.query<SurvivalRow>(query)
      expect(after).toEqual(before)
    })

    it('returns the same numbers no matter what timezone the caller reads it in', async () => {
      // The regression that motivated deriving every date from run_date. Before that change
      // this same panel returned days_active 30 in Mexico City and 31 in UTC.
      const creativeId = await panel({
        startedAt: '2026-02-01T18:00:00Z',
        days: [
          { day: 1, present: true },
          { day: 2, present: true },
          { day: 3, present: false },
        ],
      })

      const readings: { days_active: number | null; observation_days: number }[] = []
      for (const zone of ['America/Mexico_City', 'UTC', 'Asia/Tokyo', 'Pacific/Kiritimati']) {
        await db.exec(`set time zone '${zone}'`)
        const row = (await survival(creativeId))!
        readings.push({ days_active: row.days_active, observation_days: row.observation_days })
      }
      await db.exec('reset time zone')

      // Feb 1 to Mar 3, measured on the market's calendar.
      expect(readings).toEqual(Array(4).fill({ days_active: 30, observation_days: 3 }))
    })
  })

  describe('tenancy', () => {
    beforeEach(async () => {
      await panel({ workspaceId: workspaceA, days: [{ day: 1, present: true }] })
      await panel({ workspaceId: workspaceB, days: [{ day: 1, present: true }] })
    })

    it('shows each workspace only its own survival rows', async () => {
      // The leak this guards against is invisible from the base tables: without
      // security_invoker the view runs as its owner, which bypasses RLS, while
      // creative_observations still reports its policy as enabled.
      const asA = await asAuthenticated(db, { sub: USER_A, org_id: ORG_A }, (tx) =>
        tx.query<{ workspace_id: string }>('select workspace_id from public.creative_survival'),
      )
      const asB = await asAuthenticated(db, { sub: USER_B, org_id: ORG_B }, (tx) =>
        tx.query<{ workspace_id: string }>('select workspace_id from public.creative_survival'),
      )

      expect(asA.map((r) => r.workspace_id)).toEqual([workspaceA])
      expect(asB.map((r) => r.workspace_id)).toEqual([workspaceB])
    })

    it('returns nothing through the view without an org claim', async () => {
      const rows = await asAuthenticated(db, { sub: USER_A }, (tx) =>
        tx.query('select creative_id from public.creative_survival'),
      )
      expect(rows).toEqual([])
    })

    it('sees both rows only as the superuser, proving the fixture spans two tenants', async () => {
      // Without this the isolation assertions above would also pass on an empty panel.
      const rows = await db.query<{ workspace_id: string }>(
        'select workspace_id from public.creative_survival',
      )
      expect(new Set(rows.map((r) => r.workspace_id))).toEqual(new Set([workspaceA, workspaceB]))
    })
  })
})
