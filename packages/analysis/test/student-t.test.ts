import { describe, expect, it } from 'vitest'

import {
  regularizedIncompleteBeta,
  studentTCritical,
  twoSidedStudentP,
} from '../src/student-t.ts'
import fixtures from './fixtures.json' with { type: 'json' }

/**
 * Reference values or nothing — same discipline as `normal.test.ts`, for the sibling tail
 * this module exists because the normal approximation is wrong on UC-7's degrees of freedom
 * (see `student-t.ts`'s own header). `toBeGreaterThan(0)` would pass for a broken continued
 * fraction just as readily as a correct one; only an external value pins the bug.
 */

const TAIL = fixtures.studentTTail as { t: number; df: number; p: number }[]
const CRITICAL = fixtures.studentTCritical as { alpha: number; df: number; tCritical: number }[]

function relativeError(actual: number, expected: number): number {
  if (expected === 0) return Math.abs(actual)
  return Math.abs(actual - expected) / expected
}

describe('twoSidedStudentP against scipy', () => {
  it('covers a range of df, not just one', () => {
    const dfs = new Set(TAIL.map((c) => c.df))
    expect(dfs.size).toBeGreaterThanOrEqual(9)
    expect(Math.min(...dfs)).toBe(1)
    expect(Math.max(...dfs)).toBeGreaterThanOrEqual(1000)
  })

  for (const testCase of TAIL) {
    it(`matches to 10 significant digits at t=${testCase.t}, df=${testCase.df}`, () => {
      expect(relativeError(twoSidedStudentP(testCase.t, testCase.df), testCase.p)).toBeLessThan(
        1e-10,
      )
    })
  }
})

describe('studentTCritical against scipy', () => {
  for (const testCase of CRITICAL) {
    it(`matches to 8 significant digits at alpha=${testCase.alpha}, df=${testCase.df}`, () => {
      expect(
        relativeError(studentTCritical(testCase.alpha, testCase.df), testCase.tCritical),
      ).toBeLessThan(1e-8)
    })
  }

  it('is the inverse of twoSidedStudentP: P(|T| > t*) = alpha at the critical value', () => {
    for (const df of [1, 5, 30, 200]) {
      for (const alpha of [0.1, 0.05, 0.01]) {
        const tCritical = studentTCritical(alpha, df)
        expect(twoSidedStudentP(tCritical, df)).toBeCloseTo(alpha, 8)
      }
    }
  })
})

describe('the properties the fixtures cannot pin', () => {
  it('is symmetric: the sign of t never changes the p-value', () => {
    for (const df of [1, 5, 30]) {
      for (const t of [0.3, 1.7, 4.2]) {
        expect(twoSidedStudentP(t, df)).toBe(twoSidedStudentP(-t, df))
      }
    }
  })

  it('is monotone decreasing in |t|', () => {
    for (const df of [1, 5, 30]) {
      let previous = twoSidedStudentP(0, df)
      for (let t = 0.25; t <= 15; t += 0.25) {
        const p = twoSidedStudentP(t, df)
        expect(p).toBeLessThanOrEqual(previous)
        previous = p
      }
    }
  })

  it('returns exactly 1 at t = 0 and never leaves [0, 1]', () => {
    for (const df of [1, 5, 30, 500]) {
      expect(twoSidedStudentP(0, df)).toBe(1)
    }
    for (let t = 0; t <= 20; t += 0.5) {
      const p = twoSidedStudentP(t, 4)
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThanOrEqual(1)
    }
  })

  it('converges toward the normal tail as df grows large', () => {
    // The whole reason `student-t.ts` exists is that the t-tail is heavier than the normal
    // one at small df — the two should nonetheless agree closely once df is in the
    // thousands, which is the sanity check that the heavier tail is a df effect and not a
    // bug that never goes away.
    const large = twoSidedStudentP(1.96, 100_000)
    expect(large).toBeCloseTo(0.05, 2)
  })

  it('rejects non-finite t and non-positive df', () => {
    expect(() => twoSidedStudentP(Number.NaN, 5)).toThrow(RangeError)
    expect(() => twoSidedStudentP(1, 0)).toThrow(RangeError)
    expect(() => twoSidedStudentP(1, -3)).toThrow(RangeError)
    expect(() => studentTCritical(0, 5)).toThrow(RangeError)
    expect(() => studentTCritical(1, 5)).toThrow(RangeError)
  })
})

describe('regularizedIncompleteBeta, on its own', () => {
  // Exercised indirectly by every case above through `twoSidedStudentP`, but a sign error
  // inside the a<->b swap at the midpoint would still pass all of those (the swap is exactly
  // symmetric under this identity), so it needs a direct check.
  it('satisfies the symmetry identity I_x(a, b) = 1 - I_{1-x}(b, a)', () => {
    for (const [a, b, x] of [
      [2, 3, 0.3],
      [0.5, 0.5, 0.7],
      [10, 4, 0.1],
      [3.5, 3.5, 0.5],
    ] as const) {
      expect(regularizedIncompleteBeta(a, b, x)).toBeCloseTo(
        1 - regularizedIncompleteBeta(b, a, 1 - x),
        12,
      )
    }
  })

  it('is 0 at x = 0 and 1 at x = 1, by definition', () => {
    expect(regularizedIncompleteBeta(3, 4, 0)).toBe(0)
    expect(regularizedIncompleteBeta(3, 4, 1)).toBe(1)
  })

  it('is exactly x when a = b = 1 (the incomplete beta reduces to the identity)', () => {
    for (const x of [0.1, 0.4, 0.75]) {
      expect(regularizedIncompleteBeta(1, 1, x)).toBeCloseTo(x, 12)
    }
  })
})
