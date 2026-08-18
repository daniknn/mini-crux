import { describe, expect, it } from 'vitest'

import { vanElteren, type Stratum } from '../src/van-elteren.ts'
import fixtures from './fixtures.json' with { type: 'json' }

/**
 * Reference values or nothing.
 *
 * `specs/UC-5` calls this the use case where a green suite is least trustworthy, and it is
 * right: statistical code returns plausible numbers under almost any bug. A wrong tie
 * correction still yields a z in a believable range; a reversed sign still yields a
 * significant p. Every assertion here therefore pins an **exact value** produced outside
 * this codebase by `reference/generate.py`, which cross-checks itself against scipy and
 * against a brute-force pair count. `toBeGreaterThan(0)` would pass for the bugs.
 *
 * The one thing the fixtures cannot pin is the stratum combination itself, since scipy has
 * no van Elteren — that limitation is written down in the generator rather than left for a
 * reader to discover.
 */

interface FixtureStratum {
  stratum: string
  long: number[]
  short: number[]
}

interface Expected {
  z: number
  p: number
  t: number
  expectedT: number
  varianceT: number
  probabilitySuperiority: number
  rankBiserial: number
  nLong: number
  nShort: number
  strataUsed: number
  strataDropped: number
}

interface Case {
  name: string
  why: string
  strata: FixtureStratum[]
  expected: Expected
  scipy: { u: number; p: number } | null
  pooled?: Expected
}

const CASES = fixtures.vanElteren as Case[]

function byName(name: string): Case {
  const found = CASES.find((c) => c.name === name)
  if (found === undefined) throw new Error(`fixture ${name} is missing — regenerate them`)
  return found
}

/** Full precision, not "close enough": these are the numbers the product publishes. */
function expectMatches(actual: ReturnType<typeof vanElteren>, expected: Expected): void {
  if (actual === null) throw new Error('expected a result, got null')
  expect(actual.z).toBeCloseTo(expected.z, 12)
  expect(actual.p).toBeCloseTo(expected.p, 12)
  expect(actual.t).toBeCloseTo(expected.t, 12)
  expect(actual.expectedT).toBeCloseTo(expected.expectedT, 12)
  expect(actual.varianceT).toBeCloseTo(expected.varianceT, 12)
  expect(actual.probabilitySuperiority).toBeCloseTo(expected.probabilitySuperiority, 12)
  expect(actual.rankBiserial).toBeCloseTo(expected.rankBiserial, 12)
  expect(actual.nLong).toBe(expected.nLong)
  expect(actual.nShort).toBe(expected.nShort)
  expect(actual.strataUsed).toBe(expected.strataUsed)
  expect(actual.strataDropped).toBe(expected.strataDropped)
}

describe('vanElteren against the reference fixtures', () => {
  // There are five, and each one exists for a stated reason. If this list ever runs short,
  // the generator and the suite have drifted apart.
  it('covers every case the generator produced', () => {
    expect(CASES.map((c) => c.name)).toEqual([
      'single_stratum_no_ties',
      'single_stratum_heavy_ties',
      'three_strata_balanced',
      'dominant_advertiser',
      'single_cohort_strata_dropped',
    ])
  })

  for (const testCase of CASES) {
    it(`matches the reference for ${testCase.name} — ${testCase.why}`, () => {
      expectMatches(vanElteren(testCase.strata), testCase.expected)
    })
  }
})

describe('tie correction', () => {
  /**
   * The acceptance criterion, stated directly: a fixture with many ties must give a
   * *different* variance than the same fixture without. The two cases are built with
   * identical group sizes precisely so that nothing but the ties can explain the gap —
   * without the matched twin, any variance at all would look correct.
   */
  it('lowers the variance relative to the same shape with no ties', () => {
    const untied = vanElteren(byName('single_stratum_no_ties').strata)
    const tied = vanElteren(byName('single_stratum_heavy_ties').strata)
    if (untied === null || tied === null) throw new Error('both cases should produce a result')

    expect(tied.nLong).toBe(untied.nLong)
    expect(tied.nShort).toBe(untied.nShort)
    expect(tied.varianceT).toBeLessThan(untied.varianceT)

    // With n₁ = n₂ = 6 and no ties the classical variance is 6·6·13/12 = 39, scaled by the
    // weight (1/13)² = 39/169. Spelling the arithmetic out here means an implementation that
    // dropped the correction entirely would have to match this number by accident.
    expect(untied.varianceT).toBeCloseTo(39 / 169, 12)
    expect(tied.varianceT).toBeCloseTo(byName('single_stratum_heavy_ties').expected.varianceT, 12)
  })

  it('gives the same answer however the values are ordered within a stratum', () => {
    // Midranks make the statistic independent of input order. Raw positional ranks do not:
    // with ties, whichever group is listed first collects the lower positions, so the same
    // data reordered produces a different z. Nothing about a single run reveals this.
    const original = byName('single_stratum_heavy_ties').strata
    const shuffled: Stratum[] = original.map((s) => ({
      stratum: s.stratum,
      long: [...s.long].reverse(),
      short: [...s.short].reverse(),
    }))
    expect(vanElteren(shuffled)?.z).toBeCloseTo(vanElteren(original)!.z, 12)
  })
})

