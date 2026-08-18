import { ANALYSIS_FEATURES } from '@mini-crux/analysis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getLatestAnalysis, type LatestAnalysis } from '../src/dashboard/index.ts'
import { withTenant } from '../src/tenant.ts'
import { createTestDb, seedWorkspace, type TestDb } from '../src/testing.ts'

/**
 * The read half of UC-5, against rows written by hand.
 *
 * `analysis-run.test.ts` proves the job writes the right numbers; this proves the surface
 * reads back exactly those numbers and nothing else. The two halves are tested apart on
 * purpose: a fixture built by running the job can only contain what the job produces, so it
 * cannot express the arrangements this query has to survive — a refused run that is newer
 * than a published one, a run missing a feature, two runs inside the same clock tick.
 *
 * Four workspaces:
 *
 *   A  refused run, then a newer published one with 5 of 6 features   → the published read
 *   B  published run, then a newer refused one                        → the refusal wins
 *   C  two runs sharing a `created_at` to the microsecond             → the tie-break
 *   D  no runs at all                                                 → null
 *
 * B is the one that matters most. A surface that showed A's stale published numbers because
 * "a refusal is not a result" would be the same bug as rendering a blank page for a panel we
 * looked at and measured — `CLAUDE.md` rule 3, one layer up.
 */

const ORG = (key: string): string => `org_dashanalysis${key.repeat(6)}`
const USER = (key: string): string => `user_dashanalysis${key.repeat(5)}`

const KEYS = ['a', 'b', 'c', 'd'] as const
type Key = (typeof KEYS)[number]

const ws: Record<Key, string> = { a: '', b: '', c: '', d: '' }
const claims = (key: Key): { sub: string; org_id: string } => ({
  sub: USER(key),
  org_id: ORG(key),
})

/**
 * Deliberately after 18:00 UTC, which is the previous day in `America/Mexico_City`.
 *
 * `run_date` is the market-calendar day the run executed on, and the query resolves it with
 * `at time zone`. Timestamps in the middle of the UTC day would read the same on both
 * calendars, so this fixture would not notice the conversion being dropped — which is UC-3's
 * timezone bug in a new place.
 */
const CREATED_A_PUBLISHED = '2026-03-11T03:00:00Z' // → 2026-03-10 in the market
const RUN_DATE_A = '2026-03-10'

interface RunSpec {
  workspace: Key
  id: string
  createdAt: string
  panelDate: string
  outcome: 'published' | 'refused'
  failedGate?: string
  gateDetail?: Record<string, number>
}

/**
 * One run row, with every numeric column set to a different value.
 *
 * Not cosmetic. `n_long`/`n_short`, `strata_used`/`strata_dropped` and the four
 * `n_excluded_*` columns are adjacent same-typed fields, and a select list that transposed
 * two of them returns a complete, plausible run. Equal placeholders would make that
 * transposition invisible — the mutation that already survived once on this table.
 */
