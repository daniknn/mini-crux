/**
 * Benjamini-Hochberg false discovery rate control.
 *
 * WHY THIS IS NOT OPTIONAL
 *
 * UC-5 tests roughly six structural features in one run. At α = 0.05 the chance that at
 * least one of six independent tests comes back significant on pure noise is about 26%.
 * Reporting the winner of six tests as *the* finding is how a product manufactures a
 * structural insight, and it is the most likely way this analysis ships something wrong —
 * more likely than any arithmetic error, because it leaves no trace in the numbers.
 *
 * WHY BH AND NOT BONFERRONI
 *
 * The features are correlated and mildly so: an ad with more cuts tends to have more text
 * events. Bonferroni over correlated tests is conservative to the point of never finding
 * anything, which trades a false-positive problem for a false-negative one and calls it
 * rigour. BH controls the expected proportion of published findings that are false, which
 * is the quantity an operator actually cares about.
 */

/**
 * Adjusted q-values, returned in the caller's order.
 *
 * The step-up is the part that matters and the part that is easy to leave out. Raw
 * `p·m/i` is not monotone — a feature with a smaller p can come back with a larger
 * adjusted value than its neighbour — and the fix is to sweep from the largest p downward
 * taking a running minimum. Skipping it produces q-values that contradict their own
 * p-value ordering, which looks like a data problem rather than a code one.
 */
export function benjaminiHochberg(pValues: readonly number[]): number[] {
  const m = pValues.length
  if (m === 0) return []

  for (const p of pValues) {
    if (!Number.isFinite(p) || p < 0 || p > 1) {
      throw new RangeError(`p-value out of range: ${p}`)
    }
  }

  // Sort ascending, remembering where each value came from. Handing q-values back in sorted
  // order would attach every number to the wrong feature name — a silent relabelling that
  // no assertion on the values themselves would catch.
  const order = pValues
    .map((p, index) => ({ p, index }))
    .sort((a, b) => a.p - b.p)

  const q = new Array<number>(m)
  let running = Number.POSITIVE_INFINITY
  for (let rank = m; rank >= 1; rank -= 1) {
    const entry = order[rank - 1]!
    running = Math.min(running, (entry.p * m) / rank)
    // No clamp at 1, deliberately. Raw p·m/i does exceed 1 all the time, but the largest
    // rank gives p_m·m/m = p_m ≤ 1 and the sweep is a running minimum from there down, so
    // every q is bounded by the largest p-value in the run. A `Math.min(…, 1)` here would
    // be unreachable code that no test could ever kill — which is how it was caught: the
    // mutant that deleted it survived the whole suite.
    //
    // The bound rests entirely on the range check above. If that check ever goes, q-values
    // above 1 come back with it.
    q[entry.index] = running
  }
  return q
}
