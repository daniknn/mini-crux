import type { StructuralComparison } from '@mini-crux/db/dashboard'

/**
 * One advertiser's structural profile against the panel's, invented.
 *
 * Each metric carries its own `n`, and they deliberately differ: the extractor measured
 * duration on more creatives than it measured cut rate on, because a still image has a
 * duration and no cuts. A fixture that gave every metric the same n would render a page where
 * the per-metric sample size looks like decoration (CLAUDE.md rule 8).
 *
 * The advertiser cuts faster and fronts more text than the panel median. That is a
 * description and the page must not turn it into advice — there is no outcome data here, and
 * the review should confirm the copy never implies one.
 */
export const COMPARISON: StructuralComparison = {
  advertiser: {
    scope: 'advertiser',
    creatives: 41,
    extracted: 33,
    truncated: 4,
    durationS: { n: 33, p25: 18.2, p50: 24.5, p75: 41 },
    // Two fewer than `durationS`: an image ad has a duration and no cuts to time.
    firstCutTimeS: { n: 31, p25: 0.8, p50: 1.2, p75: 2.1 },
    cutsPerSecond: { n: 31, p25: 0.42, p50: 0.68, p75: 0.95 },
    textDensity: { n: 29, p25: 0.18, p50: 0.31, p75: 0.47 },
    hookText: { n: 29, share: 0.72 },
  },
  baseline: {
    scope: 'baseline',
    creatives: 138,
    extracted: 106,
    truncated: 9,
    durationS: { n: 106, p25: 15, p50: 21, p75: 33.5 },
    firstCutTimeS: { n: 98, p25: 1.1, p50: 1.8, p75: 3 },
    cutsPerSecond: { n: 98, p25: 0.31, p50: 0.52, p75: 0.79 },
    textDensity: { n: 91, p25: 0.15, p50: 0.27, p75: 0.44 },
    hookText: { n: 91, share: 0.58 },
  },
}

/**
 * The same page for an advertiser with almost nothing measured.
 *
 * Three creatives past the extractor, and one metric with none at all — so the small-sample
 * warning fires and one row has to render a median that does not exist. Both are states the
 * product will spend its first two months in.
 */
export const COMPARISON_THIN: StructuralComparison = {
  advertiser: {
    scope: 'advertiser',
    creatives: 8,
    extracted: 3,
    truncated: 0,
    durationS: { n: 3, p25: 12, p50: 15, p75: 19.5 },
    firstCutTimeS: { n: 3, p25: 1.4, p50: 1.9, p75: 2.6 },
    cutsPerSecond: { n: 3, p25: 0.22, p50: 0.29, p75: 0.4 },
    // Nothing measured: null is "we could not measure it", not "it is zero".
    textDensity: { n: 0, p25: null, p50: null, p75: null },
    hookText: { n: 0, share: null },
  },
  baseline: COMPARISON.baseline,
}
