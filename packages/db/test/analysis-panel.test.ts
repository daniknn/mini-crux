import {
  assembleCohorts,
  placeCreative,
  stratify,
  type PanelCreative,
} from '@mini-crux/analysis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getAnalysisPanel } from '../src/analysis/index.ts'
import { withTenant } from '../src/tenant.ts'
import { createTestDb, seedWorkspace, type TestDb } from '../src/testing.ts'
import type { SqlExecutor } from '../src/types.ts'

/**
 * The panel read UC-5 runs on, against a fixture where every creative's cohort is known in
 * advance and arrived at by a different route.
 *
 * The unit tests in `packages/analysis` prove the cohort rules. This file proves the rules
 * are fed the right numbers — which is the half that a pure-TypeScript suite cannot reach,
 * because every input it uses was written by hand. Here `days_active`, `is_censored` and
 * `has_gaps` come out of the survival view over real observations, so a creative can land in
 * the wrong cohort without a single line of cohort code being wrong.
 *
 * The fixture: ten healthy crawl days in March 2026 on watchlist W1, plus a three-day W2
 * whose middle day is `suspect`. Two advertisers. Ten creatives, one per outcome:
 *
 *   short-stopped   started day 5,  seen 5–6, absent day 7   → stopped,  2d  → short_lived
 *   short-censored  started day 8,  seen 8–10                → running,  2d  → THE TRAP
 *   long-censored   started 2025-12-01, seen 1–10            → running, 99d  → long_lived
 *   long-stopped    started 2025-12-15, seen 1–3, absent 4   → stopped, 79d  → long_lived
 *   middle          started 2026-02-01, seen 1–10            → running, 37d  → the middle
 *   no-start        no ad_delivery_start_time                → no duration   → excluded
 *   not-extracted   started 2025-12-01, seen 1–10, no features row          → excluded
 *   skipped-density started 2025-12-01, text_density unmeasurable → long, one feature short
 *   never-cut       started 2025-12-01, first_cut_time_s absent   → long, measured absent
 *   gaps            on W2, span crosses the suspect day       → unrecoverable → excluded
 */

const ORG_A = 'org_analysispanelaaaaaa'
const ORG_B = 'org_analysispanelbbbbbb'
const USER_A = 'user_analysispanelaaaa'
const USER_B = 'user_analysispanelbbbb'

const claimsA = { sub: USER_A, org_id: ORG_A }
const claimsB = { sub: USER_B, org_id: ORG_B }

const day = (n: number): string => `2026-03-${String(n).padStart(2, '0')}`

const FEATURE_VERSION = 2

interface Features {
  durationS: number | null
  firstCutTimeS: number | null
  cutsPerSecond: number | null
  textInFirst2s: boolean | null
  textDensity: number | null
  audioEnergyVariance: number | null
  skipped?: string[]
}

const measured = (over: Partial<Features> = {}): Features => ({
  durationS: 15,
  firstCutTimeS: 1.5,
  cutsPerSecond: 0.4,
  textInFirst2s: true,
  textDensity: 0.25,
  audioEnergyVariance: 0.031,
  ...over,
})