const insertRun = async (db: TestDb, spec: RunSpec): Promise<void> => {
  const published = spec.outcome === 'published'
  await db.query(
    `insert into public.analysis_runs
       (id, workspace_id, panel_date, panel_age_days,
        feature_schema_version, extractor_versions, analysis_version,
        outcome, failed_gate, gate_detail,
        n_long, n_short,
        n_excluded_middle, n_excluded_gaps, n_excluded_no_start, n_excluded_not_extracted,
        censoring_rate_long, strata_total, strata_used, strata_dropped,
        trace_id, actor, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
    [
      spec.id,
      ws[spec.workspace],
      spec.panelDate,
      71,
      published ? 2 : null,
      published ? ['0.3.1', '0.4.0'] : [],
      '1.0.0',
      spec.outcome,
      spec.failedGate ?? null,
      JSON.stringify(spec.gateDetail ?? {}),
      23, // n_long
      31, // n_short
      2, // excluded middle
      3, // excluded gaps
      5, // excluded no_start
      7, // excluded not_extracted
      published ? 0.25 : null,
      11, // strata_total
      9, // strata_used
      2, // strata_dropped
      'trc_dashanalysis',
      JSON.stringify({ type: 'schedule', id: 'analysis-daily' }),
      spec.createdAt,
    ],
  )
}

/**
 * The five features workspace A's published run measured, and the q-values they carry.
 *
 * `text_density` is absent — a feature with no variance in a run produces no row, and the
 * surface has to report it as untested rather than as a zero. The q-values are ordered so
 * that sorting by significance would produce a *different* order from the declared one:
 * `audio_energy_variance` is last in `ANALYSIS_FEATURES` and the most significant here.
 */
const FEATURE_ROWS = [
  { feature: 'duration_s', q: 0.9, p: 0.9, z: 0.12, ps: 0.51, r: 0.02, nLong: 23, nShort: 31 },
  { feature: 'first_cut_time_s', q: 0.4, p: 0.2, z: 1.3, ps: 0.58, r: 0.16, nLong: 23, nShort: 31 },
  { feature: 'cuts_per_second', q: 0.02, p: 0.004, z: -2.9, ps: 0.37, r: -0.26, nLong: 23, nShort: 31 },
  { feature: 'text_in_first_2s', q: 0.06, p: 0.03, z: 2.1, ps: 0.62, r: 0.24, nLong: 20, nShort: 28 },
  {
    feature: 'audio_energy_variance',
    q: 0.001,
    p: 0.0001,
    z: 3.9,
    ps: 0.71,
    r: 0.42,
    nLong: 23,
    nShort: 31,
  },
] as const

describe('getLatestAnalysis', () => {
  let db: TestDb
  let latest: Record<Key, LatestAnalysis | null>

  beforeAll(async () => {
    db = await createTestDb()
    await db.exec('reset role')

    for (const key of KEYS) {
      const { workspaceId } = await seedWorkspace(db, {
        slug: `dash-analysis-${key}`,
        name: `Dash analysis ${key.toUpperCase()}`,
        clerkOrgId: ORG(key),
        clerkUserId: USER(key),
      })
      ws[key] = workspaceId
    }

    // A: an older refusal, then the published run the surface must show.
    await insertRun(db, {
      workspace: 'a',
      id: '11111111-0000-4000-8000-000000000001',
      createdAt: '2026-03-01T18:00:00Z',
      panelDate: '2026-02-28',
      outcome: 'refused',
      failedGate: 'panel_age',
      gateDetail: { required_days: 61, actual_days: 49, shortfall_days: 12 },
    })
    await insertRun(db, {
      workspace: 'a',
      id: '11111111-0000-4000-8000-000000000002',
      createdAt: CREATED_A_PUBLISHED,
      panelDate: '2026-03-09',
      outcome: 'published',
    })

    // Inserted in reverse declared order, so a query that returned rows in insertion or
    // primary-key order would put `audio_energy_variance` first and the page would reorder
    // itself between runs.
    for (const row of [...FEATURE_ROWS].reverse()) {
      await db.query(
        `insert into public.analysis_feature_results
           (workspace_id, analysis_run_id, feature, n_long, n_short, z, p_value, q_value,
            probability_superiority, rank_biserial, strata_used, strata_dropped)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          ws.a,
          '11111111-0000-4000-8000-000000000002',
          row.feature,
          row.nLong,
          row.nShort,
          row.z,
          row.p,
          row.q,
          row.ps,
          row.r,
          9,
          2,
        ],
      )
    }

    // B: a published run, then a newer refusal. The refusal is the current state.
    await insertRun(db, {
      workspace: 'b',
      id: '22222222-0000-4000-8000-000000000001',
      createdAt: '2026-03-01T18:00:00Z',
      panelDate: '2026-02-28',
      outcome: 'published',
    })
    await insertRun(db, {
      workspace: 'b',
      id: '22222222-0000-4000-8000-000000000002',
      createdAt: '2026-03-08T18:00:00Z',
      panelDate: '2026-03-07',
      outcome: 'refused',
      failedGate: 'censoring',
      gateDetail: { max_rate: 0.8, actual_rate: 18 / 21, resolved_long: 3, n_long: 21 },
    })

    // C: a retry landing in the same microsecond as the run it retried. Same timestamp, two
    // ids — the only thing that can order them is the tie-break.
    for (const suffix of ['0001', '0002']) {
      await insertRun(db, {
        workspace: 'c',
        id: `33333333-0000-4000-8000-00000000${suffix}`,
        createdAt: '2026-03-05T18:00:00Z',
        panelDate: '2026-03-04',
        outcome: 'refused',
        failedGate: 'cohort_n',
        gateDetail: { required_n: 20, n_long: 30, n_short: 3, shortfall_n: 17 },
      })
    }

    // D gets nothing at all.

    latest = { a: null, b: null, c: null, d: null }
    for (const key of KEYS) {
      latest[key] = await withTenant(db, claims(key), (t) => getLatestAnalysis(t))
    }
  })

  afterAll(async () => {
    await db.close()
  })

  it('returns null when the workspace has never run an analysis', () => {
    // Distinct from a refusal, which is a result. The surface renders three states and this
    // is the only one that has nothing to say.
    expect(latest.d).toBeNull()
  })

  it('returns the newest run, not the newest published one', () => {
    // B's refusal is newer than B's published run. Falling back to the published row would
    // show numbers the panel no longer supports, with no indication they are stale.
    expect(latest.b?.runId).toBe('22222222-0000-4000-8000-000000000002')
    expect(latest.b?.outcome).toBe('refused')
    expect(latest.b?.failedGate).toBe('censoring')
    expect(latest.b?.features).toEqual([])
  })

  it('carries the gate detail through as the numbers the refusal is rendered from', () => {
    // Not recomputed on read: the run refused against the panel it read, and today's panel
    // would give a different shortfall than the one this run is claiming to display.
    expect(latest.b?.gateDetail).toEqual({
      max_rate: 0.8,
      actual_rate: 18 / 21,
      resolved_long: 3,
      n_long: 21,
    })
  })

  it('breaks a same-instant tie stably, so the page does not flip between loads', async () => {
    const again = await withTenant(db, claims('c'), (t) => getLatestAnalysis(t))

    expect(latest.c?.runId).toBe('33333333-0000-4000-8000-000000000002')
    expect(again?.runId).toBe(latest.c?.runId)
  })

  it('reports the published run with every stored column in its own field', () => {
    const run = latest.a

    expect(run?.runId).toBe('11111111-0000-4000-8000-000000000002')
    expect(run?.outcome).toBe('published')
    expect(run?.failedGate).toBeNull()
    expect(run?.panelDate).toBe('2026-03-09')
    expect(run?.panelAgeDays).toBe(71)
    expect(run?.featureSchemaVersion).toBe(2)
    expect(run?.extractorVersions).toEqual(['0.3.1', '0.4.0'])
    expect(run?.analysisVersion).toBe('1.0.0')
    expect(run?.nLong).toBe(23)
    expect(run?.nShort).toBe(31)
    expect(run?.censoringRateLong).toBe(0.25)
    expect(run?.strataTotal).toBe(11)
    expect(run?.strataUsed).toBe(9)
    expect(run?.strataDropped).toBe(2)
    expect(run?.excluded).toEqual({ middle: 2, gaps: 3, noStart: 5, notExtracted: 7 })
  })

  it('dates the run on the market calendar, not on UTC', () => {
    // 2026-03-11T03:00Z is 2026-03-10 21:00 in Mexico City. Reading `created_at::date` — or
    // handing the raw timestamp to JavaScript — dates this run a day into the future, and an
    // operator comparing it against `panel_date` sees a gap that is not there.
    expect(latest.a?.runDate).toBe(RUN_DATE_A)
  })

  it('is the same run date in every timezone', () => {
    // The other half of the same bug, one layer down: a `date` handed to node-postgres
    // decodes at *local* midnight. Everything crossing the driver is shaped as text, so the
    // reader's clock cannot move it.
    const original = process.env['TZ']
    try {
      process.env['TZ'] = 'Pacific/Kiritimati'
      expect(latest.a?.runDate).toBe(RUN_DATE_A)
      expect(latest.a?.panelDate).toBe('2026-03-09')
    } finally {
      if (original === undefined) delete process.env['TZ']
      else process.env['TZ'] = original
    }
  })

  it('orders features by the declared list, not by significance', () => {
    // Sorting by q would put `audio_energy_variance` first on this fixture and rebuild the
    // "winner of six tests" reading the BH adjustment exists to defuse — and it would
    // reorder the page between runs, so a reader could not compare two days by position.
    expect(latest.a?.features.map((f) => f.feature)).toEqual([
      'duration_s',
      'first_cut_time_s',
      'cuts_per_second',
      'text_in_first_2s',
      'audio_energy_variance',
    ])
  })

  it('omits a feature that produced no row instead of inventing a zero', () => {
    // `text_density` had no variance in this run. A zero-filled row would put it on the page
    // as a measured null result, which is a claim we did not make.
    expect(ANALYSIS_FEATURES).toContain('text_density')
    expect(latest.a?.features.map((f) => f.feature)).not.toContain('text_density')
    expect(latest.a?.features).toHaveLength(5)
  })

  it('carries each feature row through field by field', () => {
    // Exact values, not shapes. `z`, `p`, `q`, PS and r are five same-typed doubles on one
    // row; a select list that transposed two of them returns a complete, plausible finding
    // with the wrong number next to every word.
    const cuts = latest.a?.features.find((f) => f.feature === 'cuts_per_second')

    expect(cuts).toEqual({
      feature: 'cuts_per_second',
      nLong: 23,
      nShort: 31,
      z: -2.9,
      p: 0.004,
      qValue: 0.02,
      probabilitySuperiority: 0.37,
      rankBiserial: -0.26,
      strataUsed: 9,
      strataDropped: 2,
    })
  })

  it('keeps the per-feature n, which is not the run n', () => {
    // `text_in_first_2s` could not be measured on three long-lived creatives, so its contrast
    // ran on a smaller sample than the run reports. Rendering the run's n beside it would
    // overstate the evidence for that row specifically.
    const text = latest.a?.features.find((f) => f.feature === 'text_in_first_2s')

    expect(text?.nLong).toBe(20)
    expect(text?.nShort).toBe(28)
    expect(latest.a?.nLong).toBe(23)
  })

  it('never returns another workspace run, and never another run feature results', async () => {
    // A and B both have runs; A's is published with five feature rows and B's is a refusal.
    // If the policy on either table stopped resolving, B would read A's findings.
    expect(latest.a?.runId).not.toBe(latest.b?.runId)
    expect(latest.b?.features).toEqual([])

    await db.exec('reset role')
    const [orphan] = await db.query<{ n: number }>(
      `select count(*)::int as n
       from public.analysis_feature_results r
       join public.analysis_runs a on a.id = r.analysis_run_id
       where r.workspace_id <> a.workspace_id`,
    )
    expect(orphan?.n).toBe(0)
  })
})
