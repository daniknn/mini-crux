/**
 * UC-7's other half of `regression.ts`: turning a raw ES corpus row into either a
 * {@link FinishedAd} the regression can use or a counted reason it cannot, the gate that
 * decides whether the corpus is thick enough to publish, and the one-sentence verdict a
 * published run ships with.
 *
 * WHY EXCLUSION IS A SEPARATE, EXPLICIT STEP (spec rule 4)
 *
 * `regression.ts` requires `daysActive > 0` and `reach > 0` and says so in `FinishedAd`'s own
 * doc comment — it is the caller's job to have already excluded anything that cannot satisfy
 * that, because `log(0)` and `log(negative)` are not silently-skippable edge cases, they are
 * undefined. Folding the exclusion logic into the regression itself would hide *why* an ad
 * left the sample behind a `NaN` check; keeping it here means every exclusion has a name, and
 * every run stores how many ads left for each one (`proxy_validation_runs.n_excluded_*`).
 *
 * PRECEDENCE, WHEN AN AD MATCHES MORE THAN ONE REASON
 *
 * A still-running ad usually also has a reach that will keep growing — reporting it as
 * `zero_reach` because its current bound happens to read 0 today would be true only by
 * accident and would undercount `still_running`, the reason that actually explains it.
 * Checked in this order, each a genuine precondition for the next being a meaningful
 * question at all:
 *
 * 1. {@link classifyProxyAd}'s `still_running` check — without a stop time there is no
 *    duration to classify anything else against.
 * 2. `zero_reach` — a duration exists, but `log(0)` is undefined regardless of how long the
 *    ad ran, so duration is not yet worth looking at.
 * 3. `sub_day_duration` — only once reach is known to be positive does "was there enough
 *    time for a rate to mean anything" become the live question.
 *
 * WHY THE GATE THRESHOLDS ARE CONSTANTS HERE, NOT MEASUREMENTS (mirrors gating.ts)
 *
 * They are defensible defaults chosen before a real ES corpus has been seen, exactly like
 * `MIN_COHORT_N`/`MIN_STRATA` in `gating.ts`. Single-sourcing them here is what makes tuning
 * them later, against an actual distribution, a one-line change rather than an audit.
 */

import { CONFIDENCE_ALPHA, type FinishedAd, type WithinAdvertiserRegression } from './regression.ts'

/** Stored verbatim in `proxy_validation_ads.exclusion_reason` and tallied on the run row. */
export type ProxyExclusionReason = 'still_running' | 'zero_reach' | 'sub_day_duration'

/** Which `eu_total_reach_*` bound fed the regression (spec rule 7). */
export type ReachBound = 'min' | 'max'

/** One row of `proxy_validation_ads`, in the fields the classification needs. */
export interface RawProxyAd {
  readonly advertiserPageId: string
  /** Null is treated the same as a missing stop time — there is no duration to classify. */
  readonly adDeliveryStartTime: string | null
  /** Null means still running (spec rule 4). */
  readonly adDeliveryStopTime: string | null
  readonly euTotalReachMin: number | null
  readonly euTotalReachMax: number | null
}

