import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getLatestProxyValidation, type LatestProxyValidation } from '../src/dashboard/index.ts'
import { withTenant } from '../src/tenant.ts'
import { createTestDb, seedWorkspace, type TestDb } from '../src/testing.ts'

/**
 * The read half of UC-7, against rows written by hand.
 *
 * Simpler fixture than `dashboard-analysis.test.ts`'s: `proxy_validation_runs` has no results
 * table to join, so there is one shape of row to get right, not two. The same three arrangements
 * still matter, for the same reasons as the analysis surface:
 *
 *   A  a published run, every numeric column distinct     → every field lands in its own place
 *   B  published run, then a newer refusal                 → the refusal wins
 *   C  two runs sharing a `created_at` to the microsecond  → the tie-break
 *   D  no runs at all                                      → null
 */

const ORG = (key: string): string => `org_dashproxy${key.repeat(6)}`
const USER = (key: string): string => `user_dashproxy${key.repeat(5)}`

const KEYS = ['a', 'b', 'c', 'd'] as const
type Key = (typeof KEYS)[number]

const ws: Record<Key, string> = { a: '', b: '', c: '', d: '' }
const claims = (key: Key): { sub: string; org_id: string } => ({
  sub: USER(key),
  org_id: ORG(key),
})

/** Deliberately after 18:00 UTC, the previous day in `America/Mexico_City` — same UC-3 check. */
const CREATED_A = '2026-03-11T03:00:00Z' // → 2026-03-10 in the market
const RUN_DATE_A = '2026-03-10'

interface RunSpec {
  workspace: Key
  id: string
  createdAt: string
  outcome: 'published' | 'refused'
  failedGate?: string
  gateDetail?: Record<string, number>
}

/**
 * One run row. Every numeric column set to a different value, deliberately — this table has
 * eleven adjacent same-typed columns (three exclusion counts, three advertiser counts, five
 * regression doubles), and a select list that transposed two of them returns a complete,
 * plausible run with the wrong number next to every word.
 */
const insertRun = async (db: TestDb, spec: RunSpec): Promise<void> => {
  const published = spec.outcome === 'published'
  await db.query(
    `insert into public.proxy_validation_runs
       (id, workspace_id, corpus_size, n_excluded_still_running, n_excluded_zero_reach,
        n_excluded_sub_day, n_included, advertisers_total, advertisers_used,
        advertisers_dropped, reach_bound_used, outcome, failed_gate, gate_detail,
        beta, beta_se, beta_ci_low, beta_ci_high, t_stat, p_value, df,
        naive_pooled_beta, naive_pearson_r, verdict, trace_id, actor, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)`,
    [
      spec.id,
      ws[spec.workspace],
      61, // corpus_size
      4, // n_excluded_still_running
      5, // n_excluded_zero_reach
      6, // n_excluded_sub_day
      46, // n_included
      15, // advertisers_total
      9, // advertisers_used
      3, // advertisers_dropped
      'max',
      spec.outcome,
      spec.failedGate ?? null,
      JSON.stringify(spec.gateDetail ?? {}),
      published ? 1.18 : null, // beta
      published ? 0.07 : null, // beta_se
      published ? 1.04 : null, // beta_ci_low
      published ? 1.32 : null, // beta_ci_high
      published ? 2.57 : null, // t_stat
      published ? 0.012 : null, // p_value
      published ? 36 : null, // df
      published ? 1.41 : null, // naive_pooled_beta
      published ? 0.63 : null, // naive_pearson_r
      published ? 'reflects_effort' : null,
      'trc_dashproxy',
      JSON.stringify({ type: 'operator', id: 'user_dashproxy_cli', label: 'proxy-validation:once' }),
      spec.createdAt,
    ],
  )
}

