import type { LatestProxyValidation } from '@mini-crux/db/dashboard'

/**
 * The ES validation run, invented, in the two readings that differ (UC-7).
 *
 * Both are `published`. The interesting contrast on this surface is not published-vs-refused
 * — it is a run whose interval excludes 1 against one whose interval contains it, because
 * those two produce nearly identical-looking cards and mean opposite things. A reviewer should
 * be able to tell them apart at a glance, and this pair is how that gets checked.
 *
 * `naivePooledBeta` and `naivePearsonR` are populated in both. They are the exhibit, never the
 * headline: the naive pooled figure is what the within-advertiser estimate exists to replace,
 * and it is shown so a reader can see how far off it is.
 */
export const PROXY_VALIDATION: LatestProxyValidation = {
  runId: '01JZ8Q4M7V2N6X0K3D5R9T1B5A',
  runDate: '2026-08-16',
  reachBoundUsed: 'min',
  outcome: 'published',
  failedGate: null,
  gateDetail: {},
  corpusSize: 1_842,
  excluded: {
    // Spain's archive is complete for stopped ads, so a still-running one has no final
    // duration to regress and leaves the corpus rather than biasing it.
    stillRunning: 611,
    zeroReach: 148,
    subDay: 97,
  },
  nIncluded: 986,
  advertisersTotal: 74,
  advertisersUsed: 39,
  advertisersDropped: 35,
  beta: 1.34,
  betaMinusOne: 0.34,
  betaSe: 0.109,
  betaCiLow: 1.126,
  betaCiHigh: 1.554,
  tStat: 3.12,
  pValue: 0.0021,
  df: 946,
  naivePooledBeta: 2.07,
  naivePearsonR: 0.41,
  verdict: 'reflects_effort',
}

/**
 * The same regression, with an interval that contains 1.
 *
 * The point estimate is still above 1 and the verdict is still `inertia`, which is the case
 * worth reviewing: a reader who takes the number and leaves the interval behind reads this as
 * a weaker version of the card above, when it is a different claim entirely.
 */
export const PROXY_VALIDATION_NULL: LatestProxyValidation = {
  ...PROXY_VALIDATION,
  runId: '01JZ8Q4M7V2N6X0K3D5R9T1B5B',
  runDate: '2026-07-09',
  corpusSize: 1_104,
  excluded: {
    stillRunning: 402,
    zeroReach: 96,
    subDay: 71,
  },
  nIncluded: 535,
  advertisersTotal: 52,
  advertisersUsed: 21,
  advertisersDropped: 31,
  beta: 1.08,
  betaMinusOne: 0.08,
  betaSe: 0.147,
  betaCiLow: 0.791,
  betaCiHigh: 1.369,
  tStat: 0.54,
  pValue: 0.587,
  df: 513,
  naivePooledBeta: 1.93,
  naivePearsonR: 0.36,
  verdict: 'inertia',
}
