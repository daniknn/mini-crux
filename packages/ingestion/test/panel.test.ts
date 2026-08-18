import { newMessageId } from '@mini-crux/core'
import type { TestDb } from '@mini-crux/db/testing'
import { asAuthenticated, createTestDb, seedWorkspace } from '@mini-crux/db/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runCrawl } from '../src/crawl.ts'
import { runParse } from '../src/parse.ts'
import { createFixtureProvider, fixtureAd } from '../src/providers/ad-library/index.ts'
import type { AdLibraryProvider } from '../src/providers/ad-library/index.ts'
import { createMemoryStore } from '../src/storage.ts'
import type { ObjectStore } from '../src/storage.ts'
import { collectAlerts, instantSleep, runDay, seedWatchlist, tick } from '../src/testing.ts'

/**
 * UC-1 acceptance. Every assertion here is about the panel being *honest*: that it records
 * what we saw, records what we failed to see as a different fact, and never invents either.
 */

const DAY_1 = '2026-03-01'
const DAY_2 = '2026-03-02'
const DAY_3 = '2026-03-03'

let db: TestDb
let store: ObjectStore
let clock: Date

/** Advance the panel's clock so each day's observations sort deterministically. */
function setDay(date: string): void {
  clock = new Date(`${date}T14:00:00.000Z`)
}

const now = (): Date => clock

beforeEach(async () => {
  db = await createTestDb()
  store = createMemoryStore()
  setDay(DAY_1)
})

afterEach(async () => {
  await db.close()
})

async function observationsFor(creativeHash: string): Promise<
  { is_present: boolean; variant_count: number; run_date: string }[]
> {
  return db.query(
    `select o.is_present, o.variant_count, r.run_date::text as run_date
     from public.creative_observations o
     join public.creatives c on c.id = o.creative_id
     join public.crawl_runs r on r.id = o.crawl_run_id
     where c.creative_hash = $1
     order by r.run_date`,
    [creativeHash],
  )
}

async function creativeHashes(): Promise<string[]> {
  const rows = await db.query<{ creative_hash: string }>(
    'select creative_hash from public.creatives order by creative_hash',
  )
  return rows.map((r) => r.creative_hash)
}

