/**
 * The two-sided standard-normal tail probability.
 *
 * WHY NOT THE USUAL ONE-LINER
 *
 * The approximation most often pasted into JavaScript for this is Abramowitz & Stegun
 * 7.1.26, which is accurate to about 1.5e-7 *absolute*. Near z = 2 that is fine. At z = 6,
 * where the true p is 2e-9, an absolute error of 1.5e-7 is roughly seventy times the answer
 * — the function returns noise with the shape of a probability. That is exactly the range
 * the product cares about, because a large |z| is what gets published.
 *
 * So this is the Chebyshev expansion of `erfc` from Numerical Recipes 3rd ed. §6.2, which
 * is accurate in the *relative* sense across the whole tail. `normal.test.ts` pins it
 * against scipy at z up to 8, where p is 1.2e-15, and asserts relative rather than absolute
 * agreement — an absolute assertion there would pass for any function that returns
 * something small.
 */

/**
 * Chebyshev coefficients for `erfc` on the substitution t = 2/(2 + z). Numerical Recipes
 * 3rd ed., `Erf::cof`. Copied as printed; verified by the reference test rather than by
 * eye, because a mistyped coefficient degrades the fit smoothly instead of breaking it.
 */
const COF = [
  -1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2, -9.561514786808631e-3,
  -9.46595344482036e-4, 3.66839497852761e-4, 4.2523324806907e-5, -2.0278578112534e-5,
  -1.624290004647e-6, 1.303655835580e-6, 1.5626441722e-8, -8.5238095915e-8, 6.529054439e-9,
  5.059343495e-9, -9.91364156e-10, -2.27365122e-10, 9.6467911e-11, 2.394038e-12,
  -6.886027e-12, 8.94487e-13, 3.13092e-13, -1.12708e-13, 3.81e-16, 7.106e-15,
] as const

/** Complementary error function, relative accuracy near machine epsilon. */
export function erfc(x: number): number {
  const z = Math.abs(x)
  const t = 2 / (2 + z)
  const ty = 4 * t - 2

  // Clenshaw recurrence over the coefficients above.
  let d = 0
  let dd = 0
  for (let j = COF.length - 1; j > 0; j -= 1) {
    const tmp = d
    d = ty * d - dd + (COF[j] as number)
    dd = tmp
  }
  const ans = t * Math.exp(-z * z + 0.5 * ((COF[0] as number) + ty * d) - dd)

  // erfc is symmetric about 1: erfc(-x) = 2 - erfc(x). For x < 0 the answer is close to 2
  // and the subtraction is exact in floating point, so no precision is lost here.
  return x >= 0 ? ans : 2 - ans
}

/**
 * `P(|Z| > |z|)` for a standard normal — the two-sided p-value of a z-score.
 *
 * Equal to `2·sf(|z|)`, but written as a single `erfc` call because computing the survival
 * function and doubling it loses a bit of precision for no reason: `2·(erfc(u)/2)` is the
 * same expression with an extra rounding step in the middle.
 */
export function twoSidedNormalP(z: number): number {
  if (!Number.isFinite(z)) {
    throw new RangeError(`z must be finite, got ${z}`)
  }
  // Clamped at 1, and not for tidiness. The Chebyshev fit overshoots by about 1.6e-15 near
  // z = 0 — `erfc(0)` comes back as 1.0000000000000016 — which is a p-value greater than
  // one. `benjaminiHochberg` rejects those, so an unclamped tail would take a run where one
  // feature happened to land on z ≈ 0 and fail the entire analysis, six features at once,
  // with a range error about a number that is correct to fifteen digits.
  //
  // Only the upper end is clamped. The fit never returns a negative, and clamping a
  // negative would paper over a genuinely broken coefficient table instead of surfacing it.
  return Math.min(1, erfc(Math.abs(z) / Math.SQRT2))
}
