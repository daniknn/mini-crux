/**
 * The Student-t tail, needed because UC-7's null is `beta = 1`, not `beta = 0`.
 *
 * WHY NOT THE NORMAL APPROXIMATION ALREADY IN THIS PACKAGE
 *
 * `normal.ts` is exact for a van Elteren z-score, which is asymptotically normal by
 * construction. The within-advertiser regression's t-statistic is not: its degrees of
 * freedom are `n - A - 1`, which on a corpus thin enough to just clear UC-7's gate can be a
 * double-digit number, where the t-distribution's heavier tail matters. Using the normal
 * tail there would understate the p-value and overstate the confidence interval's
 * precision — exactly backwards for a test whose entire premise is refusing to overclaim.
 *
 * IMPLEMENTATION
 *
 * `P(|T| > t)` for a Student-t with `df` degrees of freedom has a closed form in terms of
 * the regularized incomplete beta function:
 *
 *   P(|T| > t) = I_{df/(df+t^2)}(df/2, 1/2)
 *
 * (Numerical Recipes 3rd ed. §6.14.4). `regularizedIncompleteBeta` is the textbook
 * continued-fraction evaluation (`betacf`/`betai`), which is what `scipy.stats.t` itself is
 * built on — so this is not an independent algorithm from the reference fixtures, but it is
 * a well-established one, cross-checked at the level the fixtures actually exercise: p and
 * critical-value pairs across a range of df, not the continued fraction's internals.
 *
 * `studentTCritical` inverts the same function by bisection rather than a closed form,
 * because none of the closed forms for a t-quantile are simpler than "the tail probability
 * is monotone decreasing in t, so bisect".
 */

/** Natural log of the gamma function, Lanczos approximation (g = 7, n = 9), ~15 digits. */
const LANCZOS_G = 7
const LANCZOS_COEFFICIENTS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
] as const

function lgamma(x: number): number {
  if (x < 0.5) {
    // Reflection formula: gamma(x)·gamma(1-x) = pi / sin(pi·x). Used only for the tiny
    // arguments the beta-function evaluation below never actually reaches (a and b here are
    // always >= 0.5), kept for completeness rather than exercised by these fixtures.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x)
  }

  const xm1 = x - 1
  let a = LANCZOS_COEFFICIENTS[0] as number
  const t = xm1 + LANCZOS_G + 0.5
  for (let i = 1; i < LANCZOS_COEFFICIENTS.length; i += 1) {
    a += (LANCZOS_COEFFICIENTS[i] as number) / (xm1 + i)
  }
  return 0.5 * Math.log(2 * Math.PI) + (xm1 + 0.5) * Math.log(t) - t + Math.log(a)
}

const MAX_ITERATIONS = 200
const EPSILON = 3e-16
const FLOOR = 1e-300

/** Continued-fraction evaluation used inside the incomplete beta function. */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const qab = a + b
  const qap = a + 1
  const qam = a - 1

  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < FLOOR) d = FLOOR
  d = 1 / d
  let h = d

  for (let m = 1; m <= MAX_ITERATIONS; m += 1) {
    const m2 = 2 * m

    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FLOOR) d = FLOOR
    c = 1 + aa / c
    if (Math.abs(c) < FLOOR) c = FLOOR
    d = 1 / d
    h *= d * c

    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FLOOR) d = FLOOR
    c = 1 + aa / c
    if (Math.abs(c) < FLOOR) c = FLOOR
    d = 1 / d
    const del = d * c
    h *= del

    if (Math.abs(del - 1) < EPSILON) break
  }

  return h
}

/**
 * The regularized incomplete beta function `I_x(a, b)`, for `0 <= x <= 1` and `a, b > 0`.
 *
 * Exported for its own test — a bug here would corrupt every p-value and every confidence
 * interval this module produces, and the continued fraction converges from both ends of its
 * domain by a different path, so testing it directly is what actually exercises both.
 */
export function regularizedIncompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1

  const logBeta = lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x)
  const front = Math.exp(logBeta)

  // The continued fraction converges fastest near x = 0; past the midpoint, evaluate the
  // complementary integral instead and subtract from 1, rather than let it converge slowly.
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betaContinuedFraction(a, b, x)) / a
  }
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b
}

/**
 * `P(|T| > |t|)` for a Student-t with `df` degrees of freedom — the two-sided p-value of a
 * t-statistic. `df` need not be an integer; the within-advertiser regression's degrees of
 * freedom always are, but the closed form does not require it.
 */
export function twoSidedStudentP(t: number, df: number): number {
  if (!Number.isFinite(t)) {
    throw new RangeError(`t must be finite, got ${t}`)
  }
  if (!(df > 0)) {
    throw new RangeError(`df must be positive, got ${df}`)
  }
  const x = df / (df + t * t)
  return regularizedIncompleteBeta(df / 2, 0.5, x)
}

/**
 * The two-sided critical value `t*` such that `P(|T| > t*) = alpha`, for a `(1 - alpha)`
 * confidence interval on `df` degrees of freedom.
 *
 * `twoSidedStudentP(·, df)` is continuous and strictly decreasing from 1 at `t = 0` toward 0
 * as `t -> infinity`, so bisection needs only a bracket wide enough to contain the root —
 * found by doubling — and then halves it to machine precision.
 */
export function studentTCritical(alpha: number, df: number): number {
  if (!(alpha > 0 && alpha < 1)) {
    throw new RangeError(`alpha must be in (0, 1), got ${alpha}`)
  }

  let lo = 0
  let hi = 1
  while (twoSidedStudentP(hi, df) > alpha) hi *= 2

  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2
    if (twoSidedStudentP(mid, df) > alpha) lo = mid
    else hi = mid
    if (hi - lo < 1e-13 * Math.max(1, hi)) break
  }

  return (lo + hi) / 2
}
