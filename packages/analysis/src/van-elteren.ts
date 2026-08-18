import { twoSidedNormalP } from './normal.ts'

/**
 * The van Elteren test: Wilcoxon rank sum stratified by advertiser.
 *
 * WHY STRATIFIED AND NOT POOLED
 *
 * A pooled Mann-Whitney over the panel answers a question nobody asked. One advertiser with
 * two hundred creatives and a house style — every ad fast-cut, every ad kept running for
 * months — reproduces that house style as a finding about cuts. The comparison is then
 * between advertisers wearing the costume of a comparison between creatives.
 *
 * Stratifying asks the question *within* each advertiser, where the house style is held
 * fixed, and combines the answers afterwards. `van-elteren.test.ts` runs the same fixture
 * both ways and the two disagree on the **sign**: pooled says long-lived creatives score
 * higher, stratified says lower, and stratified is right.
 *
 * WHY THESE WEIGHTS
 *
 * `wᵢ = 1/(Nᵢ + 1)` — van Elteren's design-free weighting, the standard choice when the
 * strata are advertisers we happened to observe rather than blocks somebody designed. It is
 * locally optimal against a location shift and it does not hand the result to the largest
 * spender.
 *
 * SIGN CONVENTION, WHICH IS LOAD-BEARING
 *
 * The rank sum is taken over the **long-lived** group. A positive `z` and a probability of
 * superiority above 0.5 both mean *long-lived creatives score higher on this feature*.
 * Reversing this leaves every magnitude in the product correct and every conclusion
 * backwards, which is the cheapest bug to write and the most expensive to ship.
 */

export interface Stratum {
  /** The advertiser. Only used for reporting which strata were dropped. */
  readonly stratum: string
  /** Feature values for `long_lived` creatives of this advertiser. */
  readonly long: readonly number[]
  /** Feature values for `short_lived` creatives of this advertiser. */
  readonly short: readonly number[]
}

export interface ContrastResult {
  /** Standardized statistic. Positive = long-lived score higher. */
  readonly z: number
  /** Two-sided p-value, before any multiplicity adjustment. */
  readonly p: number
  /** `Σ wᵢSᵢ`, the weighted rank sum over the long-lived group. */
  readonly t: number
  readonly expectedT: number
  readonly varianceT: number
  /** `P(long > short) + ½·P(equal)`, weighted the same way the test is. */
  readonly probabilitySuperiority: number
  /** `2·PS − 1`, in [−1, 1]. */
  readonly rankBiserial: number
  /** Long-lived creatives in the strata that were *used*, not in the panel. */
  readonly nLong: number
  readonly nShort: number
  readonly strataUsed: number
  readonly strataDropped: number
}

interface StratumStats {
  readonly nLong: number
  readonly nShort: number
  readonly s: number
  readonly expected: number
  readonly variance: number
  readonly ps: number
  readonly weight: number
}

/**
 * Midranks: tied values all take the average of the positions they occupy.
 *
 * This is the whole tie correction on the statistic side, and it is invisible when it is
 * wrong — assigning ties their raw positions instead shifts the rank sum by an amount that
 * depends on which group happened to be listed first, so the same data reordered gives a
 * different z.
 */
function midranks(values: readonly number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value)
  const ranks = new Array<number>(values.length)

  let i = 0
  while (i < order.length) {
    let j = i
    while (j + 1 < order.length && order[j + 1]!.value === order[i]!.value) j += 1
    // Positions i..j (0-based) are ranks i+1..j+1 (1-based); their mean is the midrank.
    const shared = (i + 1 + (j + 1)) / 2
    for (let k = i; k <= j; k += 1) ranks[order[k]!.index] = shared
    i = j + 1
  }
  return ranks
}

function statsFor(long: readonly number[], short: readonly number[]): StratumStats {
  const nLong = long.length
  const nShort = short.length
  const n = nLong + nShort
  const ranks = midranks([...long, ...short])

  let s = 0
  for (let i = 0; i < nLong; i += 1) s += ranks[i]!
  let sumSquares = 0
  for (const rank of ranks) sumSquares += rank * rank

  const expected = (nLong * (n + 1)) / 2
  // The tie-corrected variance, in the general form that reduces to n₁·n₂·(N+1)/12 when no
  // value repeats. Written once rather than as an untied fast path with a tied fallback:
  // two expressions that are supposed to agree on the untied case are two expressions that
  // can stop agreeing.
  const variance =
    ((nLong * nShort) / (n * (n - 1))) * (sumSquares - (n * (n + 1) * (n + 1)) / 4)

  // U counts the (long, short) pairs the long value wins, ties counting a half. Dividing by
  // the pair count turns it into a probability directly — no separate pair loop needed.
  const u = s - (nLong * (nLong + 1)) / 2

  return {
    nLong,
    nShort,
    s,
    expected,
    variance,
    ps: u / (nLong * nShort),
    weight: 1 / (n + 1),
  }
}

/**
 * Run the contrast over one feature.
 *
 * Returns `null` when no stratum carries information about the contrast — either every
 * advertiser landed in a single cohort, or every observation in every usable stratum is
 * tied, which makes the variance exactly zero. Both are real shapes on a thin panel, and
 * both would otherwise divide by zero and return a `NaN` that renders as a finding.
 */
export function vanElteren(strata: readonly Stratum[]): ContrastResult | null {
  const used: StratumStats[] = []
  let strataDropped = 0

  for (const stratum of strata) {
    if (stratum.long.length === 0 || stratum.short.length === 0) {
      // A stratum present in only one cohort carries no information about the contrast:
      // there is no pair to rank. Weighting it anyway adds its expectation to both sides
      // and its variance to the denominator, shrinking every z toward zero for free — and,
      // worse, inflates the reported strata count so a result computed from one advertiser
      // reads as if it came from four.
      strataDropped += 1
      continue
    }
    used.push(statsFor(stratum.long, stratum.short))
  }

  if (used.length === 0) return null

  let t = 0
  let expectedT = 0
  let varianceT = 0
  let weightSum = 0
  let psWeighted = 0
  let nLong = 0
  let nShort = 0

  for (const st of used) {
    t += st.weight * st.s
    expectedT += st.weight * st.expected
    varianceT += st.weight * st.weight * st.variance
    weightSum += st.weight
    psWeighted += st.weight * st.ps
    nLong += st.nLong
    nShort += st.nShort
  }

  if (varianceT === 0) return null

  const z = (t - expectedT) / Math.sqrt(varianceT)
  // The effect size is weighted with the *same* weights as the test. Weighting by pair
  // count instead would read more naturally in Spanish — "de cada 100 pares" over the whole
  // panel — but it hands the headline number back to the one advertiser with two hundred
  // creatives, which is the failure stratification exists to prevent. A published effect
  // size that disagrees with its own p-value is worse than a sentence that needs the words
  // "dentro de un mismo anunciante".
  const probabilitySuperiority = psWeighted / weightSum

  return {
    z,
    p: twoSidedNormalP(z),
    t,
    expectedT,
    varianceT,
    probabilitySuperiority,
    rankBiserial: 2 * probabilitySuperiority - 1,
    nLong,
    nShort,
    strataUsed: used.length,
    strataDropped,
  }
}
