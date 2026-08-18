import {
  ANALYSIS_VERSION,
  assembleCohorts,
  MIN_PANEL_AGE_DAYS,
  MixedFeatureVersionsError,
  runContrasts,
} from '@mini-crux/analysis'
import { newTraceId, type Actor, type TraceId } from '@mini-crux/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getAnalysisPanel, runAnalysis, type RunAnalysisOutcome } from '../src/analysis/index.ts'
import { findAuditEventsByTrace } from '../src/audit.ts'
import { createTestDb, seedWorkspace, type TestDb } from '../src/testing.ts'

/**
 * The analysis job end to end, against a real panel.
 *
 * `gating.test.ts` and `contrast.test.ts` prove the decisions; this proves the decisions are
 * made over the panel the database actually holds and that what they decide reaches the two
 * tables an operator reads. Everything in between — the panel window, the exclusion counts,
 * the version pinning, the rule that a refused run publishes nothing — is invisible to a
 * pure-TypeScript suite because every input it uses was written by hand.
 *
 * Four workspaces, each shaped to reach one ending:
 *
 *   A  61 healthy crawl days, 21 long + 21 short over 3 advertisers   → published
 *   B  12 healthy crawl days, a real cohort on each side              → refused (panel_age)
 *   C  one *failed* crawl and nothing else                            → no panel, no row
 *   D  one crawl day, two creatives at two feature schema versions    → throws, no row
 *
 * C and D are the two endings that write nothing, and they are not the same as a refusal.
 * Both are asserted by counting rows in `analysis_runs`, because "wrote nothing" is the only
 * claim here that a bug satisfies by doing something.
 */

const ORG = (suffix: string): string => `org_analysisrun${suffix}`
const USER = (suffix: string): string => `user_analysisrun${suffix}`

/** Day 1 is 2026-01-01; day 61 is the last crawl of the healthy panel. */
const DAY_ONE = Date.UTC(2026, 0, 1)
const day = (n: number): string =>
  new Date(DAY_ONE + (n - 1) * 86_400_000).toISOString().slice(0, 10)

const PANEL_DAYS = 61

/** Well before the first crawl, so a long-lived creative is long-lived on any end date. */
const LONG_START = '2025-09-01T12:00:00Z'

const FEATURE_VERSION = 2

/** Rides on cohort members. The run's `extractor_versions` must be exactly these two. */
const MEMBER_BUILDS = ['0.3.1', '0.4.0'] as const
/** Rides on excluded creatives only, so it must never appear on a run. */
const EXCLUDED_BUILD = '9.9.9'

interface Features {
  durationS: number
  firstCutTimeS: number
  cutsPerSecond: number
  textInFirst2s: boolean
  textDensity: number
  audioEnergyVariance: number
}

/**
 * Long-lived and short-lived measurements that never overlap, so all six features have
 * variance and none of them comes back untestable. A fixture where one feature is constant
 * would make `featureCount` 5 and quietly weaken every count below.
 */
const longFeatures = (i: number): Features => ({
  durationS: 20 + i,
  firstCutTimeS: 2 + i * 0.1,
  cutsPerSecond: 0.8 + i * 0.01,
  textInFirst2s: i % 2 === 0,
  textDensity: 0.5 + i * 0.01,
  audioEnergyVariance: 0.05 + i * 0.001,
})

const shortFeatures = (i: number): Features => ({
  durationS: 10 + i,
  firstCutTimeS: 1 + i * 0.1,
  cutsPerSecond: 0.2 + i * 0.01,
  textInFirst2s: i % 2 === 1,
  textDensity: 0.1 + i * 0.01,
  audioEnergyVariance: 0.01 + i * 0.001,
})

