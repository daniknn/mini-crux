import { describe, expect, it } from 'vitest'

import { benjaminiHochberg } from '../src/fdr.ts'
import fixtures from './fixtures.json' with { type: 'json' }

/** Reference q-values come from `scipy.stats.false_discovery_control`, not from here. */

interface BhCase {
  name: string
  why: string
  p: number[]
  q: number[]
}

const CASES = fixtures.benjaminiHochberg as BhCase[]

describe('benjaminiHochberg against the reference', () => {
  it('covers every case the generator produced', () => {
    expect(CASES.map((c) => c.name)).toEqual([
      'monotonicity_step_up',
      'unsorted_input',
      'large_p_values',
      'single_test',
    ])
  })

  for (const testCase of CASES) {
    it(`matches scipy for ${testCase.name} — ${testCase.why}`, () => {
      const q = benjaminiHochberg(testCase.p)
      expect(q).toHaveLength(testCase.q.length)
      q.forEach((value, index) => expect(value).toBeCloseTo(testCase.q[index]!, 12))
    })
  }
})

describe('the parts that fail silently', () => {
  /**
   * The step-up is the whole difference between BH and "multiply by m over rank". Without
   * it, feature 3 below reports q = 0.078 while feature 5, with a *larger* p, reports
   * 0.0504 — an ordering that contradicts its own inputs and reads to an operator like a
   * data problem.
   */
  it('enforces monotonicity, so a smaller p never gets a larger q', () => {
    const p = [0.001, 0.008, 0.039, 0.041, 0.042, 0.6]
    const q = benjaminiHochberg(p)

    // Pinned exactly: raw p·m/i at rank 3 is 0.078, and the step-up pulls it down to the
    // running minimum from rank 5. Asserting only "sorted" would pass for an
    // implementation that returned the raw p-values.
    expect(q[2]).toBeCloseTo(0.0504, 12)
    expect(q[3]).toBeCloseTo(0.0504, 12)
    expect(q[4]).toBeCloseTo(0.0504, 12)
    expect(q[0]).toBeCloseTo(0.006, 12)
    expect(q[1]).toBeCloseTo(0.024, 12)

    for (let i = 1; i < q.length; i += 1) {
      expect(q[i]!).toBeGreaterThanOrEqual(q[i - 1]!)
    }
  })

  it('returns q-values in the caller order, not sorted order', () => {
    /**
     * The failure this catches has no numeric signature at all: every q-value returned is
     * correct, they are simply attached to the wrong features. The product would publish a
     * real finding under another feature's name.
     */
    const p = [0.6, 0.001, 0.041]
    const q = benjaminiHochberg(p)
    expect(q[0]).toBeCloseTo(0.6, 12)
    expect(q[1]).toBeCloseTo(0.003, 12)
    expect(q[2]).toBeCloseTo(0.0615, 12)

    // And the same p-values in a different order must produce the same pairing.
    const reordered = benjaminiHochberg([0.041, 0.6, 0.001])
    expect(reordered[0]).toBeCloseTo(q[2]!, 12)
    expect(reordered[1]).toBeCloseTo(q[0]!, 12)
    expect(reordered[2]).toBeCloseTo(q[1]!, 12)
  })

  it('caps every q at the largest p in the run, which is what keeps them below 1', () => {
    /**
     * Raw p·m/i runs well past 1 here — 0.4·4/1 is 1.6 — and yet no clamp is needed. The
     * largest rank contributes p_m·m/m = p_m, and the running minimum sweeps down from
     * there, so `max(q) === max(p)` exactly.
     *
     * This started as a `toBeLessThanOrEqual(1)` assertion and a `Math.min(…, 1)` in the
     * source. Deleting that clamp left the suite green, because the step-up had already
     * done the work — a guard that never fires next to one that always does
     * (`CLAUDE.md`: a fixture where two expressions coincide tests neither). The clamp is
     * gone and the exact identity is asserted instead, which is a stronger statement and
     * one that can actually fail.
     */
    const p = [0.4, 0.7, 0.9, 0.95]
    const q = benjaminiHochberg(p)
    expect(Math.max(...q)).toBe(Math.max(...p))
    expect(q).toEqual([0.95, 0.95, 0.95, 0.95])
    expect(benjaminiHochberg([1, 1, 1])).toEqual([1, 1, 1])
  })

  it('is the identity for a single test', () => {
    expect(benjaminiHochberg([0.031])).toEqual([0.031])
  })

  it('handles an empty run', () => {
    expect(benjaminiHochberg([])).toEqual([])
  })

  it('rejects anything that is not a p-value', () => {
    // A NaN would sort unpredictably and propagate into every q. Better to fail the run
    // than to publish six numbers derived from one.
    expect(() => benjaminiHochberg([0.1, Number.NaN])).toThrow(RangeError)
    expect(() => benjaminiHochberg([0.1, 1.5])).toThrow(RangeError)
    expect(() => benjaminiHochberg([-0.1])).toThrow(RangeError)
  })

  it('does not mutate the caller array', () => {
    const p = [0.6, 0.001, 0.041]
    benjaminiHochberg(p)
    expect(p).toEqual([0.6, 0.001, 0.041])
  })
})
