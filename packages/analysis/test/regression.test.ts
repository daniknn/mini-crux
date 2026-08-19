import { describe, expect, it } from 'vitest'

import {
  type FinishedAd,
  naivePooledEstimate,
  withinAdvertiserRegression,
} from '../src/regression.ts'
import { twoSidedStudentP } from '../src/student-t.ts'
import fixtures from './fixtures.json' with { type: 'json' }

/**
 * Reference values or nothing — same discipline as `van-elteren.test.ts`. A within-advertiser
 * regression with the demeaning done against the wrong axis, or `df` off by exactly the
 * advertiser count, still returns a beta in a believable range and a p-value in `[0, 1]`.
 * Every numeric assertion below pins a value `reference/generate.py` computed independently,
 * cross-checked there against dummy-variable OLS via `numpy.linalg.lstsq` — see that script's
 * header for how independent that check actually is.
 */

interface FixtureAd {
  advertiser: string
  days: number
  reach: number
}

interface ExpectedRegression {
  beta: number
  betaMinusOne: number
  se: number
  ciLow: number
  ciHigh: number
  tStat: number
  pValue: number
  df: number
  n: number
  advertisersUsed: number
  advertisersDropped: number
  betaDummyOls: number
}

interface ExpectedNaive {
  pooledBeta: number
  pearsonR: number
  n: number
}

interface Case {
  name: string
  why: string
  ads: FixtureAd[]
  expected: ExpectedRegression
  naive: ExpectedNaive
}

const CASES = fixtures.regression as Case[]

function byName(name: string): Case {
  const found = CASES.find((c) => c.name === name)
  if (found === undefined) throw new Error(`fixture ${name} is missing — regenerate them`)
  return found
}

function toFinishedAds(ads: FixtureAd[]): FinishedAd[] {
  return ads.map((a) => ({ advertiser: a.advertiser, daysActive: a.days, reach: a.reach }))
}

function relativeError(actual: number, expected: number): number {
  if (expected === 0) return Math.abs(actual)
  return Math.abs(actual - expected) / expected
}

/** Full precision, not "close enough": these are the numbers the product publishes. */
function expectMatches(
  actual: ReturnType<typeof withinAdvertiserRegression>,
  expected: ExpectedRegression,
): void {
  if (actual === null) throw new Error('expected a result, got null')
  expect(relativeError(actual.beta, expected.beta)).toBeLessThan(1e-9)
  expect(relativeError(actual.betaMinusOne, expected.betaMinusOne)).toBeLessThan(1e-9)
  expect(relativeError(actual.se, expected.se)).toBeLessThan(1e-9)
  expect(relativeError(actual.ciLow, expected.ciLow)).toBeLessThan(1e-8)
  expect(relativeError(actual.ciHigh, expected.ciHigh)).toBeLessThan(1e-8)
  expect(relativeError(actual.tStat, expected.tStat)).toBeLessThan(1e-9)
  expect(relativeError(actual.pValue, expected.pValue)).toBeLessThan(1e-8)
  expect(actual.df).toBe(expected.df)
  expect(actual.n).toBe(expected.n)
  expect(actual.advertisersUsed).toBe(expected.advertisersUsed)
  expect(actual.advertisersDropped).toBe(expected.advertisersDropped)
  // The independent route the generator cross-checked itself against, per the spec's own
  // acceptance criterion ("matches a scipy reference fixture to 1e-9").
  expect(relativeError(actual.beta, expected.betaDummyOls)).toBeLessThan(1e-9)
}

describe('withinAdvertiserRegression against the reference fixtures', () => {
  it('covers every case the generator produced', () => {
    expect(CASES.map((c) => c.name)).toEqual([
      'general_case',
      'singleton_advertiser_dropped',
      'df_matters',
      'near_proportional_accumulation',
      'dominant_advertiser_confound',
    ])
  })

  for (const testCase of CASES) {
    it(`${testCase.name}: ${testCase.why.slice(0, 60)}...`, () => {
      const result = withinAdvertiserRegression(toFinishedAds(testCase.ads))
      expectMatches(result, testCase.expected)
    })
  }
})

describe('naivePooledEstimate against the reference fixtures', () => {
  for (const testCase of CASES) {
    it(`${testCase.name}: pooled beta and Pearson r match scipy.stats.linregress`, () => {
      const result = naivePooledEstimate(toFinishedAds(testCase.ads))
      if (result === null) throw new Error('expected a result, got null')
      expect(relativeError(result.pooledBeta, testCase.naive.pooledBeta)).toBeLessThan(1e-9)
      expect(relativeError(result.pearsonR, testCase.naive.pearsonR)).toBeLessThan(1e-9)
      expect(result.n).toBe(testCase.naive.n)
    })
  }
})

