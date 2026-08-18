import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createWatchlist,
  getChangeFeed,
  getCreativeDetail,
  getPanelHealth,
  getStructuralProfile,
  listAdvertisers,
  listCreatives,
  listWatchlists,
  renameWatchlist,
  setWatchlistActive,
} from '../src/dashboard/index.ts'
import { withTenant } from '../src/tenant.ts'
import { createTestDb, seedWorkspace, type TestDb } from '../src/testing.ts'
import type { SqlExecutor } from '../src/types.ts'

/**
 * The dashboard reads, against a panel whose every number is known in advance.
 *
 * These assert exact values, never `> 0` or `is not null`. A change feed that puts a
 * creative in the wrong section, a profile whose median silently includes a zero-filled
 * skip, a duration off by a day — all of them return a full, well-shaped, entirely
 * plausible page. Shape assertions are satisfied by every one of those bugs.
 *
 * The fixture panel: ten consecutive healthy crawl days in March 2026, one watchlist, two
 * advertisers, five creatives chosen so that each occupies a different corner of the
 * change feed and the censoring logic:
 *
 *   C1 evergreen   started 2026-01-01, seen days 1–10        → censored, predates the panel
 *   C2 launched    started day 5,      seen days 5–10        → censored, launched in-window
 *   C3 died        started day 1,      seen days 1–4, gone 5 → stopped in-window
 *   C4 discovered  started 2025-12-01, seen days 7–10        → censored, old ad, new to us
 *   C5 other       started day 1,      seen days 1–10        → censored, second advertiser
 */

const ORG_A = 'org_dashboardaaaaaaaaaaa'
const ORG_B = 'org_dashboardbbbbbbbbbbb'
const USER_A = 'user_dashboardaaaaaaaaa'
const USER_B = 'user_dashboardbbbbbbbbb'

const claimsA = { sub: USER_A, org_id: ORG_A }
const claimsB = { sub: USER_B, org_id: ORG_B }

const day = (n: number): string => `2026-03-${String(n).padStart(2, '0')}`

interface CreativeSpec {
  hash: string
  advertiser: 'zapatos' | 'tenis'
  startedAt: string | null
  /** Days on which the creative was observed present. */
  presentDays: number[]
  /** Days on which it was observed absent — an explicit `is_present = false`. */
  absentDays?: number[]
  features?: {
    durationS: number
    firstCutTimeS: number
    cutsPerSecond: number
    textDensity: number | null
    textInFirst2s: boolean | null
    poster: string | null
    truncated?: boolean
    analysisCapS?: number
    skipped?: string[]
  }
}

const PANEL: CreativeSpec[] = [
  {
    hash: 'c1-evergreen',
    advertiser: 'zapatos',
    startedAt: '2026-01-01T12:00:00Z',
    presentDays: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    features: {
      durationS: 30,
      firstCutTimeS: 2,
      cutsPerSecond: 0.5,
      textDensity: 0.2,
      textInFirst2s: true,
      poster: 'posters/c1.jpg',
    },
  },
  {
    hash: 'c2-launched',
    advertiser: 'zapatos',
    startedAt: '2026-03-05T12:00:00Z',
    presentDays: [5, 6, 7, 8, 9, 10],
    features: {
      durationS: 15,
      firstCutTimeS: 1,
      cutsPerSecond: 1,
      textDensity: 0.4,
      textInFirst2s: false,
      poster: null,
      truncated: true,
      analysisCapS: 60,
      skipped: ['poster'],
    },
  },
  {
    hash: 'c3-died',
    advertiser: 'zapatos',
    startedAt: '2026-03-01T12:00:00Z',
    presentDays: [1, 2, 3, 4],
    absentDays: [5, 6, 7, 8, 9, 10],
    features: {
      durationS: 60,
      firstCutTimeS: 3,
      cutsPerSecond: 0.25,
      // Measured-absent with a skip entry: not-measurable, and it must shrink the sample
      // rather than pull the median toward zero.
      textDensity: null,
      textInFirst2s: true,
      poster: 'posters/c3.jpg',
      skipped: ['text_density'],
    },
  },
  {
    hash: 'c4-discovered',
    advertiser: 'zapatos',
    startedAt: '2025-12-01T12:00:00Z',
    // No rows at all before day 7 — we were not looking for it, which is different from
    // looking and not finding it. Never extraction'd, so it has no feature row.
    presentDays: [7, 8, 9, 10],
  },
  {
    hash: 'c5-other',
    advertiser: 'tenis',
    startedAt: '2026-03-01T12:00:00Z',
    presentDays: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    features: {
      durationS: 5,
      firstCutTimeS: 0.5,
      cutsPerSecond: 2,
      textDensity: 0.6,
      textInFirst2s: true,
      poster: 'posters/c5.jpg',
    },
  },
]