export interface ClassifiedProxyAd {
  /** Null exactly when `finishedAd` is present. */
  readonly exclusionReason: ProxyExclusionReason | null
  readonly finishedAd: FinishedAd | null
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Classify one ad. This is a plain duration between two instants, not a calendar-day
 * bucketing — unlike `creative_survival.days_active` (0005_survival.sql), which subtracts
 * two *dates* struck in `America/Mexico_City` to align with the MX panel's daily crawl tick.
 * There is no crawl tick here: a finished ES ad's start and stop are both exact instants
 * already, and dividing their millisecond difference by a day's worth of milliseconds is the
 * whole computation. Casting either instant to a date first would reintroduce the very
 * timezone-boundary bug that rule exists to prevent, for no benefit.
 */
export function classifyProxyAd(ad: RawProxyAd, reachBoundUsed: ReachBound): ClassifiedProxyAd {
  if (ad.adDeliveryStartTime === null || ad.adDeliveryStopTime === null) {
    return { exclusionReason: 'still_running', finishedAd: null }
  }

  const reach = reachBoundUsed === 'min' ? ad.euTotalReachMin : ad.euTotalReachMax
  if (reach === null || reach <= 0) {
    return { exclusionReason: 'zero_reach', finishedAd: null }
  }

  const start = new Date(ad.adDeliveryStartTime).getTime()
  const stop = new Date(ad.adDeliveryStopTime).getTime()
  const daysActive = (stop - start) / MS_PER_DAY
  if (!(daysActive >= 1)) {
    return { exclusionReason: 'sub_day_duration', finishedAd: null }
  }

  return {
    exclusionReason: null,
    finishedAd: { advertiser: ad.advertiserPageId, daysActive, reach },
  }
}

/** The whole corpus, split into what the regression can use and what it counted out. */
export interface ProxyCorpusClassification {
  readonly finishedAds: readonly FinishedAd[]
  readonly nExcludedStillRunning: number
  readonly nExcludedZeroReach: number
  readonly nExcludedSubDay: number
}

/**
 * Classify every ad in the corpus. The four counts here plus `finishedAds.length` sum to
 * `ads.length` exactly — the same invariant `cohorts.test.ts` asserts for the MX panel, for
 * the same reason: it is the only thing that catches an ad quietly falling out of every
 * bucket.
 */
export function classifyProxyCorpus(
  ads: readonly RawProxyAd[],
  reachBoundUsed: ReachBound,
): ProxyCorpusClassification {
  const finishedAds: FinishedAd[] = []
  let nExcludedStillRunning = 0
  let nExcludedZeroReach = 0
  let nExcludedSubDay = 0

  for (const ad of ads) {
    const classified = classifyProxyAd(ad, reachBoundUsed)
    if (classified.finishedAd !== null) {
      finishedAds.push(classified.finishedAd)
      continue
    }
    switch (classified.exclusionReason) {
      case 'still_running':
        nExcludedStillRunning += 1
        break
      case 'zero_reach':
        nExcludedZeroReach += 1
        break
      case 'sub_day_duration':
        nExcludedSubDay += 1
        break
    }
  }

  return { finishedAds, nExcludedStillRunning, nExcludedZeroReach, nExcludedSubDay }
}

/**
 * Finished ads required before the regression is worth running at all.
 *
 * Below this, `regression.ts` may well still return a number — it only refuses on
 * `advertisersUsed === 0` or `df <= 0` — but a CI built from a handful of ads is wide enough
 * to be uninformative in the specific way that renders identically to a precise null. Thirty
 * is the conventional floor below which a slope's standard error stops being trustworthy even
 * when it is computable; it is not a claim that thirty is enough to detect a small effect.
 */
export const MIN_FINISHED_ADS = 30

/**
 * Advertisers that must contribute an actual within-advertiser contrast — i.e. have at least
 * two finished ads, the same bar `regression.ts` itself uses to decide `advertisersDropped`.
 *
 * Below this the within estimator is a regression over one or two advertisers' internal
 * variation wearing a confidence interval computed as if it generalized. Five is the smallest
 * count at which "for the same advertiser, does the longer ad get disproportionately more
 * reach" stops being a statement about a handful of specific advertisers' house habits.
 */
export const MIN_ADVERTISERS_USED = 5

/** Which gate refused. Stored verbatim in `proxy_validation_runs.failed_gate`. */
export type ProxyGateId = 'corpus_size' | 'advertisers'

/** Snake-cased for the same reason as `gating.ts`'s `GateDetail`: it lands in `jsonb`. */
export type ProxyGateDetail = Readonly<Record<string, number>>

export interface ProxyGateRefusal {
  readonly outcome: 'refused'
  readonly failedGate: ProxyGateId
  readonly detail: ProxyGateDetail
}

export interface ProxyGatePass {
  readonly outcome: 'published'
  readonly failedGate: null
  readonly detail: ProxyGateDetail
}

export type ProxyGateVerdict = ProxyGateRefusal | ProxyGatePass

export interface ProxyGateInput {
  readonly finishedAds: readonly FinishedAd[]
}

/**
 * Decide whether this corpus may publish. Order matters, same reasoning as `evaluateGates`:
 * corpus size first, because with too few finished ads the advertiser count is downstream
 * noise; advertiser contribution second, because it is only meaningful once there are enough
 * ads for it to be about the advertiser mix rather than about the total.
 */
export function evaluateProxyValidationGate(input: ProxyGateInput): ProxyGateVerdict {
  const n = input.finishedAds.length
  if (n < MIN_FINISHED_ADS) {
    return refuse('corpus_size', {
      required_n: MIN_FINISHED_ADS,
      actual_n: n,
      shortfall_n: MIN_FINISHED_ADS - n,
    })
  }

  const counts = new Map<string, number>()
  for (const ad of input.finishedAds) {
    counts.set(ad.advertiser, (counts.get(ad.advertiser) ?? 0) + 1)
  }
  const contributing = [...counts.values()].filter((count) => count >= 2).length
  if (contributing < MIN_ADVERTISERS_USED) {
    return refuse('advertisers', {
      required_advertisers: MIN_ADVERTISERS_USED,
      actual_advertisers: contributing,
      shortfall_advertisers: MIN_ADVERTISERS_USED - contributing,
    })
  }

  return { outcome: 'published', failedGate: null, detail: {} }
}

function refuse(failedGate: ProxyGateId, detail: ProxyGateDetail): ProxyGateRefusal {
  return { outcome: 'refused', failedGate, detail }
}

/** Stored verbatim in `proxy_validation_runs.verdict`. */
export type ProxyVerdict = 'reflects_effort' | 'inertia' | 'throttled'

/**
 * The one-sentence reading of β vs. 1 (spec: "The verdict MUST ship with n, A, the confidence
 * interval..."). This function supplies only the categorical read; the report surface is
 * responsible for rendering it alongside the numbers it is not allowed to stand in for.
 *
 * Failing to reject β = 1 is `inertia` regardless of which side of 1 the point estimate
 * landed on — a p-value at or above {@link CONFIDENCE_ALPHA} means the data cannot
 * distinguish this run's β from pure proportional accumulation, and reporting `reflects_effort`
 * or `throttled` off a non-significant point estimate would be exactly the "significance
 * mistaken for size" the spec's β − 1 framing exists to prevent.
 */
export function deriveVerdict(regression: WithinAdvertiserRegression): ProxyVerdict {
  if (regression.pValue >= CONFIDENCE_ALPHA) return 'inertia'
  return regression.beta > 1 ? 'reflects_effort' : 'throttled'
}
