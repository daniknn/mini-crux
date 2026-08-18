/**
 * The within-advertiser log-log regression UC-7 is built around.
 *
 * WHY beta = 1 IS THE NULL, NOT beta = 0
 *
 * `eu_total_reach` accumulates over an ad's life, so `reach = rate * days` under the flattest
 * possible model — constant daily delivery. In logs, `log(reach) = log(rate) + 1*log(days)`.
 * A slope of exactly 1 is what pure accumulation at a constant rate produces; testing against
 * 0 would reject on that mechanical fact alone, on every corpus, before a single ad is
 * examined. See `specs/UC-7-proxy-validation.md`, "The trap, stated before the design".
 *
 * WHY WITHIN ADVERTISER
 *
 * A large advertiser both runs ads longer and buys more reach, from budget this dataset
 * cannot see. Pooling would let that confound alone manufacture beta > 1. Demeaning each
 * advertiser's `log(days)` and `log(reach)` by its own mean removes exactly that: the
 * question becomes "for the same advertiser, does their longer-running ad get
 * disproportionately more reach than their shorter one", which no longer depends on how much
 * that advertiser spends overall. This is the fixed-effects (within) estimator, and it is
 * algebraically identical to OLS with one dummy variable per advertiser — demeaning is just
 * the cheaper way to compute it. `packages/analysis/reference/generate.py` checks the two
 * routes against each other for exactly this reason.
 *
 * DEGREES OF FREEDOM
 *
 * Demeaning consumes one parameter per advertiser (its mean) in addition to the slope, so
 * `df = n - A - 1`, not `n - 2`. Using `n - 2` overstates precision by exactly the number of
 * contributing advertisers — on a corpus with as many advertisers as it has ads per
 * advertiser, that difference is not a rounding error.
 */

import { studentTCritical, twoSidedStudentP } from './student-t.ts'

/** One ended ad, already resolved to the reach bound the run has chosen to use. */
export interface FinishedAd {
  readonly advertiser: string
  /** Must be > 0 — a same-day ad has no defined log and must be excluded before this call. */
  readonly daysActive: number
  /** Must be > 0 — zero reach has no defined log and must be excluded before this call. */
  readonly reach: number
}

export interface WithinAdvertiserRegression {
  readonly beta: number
  /** The effect size UC-7 actually reports (spec: "beta is an elasticity, so beta - 1..."). */
  readonly betaMinusOne: number
  readonly se: number
  readonly ciLow: number
  readonly ciHigh: number
  /** Against beta = 1, not beta = 0: `(beta - 1) / se`. */
  readonly tStat: number
  readonly pValue: number
  /** `n - advertisersUsed - 1`. */
  readonly df: number
  readonly n: number
  readonly advertisersUsed: number
  /** Advertisers with exactly one ended ad — no within-advertiser contrast to contribute. */
  readonly advertisersDropped: number
}

export interface NaiveEstimate {
  /** Pooled OLS slope, advertiser thrown away entirely — the estimate the trap produces. */
  readonly pooledBeta: number
  readonly pearsonR: number
  readonly n: number
}

/**
 * Exported so {@link deriveVerdict} in `proxy-validation.ts` reads the same threshold this
 * regression's own confidence interval was built from, rather than a second literal `0.05`
 * that could drift from it.
 */
export const CONFIDENCE_ALPHA = 0.05

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

/**
 * The within-advertiser (fixed-effects) slope of `log(reach)` on `log(days)`, tested against
 * `beta = 1`.
 *
 * Returns `null` when there is nothing to estimate — every advertiser contributed at most one
 * ad, or the surviving degrees of freedom are non-positive. Callers are expected to have
 * already gated on a minimum corpus size; this is the arithmetic's own final check, not a
 * substitute for that gate.
 */
export function withinAdvertiserRegression(
  ads: readonly FinishedAd[],
): WithinAdvertiserRegression | null {
  const byAdvertiser = new Map<string, FinishedAd[]>()
  for (const ad of ads) {
    const group = byAdvertiser.get(ad.advertiser)
    if (group === undefined) byAdvertiser.set(ad.advertiser, [ad])
    else group.push(ad)
  }

  let advertisersDropped = 0
  // Demeaned (x, y) pairs pooled across every advertiser that contributed to both — i.e.
  // that has at least two ended ads, so it has an internal contrast to offer.
  const demeanedX: number[] = []
  const demeanedY: number[] = []

  for (const group of byAdvertiser.values()) {
    if (group.length < 2) {
      advertisersDropped += 1
      continue
    }
    const xs = group.map((ad) => Math.log(ad.daysActive))
    const ys = group.map((ad) => Math.log(ad.reach))
    const meanX = mean(xs)
    const meanY = mean(ys)
    for (let i = 0; i < group.length; i += 1) {
      demeanedX.push((xs[i] as number) - meanX)
      demeanedY.push((ys[i] as number) - meanY)
    }
  }

  const advertisersUsed = byAdvertiser.size - advertisersDropped
  const n = demeanedX.length
  const df = n - advertisersUsed - 1
  if (advertisersUsed === 0 || df <= 0) return null

  let sxx = 0
  let sxy = 0
  for (let i = 0; i < n; i += 1) {
    const x = demeanedX[i] as number
    sxx += x * x
    sxy += x * (demeanedY[i] as number)
  }
  if (sxx === 0) return null

  const beta = sxy / sxx

  let rss = 0
  for (let i = 0; i < n; i += 1) {
    const residual = (demeanedY[i] as number) - beta * (demeanedX[i] as number)
    rss += residual * residual
  }
  const variance = rss / df
  const se = Math.sqrt(variance / sxx)

  const tStat = (beta - 1) / se
  const pValue = twoSidedStudentP(tStat, df)
  const tCritical = studentTCritical(CONFIDENCE_ALPHA, df)

  return {
    beta,
    betaMinusOne: beta - 1,
    se,
    ciLow: beta - tCritical * se,
    ciHigh: beta + tCritical * se,
    tStat,
    pValue,
    df,
    n,
    advertisersUsed,
    advertisersDropped,
  }
}

/**
 * The pooled slope and Pearson correlation with advertiser thrown away — the exhibit (spec:
 * "The naive estimate is computed too, and shown"), never the headline. Computed over the
 * same ads as {@link withinAdvertiserRegression} so the two are comparable on one corpus.
 */
export function naivePooledEstimate(ads: readonly FinishedAd[]): NaiveEstimate | null {
  if (ads.length < 2) return null

  const xs = ads.map((ad) => Math.log(ad.daysActive))
  const ys = ads.map((ad) => Math.log(ad.reach))
  const meanX = mean(xs)
  const meanY = mean(ys)

  let sxx = 0
  let syy = 0
  let sxy = 0
  for (let i = 0; i < ads.length; i += 1) {
    const dx = (xs[i] as number) - meanX
    const dy = (ys[i] as number) - meanY
    sxx += dx * dx
    syy += dy * dy
    sxy += dx * dy
  }
  if (sxx === 0 || syy === 0) return null

  return {
    pooledBeta: sxy / sxx,
    pearsonR: sxy / Math.sqrt(sxx * syy),
    n: ads.length,
  }
}