describe('dashboard', () => {
  let db: TestDb
  let workspaceA: string
  let workspaceB: string
  let advertisers: Record<string, string>
  let creatives: Record<string, string>
  let foreignCreativeId: string

  /** Run `fn` as tenant A, the workspace the fixture panel belongs to. */
  const asA = <T>(fn: (t: SqlExecutor) => Promise<T>): Promise<T> => withTenant(db, claimsA, fn)

  beforeAll(async () => {
    db = await createTestDb()
    await db.exec('reset role')
    ;({ workspaceId: workspaceA } = await seedWorkspace(db, {
      slug: 'dash-a',
      name: 'Dash A',
      clerkOrgId: ORG_A,
      clerkUserId: USER_A,
    }))
    ;({ workspaceId: workspaceB } = await seedWorkspace(db, {
      slug: 'dash-b',
      name: 'Dash B',
      clerkOrgId: ORG_B,
      clerkUserId: USER_B,
    }))

    advertisers = {
      zapatos: await newAdvertiser(workspaceA, 'page-zapatos', 'Zapatos MX'),
      tenis: await newAdvertiser(workspaceA, 'page-tenis', 'Tenis MX'),
    }

    const watchlistId = await newWatchlist(workspaceA, 'calzado', 'Calzado')

    // Ten healthy crawl days, all on the one watchlist, then an eleventh that failed.
    //
    // The failure is not decoration. With eleven identical healthy days, `panel_age_days`
    // and `healthy_days` would be the same number and either expression could stand in for
    // the other with the suite still green; the same goes for "the newest run's status" and
    // "any run's status" on the watchlist list. A failed day forces those pairs apart. It
    // writes no observations at all — rule: a failed crawl records nothing, not even
    // absences — so it lies outside every survival span and moves no duration.
    const runs: Record<number, string> = {}
    for (let n = 1; n <= 10; n += 1) {
      runs[n] = await newCrawlRun(workspaceA, watchlistId, day(n), 'succeeded')
    }
    await newCrawlRun(workspaceA, watchlistId, day(11), 'failed')

    creatives = {}
    for (const spec of PANEL) {
      const id = await newCreative(workspaceA, advertisers[spec.advertiser]!, spec.hash, spec.startedAt)
      creatives[spec.hash] = id

      for (const n of spec.presentDays) await observe(workspaceA, id, runs[n]!, day(n), true)
      for (const n of spec.absentDays ?? []) await observe(workspaceA, id, runs[n]!, day(n), false)
      if (spec.features !== undefined) await addFeatures(workspaceA, id, spec.features)
    }

    // A complete second tenant, so every isolation assertion has something real to fail on.
    const advertiserB = await newAdvertiser(workspaceB, 'page-ajeno', 'Ajeno SA')
    const watchlistB = await newWatchlist(workspaceB, 'ajeno', 'Ajeno')
    const runB = await newCrawlRun(workspaceB, watchlistB, day(3), 'succeeded')
    foreignCreativeId = await newCreative(workspaceB, advertiserB, 'b1-ajeno', '2026-03-01T12:00:00Z')
    await observe(workspaceB, foreignCreativeId, runB, day(3), true)
  })

  afterAll(async () => {
    await db.close()
  })

  // ────────────────────────────── fixture builders ──────────────────────────────

  async function newAdvertiser(ws: string, pageId: string, name: string): Promise<string> {
    const [row] = await db.query<{ id: string }>(
      `insert into public.advertisers (workspace_id, meta_page_id, name)
       values ($1, $2, $3) returning id`,
      [ws, pageId, name],
    )
    return row!.id
  }

  async function newWatchlist(ws: string, query: string, label: string): Promise<string> {
    const [row] = await db.query<{ id: string }>(
      `insert into public.watchlists (workspace_id, kind, query, label)
       values ($1, 'keyword', $2, $3) returning id`,
      [ws, query, label],
    )
    return row!.id
  }

  async function newCrawlRun(
    ws: string,
    watchlistId: string,
    runDate: string,
    status: string,
  ): Promise<string> {
    const [row] = await db.query<{ id: string }>(
      `insert into public.crawl_runs
         (workspace_id, watchlist_id, run_date, status, trace_id, actor)
       values ($1, $2, $3, $4, 'trc_dashboard_fixture', $5) returning id`,
      [ws, watchlistId, runDate, status, JSON.stringify({ type: 'schedule', id: 'test' })],
    )
    return row!.id
  }

  async function newCreative(
    ws: string,
    advertiserId: string,
    hash: string,
    startedAt: string | null,
  ): Promise<string> {
    const [row] = await db.query<{ id: string }>(
      `insert into public.creatives
         (workspace_id, advertiser_id, creative_hash, media_type, ad_delivery_start_time,
          ad_copy, ad_archive_ids, publisher_platforms)
       values ($1, $2, $3, 'video', $4, $5, $6, $7) returning id`,
      [
        ws,
        advertiserId,
        hash,
        startedAt,
        `Copia de ${hash}`,
        [`${hash}-ad-1`, `${hash}-ad-2`],
        ['facebook', 'instagram'],
      ],
    )
    return row!.id
  }

  async function observe(
    ws: string,
    creativeId: string,
    runId: string,
    runDate: string,
    present: boolean,
  ): Promise<void> {
    // 20:00 in Mexico City — 02:00 UTC the next calendar day, so any date derived from the
    // instant rather than from `run_date` lands on the wrong day and fails loudly here.
    await db.query(
      `insert into public.creative_observations
         (workspace_id, creative_id, crawl_run_id, observed_at, is_present)
       values ($1, $2, $3, ($4::date + interval '20 hours') at time zone 'America/Mexico_City', $5)`,
      [ws, creativeId, runId, runDate, present],
    )
  }

  async function addFeatures(
    ws: string,
    creativeId: string,
    f: NonNullable<CreativeSpec['features']>,
  ): Promise<void> {
    await db.query(
      `insert into public.creative_features
         (workspace_id, creative_id, schema_version, duration_s, first_cut_time_s,
          cuts_per_second, text_density, text_in_first_2s, first_line_transcript,
          full_transcript, poster_storage_path, truncated, analysis_cap_s, skipped_features)
       values ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        ws,
        creativeId,
        f.durationS,
        f.firstCutTimeS,
        f.cutsPerSecond,
        f.textDensity,
        f.textInFirst2s,
        'Primera línea',
        'Transcripción completa del anuncio.',
        f.poster,
        f.truncated ?? false,
        f.analysisCapS ?? null,
        f.skipped ?? [],
      ],
    )
  }

  // ────────────────────────────── panel health ──────────────────────────────

  describe('panel health', () => {
    it('reports the panel span, the censoring rate and the gap count', async () => {
      const health = await asA(getPanelHealth)

      expect(health).toEqual({
        firstRunDate: day(1),
        // The failed eleventh day still happened, so the panel is eleven days deep — but
        // only ten of those days are evidence. The two numbers are deliberately different:
        // an operator reading "11 días de panel, 10 sanos" can see the outage.
        lastRunDate: day(11),
        // Inclusive: eleven crawl days is an eleven-day-deep panel, not ten.
        panelAgeDays: 11,
        healthyDays: 10,
        totalCreatives: 5,
        // Everything except C3, which has an explicit death.
        censoredCreatives: 4,
        censoringRate: 0.8,
        creativesWithGaps: 0,
      })
    })

    it('returns a null censoring rate for an empty panel rather than a confident zero', async () => {
      // Tenant B has one creative but no way to divide by nothing, so use a third org with
      // nothing at all. A 0 here would render as "0% aún activos" over no data.
      await db.exec('reset role')
      await seedWorkspace(db, {
        slug: 'dash-empty',
        name: 'Dash Empty',
        clerkOrgId: 'org_dashboardempty',
        clerkUserId: 'user_dashboardempty',
      })

      const health = await withTenant(
        db,
        { sub: 'user_dashboardempty', org_id: 'org_dashboardempty' },
        getPanelHealth,
      )

      expect(health.totalCreatives).toBe(0)
      expect(health.censoringRate).toBeNull()
      expect(health.panelAgeDays).toBe(0)
      expect(health.firstRunDate).toBeNull()
    })
  })

  // ────────────────────────────── change feed ──────────────────────────────

  describe('change feed', () => {
    it('separates a launch from a discovery and a death', async () => {
      const feed = await asA((t) => getChangeFeed(t, { since: day(5), until: day(8) }))

      expect(feed.launched.map((e) => e.creativeHash)).toEqual(['c2-launched'])
      expect(feed.discovered.map((e) => e.creativeHash)).toEqual(['c4-discovered'])
      expect(feed.stopped.map((e) => e.creativeHash)).toEqual(['c3-died'])
    })

    it('does not report an old ad we just found as a launch', async () => {
      // The failure this guards: C4 started in December 2025 and entered the panel on day 7.
      // A feed keyed on "first row in the database" announces a competitor's eight-month
      // evergreen as this week's news — and does it for every ad, every time a watchlist
      // is created.
      const feed = await asA((t) => getChangeFeed(t, { since: day(5), until: day(8) }))

      const discovered = feed.discovered[0]!
      expect(discovered.creativeHash).toBe('c4-discovered')
      expect(discovered.startedDate).toBe('2025-12-01')
      expect(discovered.firstSeenDate).toBe(day(7))
      expect(discovered.eventDate).toBe(day(7))
      // Measured from Meta's start date, not from when we met it (CLAUDE.md rule 5):
      // 2025-12-01 → 2026-03-10 is 99 days.
      expect(discovered.daysActive).toBe(99)
      expect(discovered.isCensored).toBe(true)
      expect(feed.launched.map((e) => e.creativeHash)).not.toContain('c4-discovered')
    })

    it('reports only explicit deaths as stopped', async () => {
      // `end_date` falls back to the last crawl day for a living creative. A feed reading
      // deaths off it would announce all four censored creatives as stopped on day 10.
      const feed = await asA((t) => getChangeFeed(t, { since: day(9), until: day(10) }))

      expect(feed.stopped).toEqual([])
    })

    it('pins the death day and the measured span of a stopped creative', async () => {
      const feed = await asA((t) => getChangeFeed(t, { since: day(5), until: day(8) }))
      const dead = feed.stopped[0]!

      expect(dead.creativeHash).toBe('c3-died')
      expect(dead.stoppedDate).toBe(day(5))
      expect(dead.eventDate).toBe(day(5))
      expect(dead.isCensored).toBe(false)
      // Started day 1, dead day 5 — four days. Crawling continued to day 10 and must not
      // have moved it.
      expect(dead.daysActive).toBe(4)
    })

    it('places a creative in exactly one section', async () => {
      const feed = await asA((t) => getChangeFeed(t, { since: day(1), until: day(10) }))

      const all = [...feed.launched, ...feed.discovered, ...feed.stopped].map((e) => e.kind + ':' + e.creativeHash)
      expect(new Set(all).size).toBe(all.length)

      // Over the whole panel: C2 and C3 and C5 launched (started days 1–10), C1 and C4
      // predate it so they are discoveries, and C3 also died.
      expect(feed.launched.map((e) => e.creativeHash).sort()).toEqual([
        'c2-launched',
        'c3-died',
        'c5-other',
      ])
      expect(feed.discovered.map((e) => e.creativeHash).sort()).toEqual([
        'c1-evergreen',
        'c4-discovered',
      ])
      expect(feed.stopped.map((e) => e.creativeHash)).toEqual(['c3-died'])
    })

    it('excludes everything outside the window', async () => {
      const feed = await asA((t) => getChangeFeed(t, { since: day(2), until: day(3) }))

      expect(feed.launched).toEqual([])
      expect(feed.discovered).toEqual([])
      expect(feed.stopped).toEqual([])
    })

    it('carries the poster and the advertiser name for rendering', async () => {
      const feed = await asA((t) => getChangeFeed(t, { since: day(1), until: day(10) }))
      const evergreen = feed.discovered.find((e) => e.creativeHash === 'c1-evergreen')!

      expect(evergreen.advertiserName).toBe('Zapatos MX')
      expect(evergreen.posterStoragePath).toBe('posters/c1.jpg')
      expect(evergreen.firstLineTranscript).toBe('Primera línea')
    })
  })

  // ────────────────────────────── gallery ──────────────────────────────

  describe('gallery', () => {
    it('orders by days active, longest first', async () => {
      const rows = await asA((t) => listCreatives(t, { sort: 'longest' }))

      expect(rows.map((r) => r.creativeHash)).toEqual([
        'c4-discovered', // 99 days
        'c1-evergreen', // 68
        'c5-other', // 9
        'c2-launched', // 5
        'c3-died', // 4
      ])
    })

    it('pins each creative duration against its Meta start date', async () => {
      const rows = await asA((t) => listCreatives(t, {}))
      const byHash = new Map(rows.map((r) => [r.creativeHash, r]))

      // 2026-01-01 → 2026-03-10.
      expect(byHash.get('c1-evergreen')!.daysActive).toBe(68)
      // day 5 → day 10.
      expect(byHash.get('c2-launched')!.daysActive).toBe(5)
      // day 1 → death on day 5.
      expect(byHash.get('c3-died')!.daysActive).toBe(4)
      // 2025-12-01 → 2026-03-10.
      expect(byHash.get('c4-discovered')!.daysActive).toBe(99)
    })

    it('carries is_censored beside every duration', async () => {
      const rows = await asA((t) => listCreatives(t, {}))

      // UC-3 rule 1. There is no row shape here that can render a duration without it.
      for (const row of rows) {
        expect(typeof row.isCensored).toBe('boolean')
        expect(typeof row.observationDays).toBe('number')
      }
      expect(rows.find((r) => r.creativeHash === 'c3-died')!.isCensored).toBe(false)
      expect(rows.find((r) => r.creativeHash === 'c1-evergreen')!.isCensored).toBe(true)
    })

    it('reports how many looks each duration rests on', async () => {
      const rows = await asA((t) => listCreatives(t, {}))
      const byHash = new Map(rows.map((r) => [r.creativeHash, r]))

      // C4's 99 days are built from four looks; C1's 68 from ten. Same units, very
      // different measurements, and only observation_days says so.
      expect(byHash.get('c4-discovered')!.observationDays).toBe(4)
      expect(byHash.get('c1-evergreen')!.observationDays).toBe(10)
    })

    it('filters by advertiser', async () => {
      const rows = await asA((t) => listCreatives(t, { advertiserId: advertisers['tenis']! }))
      expect(rows.map((r) => r.creativeHash)).toEqual(['c5-other'])
    })

    it('filters running and stopped', async () => {
      const running = await asA((t) => listCreatives(t, { status: 'running' }))
      const stopped = await asA((t) => listCreatives(t, { status: 'stopped' }))

      expect(running.map((r) => r.creativeHash).sort()).toEqual([
        'c1-evergreen',
        'c2-launched',
        'c4-discovered',
        'c5-other',
      ])
      expect(stopped.map((r) => r.creativeHash)).toEqual(['c3-died'])
    })

    it('counts the ad variants sharing one creative', async () => {
      const rows = await asA((t) => listCreatives(t, {}))
      // The creative is the unit, not the ad (CLAUDE.md rule 4) — two archive ids, one row.
      expect(rows.every((r) => r.variantCount === 2)).toBe(true)
    })

    it('lists advertisers with their running counts', async () => {
      const rows = await asA(listAdvertisers)

      expect(rows).toEqual([
        { id: advertisers['zapatos'], name: 'Zapatos MX', creativeCount: 4, runningCount: 3 },
        { id: advertisers['tenis'], name: 'Tenis MX', creativeCount: 1, runningCount: 1 },
      ])
    })
  })

  // ────────────────────────────── creative detail ──────────────────────────────

  describe('creative detail', () => {
    it('returns the measurements, the transcript and the observation history', async () => {
      const detail = (await asA((t) => getCreativeDetail(t, creatives['c3-died']!)))!

      expect(detail.creativeHash).toBe('c3-died')
      expect(detail.daysActive).toBe(4)
      expect(detail.isCensored).toBe(false)
      expect(detail.cutsPerSecond).toBe(0.25)
      expect(detail.durationS).toBe(60)
      expect(detail.fullTranscript).toBe('Transcripción completa del anuncio.')
      expect(detail.adArchiveIds).toEqual(['c3-died-ad-1', 'c3-died-ad-2'])

      // Four present, then six explicit absences — "we looked and it was gone", which is
      // what the death was derived from.
      expect(detail.observations).toHaveLength(10)
      expect(detail.observations.slice(0, 4).every((o) => o.isPresent)).toBe(true)
      expect(detail.observations[4]).toEqual({
        runDate: day(5),
        isPresent: false,
        crawlStatus: 'succeeded',
      })
    })

    it('distinguishes a skipped feature from a measured zero', async () => {
      const detail = (await asA((t) => getCreativeDetail(t, creatives['c3-died']!)))!

      // Null *with* a skip entry: not-measurable. Rendering it as 0 would put this creative
      // in the "no on-screen text" cohort it does not belong to.
      expect(detail.textDensity).toBeNull()
      expect(detail.skippedFeatures).toEqual(['text_density'])
    })

    it('distinguishes never-extracted from extracted-and-skipped', async () => {
      const detail = (await asA((t) => getCreativeDetail(t, creatives['c4-discovered']!)))!

      // No feature row at all — not attempted. Every measurement is null and there is no
      // skip list to explain them, which is exactly the distinction: an empty
      // `skippedFeatures` with a null `featureSchemaVersion` means "never asked".
      expect(detail.featureSchemaVersion).toBeNull()
      expect(detail.cutsPerSecond).toBeNull()
      expect(detail.skippedFeatures).toEqual([])
      expect(detail.posterStoragePath).toBeNull()
    })

    it('reports the analysed span when the media outran the cap', async () => {
      const detail = (await asA((t) => getCreativeDetail(t, creatives['c2-launched']!)))!

      // A rate over the first 60s of a longer ad is a different quantity from one over the
      // whole ad, and the consumer has to be able to tell which it is holding.
      expect(detail.truncated).toBe(true)
      expect(detail.analysisCapS).toBe(60)
    })

    it('returns null for a creative in another workspace', async () => {
      expect(await asA((t) => getCreativeDetail(t, foreignCreativeId))).toBeNull()
    })
  })

  // ────────────────────────────── structural profile ──────────────────────────────

  describe('structural profile', () => {
    it('compares an advertiser against the whole panel, each metric with its own n', async () => {
      const { advertiser, baseline } = await asA((t) =>
        getStructuralProfile(t, { advertiserId: advertisers['zapatos']! }),
      )

      // Active-only, so C3 (dead) drops out: C1, C2, C4 remain, of which only C1 and C2
      // were ever extracted.
      expect(advertiser.creatives).toBe(3)
      expect(advertiser.extracted).toBe(2)
      expect(advertiser.truncated).toBe(1)

      // median(30, 15) — C4 contributes nothing because it has no measurement, and
      // contributing a zero would halve this.
      expect(advertiser.durationS).toEqual({ n: 2, p25: 18.75, p50: 22.5, p75: 26.25 })
      expect(advertiser.cutsPerSecond.n).toBe(2)
      expect(advertiser.cutsPerSecond.p50).toBe(0.75)

      // Baseline adds C5 from the other advertiser: median(30, 15, 5) = 15.
      expect(baseline.creatives).toBe(4)
      expect(baseline.extracted).toBe(3)
      expect(baseline.durationS.n).toBe(3)
      expect(baseline.durationS.p50).toBe(15)
      expect(baseline.cutsPerSecond.p50).toBe(1)
    })

    it('shrinks the sample for a skipped metric instead of zero-filling it', async () => {
      const { advertiser } = await asA((t) =>
        getStructuralProfile(t, { advertiserId: advertisers['zapatos']!, activeOnly: false }),
      )

      // All four of this advertiser's creatives, three of them extracted. C3's text_density
      // was skipped, so that one metric has n = 2 while the others have n = 3. A single
      // profile-wide n would be wrong for every metric here.
      expect(advertiser.creatives).toBe(4)
      expect(advertiser.extracted).toBe(3)
      expect(advertiser.cutsPerSecond.n).toBe(3)
      expect(advertiser.textDensity.n).toBe(2)
      expect(advertiser.textDensity.p50).toBe(0.30000000000000004)
    })

    it('reports the hook-text share over the creatives that measured it', async () => {
      const { advertiser } = await asA((t) =>
        getStructuralProfile(t, { advertiserId: advertisers['zapatos']! }),
      )

      // C1 true, C2 false, C4 unmeasured → 1 of 2, never 1 of 3.
      expect(advertiser.hookText).toEqual({ n: 2, share: 0.5 })
    })

    it('returns nulls rather than zeros for an advertiser with nothing measured', async () => {
      const { advertiser } = await asA((t) =>
        getStructuralProfile(t, { advertiserId: advertisers['tenis']!, activeOnly: true }),
      )
      expect(advertiser.creatives).toBe(1)
      expect(advertiser.durationS.p50).toBe(5)

      const empty = await asA((t) =>
        getStructuralProfile(t, { advertiserId: '00000000-0000-0000-0000-000000000000' }),
      )
      expect(empty.advertiser.creatives).toBe(0)
      expect(empty.advertiser.durationS).toEqual({ n: 0, p25: null, p50: null, p75: null })
      expect(empty.advertiser.hookText).toEqual({ n: 0, share: null })
    })
  })

  // ────────────────────────────── watchlists ──────────────────────────────

  describe('watchlists', () => {
    it('lists watchlists with the status of their most recent crawl', async () => {
      const rows = await asA(listWatchlists)

      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        query: 'calzado',
        label: 'Calzado',
        country: 'MX',
        isActive: true,
        // The most recent run, not the most common one: ten of eleven crawls succeeded and
        // the honest headline is still that the last one failed. This is the whole point of
        // the column — an operator needs to know ingestion is down right now.
        lastRunDate: day(11),
        lastRunStatus: 'failed',
        succeededRuns: 10,
        failedRuns: 1,
        suspectRuns: 0,
      })
    })

    it('creates a watchlist and audits who did it', async () => {
      const { id, traceId } = await asA((t) =>
        createWatchlist(t, {
          kind: 'keyword',
          query: '  botas  ',
          label: '  Botas  ',
          clerkUserId: USER_A,
        }),
      )

      const [created] = await db.query<{ workspace_id: string; query: string; label: string }>(
        'select workspace_id, query, label from public.watchlists where id = $1',
        [id],
      )
      // Workspace came from `app.current_workspace_id()`, never from the caller.
      expect(created).toEqual({ workspace_id: workspaceA, query: 'botas', label: 'Botas' })

      const [event] = await db.query<{ type: string; actor: { type: string; id: string } }>(
        'select type, actor from public.audit_events where trace_id = $1',
        [traceId],
      )
      expect(event!.type).toBe('watchlist.created')
      expect(event!.actor).toEqual({ type: 'user', id: USER_A })
    })

    it('deactivates without destroying a single observation', async () => {
      const before = await db.query<{ n: number }>(
        'select count(*)::int as n from public.creative_observations where workspace_id = $1',
        [workspaceA],
      )

      const [watchlist] = await db.query<{ id: string }>(
        'select id from public.watchlists where workspace_id = $1 and query = $2',
        [workspaceA, 'calzado'],
      )
      const ok = await asA((t) =>
        setWatchlistActive(t, { id: watchlist!.id, isActive: false, clerkUserId: USER_A }),
      )

      expect(ok).toBe(true)
      const after = await db.query<{ n: number }>(
        'select count(*)::int as n from public.creative_observations where workspace_id = $1',
        [workspaceA],
      )
      // Longitudinal data cannot be backfilled: tidying up a watchlist must never be a way
      // to delete months of panel.
      expect(after[0]!.n).toBe(before[0]!.n)

      // Put it back for any test that runs after this one.
      await asA((t) =>
        setWatchlistActive(t, { id: watchlist!.id, isActive: true, clerkUserId: USER_A }),
      )
    })

    it('reports a rename of another workspace watchlist as not found', async () => {
      const [foreign] = await db.query<{ id: string }>(
        'select id from public.watchlists where workspace_id = $1',
        [workspaceB],
      )

      const ok = await asA((t) =>
        renameWatchlist(t, { id: foreign!.id, label: 'Secuestrada', clerkUserId: USER_A }),
      )

      expect(ok).toBe(false)
      const [row] = await db.query<{ label: string }>(
        'select label from public.watchlists where id = $1',
        [foreign!.id],
      )
      expect(row!.label).toBe('Ajeno')
    })
  })

  // ────────────────────────────── tenancy ──────────────────────────────

  describe('tenancy', () => {
    it('shows tenant B only its own panel, through every read', async () => {
      const [health, feed, gallery, advertiserList, watchlists] = await withTenant(
        db,
        claimsB,
        async (t) => [
          await getPanelHealth(t),
          await getChangeFeed(t, { since: day(1), until: day(10) }),
          await listCreatives(t, {}),
          await listAdvertisers(t),
          await listWatchlists(t),
        ],
      )

      expect(health.totalCreatives).toBe(1)
      expect(gallery.map((r) => r.creativeHash)).toEqual(['b1-ajeno'])
      expect(advertiserList.map((a) => a.name)).toEqual(['Ajeno SA'])
      expect(watchlists.map((w) => w.query)).toEqual(['ajeno'])

      const seen = [...feed.launched, ...feed.discovered, ...feed.stopped]
      expect(seen.every((e) => e.creativeHash === 'b1-ajeno')).toBe(true)
    })

    it('leaks nothing of tenant A through the structural baseline', async () => {
      // The baseline aggregates the *whole workspace*, so it is the query most likely to
      // reach past the tenant boundary without any single row being visible.
      const { baseline } = await withTenant(db, claimsB, (t) =>
        getStructuralProfile(t, { advertiserId: advertisers['zapatos']!, activeOnly: false }),
      )

      expect(baseline.creatives).toBe(1)
      expect(baseline.extracted).toBe(0)
    })

    it('finds nothing when tenant B asks for tenant A creative by id', async () => {
      const detail = await withTenant(db, claimsB, (t) =>
        getCreativeDetail(t, creatives['c1-evergreen']!),
      )
      expect(detail).toBeNull()
    })
  })
})
