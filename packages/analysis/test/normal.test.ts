import { describe, expect, it } from 'vitest'

import { benjaminiHochberg } from '../src/fdr.ts'
import { twoSidedNormalP } from '../src/normal.ts'
import fixtures from './fixtures.json' with { type: 'json' }

/**
 * Every p-value the product publishes comes through here.
 *
 * The assertions are **relative**, not absolute, and that is the whole point of the file.
 * At z = 8 the true p is 1.2e-15; an absolute tolerance of 1e-6 there is satisfied by
 * `return 0`, by `return 1e-9`, and by the popular Abramowitz-Stegun one-liner whose error
 * in that range is thousands of times the answer. A tail approximation is only meaningful
 * to the number of *significant digits* it keeps.
 */

const CASES = fixtures.normalTail as { z: number; p: number }[]

function relativeError(actual: number, expected: number): number {
  if (expected === 0) return Math.abs(actual)
  return Math.abs(actual - expected) / expected
}

describe('twoSidedNormalP against scipy', () => {
  it('covers the tail, not just the middle', () => {
    // Guards the fixture itself: a set of z-values that stopped at 2 would make every
    // assertion below pass for an approximation that falls apart at 6.
    expect(Math.max(...CASES.map((c) => Math.abs(c.z)))).toBeGreaterThanOrEqual(8)
    expect(Math.min(...CASES.map((c) => c.p))).toBeLessThan(1e-14)
  })

  for (const testCase of CASES) {
    it(`matches to 12 significant digits at z = ${testCase.z}`, () => {
      expect(relativeError(twoSidedNormalP(testCase.z), testCase.p)).toBeLessThan(1e-12)
    })
  }
})

describe('the properties the fixtures cannot pin', () => {
  it('is symmetric: the sign of z never changes the p-value', () => {
    for (const z of [0.37, 1.4, 2.9, 5.5]) {
      expect(twoSidedNormalP(z)).toBe(twoSidedNormalP(-z))
    }
  })

  it('is monotone decreasing in |z|', () => {
    let previous = twoSidedNormalP(0)
    for (let z = 0.25; z <= 9; z += 0.25) {
      const p = twoSidedNormalP(z)
      expect(p).toBeLessThan(previous)
      previous = p
    }
  })

  it('returns exactly 1 at z = 0 and never leaves [0, 1]', () => {
    /**
     * Not a tidiness check. The raw Chebyshev fit overshoots to 1.0000000000000016 at
     * z = 0, and `benjaminiHochberg` throws on a p-value above 1 — so a feature that
     * happened to land on z ≈ 0, which is the *least* interesting result possible, would
     * abort the whole six-feature run with a range error.
     */
    expect(twoSidedNormalP(0)).toBe(1)
    for (let z = 0; z <= 40; z += 0.5) {
      const p = twoSidedNormalP(z)
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThanOrEqual(1)
    }
  })

  it('produces p-values Benjamini-Hochberg will accept, including at z = 0', () => {
    // The two modules meet here and nowhere else, so the contract between them gets its
    // own assertion rather than being implied by two passing unit tests.
    const p = [0, 1e-9, 0.5, 3.2, -8].map(twoSidedNormalP)
    expect(() => benjaminiHochberg(p)).not.toThrow()
  })

  it('refuses a non-finite z rather than returning NaN', () => {
    // `vanElteren` guards against a zero variance, so this should be unreachable — which is
    // exactly why it must throw rather than return. An unreachable path that silently
    // returns NaN stays unreachable right up until it isn't.
    expect(() => twoSidedNormalP(Number.NaN)).toThrow(RangeError)
    expect(() => twoSidedNormalP(Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })
})