describe('the properties the fixtures exist to demonstrate', () => {
  it('an advertiser with one finished ad changes nothing but the dropped count', () => {
    const withSolo = byName('singleton_advertiser_dropped')
    const without = byName('general_case')
    const resultWithSolo = withinAdvertiserRegression(toFinishedAds(withSolo.ads))
    const resultWithout = withinAdvertiserRegression(toFinishedAds(without.ads))
    if (resultWithSolo === null || resultWithout === null) throw new Error('expected a result')

    expect(resultWithSolo.beta).toBeCloseTo(resultWithout.beta, 12)
    expect(resultWithSolo.se).toBeCloseTo(resultWithout.se, 12)
    expect(resultWithSolo.df).toBe(resultWithout.df)
    expect(resultWithSolo.advertisersUsed).toBe(resultWithout.advertisersUsed)
    expect(resultWithSolo.advertisersDropped).toBe(resultWithout.advertisersDropped + 1)
  })

  it('df = n - A - 1 gives a materially different p-value than the naive n - 2 would', () => {
    const testCase = byName('df_matters')
    const result = withinAdvertiserRegression(toFinishedAds(testCase.ads))
    if (result === null) throw new Error('expected a result')

    const wrongDf = result.n - 2
    expect(wrongDf).not.toBe(result.df)
    const pWithWrongDf = twoSidedStudentP(result.tStat, wrongDf)
    // Both happen to reject here, but the p-values themselves are orders of magnitude
    // apart — using n - 2 is not "slightly optimistic", it is a different answer.
    expect(pWithWrongDf / result.pValue).toBeLessThan(0.01)
  })

  it('exact proportional accumulation does not reject beta = 1', () => {
    const testCase = byName('near_proportional_accumulation')
    const result = withinAdvertiserRegression(toFinishedAds(testCase.ads))
    if (result === null) throw new Error('expected a result')
    expect(result.pValue).toBeGreaterThan(0.05)
    expect(result.beta).toBeCloseTo(1, 1)
  })

  it('a dominant advertiser makes the naive and within-advertiser estimates disagree in sign of the reading', () => {
    const testCase = byName('dominant_advertiser_confound')
    const within = withinAdvertiserRegression(toFinishedAds(testCase.ads))
    const naive = naivePooledEstimate(toFinishedAds(testCase.ads))
    if (within === null || naive === null) throw new Error('expected a result')
    // Naive reads a strong positive validation (beta well above 1, r near 1); the
    // within-advertiser estimate reads the opposite: reach barely tracks duration at all.
    expect(naive.pooledBeta).toBeGreaterThan(1.5)
    expect(naive.pearsonR).toBeGreaterThan(0.9)
    expect(within.beta).toBeLessThan(0.5)
  })

  /**
   * Beta exactly 1, constructed by hand rather than pulled from a fixture — the direct test
   * of "the null is beta = 1" (spec rule 1, acceptance criterion "a fixture with beta
   * exactly 1 does not reject").
   *
   * One advertiser, four ads. In demeaned log-log space the days are `x = [-3, -1, 1, 3]`
   * and the reach is `y = x + r` with `r = [1, -1, -1, 1]`. `r` sums to zero (so `y` is a
   * valid demeaned series) and is orthogonal to `x` (`sum(x·r) = -3+1-1+3 = 0`), which
   * forces `sxy = sum(x·y) = sum(x·x) + sum(x·r) = sxx` exactly — beta = sxy/sxx = 1 on the
   * nose, by construction, while the residuals `r` are not all zero, so `se` is a genuine
   * positive number and this is not the degenerate `0/0` a perfect fit would produce.
   */
  it('beta = 1 by construction gives tStat = 0 and pValue = 1', () => {
    const ads: FinishedAd[] = [
      { advertiser: 'adv_only', daysActive: Math.exp(-1), reach: Math.exp(8) },
      { advertiser: 'adv_only', daysActive: Math.exp(1), reach: Math.exp(8) },
      { advertiser: 'adv_only', daysActive: Math.exp(3), reach: Math.exp(10) },
      { advertiser: 'adv_only', daysActive: Math.exp(5), reach: Math.exp(14) },
    ]
    const result = withinAdvertiserRegression(ads)
    if (result === null) throw new Error('expected a result')
    expect(result.beta).toBeCloseTo(1, 9)
    expect(result.df).toBe(2)
    expect(result.se).toBeGreaterThan(0)
    expect(result.tStat).toBeCloseTo(0, 6)
    expect(result.pValue).toBeCloseTo(1, 6)
  })

  it('returns null when every advertiser contributed at most one ad', () => {
    const ads: FinishedAd[] = [
      { advertiser: 'a', daysActive: 10, reach: 100 },
      { advertiser: 'b', daysActive: 20, reach: 200 },
      { advertiser: 'c', daysActive: 30, reach: 300 },
    ]
    expect(withinAdvertiserRegression(ads)).toBeNull()
  })

  it('returns null when df is non-positive', () => {
    // One advertiser, two ads: n = 2, advertisersUsed = 1, df = 2 - 1 - 1 = 0.
    const ads: FinishedAd[] = [
      { advertiser: 'a', daysActive: 10, reach: 100 },
      { advertiser: 'a', daysActive: 20, reach: 400 },
    ]
    expect(withinAdvertiserRegression(ads)).toBeNull()
  })

  it('returns null when demeaned days have no variance (sxx = 0)', () => {
    const ads: FinishedAd[] = [
      { advertiser: 'a', daysActive: 10, reach: 100 },
      { advertiser: 'a', daysActive: 10, reach: 400 },
      { advertiser: 'a', daysActive: 10, reach: 900 },
    ]
    expect(withinAdvertiserRegression(ads)).toBeNull()
  })

  it('naivePooledEstimate returns null with fewer than two ads', () => {
    expect(naivePooledEstimate([])).toBeNull()
    expect(naivePooledEstimate([{ advertiser: 'a', daysActive: 10, reach: 100 }])).toBeNull()
  })
})