describe('daily ingestion', () => {
  describe('the tick', () => {
    it('enqueues exactly one crawl job per active watchlist per day', async () => {
      const { workspaceId } = await seedWorkspace(db, {
        slug: 'acme',
        name: 'Acme',
        clerkOrgId: 'org_acme',
        clerkUserId: 'user_acme',
      })
      await seedWatchlist(db, { workspaceId, query: 'stori' })
      await seedWatchlist(db, { workspaceId, query: 'nu' })

      expect(await tick(db, DAY_1)).toBe(2)
      // The whole point: a second tick on the same day is a no-op, enforced by the
      // unique constraint rather than by checking first.
      expect(await tick(db, DAY_1)).toBe(0)
      expect(await tick(db, DAY_2)).toBe(2)

      const jobs = await db.query<{ n: string }>(
        "select count(*) as n from public.jobs where type = 'crawl'",
      )
      expect(Number(jobs[0]!.n)).toBe(4)
    })

    it('skips inactive watchlists', async () => {
      const { workspaceId } = await seedWorkspace(db, {
        slug: 'acme',
        name: 'Acme',
        clerkOrgId: 'org_acme',
        clerkUserId: 'user_acme',
      })
      const { watchlistId } = await seedWatchlist(db, { workspaceId })
      await db.query('update public.watchlists set is_active = false where id = $1', [watchlistId])

      expect(await tick(db, DAY_1)).toBe(0)
    })
  })

  describe('the panel', () => {
    it('records one observation per creative per day across a 3-day run', async () => {
      const { workspaceId } = await seedWorkspace(db, {
        slug: 'acme',
        name: 'Acme',
        clerkOrgId: 'org_acme',
        clerkUserId: 'user_acme',
      })
      const { watchlistId } = await seedWatchlist(db, { workspaceId })

      const ads = [
        fixtureAd({ adArchiveId: 'ad_1', adCopy: 'Sin anualidad.' }),
        fixtureAd({ adArchiveId: 'ad_2', adCopy: 'Sin buró.' }),
      ]
      const provider = createFixtureProvider([{ ads }, { ads }, { ads }])
      const deps = { db, store, provider, now, sleep: instantSleep }

      for (const runDate of [DAY_1, DAY_2, DAY_3]) {
        setDay(runDate)
        await runDay(deps, { watchlistId, runDate })
      }

      const hashes = await creativeHashes()
      expect(hashes).toHaveLength(2)

      for (const hash of hashes) {
        const observations = await observationsFor(hash)
        expect(observations.map((o) => o.run_date)).toEqual([DAY_1, DAY_2, DAY_3])
        expect(observations.every((o) => o.is_present)).toBe(true)
      }
    })

    it('records a disappearance as an explicit absence, not a missing row', async () => {
      const { workspaceId } = await seedWorkspace(db, {
        slug: 'acme',
        name: 'Acme',
        clerkOrgId: 'org_acme',
        clerkUserId: 'user_acme',
      })
      const { watchlistId } = await seedWatchlist(db, { workspaceId })

      const survivor = fixtureAd({ adArchiveId: 'ad_1', adCopy: 'Sin anualidad.' })
      const doomed = fixtureAd({ adArchiveId: 'ad_2', adCopy: 'Sin buró.' })

      const provider = createFixtureProvider([
        { ads: [survivor, doomed] },
        { ads: [survivor, doomed] },
        { ads: [survivor] },
      ])
      const deps = { db, store, provider, now, sleep: instantSleep }

      for (const runDate of [DAY_1, DAY_2, DAY_3]) {
        setDay(runDate)
        await runDay(deps, { watchlistId, runDate })
      }

      const rows = await db.query<{ ad_copy: string; run_date: string; is_present: boolean }>(
        `select c.ad_copy, r.run_date::text as run_date, o.is_present
         from public.creative_observations o
         join public.creatives c on c.id = o.creative_id
         join public.crawl_runs r on r.id = o.crawl_run_id
         where c.ad_copy = 'Sin buró.'
         order by r.run_date`,
      )

      expect(rows.map((r) => [r.run_date, r.is_present])).toEqual([
        [DAY_1, true],
        [DAY_2, true],
        // The row that makes this a survival dataset: we looked, and it was gone.
        [DAY_3, false],
      ])
    })

    it('deduplicates one creative served under two ad_archive_ids', async () => {
      const { workspaceId } = await seedWorkspace(db, {
        slug: 'acme',
        name: 'Acme',
        clerkOrgId: 'org_acme',
        clerkUserId: 'user_acme',
      })
      const { watchlistId } = await seedWatchlist(db, { workspaceId })

      // Same advertiser, same copy, same media type — one creative, two ads.
      const provider = createFixtureProvider([
        {
          ads: [
            fixtureAd({ adArchiveId: 'ad_1', adCopy: 'Igual.', variantCount: 3 }),
            fixtureAd({ adArchiveId: 'ad_2', adCopy: 'Igual.', variantCount: 4 }),
          ],
        },
      ])

      await runDay({ db, store, provider, now, sleep: instantSleep }, { watchlistId, runDate: DAY_1 })

      const creatives = await db.query<{ ad_archive_ids: string[] }>(
        'select ad_archive_ids from public.creatives',
      )
      expect(creatives).toHaveLength(1)
      expect(creatives[0]!.ad_archive_ids.sort()).toEqual(['ad_1', 'ad_2'])

      const observations = await db.query<{ variant_count: number }>(
        'select variant_count from public.creative_observations',
      )
      expect(observations).toHaveLength(1)
      // Variants are per archive id; the creative carries their sum.
      expect(observations[0]!.variant_count).toBe(7)
    })

    it('does not fork a creative when the signed media URL rotates', async () => {
      // Ad Library media URLs are signed and change between crawls. Keying identity on one
      // would mint a new creative daily and cap every ad's observed life at a single day —
      // silently, and fatally for the survival estimate.
      const { workspaceId } = await seedWorkspace(db, {
        slug: 'acme',
        name: 'Acme',
        clerkOrgId: 'org_acme',
        clerkUserId: 'user_acme',
      })
      const { watchlistId } = await seedWatchlist(db, { workspaceId })

      const provider = createFixtureProvider([
        { ads: [fixtureAd({ adArchiveId: 'ad_1', mediaUrl: 'https://cdn/x?sig=day1' })] },
        { ads: [fixtureAd({ adArchiveId: 'ad_1', mediaUrl: 'https://cdn/x?sig=day2' })] },
      ])
      const deps = { db, store, provider, now, sleep: instantSleep }

      for (const runDate of [DAY_1, DAY_2]) {
        setDay(runDate)
        await runDay(deps, { watchlistId, runDate })
      }

      expect(await creativeHashes()).toHaveLength(1)
      const observations = await observationsFor((await creativeHashes())[0]!)
      expect(observations.map((o) => o.is_present)).toEqual([true, true])
    })
  })

  describe('run health', () => {
    it('writes no observations at all when the crawl fails, and raises a P0', async () => {
      const { workspaceId } = await seedWorkspace(db, {
        slug: 'acme',
        name: 'Acme',
        clerkOrgId: 'org_acme',
        clerkUserId: 'user_acme',
      })
      const { watchlistId } = await seedWatchlist(db, { workspaceId })

      const provider = createFixtureProvider([
        { ads: [fixtureAd({ adArchiveId: 'ad_1' })] },
        { fail: { message: 'apify timed out' }, ads: [] },
      ])
      const { alerts, onAlert } = collectAlerts()
      const deps = { db, store, provider, now, sleep: instantSleep, onAlert }

      setDay(DAY_1)
      await runDay(deps, { watchlistId, runDate: DAY_1 })
      setDay(DAY_2)
      const day2 = await runDay(deps, { watchlistId, runDate: DAY_2 })

      expect(day2.crawl.status).toBe('failed')

      const run = await db.query<{ status: string; error: string }>(
        'select status, error from public.crawl_runs where run_date = $1::date',
        [DAY_2],
      )
      expect(run[0]!.status).toBe('failed')

      // The critical distinction: a day we could not crawl must NOT look like a day on
      // which everything died.
      const day2Observations = await db.query<{ n: string }>(
        `select count(*) as n from public.creative_observations o
         join public.crawl_runs r on r.id = o.crawl_run_id
         where r.run_date = $1::date`,
        [DAY_2],
      )
      expect(Number(day2Observations[0]!.n)).toBe(0)
      expect(alerts).toHaveLength(1)
      expect(alerts[0]!.severity).toBe('p0')
    })

    it('retries a transient provider failure within the same day', async () => {
      const { workspaceId } = await seedWorkspace(db, {
        slug: 'acme',
        name: 'Acme',
        clerkOrgId: 'org_acme',
        clerkUserId: 'user_acme',
      })
      const { watchlistId } = await seedWatchlist(db, { workspaceId })

      const provider = createFixtureProvider([
        { fail: { message: 'rate limited', retryable: true }, ads: [] },
        { ads: [fixtureAd({ adArchiveId: 'ad_1' })] },
      ])

      const outcome = await runDay(
        { db, store, provider, now, sleep: instantSleep },
        { watchlistId, runDate: DAY_1 },
      )

      expect(outcome.crawl.status).toBe('landed')
      expect(provider.calls).toHaveLength(2)
    })

    it('stops retrying a non-retryable provider error', async () => {
      const { workspaceId } = await seedWorkspace(db, {
        slug: 'acme',
        name: 'Acme',
        clerkOrgId: 'org_acme',
        clerkUserId: 'user_acme',
      })
      const { watchlistId } = await seedWatchlist(db, { workspaceId })

      const provider = createFixtureProvider([
        { fail: { message: 'actor not found', retryable: false }, ads: [] },
      ])

      const outcome = await runDay(
        { db, store, provider, now, sleep: instantSleep },
        { watchlistId, runDate: DAY_1 },
      )

      expect(outcome.crawl.status).toBe('failed')
      // A bad actor id fails identically every time; burning the budget only delays the alert.
      expect(provider.calls).toHaveLength(1)
    })

    it('records a truncated crawl as suspect and withholds every absence', async () => {
      const { workspaceId } = await seedWorkspace(db, {
        slug: 'acme',
        name: 'Acme',
        clerkOrgId: 'org_acme',
        clerkUserId: 'user_acme',
      })
      const { watchlistId } = await seedWatchlist(db, { workspaceId })

      const many = Array.from({ length: 10 }, (_, i) =>
        fixtureAd({ adArchiveId: `ad_${i}`, adCopy: `copy ${i}` }),
      )
      // Day 3 returns 10% of the previous volume: indistinguishable from a mass die-off
      // by inspection, so the parser must refuse to call it one.
      const provider = createFixtureProvider([
        { ads: many },
        { ads: many },
        { ads: many.slice(0, 1) },
      ])
      const deps = { db, store, provider, now, sleep: instantSleep }

      for (const runDate of [DAY_1, DAY_2, DAY_3]) {
        setDay(runDate)
        await runDay(deps, { watchlistId, runDate })
      }

      const run = await db.query<{ status: string; result_count: number; previous_count: number }>(
        'select status, result_count, previous_count from public.crawl_runs where run_date = $1::date',
        [DAY_3],
      )
      expect(run[0]!.status).toBe('suspect')

      const day3 = await db.query<{ is_present: boolean; n: string }>(
        `select o.is_present, count(*) as n
         from public.creative_observations o
         join public.crawl_runs r on r.id = o.crawl_run_id
         where r.run_date = $1::date
         group by o.is_present`,
        [DAY_3],
      )
      expect(day3).toHaveLength(1)
      expect(day3[0]!.is_present).toBe(true)
      expect(Number(day3[0]!.n)).toBe(1)
    })
  })

  describe('land raw, parse later', () => {
    it('lands the snapshot before any row is parsed', async () => {
      const { workspaceId } = await seedWorkspace(db, {
        slug: 'acme',
        name: 'Acme',
        clerkOrgId: 'org_acme',
        clerkUserId: 'user_acme',
      })
      const { watchlistId } = await seedWatchlist(db, { workspaceId })
      const provider = createFixtureProvider([{ ads: [fixtureAd({ adArchiveId: 'ad_1' })] }])

      await tick(db, DAY_1)
      const [run] = await db.query<{ id: string }>(
        'select id from public.crawl_runs where watchlist_id = $1',
        [watchlistId],
      )

      const crawl = await runCrawl(
        { db, store, provider, now, sleep: instantSleep },
        { crawlRunId: run!.id },
      )
      expect(crawl.status).toBe('landed')

      // Crawl alone must not have touched the panel — that is what makes a parser bug
      // recoverable instead of a lost day.
      const parsed = await db.query<{ n: string }>(
        'select count(*) as n from public.creative_observations',
      )
      expect(Number(parsed[0]!.n)).toBe(0)

      const snapshot = await store.get(
        crawl.status === 'landed' ? crawl.snapshotPath : '',
      )
      expect(snapshot).not.toBeNull()
      const envelope = JSON.parse(snapshot!) as Record<string, unknown>
      expect(envelope['schema_version']).toBe(1)
      expect(envelope['trace_id']).toMatch(/^trc_/)
      expect(envelope['provider']).toBe('fixture')
    })

    it('reproduces identical rows when parse is replayed against the stored snapshot', async () => {
      const { workspaceId } = await seedWorkspace(db, {
        slug: 'acme',
        name: 'Acme',
        clerkOrgId: 'org_acme',
        clerkUserId: 'user_acme',
      })
      const { watchlistId } = await seedWatchlist(db, { workspaceId })
      const provider = createFixtureProvider([
        {
          ads: [
            fixtureAd({ adArchiveId: 'ad_1', adCopy: 'Uno.' }),
            fixtureAd({ adArchiveId: 'ad_2', adCopy: 'Dos.' }),
          ],
        },
      ])

      const outcome = await runDay(
        { db, store, provider, now, sleep: instantSleep },
        { watchlistId, runDate: DAY_1 },
      )

      const snapshotOf = async (): Promise<unknown[]> =>
        db.query(
          `select c.creative_hash, c.ad_copy, c.ad_archive_ids, o.is_present, o.variant_count
           from public.creative_observations o
           join public.creatives c on c.id = o.creative_id
           order by c.creative_hash`,
        )

      const before = await snapshotOf()

      // Wipe the parsed rows and replay. The provider is NOT called again — a reprocess
      // must never depend on Meta still serving yesterday's ads.
      await db.exec('delete from public.creative_observations')
      await db.exec('delete from public.creatives')

      const replay = await runParse(
        { db, store, now },
        { crawlRunId: outcome.crawlRunId, messageId: newMessageId() },
      )
      expect(replay.applied).toBe(true)
      expect(await snapshotOf()).toEqual(before)
      expect(provider.calls).toHaveLength(1)
    })

    it('does not re-crawl when the snapshot already landed', async () => {
      const { workspaceId } = await seedWorkspace(db, {
        slug: 'acme',
        name: 'Acme',
        clerkOrgId: 'org_acme',
        clerkUserId: 'user_acme',
      })
      const { watchlistId } = await seedWatchlist(db, { workspaceId })
      const provider = createFixtureProvider([{ ads: [fixtureAd({ adArchiveId: 'ad_1' })] }])

      await tick(db, DAY_1)
      const [run] = await db.query<{ id: string }>(
        'select id from public.crawl_runs where watchlist_id = $1',
        [watchlistId],
      )
      const deps = { db, store, provider, now, sleep: instantSleep }

      await runCrawl(deps, { crawlRunId: run!.id })
      const second = await runCrawl(deps, { crawlRunId: run!.id })

      expect(second.status).toBe('already-landed')
      expect(provider.calls).toHaveLength(1)
    })
  })

  describe('idempotency and tracing', () => {
    it('does not double-write the panel when a parse job is redelivered', async () => {
      const { workspaceId } = await seedWorkspace(db, {
        slug: 'acme',
        name: 'Acme',
        clerkOrgId: 'org_acme',
        clerkUserId: 'user_acme',
      })
      const { watchlistId } = await seedWatchlist(db, { workspaceId })
      const provider = createFixtureProvider([{ ads: [fixtureAd({ adArchiveId: 'ad_1' })] }])

      await tick(db, DAY_1)
      const [run] = await db.query<{ id: string }>(
        'select id from public.crawl_runs where watchlist_id = $1',
        [watchlistId],
      )
      await runCrawl({ db, store, provider, now, sleep: instantSleep }, { crawlRunId: run!.id })

      const messageId = newMessageId()
      const first = await runParse({ db, store, now }, { crawlRunId: run!.id, messageId })
      const second = await runParse({ db, store, now }, { crawlRunId: run!.id, messageId })

      expect(first.applied).toBe(true)
      expect(second.applied).toBe(false)

      const observations = await db.query<{ n: string }>(
        'select count(*) as n from public.creative_observations',
      )
      expect(Number(observations[0]!.n)).toBe(1)
    })

    it('links tick, job, snapshot and parsed rows on one trace_id', async () => {
      const { workspaceId } = await seedWorkspace(db, {
        slug: 'acme',
        name: 'Acme',
        clerkOrgId: 'org_acme',
        clerkUserId: 'user_acme',
      })
      const { watchlistId } = await seedWatchlist(db, { workspaceId })
      const provider = createFixtureProvider([{ ads: [fixtureAd({ adArchiveId: 'ad_1' })] }])

      const outcome = await runDay(
        { db, store, provider, now, sleep: instantSleep },
        { watchlistId, runDate: DAY_1 },
      )

      const [run] = await db.query<{ trace_id: string; raw_storage_path: string }>(
        'select trace_id, raw_storage_path from public.crawl_runs where id = $1',
        [outcome.crawlRunId],
      )
      const traceId = run!.trace_id
      expect(traceId).toMatch(/^trc_[0-9A-HJKMNP-TV-Z]{26}$/)

      const jobs = await db.query<{ type: string }>(
        'select type from public.jobs where trace_id = $1 order by created_at',
        [traceId],
      )
      expect(jobs.map((j) => j.type)).toEqual(['crawl', 'parse'])

      const events = await db.query<{ type: string }>(
        'select type from public.audit_events where trace_id = $1 order by id',
        [traceId],
      )
      expect(events.map((e) => e.type)).toEqual(['crawl.landed', 'crawl.parsed'])

      const envelope = JSON.parse((await store.get(run!.raw_storage_path))!) as {
        trace_id: string
      }
      expect(envelope.trace_id).toBe(traceId)
    })
  })

  describe('tenancy', () => {
    it('keeps two workspaces watching the same competitor on separate panels', async () => {
      const acme = await seedWorkspace(db, {
        slug: 'acme',
        name: 'Acme',
        clerkOrgId: 'org_acme',
        clerkUserId: 'user_acme',
      })
      const beta = await seedWorkspace(db, {
        slug: 'beta',
        name: 'Beta',
        clerkOrgId: 'org_beta',
        clerkUserId: 'user_beta',
      })

      const acmeList = await seedWatchlist(db, { workspaceId: acme.workspaceId })
      const betaList = await seedWatchlist(db, { workspaceId: beta.workspaceId })

      // Same competitor, same ad — deliberately identical input for both tenants.
      const ad = fixtureAd({ adArchiveId: 'ad_shared', adCopy: 'Mismo anuncio.' })
      await runDay(
        { db, store, provider: createFixtureProvider([{ ads: [ad] }]), now, sleep: instantSleep },
        { watchlistId: acmeList.watchlistId, runDate: DAY_1 },
      )
      await runDay(
        { db, store, provider: createFixtureProvider([{ ads: [ad] }]), now, sleep: instantSleep },
        { watchlistId: betaList.watchlistId, runDate: DAY_1 },
      )

      // Two separate creative rows: identity is scoped per workspace, so tenants can never
      // share a row and therefore can never leak one.
      const all = await db.query<{ n: string }>('select count(*) as n from public.creatives')
      expect(Number(all[0]!.n)).toBe(2)

      // Proven from inside the authenticated role — a superuser read would prove nothing.
      const visible = await asAuthenticated(
        db,
        { sub: 'user_acme', org_id: 'org_acme' },
        async (scoped) =>
          scoped.query<{ n: string }>('select count(*) as n from public.creative_observations'),
      )
      expect(Number(visible[0]!.n)).toBe(1)

      const runsVisible = await asAuthenticated(
        db,
        { sub: 'user_acme', org_id: 'org_acme' },
        async (scoped) =>
          scoped.query<{ workspace_id: string }>('select workspace_id from public.crawl_runs'),
      )
      expect(runsVisible.every((r) => r.workspace_id === acme.workspaceId)).toBe(true)
    })
  })

  describe('legal posture', () => {
    it('refuses a provider that does not declare logged-off collection', async () => {
      const { workspaceId } = await seedWorkspace(db, {
        slug: 'acme',
        name: 'Acme',
        clerkOrgId: 'org_acme',
        clerkUserId: 'user_acme',
      })
      const { watchlistId } = await seedWatchlist(db, { workspaceId })
      await tick(db, DAY_1)
      const [run] = await db.query<{ id: string }>(
        'select id from public.crawl_runs where watchlist_id = $1',
        [watchlistId],
      )

      // Scraping with an authenticated Meta session is the one thing that would collapse
      // the legal posture the product rests on (ARCHITECTURE.md §9).
      const sessionProvider = {
        ...createFixtureProvider([{ ads: [] }]),
        collectionMode: 'authenticated',
      } as unknown as AdLibraryProvider

      await expect(
        runCrawl({ db, store, provider: sessionProvider, now }, { crawlRunId: run!.id }),
      ).rejects.toThrow(/logged-off/i)
    })
  })
})