describe('getLatestProxyValidation', () => {
  let db: TestDb
  let latest: Record<Key, LatestProxyValidation | null>

  beforeAll(async () => {
    db = await createTestDb()
    await db.exec('reset role')

    for (const key of KEYS) {
      const { workspaceId } = await seedWorkspace(db, {
        slug: `dash-proxy-${key}`,
        name: `Dash proxy ${key.toUpperCase()}`,
        clerkOrgId: ORG(key),
        clerkUserId: USER(key),
      })
      ws[key] = workspaceId
    }

    // A: the published run the surface must show, with every column distinct.
    await insertRun(db, {
      workspace: 'a',
      id: '11111111-0000-4000-8000-000000000001',
      createdAt: CREATED_A,
      outcome: 'published',
    })

    // B: a published run, then a newer refusal. The refusal is the current state.
    await insertRun(db, {
      workspace: 'b',
      id: '22222222-0000-4000-8000-000000000001',
      createdAt: '2026-03-01T18:00:00Z',
      outcome: 'published',
    })
    await insertRun(db, {
      workspace: 'b',
      id: '22222222-0000-4000-8000-000000000002',
      createdAt: '2026-03-08T18:00:00Z',
      outcome: 'refused',
      failedGate: 'advertisers',
      gateDetail: { required_advertisers: 5, actual_advertisers: 3, shortfall_advertisers: 2 },
    })

    // C: a retry landing in the same microsecond as the run it retried.
    for (const suffix of ['0001', '0002']) {
      await insertRun(db, {
        workspace: 'c',
        id: `33333333-0000-4000-8000-00000000${suffix}`,
        createdAt: '2026-03-05T18:00:00Z',
        outcome: 'refused',
        failedGate: 'corpus_size',
        gateDetail: { required_n: 30, actual_n: 12, shortfall_n: 18 },
      })
    }

    // D gets nothing at all.

    latest = { a: null, b: null, c: null, d: null }
    for (const key of KEYS) {
      latest[key] = await withTenant(db, claims(key), (t) => getLatestProxyValidation(t))
    }
  })

  afterAll(async () => {
    await db.close()
  })

  it('returns null when the workspace has never triggered a validation run', () => {
    // Distinct from a refusal, which is a result — spec rule 6, same as UC-5.
    expect(latest.d).toBeNull()
  })

  it('returns the newest run, not the newest published one', () => {
    expect(latest.b?.runId).toBe('22222222-0000-4000-8000-000000000002')
    expect(latest.b?.outcome).toBe('refused')
    expect(latest.b?.failedGate).toBe('advertisers')
  })

  it('carries the gate detail through as the numbers the refusal is rendered from', () => {
    expect(latest.b?.gateDetail).toEqual({
      required_advertisers: 5,
      actual_advertisers: 3,
      shortfall_advertisers: 2,
    })
  })

  it('breaks a same-instant tie stably, so the page does not flip between loads', async () => {
    const again = await withTenant(db, claims('c'), (t) => getLatestProxyValidation(t))

    expect(latest.c?.runId).toBe('33333333-0000-4000-8000-000000000002')
    expect(again?.runId).toBe(latest.c?.runId)
  })

  it('reports the published run with every stored column in its own field', () => {
    const run = latest.a

    expect(run?.runId).toBe('11111111-0000-4000-8000-000000000001')
    expect(run?.outcome).toBe('published')
    expect(run?.failedGate).toBeNull()
    expect(run?.reachBoundUsed).toBe('max')
    expect(run?.corpusSize).toBe(61)
    expect(run?.excluded).toEqual({ stillRunning: 4, zeroReach: 5, subDay: 6 })
    expect(run?.nIncluded).toBe(46)
    expect(run?.advertisersTotal).toBe(15)
    expect(run?.advertisersUsed).toBe(9)
    expect(run?.advertisersDropped).toBe(3)
    expect(run?.beta).toBe(1.18)
    expect(run?.betaSe).toBe(0.07)
    expect(run?.betaCiLow).toBe(1.04)
    expect(run?.betaCiHigh).toBe(1.32)
    expect(run?.tStat).toBe(2.57)
    expect(run?.pValue).toBe(0.012)
    expect(run?.df).toBe(36)
    expect(run?.naivePooledBeta).toBe(1.41)
    expect(run?.naivePearsonR).toBe(0.63)
    expect(run?.verdict).toBe('reflects_effort')
  })

  it('derives betaMinusOne as arithmetic, not a second pass over the corpus', () => {
    // 1.18 - 1, at floating-point precision — not a hand-rounded 0.18. Pinning the raw
    // subtraction here is what catches a future change that rounds before storing the field.
    expect(latest.a?.betaMinusOne).toBeCloseTo(0.18, 10)
  })

  it('leaves every regression field null on a refusal, not zero-filled', () => {
    // A refused run never ran the regression — a zero would read as a measured beta of 0.
    const run = latest.b
    expect(run?.beta).toBeNull()
    expect(run?.betaMinusOne).toBeNull()
    expect(run?.betaSe).toBeNull()
    expect(run?.betaCiLow).toBeNull()
    expect(run?.betaCiHigh).toBeNull()
    expect(run?.tStat).toBeNull()
    expect(run?.pValue).toBeNull()
    expect(run?.df).toBeNull()
    expect(run?.naivePooledBeta).toBeNull()
    expect(run?.naivePearsonR).toBeNull()
    expect(run?.verdict).toBeNull()
  })

  it('dates the run on the market calendar, not on UTC', () => {
    expect(latest.a?.runDate).toBe(RUN_DATE_A)
  })

  it('is the same run date in every timezone', () => {
    const original = process.env['TZ']
    try {
      process.env['TZ'] = 'Pacific/Kiritimati'
      expect(latest.a?.runDate).toBe(RUN_DATE_A)
    } finally {
      if (original === undefined) delete process.env['TZ']
      else process.env['TZ'] = original
    }
  })

  it('never returns another workspace run', () => {
    expect(latest.a?.runId).not.toBe(latest.b?.runId)
    expect(latest.a?.runId).not.toBe(latest.c?.runId)
  })
})