interface RunRow {
  id: string
  panel_date: string
  panel_age_days: number
  feature_schema_version: number | null
  extractor_versions: string[]
  analysis_version: string
  outcome: string
  failed_gate: string | null
  gate_detail: Record<string, number>
  n_long: number
  n_short: number
  n_excluded_middle: number
  n_excluded_gaps: number
  n_excluded_no_start: number
  n_excluded_not_extracted: number
  censoring_rate_long: number | null
  strata_total: number
  strata_used: number
  strata_dropped: number
  trace_id: string
  actor: Actor
}

interface ResultRow {
  feature: string
  n_long: number
  n_short: number
  z: number
  p_value: number
  q_value: number
  probability_superiority: number
  rank_biserial: number
  strata_used: number
  strata_dropped: number
}

describe('the analysis job', () => {
  let db: TestDb

  const ws: Record<'A' | 'B' | 'C' | 'D', string> = { A: '', B: '', C: '', D: '' }
  const trace: Record<'A' | 'B' | 'C' | 'D', TraceId> = {
    A: newTraceId(),
    B: newTraceId(),
    C: newTraceId(),
    D: newTraceId(),
  }
  const actor: Actor = { type: 'schedule', id: 'analysis-tick', label: 'daily-analysis' }

  const outcome: Record<'A' | 'B' | 'C', RunAnalysisOutcome> = {} as Record<
    'A' | 'B' | 'C',
    RunAnalysisOutcome
  >
  let mixedVersionsFailure: unknown

  // ────────────────────────────── fixture builders ──────────────────────────────

  async function newAdvertiser(workspace: string, pageId: string): Promise<string> {
    const [r] = await db.query<{ id: string }>(
      `insert into public.advertisers (workspace_id, meta_page_id, name)
       values ($1, $2, $3) returning id`,
      [workspace, pageId, `Anunciante ${pageId}`],
    )
    return r!.id
  }

  async function newWatchlist(workspace: string, query: string): Promise<string> {
    const [r] = await db.query<{ id: string }>(
      `insert into public.watchlists (workspace_id, kind, query, label)
       values ($1, 'keyword', $2, $3) returning id`,
      [workspace, query, query],
    )
    return r!.id
  }

  /** One crawl run per listed day, returning the run ids keyed by day number. */
  async function newCrawlDays(
    workspace: string,
    watchlistId: string,
    days: number[],
    status: (n: number) => string = () => 'succeeded',
  ): Promise<Record<number, string>> {
    const runs: Record<number, string> = {}
    for (const n of days) {
      const [r] = await db.query<{ id: string }>(
        `insert into public.crawl_runs
           (workspace_id, watchlist_id, run_date, status, trace_id, actor)
         values ($1, $2, $3, $4, 'trc_analysis_run_fixture', $5) returning id`,
        [
          workspace,
          watchlistId,
          day(n),
          status(n),
          JSON.stringify({ type: 'schedule', id: 'test' }),
        ],
      )
      runs[n] = r!.id
    }
    return runs
  }

  async function newCreative(
    workspace: string,
    advertiserId: string,
    hash: string,
    startedAt: string | null,
  ): Promise<string> {
    const [r] = await db.query<{ id: string }>(
      `insert into public.creatives
         (workspace_id, advertiser_id, creative_hash, media_type, ad_delivery_start_time,
          ad_copy, ad_archive_ids, publisher_platforms)
       values ($1, $2, $3, 'video', $4, $5, $6, $7) returning id`,
      [workspace, advertiserId, hash, startedAt, `Copia de ${hash}`, [`${hash}-ad`], ['facebook']],
    )
    return r!.id
  }

  async function observe(
    workspace: string,
    creativeId: string,
    runId: string,
    runDate: string,
    present: boolean,
  ): Promise<void> {
    // 20:00 in Mexico City, which is 02:00 UTC the next calendar day. Any duration derived
    // from the instant rather than from `run_date` is a day out and moves creatives across a
    // cohort edge — the counts below would change without anything erroring.
    await db.query(
      `insert into public.creative_observations
         (workspace_id, creative_id, crawl_run_id, observed_at, is_present)
       values ($1, $2, $3, ($4::date + interval '20 hours') at time zone 'America/Mexico_City', $5)`,
      [workspace, creativeId, runId, runDate, present],
    )
  }

  async function addFeatures(
    workspace: string,
    creativeId: string,
    f: Features,
    build: string,
    version = FEATURE_VERSION,
  ): Promise<void> {
    await db.query(
      `insert into public.creative_features
         (workspace_id, creative_id, schema_version, extractor_version, duration_s,
          first_cut_time_s, cuts_per_second, text_in_first_2s, text_density,
          audio_energy_variance, skipped_features)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '{}')`,
      [
        workspace,
        creativeId,
        version,
        build,
        f.durationS,
        f.firstCutTimeS,
        f.cutsPerSecond,
        f.textInFirst2s,
        f.textDensity,
        f.audioEnergyVariance,
      ],
    )
  }

  // ────────────────────────────── the panels ──────────────────────────────

  /**
   * A publishable panel: `PANEL_DAYS` healthy crawls, three advertisers, seven long-lived and
   * seven short-lived creatives each. One long-lived creative per advertiser is still running,
   * so the censoring rate is 3/21 and clears its gate with room to spare.
   *
   * Then ten creatives that must not reach a cohort, in four different counts — 2 middle, 1
   * gaps, 3 no-start, 4 not-extracted. The counts differ on purpose: four exclusions all equal
   * to 1 would let the four columns be written in any order with the suite still green, which
   * is exactly the mutation that survived on this table's schema.
   */
  async function buildHealthyPanel(workspace: string): Promise<void> {
    const main = await newWatchlist(workspace, 'calzado')
    const runs = await newCrawlDays(
      workspace,
      main,
      Array.from({ length: PANEL_DAYS }, (_, k) => k + 1),
    )

    const advertisers: string[] = []
    for (let a = 0; a < 3; a += 1) advertisers.push(await newAdvertiser(workspace, `page-${a}`))

    for (const [a, advertiserId] of advertisers.entries()) {
      for (let i = 0; i < 7; i += 1) {
        // Still running only for i === 0: 3 censored out of 21.
        const censored = i === 0
        const id = await newCreative(workspace, advertiserId, `a${a}-long${i}`, LONG_START)
        await observe(workspace, id, runs[1]!, day(1), true)
        await observe(workspace, id, runs[2]!, day(2), true)
        if (!censored) await observe(workspace, id, runs[3]!, day(3), false)
        await addFeatures(workspace, id, longFeatures(i), MEMBER_BUILDS[i === 0 ? 1 : 0]!)
      }

      for (let i = 0; i < 7; i += 1) {
        // Started on day 20, gone by day 22: two days, resolved, unambiguously short.
        const id = await newCreative(
          workspace,
          advertiserId,
          `a${a}-short${i}`,
          `${day(20)}T12:00:00Z`,
        )
        await observe(workspace, id, runs[20]!, day(20), true)
        await observe(workspace, id, runs[21]!, day(21), true)
        await observe(workspace, id, runs[22]!, day(22), false)
        await addFeatures(workspace, id, shortFeatures(i), MEMBER_BUILDS[i === 0 ? 1 : 0]!)
      }
    }

    const odd = advertisers[0]!

    // The excluded middle: started on day 1 and still running on day 61, so exactly 60 days.
    // The edge is strict, so 60 is not long-lived — and the fixture sits on the edge rather
    // than near it, because `>` and `>=` differ by precisely this creative.
    for (let i = 0; i < 2; i += 1) {
      const id = await newCreative(workspace, odd, `mid${i}`, `${day(1)}T12:00:00Z`)
      await observe(workspace, id, runs[1]!, day(1), true)
      await addFeatures(workspace, id, longFeatures(i), EXCLUDED_BUILD)
    }

    // No `ad_delivery_start_time`: no duration, no cohort, and never a guess from first sight.
    for (let i = 0; i < 3; i += 1) {
      const id = await newCreative(workspace, odd, `nostart${i}`, null)
      await observe(workspace, id, runs[1]!, day(1), true)
      await addFeatures(workspace, id, longFeatures(i), EXCLUDED_BUILD)
    }

    // No current feature row at all: *not attempted*, and so not part of any n.
    for (let i = 0; i < 4; i += 1) {
      const id = await newCreative(workspace, odd, `noextract${i}`, LONG_START)
      await observe(workspace, id, runs[1]!, day(1), true)
    }

    // A second watchlist whose middle day is `suspect`, covering one creative. Kept off the
    // main watchlist on purpose: a suspect run there would flag every creative whose span
    // crosses it, and the panel would collapse to a single exclusion count.
    const patchy = await newWatchlist(workspace, 'ropa')
    const patchyRuns = await newCrawlDays(workspace, patchy, [1, 2, 3], (n) =>
      n === 2 ? 'suspect' : 'succeeded',
    )
    const gapId = await newCreative(workspace, odd, 'gaps0', LONG_START)
    await observe(workspace, gapId, patchyRuns[1]!, day(1), true)
    await observe(workspace, gapId, patchyRuns[3]!, day(3), true)
    await addFeatures(workspace, gapId, longFeatures(0), EXCLUDED_BUILD)
  }

  /** Twelve healthy days and a creative on each side, so only the age gate can refuse. */
  async function buildYoungPanel(workspace: string): Promise<void> {
    const list = await newWatchlist(workspace, 'joven')
    const runs = await newCrawlDays(
      workspace,
      list,
      Array.from({ length: 12 }, (_, k) => k + 1),
    )
    const advertiserId = await newAdvertiser(workspace, 'page-joven')

    const long = await newCreative(workspace, advertiserId, 'b-long', LONG_START)
    await observe(workspace, long, runs[1]!, day(1), true)
    await addFeatures(workspace, long, longFeatures(0), MEMBER_BUILDS[0]!)

    const short = await newCreative(workspace, advertiserId, 'b-short', `${day(1)}T12:00:00Z`)
    await observe(workspace, short, runs[1]!, day(1), true)
    await observe(workspace, short, runs[2]!, day(2), true)
    await observe(workspace, short, runs[3]!, day(3), false)
    await addFeatures(workspace, short, shortFeatures(0), MEMBER_BUILDS[0]!)
  }

  beforeAll(async () => {
    db = await createTestDb()
    await db.exec('reset role')

    for (const key of ['A', 'B', 'C', 'D'] as const) {
      const { workspaceId } = await seedWorkspace(db, {
        slug: `run-${key.toLowerCase()}`,
        name: `Run ${key}`,
        clerkOrgId: ORG(key.toLowerCase().repeat(6)),
        clerkUserId: USER(key.toLowerCase().repeat(6)),
      })
      ws[key] = workspaceId
    }

    await buildHealthyPanel(ws.A)
    await buildYoungPanel(ws.B)

    // C: the crawler ran and failed. There is no healthy day, so there is no panel — and the
    // run being present at all is the point, since a job keying on "any crawl_runs row"
    // instead of on a healthy one would find this and date a panel to it.
    const listC = await newWatchlist(ws.C, 'fallida')
    await newCrawlDays(ws.C, listC, [1], () => 'failed')

    // D: two long-lived creatives measured under two different feature definition sets.
    const listD = await newWatchlist(ws.D, 'mixta')
    const runsD = await newCrawlDays(ws.D, listD, [1])
    const advertiserD = await newAdvertiser(ws.D, 'page-mixta')
    for (const [i, version] of [FEATURE_VERSION, FEATURE_VERSION + 1].entries()) {
      const id = await newCreative(ws.D, advertiserD, `d-long${i}`, LONG_START)
      await observe(ws.D, id, runsD[1]!, day(1), true)
      await addFeatures(ws.D, id, longFeatures(i), MEMBER_BUILDS[0]!, version)
    }

    for (const key of ['A', 'B', 'C'] as const) {
      outcome[key] = await runAnalysis(
        { db },
        { workspaceId: ws[key], traceId: trace[key], actor },
      )
    }
    mixedVersionsFailure = await runAnalysis(
      { db },
      { workspaceId: ws.D, traceId: trace.D, actor },
    ).then(
      () => null,
      (error: unknown) => error,
    )
  })

  afterAll(async () => {
    await db.close()
  })

  const runsFor = async (workspace: string): Promise<RunRow[]> =>
    db.query<RunRow>(
      `select id, ${"to_char(panel_date, 'YYYY-MM-DD')"} as panel_date, panel_age_days,
              feature_schema_version, extractor_versions, analysis_version,
              outcome, failed_gate, gate_detail, n_long, n_short,
              n_excluded_middle, n_excluded_gaps, n_excluded_no_start, n_excluded_not_extracted,
              censoring_rate_long, strata_total, strata_used, strata_dropped, trace_id, actor
       from public.analysis_runs
       where workspace_id = $1
       order by created_at`,
      [workspace],
    )

  const resultsFor = async (analysisRunId: string): Promise<ResultRow[]> =>
    db.query<ResultRow>(
      `select feature, n_long, n_short, z, p_value, q_value, probability_superiority,
              rank_biserial, strata_used, strata_dropped
       from public.analysis_feature_results
       where analysis_run_id = $1
       order by feature`,
      [analysisRunId],
    )

  // ────────────────────────────── the two endings that write nothing ──────────────────────

  it('writes nothing when the only crawl this workspace ever had failed', async () => {
    // Not a refusal. "We did not look" and "we looked and the panel is too thin" are
    // different facts, and only the second belongs in the table an operator reads as
    // findings. A run here would also have to invent a `panel_date`, which is the timezone
    // argument in a new disguise: a date not taken from a `run_date` is a date nobody struck.
    expect(outcome.C).toEqual({ status: 'no-panel' })
    expect(await runsFor(ws.C)).toEqual([])
    expect(await findAuditEventsByTrace(db, trace.C)).toEqual([])
  })

  it('fails without writing anything when the panel spans two feature schema versions', async () => {
    // The throw is the specification. `cuts_per_second` at v2 and at v3 are different
    // quantities sharing a column name, so pooling them reports a contrast between two
    // definitions as a contrast between cohorts. Failing means the job is retried once the
    // re-extraction finishes, which is the correct outcome — and there is no `failed_gate`
    // that would be true, so a refused row would be wrong twice over.
    expect(mixedVersionsFailure).toBeInstanceOf(MixedFeatureVersionsError)
    expect((mixedVersionsFailure as MixedFeatureVersionsError).versions).toEqual([
      FEATURE_VERSION,
      FEATURE_VERSION + 1,
    ])

    expect(await runsFor(ws.D)).toEqual([])
    expect(await findAuditEventsByTrace(db, trace.D)).toEqual([])
  })

  // ────────────────────────────── refusal ──────────────────────────────

  it('refuses a young panel with a stored row that says how long is left', async () => {
    expect(outcome.B).toEqual({
      status: 'refused',
      analysisRunId: expect.any(String),
      failedGate: 'panel_age',
      detail: { required_days: MIN_PANEL_AGE_DAYS, actual_days: 12, shortfall_days: 49 },
    })

    const [run, ...rest] = await runsFor(ws.B)
    expect(rest).toEqual([])
    expect(run!.outcome).toBe('refused')
    expect(run!.failed_gate).toBe('panel_age')
    // The numbers "faltan 49 días" is rendered from, stored rather than recomputed on read.
    expect(run!.gate_detail).toEqual({
      required_days: MIN_PANEL_AGE_DAYS,
      actual_days: 12,
      shortfall_days: 49,
    })
    expect(run!.panel_date).toBe(day(12))
    expect(run!.panel_age_days).toBe(12)
  })

  it('publishes no feature result from a run that refused', async () => {
    // Rule 7, at the level the rule is about. The cohorts exist here — one creative on each
    // side, both measured — so a job that computed the contrasts first and checked the gate
    // afterwards would have six perfectly good rows in hand and one `if` between them and
    // the table.
    const [run] = await runsFor(ws.B)
    expect(await resultsFor(run!.id)).toEqual([])

    expect(run!.n_long).toBe(1)
    expect(run!.n_short).toBe(1)
    // A refused run still pins the version it read. The column is nullable only for a run
    // whose panel produced no members at all, which is not this one.
    expect(run!.feature_schema_version).toBe(FEATURE_VERSION)
  })

  // ────────────────────────────── publication ──────────────────────────────

  it('publishes one run over the healthy panel, dated to the last healthy crawl', async () => {
    const [run, ...rest] = await runsFor(ws.A)
    expect(rest).toEqual([])
    expect(run!.outcome).toBe('published')
    expect(run!.failed_gate).toBeNull()
    expect(run!.gate_detail).toEqual({})

    // 61 distinct healthy crawl days, and the panel dated to the last of them. Both come from
    // `run_date`; the second watchlist adds three runs on days that already existed, so a
    // window counting *runs* instead of distinct days would report 64 here.
    expect(run!.panel_date).toBe(day(PANEL_DAYS))
    expect(run!.panel_age_days).toBe(PANEL_DAYS)

    expect(run!.n_long).toBe(21)
    expect(run!.n_short).toBe(21)
    expect(run!.strata_total).toBe(3)
    expect(run!.strata_used).toBe(3)
    expect(run!.strata_dropped).toBe(0)
    // One still-running long-lived creative per advertiser.
    expect(run!.censoring_rate_long).toBeCloseTo(3 / 21, 12)

    expect(run!.trace_id).toBe(trace.A)
    expect(run!.actor).toEqual(actor)
  })

  it('counts the four exclusions on four different columns', async () => {
    const [run] = await runsFor(ws.A)

    // Four different numbers, because four equal ones would let the columns be written in
    // any order. Each is also a distinct product problem: the middle shrinks as the panel
    // ages, gaps track crawler outages, no-start is the provider, and not-extracted is the
    // only one an operator clears by draining a queue.
    expect(run!.n_excluded_middle).toBe(2)
    expect(run!.n_excluded_gaps).toBe(1)
    expect(run!.n_excluded_no_start).toBe(3)
    expect(run!.n_excluded_not_extracted).toBe(4)

    // And the six numbers account for the whole panel, so nothing fell out of every bucket.
    const panel = await getAnalysisPanel(db, ws.A)
    expect(
      run!.n_long +
        run!.n_short +
        run!.n_excluded_middle +
        run!.n_excluded_gaps +
        run!.n_excluded_no_start +
        run!.n_excluded_not_extracted,
    ).toBe(panel.length)
  })

  it('pins the versions the run actually read, and no others', async () => {
    const [run] = await runsFor(ws.A)

    expect(run!.analysis_version).toBe(ANALYSIS_VERSION)
    expect(run!.feature_schema_version).toBe(FEATURE_VERSION)

    // Provenance over cohort *members*. The excluded creatives carry a build of their own and
    // it must not appear: a creative dropped for having gaps was never measured by this
    // analysis, so recording its extractor build as provenance for these numbers would be a
    // small lie in the one place provenance is kept.
    expect(run!.extractor_versions).toEqual([...MEMBER_BUILDS])
    expect(run!.extractor_versions).not.toContain(EXCLUDED_BUILD)
  })

  it('writes one result per feature, carrying the numbers the module computed', async () => {
    const [run] = await runsFor(ws.A)
    const stored = await resultsFor(run!.id)

    // Recomputed from the same panel rather than hard-coded. The point of the assertion is
    // that the job stored what the analysis said — pinning literals here would test the
    // fixture's arithmetic a second time and would not notice a q attached to the wrong row.
    const expected = runContrasts(assembleCohorts(await getAnalysisPanel(db, ws.A)))
    expect(expected.untestable).toEqual([])
    expect(outcome.A).toEqual({
      status: 'published',
      analysisRunId: run!.id,
      featureCount: expected.features.length,
      untestable: [],
    })

    expect(stored.map((r) => r.feature).sort()).toEqual(
      expected.features.map((f) => f.feature).sort(),
    )

    for (const feature of expected.features) {
      const row = stored.find((r) => r.feature === feature.feature)!
      expect(row.n_long).toBe(feature.nLong)
      expect(row.n_short).toBe(feature.nShort)
      expect(row.z).toBeCloseTo(feature.z, 12)
      expect(row.p_value).toBeCloseTo(feature.p, 12)
      expect(row.q_value).toBeCloseTo(feature.qValue, 12)
      expect(row.probability_superiority).toBeCloseTo(feature.probabilitySuperiority, 12)
      expect(row.rank_biserial).toBeCloseTo(feature.rankBiserial, 12)
      expect(row.strata_used).toBe(feature.strataUsed)
      expect(row.strata_dropped).toBe(feature.strataDropped)
    }

    // Every member measured on every feature, so each n is the full cohort. A drop that
    // landed on the wrong feature's row would show up here as a 20 next to a 21.
    for (const row of stored) {
      expect(row.n_long).toBe(21)
      expect(row.n_short).toBe(21)
    }
  })

  // ────────────────────────────── the audit trail ──────────────────────────────

  it('leaves one audit event per run, on the trace id it was handed', async () => {
    const published = await findAuditEventsByTrace(db, trace.A)
    expect(published).toHaveLength(1)
    expect(published[0]!.type).toBe('analysis.published')
    expect(published[0]!.subject_type).toBe('analysis_run')
    expect(published[0]!.subject_id).toBe((await runsFor(ws.A))[0]!.id)
    expect(published[0]!.actor).toEqual(actor)
    expect(published[0]!.payload).toEqual({
      panel_date: day(PANEL_DAYS),
      feature_count: 6,
      untestable: [],
      n_long: 21,
      n_short: 21,
    })

    // A refusal is an event too. It is the one an operator asks about — "why is the page
    // still empty" — so it carries the gate and the shortfall rather than just a run id.
    const refused = await findAuditEventsByTrace(db, trace.B)
    expect(refused).toHaveLength(1)
    expect(refused[0]!.type).toBe('analysis.refused')
    expect(refused[0]!.payload).toEqual({
      panel_date: day(12),
      failed_gate: 'panel_age',
      gate_detail: { required_days: MIN_PANEL_AGE_DAYS, actual_days: 12, shortfall_days: 49 },
    })
  })

  // ────────────────────────────── tenancy ──────────────────────────────

  it('assembles each workspace out of its own panel', async () => {
    // A and B were analysed against the same database in the same beforeAll. A's run is 21
    // and 21; B's is 1 and 1. A job whose read ignored its workspace parameter would give
    // both runs the same cohort sizes — and would publish A's finding to B.
    const [a] = await runsFor(ws.A)
    const [b] = await runsFor(ws.B)

    expect([a!.n_long, a!.n_short]).toEqual([21, 21])
    expect([b!.n_long, b!.n_short]).toEqual([1, 1])
    expect(a!.panel_date).not.toBe(b!.panel_date)

    // And every feature result belongs to the workspace of its run, which is what the
    // `assert_run_published` trigger checks on the way in.
    const stray = await db.query(
      `select r.id
       from public.analysis_feature_results r
       join public.analysis_runs a on a.id = r.analysis_run_id
       where r.workspace_id <> a.workspace_id`,
    )
    expect(stray).toEqual([])
  })
})