describe('analysis panel', () => {
  let db: TestDb
  let workspaceA: string
  let workspaceB: string
  let panel: PanelCreative[]
  const ids: Record<string, string> = {}

  const asA = <T>(fn: (t: SqlExecutor) => Promise<T>): Promise<T> => withTenant(db, claimsA, fn)
  const asB = <T>(fn: (t: SqlExecutor) => Promise<T>): Promise<T> => withTenant(db, claimsB, fn)

  /** The panel row for a fixture creative, by its hash. */
  const row = (hash: string): PanelCreative => {
    const found = panel.find((p) => p.creativeId === ids[hash])
    if (found === undefined) throw new Error(`no panel row for ${hash}`)
    return found
  }

  beforeAll(async () => {
    db = await createTestDb()
    await db.exec('reset role')
    ;({ workspaceId: workspaceA } = await seedWorkspace(db, {
      slug: 'panel-a',
      name: 'Panel A',
      clerkOrgId: ORG_A,
      clerkUserId: USER_A,
    }))
    ;({ workspaceId: workspaceB } = await seedWorkspace(db, {
      slug: 'panel-b',
      name: 'Panel B',
      clerkOrgId: ORG_B,
      clerkUserId: USER_B,
    }))

    const zapatos = await newAdvertiser(workspaceA, 'page-zapatos', 'Zapatos MX')
    const tenis = await newAdvertiser(workspaceA, 'page-tenis', 'Tenis MX')

    const w1 = await newWatchlist(workspaceA, 'calzado', 'Calzado')
    const w2 = await newWatchlist(workspaceA, 'ropa', 'Ropa')

    const r1: Record<number, string> = {}
    for (let n = 1; n <= 10; n += 1) r1[n] = await newCrawlRun(workspaceA, w1, day(n), 'succeeded')

    // W2 is three days with a `suspect` middle. A suspect run withheld its absences at write
    // time, so the day is a hole in the record rather than evidence of anything — which is
    // exactly the shape `has_gaps` exists to flag.
    const r2: Record<number, string> = {
      3: await newCrawlRun(workspaceA, w2, day(3), 'succeeded'),
      4: await newCrawlRun(workspaceA, w2, day(4), 'suspect'),
      5: await newCrawlRun(workspaceA, w2, day(5), 'succeeded'),
    }

    const add = async (
      hash: string,
      advertiser: string,
      startedAt: string | null,
      present: number[],
      absent: number[],
      features: Features | null,
      runs: Record<number, string> = r1,
    ): Promise<void> => {
      const id = await newCreative(workspaceA, advertiser, hash, startedAt)
      ids[hash] = id
      for (const n of present) await observe(workspaceA, id, runs[n]!, day(n), true)
      for (const n of absent) await observe(workspaceA, id, runs[n]!, day(n), false)
      if (features !== null) await addFeatures(workspaceA, id, features)
    }

    await add('short-stopped', zapatos, '2026-03-05T12:00:00Z', [5, 6], [7], measured())
    await add('short-censored', zapatos, '2026-03-08T12:00:00Z', [8, 9, 10], [], measured())
    await add('long-censored', zapatos, '2025-12-01T12:00:00Z', all10(), [], measured())
    await add('long-stopped', tenis, '2025-12-15T12:00:00Z', [1, 2, 3], [4], measured())
    await add('middle', zapatos, '2026-02-01T12:00:00Z', all10(), [], measured())
    await add('no-start', zapatos, null, all10(), [], measured())
    await add('not-extracted', zapatos, '2025-12-01T12:00:00Z', all10(), [], null)
    await add(
      'skipped-density',
      tenis,
      '2025-12-01T12:00:00Z',
      all10(),
      [],
      measured({ textDensity: null, skipped: ['text_density'] }),
    )
    // Measured absent, not skipped: a single-shot video really has no cut.
    await add(
      'never-cut',
      tenis,
      '2025-12-01T12:00:00Z',
      all10(),
      [],
      measured({ firstCutTimeS: null }),
    )
    await add('gaps', zapatos, '2026-03-01T12:00:00Z', [3, 5], [], measured(), r2)

    // A second tenant with a panel of its own, so every isolation assertion has something
    // real to fail on rather than passing over an empty table.
    const advertiserB = await newAdvertiser(workspaceB, 'page-ajeno', 'Ajeno SA')
    const watchlistB = await newWatchlist(workspaceB, 'ajeno', 'Ajeno')
    const runB = await newCrawlRun(workspaceB, watchlistB, day(3), 'succeeded')
    const foreign = await newCreative(workspaceB, advertiserB, 'b1-ajeno', '2025-12-01T12:00:00Z')
    ids['b1-ajeno'] = foreign
    await observe(workspaceB, foreign, runB, day(3), true)
    await addFeatures(workspaceB, foreign, measured())

    panel = await asA(getAnalysisPanel)
  })

  afterAll(async () => {
    await db.close()
  })

  // ────────────────────────────── fixture builders ──────────────────────────────

  const all10 = (): number[] => [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

  async function newAdvertiser(ws: string, pageId: string, name: string): Promise<string> {
    const [r] = await db.query<{ id: string }>(
      `insert into public.advertisers (workspace_id, meta_page_id, name)
       values ($1, $2, $3) returning id`,
      [ws, pageId, name],
    )
    return r!.id
  }

  async function newWatchlist(ws: string, query: string, label: string): Promise<string> {
    const [r] = await db.query<{ id: string }>(
      `insert into public.watchlists (workspace_id, kind, query, label)
       values ($1, 'keyword', $2, $3) returning id`,
      [ws, query, label],
    )
    return r!.id
  }

  async function newCrawlRun(
    ws: string,
    watchlistId: string,
    runDate: string,
    status: string,
  ): Promise<string> {
    const [r] = await db.query<{ id: string }>(
      `insert into public.crawl_runs
         (workspace_id, watchlist_id, run_date, status, trace_id, actor)
       values ($1, $2, $3, $4, 'trc_analysis_panel_fixture', $5) returning id`,
      [ws, watchlistId, runDate, status, JSON.stringify({ type: 'schedule', id: 'test' })],
    )
    return r!.id
  }

  async function newCreative(
    ws: string,
    advertiserId: string,
    hash: string,
    startedAt: string | null,
  ): Promise<string> {
    const [r] = await db.query<{ id: string }>(
      `insert into public.creatives
         (workspace_id, advertiser_id, creative_hash, media_type, ad_delivery_start_time,
          ad_copy, ad_archive_ids, publisher_platforms)
       values ($1, $2, $3, 'video', $4, $5, $6, $7) returning id`,
      [ws, advertiserId, hash, startedAt, `Copia de ${hash}`, [`${hash}-ad`], ['facebook']],
    )
    return r!.id
  }

  async function observe(
    ws: string,
    creativeId: string,
    runId: string,
    runDate: string,
    present: boolean,
  ): Promise<void> {
    // 20:00 in Mexico City — 02:00 UTC the next calendar day. Any duration derived from the
    // instant rather than from `run_date` comes out a day wrong and fails below.
    await db.query(
      `insert into public.creative_observations
         (workspace_id, creative_id, crawl_run_id, observed_at, is_present)
       values ($1, $2, $3, ($4::date + interval '20 hours') at time zone 'America/Mexico_City', $5)`,
      [ws, creativeId, runId, runDate, present],
    )
  }

  async function addFeatures(ws: string, creativeId: string, f: Features): Promise<void> {
    await db.query(
      `insert into public.creative_features
         (workspace_id, creative_id, schema_version, duration_s, first_cut_time_s,
          cuts_per_second, text_in_first_2s, text_density, audio_energy_variance,
          skipped_features)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        ws,
        creativeId,
        FEATURE_VERSION,
        f.durationS,
        f.firstCutTimeS,
        f.cutsPerSecond,
        f.textInFirst2s,
        f.textDensity,
        f.audioEnergyVariance,
        f.skipped ?? [],
      ],
    )
  }

  // ────────────────────────────── the read ──────────────────────────────

  it('returns every creative in the workspace panel, deterministically ordered', () => {
    expect(panel).toHaveLength(10)
    expect([...panel].map((p) => p.creativeId).sort()).toEqual(panel.map((p) => p.creativeId))
  })

  it('carries the survival outcome the view derived, not a re-derivation of it', () => {
    // Exact day counts, not `> 0`. A duration measured off `observed_at` instead of
    // `run_date` is a day out; a `coalesce(stopped_date, last_crawl_date)` collapsed to the
    // latter grows every stopped creative's life by the days the crawler kept running. Both
    // produce a plausible integer.
    expect(row('short-stopped').daysActive).toBe(2)
    expect(row('short-stopped').isCensored).toBe(false)

    expect(row('short-censored').daysActive).toBe(2)
    expect(row('short-censored').isCensored).toBe(true)

    expect(row('long-censored').daysActive).toBe(99)
    expect(row('long-censored').isCensored).toBe(true)

    // Stopped on day 4 while the crawler ran to day 10 — the fixture where `stopped_date`
    // and `last_crawl_date` diverge, so only one of them produces 79.
    expect(row('long-stopped').daysActive).toBe(79)
    expect(row('long-stopped').isCensored).toBe(false)

    expect(row('middle').daysActive).toBe(37)
    expect(row('no-start').daysActive).toBeNull()
  })

  it('flags the creative whose span crosses an unrecoverable crawl, and only that one', () => {
    expect(row('gaps').hasGaps).toBe(true)
    for (const p of panel) {
      if (p.creativeId === ids['gaps']) continue
      expect(p.hasGaps).toBe(false)
    }
  })

  it('shapes every value so it cannot be decoded two ways', () => {
    // `days_active` is `date - date`, which node-postgres would hand back as a string
    // without the cast; `text_in_first_2s` is a boolean the rank test needs an order for.
    // PGlite decodes both differently from production, so the shaping is what makes this
    // assertion mean anything at all (CLAUDE.md's driver-decoding table).
    expect(typeof row('long-censored').daysActive).toBe('number')
    expect(row('long-censored').features).toEqual({
      duration_s: 15,
      first_cut_time_s: 1.5,
      cuts_per_second: 0.4,
      text_in_first_2s: 1,
      text_density: 0.25,
      audio_energy_variance: 0.031,
    })
    expect(row('long-censored').featureSchemaVersion).toBe(FEATURE_VERSION)
    expect(row('long-censored').skippedFeatures).toEqual([])
  })

  it('keeps the three kinds of null apart across the driver boundary', () => {
    // Not measurable: null *and* named in skipped_features.
    expect(row('skipped-density').features.text_density).toBeNull()
    expect(row('skipped-density').skippedFeatures).toEqual(['text_density'])

    // Measured absent: null with nothing skipped. A single-shot video.
    expect(row('never-cut').features.first_cut_time_s).toBeNull()
    expect(row('never-cut').skippedFeatures).toEqual([])

    // Not attempted: no feature row at all, so there is no version and no measurements.
    expect(row('not-extracted').featureSchemaVersion).toBeNull()
    expect(row('not-extracted').skippedFeatures).toEqual([])
    expect(row('not-extracted').features.duration_s).toBeNull()
  })

  // ────────────────────────────── through to the cohorts ──────────────────────────────

  it('places every creative where the survival view says it belongs', () => {
    const placements = Object.fromEntries(
      Object.entries(ids)
        .filter(([hash]) => hash !== 'b1-ajeno')
        .map(([hash]) => [hash, placeCreative(row(hash))]),
    )

    expect(placements).toEqual({
      'short-stopped': 'short_lived',
      // Two days observed and still running: identical `days_active` to short-stopped, and
      // the opposite placement. This is the censoring trap arriving through real data
      // rather than through a hand-built object.
      'short-censored': 'excluded_middle',
      'long-censored': 'long_lived',
      'long-stopped': 'long_lived',
      middle: 'excluded_middle',
      'no-start': 'excluded_no_start',
      'not-extracted': 'excluded_not_extracted',
      'skipped-density': 'long_lived',
      'never-cut': 'long_lived',
      gaps: 'excluded_gaps',
    })
  })

  it('assembles cohorts whose counts account for the whole panel', () => {
    const assembly = assembleCohorts(panel)

    expect(assembly.counts).toEqual({
      short_lived: 1,
      long_lived: 4,
      excluded_middle: 2,
      excluded_gaps: 1,
      excluded_no_start: 1,
      excluded_not_extracted: 1,
    })
    expect(assembly.panelSize).toBe(10)
    expect(assembly.featureSchemaVersion).toBe(FEATURE_VERSION)
    // long-censored, skipped-density and never-cut are still running; long-stopped is not.
    expect(assembly.censoringRateLong).toBeCloseTo(3 / 4, 12)
    expect(assembly.strataTotal).toBe(2)
  })

  it('drops the unmeasurable feature from its own test and no other', () => {
    const assembly = assembleCohorts(panel)

    const density = stratify(assembly, 'text_density')
    expect(density.nLong).toBe(3)
    expect(density.droppedNotMeasurable).toBe(1)
    expect(density.droppedUnexplained).toBe(0)

    // The same creative is present in every other feature's sample.
    const cuts = stratify(assembly, 'cuts_per_second')
    expect(cuts.nLong).toBe(4)
    expect(cuts.droppedNotMeasurable).toBe(0)

    // And the never-cut creative stays in the first-cut test, at the top of the order.
    const firstCut = stratify(assembly, 'first_cut_time_s')
    expect(firstCut.nLong).toBe(4)
    expect(firstCut.droppedUnexplained).toBe(0)
    expect(firstCut.strata.flatMap((s) => s.long)).toContain(Number.POSITIVE_INFINITY)
  })

  // ────────────────────────────── tenancy ──────────────────────────────

  it('reads only the caller workspace panel', async () => {
    const fromB = await asB(getAnalysisPanel)

    expect(fromB.map((p) => p.creativeId)).toEqual([ids['b1-ajeno']])
    expect(panel.map((p) => p.creativeId)).not.toContain(ids['b1-ajeno'])
  })

  it('leaks nothing when a tenant names another tenant workspace outright', async () => {
    // The query has no workspace parameter to talk past, so the attempt has to be made in
    // SQL: same view, same connection, an explicit filter for the other tenant's rows.
    const rows = await asB((t) =>
      t.query(`select creative_id from public.creative_survival where workspace_id = $1`, [
        workspaceA,
      ]),
    )
    expect(rows).toEqual([])
  })
})
