/**
 * The whole analysis, as arithmetic: every feature contrasted, then adjusted across them.
 *
 * WHY THE ADJUSTMENT LIVES HERE AND NOT AT THE CALL SITE
 *
 * A q-value is not a property of a feature. It is a property of a feature *within a set*,
 * and the set is "the features this run tested". Computing z and p per feature and leaving
 * the caller to remember the Benjamini-Hochberg step makes the most important correction in
 * UC-5 an optional one — and the failure mode of forgetting it is not an error, it is six
 * plausible p-values, one of which is below 0.05 about a quarter of the time on pure noise.
 *
 * So the only exported entry point returns features that already carry their q. There is no
 * supported way to get a p-value out of this module without the adjustment that makes it
 * publishable, because the version of this code that offered one would be the version that
 * gets called.
 *
 * WHY A FEATURE CAN VANISH FROM THE OUTPUT
 *
 * `vanElteren` returns `null` when no stratum informs the contrast — every advertiser landed
 * in one cohort, or every observation is tied. Those features are dropped from the results
 * and, critically, **from the adjustment set**: including them would mean choosing a
 * p-value for a test that was never run. Since BH divides by the size of that set, a
 * placeholder p of 1.0 would inflate every real q in the run, and a placeholder of 0 would
 * deflate them. The count is reported instead, so a run that tested four of six features
 * says so rather than implying six.
 */

import type { AnalysisFeature } from './cohorts.ts'
import { ANALYSIS_FEATURES, stratify } from './cohorts.ts'
import type { CohortAssembly } from './cohorts.ts'
import { benjaminiHochberg } from './fdr.ts'
import type { ContrastResult } from './van-elteren.ts'
import { vanElteren } from './van-elteren.ts'

/**
 * The analysis method's own version, pinned on every run.
 *
 * Distinct from `feature_schema_version`, which pins what the *measurements* mean. This
 * pins what was done to them: the weighting, the tie correction, the adjustment, the gate
 * thresholds. Bump it when a change would give a different answer on an identical panel —
 * a new gate threshold counts, a comment does not — so that two runs carrying the same
 * value are genuinely comparable and a chart across a bump can break the line.
 */
export const ANALYSIS_VERSION = '1.0.0'

export interface FeatureContrast extends ContrastResult {
  readonly feature: AnalysisFeature
  /** Benjamini-Hochberg adjusted across the features actually tested in this run. */
  readonly qValue: number
  /** Members carrying this feature in `skipped_features`. */
  readonly droppedNotMeasurable: number
  /** Members with a null this feature defines no absent-ordering for. Upstream bug. */
  readonly droppedUnexplained: number
}

export interface ContrastSet {
  /** One per feature that produced a testable contrast, in {@link ANALYSIS_FEATURES} order. */
  readonly features: readonly FeatureContrast[]
  /**
   * Features skipped because no stratum informed them. The size of the adjustment set is
   * `features.length`, so this is the number an operator needs to read "four of six".
   */
  readonly untestable: readonly AnalysisFeature[]
}

/** Contrast every feature over an assembled panel and adjust across the ones that ran. */
export function runContrasts(assembly: CohortAssembly): ContrastSet {
  const tested: { feature: AnalysisFeature; result: ContrastResult; strata: ReturnType<typeof stratify> }[] = []
  const untestable: AnalysisFeature[] = []

  for (const feature of ANALYSIS_FEATURES) {
    const strata = stratify(assembly, feature)
    const result = vanElteren(strata.strata)
    if (result === null) {
      untestable.push(feature)
      continue
    }
    tested.push({ feature, result, strata })
  }

  // One call over the whole set, in one place. `benjaminiHochberg` returns q-values in the
  // caller's order, which is the only reason zipping them back by index is safe — it is
  // documented there because sorting them and reattaching by position would relabel every
  // finding without changing a single number.
  const qValues = benjaminiHochberg(tested.map((t) => t.result.p))

  return {
    features: tested.map((t, index) => ({
      ...t.result,
      feature: t.feature,
      qValue: qValues[index]!,
      droppedNotMeasurable: t.strata.droppedNotMeasurable,
      droppedUnexplained: t.strata.droppedUnexplained,
    })),
    untestable,
  }
}