describe('stratification', () => {
  /**
   * The reason the whole test is stratified, made concrete. `adv_big` has 35 long-lived and
   * 5 short-lived creatives all drawn from the same high values — no within-advertiser
   * contrast whatsoever — while three small advertisers each run *lower* when long-lived.
   *
   * Pooled, the big advertiser's volume at high values swamps everything and the analysis
   * announces that long-lived creatives score higher. Stratified, it announces the
   * opposite, which is what the data actually says advertiser by advertiser.
   */
  it('does not let one advertiser at ten times the volume decide the answer', () => {
    const testCase = byName('dominant_advertiser')
    const stratified = vanElteren(testCase.strata)
    const pooled = vanElteren([
      {
        stratum: 'pooled',
        long: testCase.strata.flatMap((s) => s.long),
        short: testCase.strata.flatMap((s) => s.short),
      },
    ])
    if (stratified === null || pooled === null) throw new Error('both runs should produce a result')

    // Not merely "different": the two disagree about which cohort scores higher. A test
    // that only asserted inequality would pass for a stratification that barely moved the
    // number, which is the same as no stratification at all.
    expect(stratified.z).toBeLessThan(0)
    expect(pooled.z).toBeGreaterThan(0)
    expect(stratified.probabilitySuperiority).toBeLessThan(0.5)
    expect(pooled.probabilitySuperiority).toBeGreaterThan(0.5)

    expect(pooled.z).toBeCloseTo(testCase.pooled!.z, 12)
    expect(stratified.z).toBeCloseTo(testCase.expected.z, 12)
  })

  it('drops a stratum present in only one cohort and counts it', () => {
    const testCase = byName('single_cohort_strata_dropped')
    const withOneSided = vanElteren(testCase.strata)
    // The two single-cohort advertisers contribute nothing, so removing them entirely must
    // leave the statistic untouched. Only the dropped count changes.
    const withoutThem = vanElteren(testCase.strata.filter((s) => s.stratum === 'adv_a'))
    if (withOneSided === null || withoutThem === null) throw new Error('expected results')

    expect(withOneSided.z).toBeCloseTo(withoutThem.z, 12)
    expect(withOneSided.varianceT).toBeCloseTo(withoutThem.varianceT, 12)
    expect(withOneSided.strataUsed).toBe(1)
    expect(withOneSided.strataDropped).toBe(2)
    expect(withoutThem.strataDropped).toBe(0)

    // And their creatives are not in the n either. Counting them would report a sample the
    // test never looked at.
    expect(withOneSided.nLong).toBe(4)
    expect(withOneSided.nShort).toBe(4)
  })
})

describe('sign convention', () => {
  /**
   * Pinned on the simplest possible data, because every finding in the product inherits it
   * and reversing it leaves all the magnitudes correct. The fixtures alone would not catch
   * a flip if the generator and the implementation flipped together; this case is written
   * from the definition instead: long-lived creatives here score higher on every single
   * comparison, so PS must be exactly 1.
   */
  it('reports positive z and PS above 0.5 when long-lived creatives score higher', () => {
    const result = vanElteren([{ stratum: 'a', long: [10, 11, 12], short: [1, 2, 3] }])
    expect(result?.z).toBeGreaterThan(0)
    expect(result?.probabilitySuperiority).toBe(1)
    expect(result?.rankBiserial).toBe(1)
  })

  it('reports negative z and PS below 0.5 when long-lived creatives score lower', () => {
    const result = vanElteren([{ stratum: 'a', long: [1, 2, 3], short: [10, 11, 12] }])
    expect(result?.z).toBeLessThan(0)
    expect(result?.probabilitySuperiority).toBe(0)
    expect(result?.rankBiserial).toBe(-1)
  })

  it('reports PS of exactly ½ when the two cohorts interleave perfectly', () => {
    // Also pins the half-credit for ties, which is the term most easily dropped from
    // `P(long > short) + ½·P(equal)`.
    expect(vanElteren([{ stratum: 'a', long: [1, 1], short: [1, 1] }])).toBeNull()
    const result = vanElteren([{ stratum: 'a', long: [1, 4], short: [2, 3] }])
    expect(result?.probabilitySuperiority).toBe(0.5)
    expect(result?.rankBiserial).toBe(0)
    expect(result?.z).toBe(0)
  })
})

describe('refusing to return a number it does not have', () => {
  it('returns null when every advertiser landed in a single cohort', () => {
    // The common shape on a thin panel. Returning a z here would mean dividing zero by
    // zero and rendering the NaN as a finding.
    expect(
      vanElteren([
        { stratum: 'a', long: [1, 2, 3], short: [] },
        { stratum: 'b', long: [], short: [4, 5] },
      ]),
    ).toBeNull()
  })

  it('returns null when every observation is tied, so the variance is exactly zero', () => {
    // A real case: `cuts_per_second` is 0 for every static image in the panel. The rank sum
    // then equals its expectation exactly and the variance is 0 — arithmetically 0/0, and
    // there is genuinely no contrast to report.
    expect(
      vanElteren([
        { stratum: 'a', long: [3, 3, 3], short: [3, 3] },
        { stratum: 'b', long: [3, 3], short: [3, 3] },
      ]),
    ).toBeNull()
  })

  it('returns null for an empty panel', () => {
    expect(vanElteren([])).toBeNull()
  })

  it('still works when a stratum has exactly one creative per cohort', () => {
    // N = 2 gives variance n₁n₂(N+1)/(…) with an N−1 of 1 in the denominator — the smallest
    // stratum that is not a division by zero. Worth pinning: an off-by-one guard that
    // required N > 2 would silently drop these, and on a thin panel they are most of them.
    const result = vanElteren([
      { stratum: 'a', long: [5], short: [1] },
      { stratum: 'b', long: [6], short: [2] },
      { stratum: 'c', long: [7], short: [3] },
    ])
    expect(result?.strataUsed).toBe(3)
    expect(result?.probabilitySuperiority).toBe(1)
    expect(Number.isFinite(result!.z)).toBe(true)
  })
})
