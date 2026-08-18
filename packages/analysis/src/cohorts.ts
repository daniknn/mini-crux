import type { Stratum } from './van-elteren.ts'

/**
 * Turning a panel into two cohorts and one stratified sample per feature.
 *
 * This module is where the outcome variable is at most risk, and none of the risks announce
 * themselves. Every mistake below produces a full-looking panel, a plausible n, and a
 * confident number:
 *
 * - Calling a *still running* short creative `short_lived` (right-censoring, `CLAUDE.md`
 *   rule 6). It has run 9 days **so far**; that is a lower bound, not a duration.
 * - Letting a `has_gaps` creative in. Its span crosses a crawl we cannot recover, so its
 *   `days_active` is a guess wearing an integer.
 * - Zeroing a feature the extractor could not measure, which moves the creative into a
 *   cohort it does not belong in.
 * - Dropping a feature the extractor *did* measure as absent, which is the same corruption
 *   from the other side: a single-shot video really has no cut, and silently discarding
 *   every single-shot video from the first-cut test removes a whole structural style from
 *   the sample.
 *
 * So nothing here is inferred. A creative is placed by an explicit rule, every exclusion is
 * counted under the reason that excluded it, and the counts plus the two cohorts sum to the
 * panel exactly — an invariant `cohorts.test.ts` asserts, because it is the only thing that
 * catches a creative quietly falling out of every bucket.
 */

/**
 * The features the contrast runs over, in the order the UI lists them.
 *
 * This list is duplicated as a `check` constraint on `analysis_feature_results.feature`, and
 * `packages/db/test/analysis-schema.test.ts` reads that constraint out of the live catalog
 * and compares it to this array. A feature added on one side and not the other fails there
 * rather than writing rows that no surface can render.
 */
export const ANALYSIS_FEATURES = [
  'duration_s',
  'first_cut_time_s',
  'cuts_per_second',
  'text_in_first_2s',
  'text_density',
  'audio_energy_variance',
] as const

export type AnalysisFeature = (typeof ANALYSIS_FEATURES)[number]

/**
 * Cohort edges, from `ARCHITECTURE.md` §5. Both comparisons are strict, so a creative at
 * exactly 14 or exactly 60 days lands in the excluded middle — the edges name the cohorts
 * they exclude, not the ones they admit.
 */
export const SHORT_LIVED_BELOW_DAYS = 14
export const LONG_LIVED_ABOVE_DAYS = 60

export type Cohort = 'short_lived' | 'long_lived'

export type Exclusion =
  | 'excluded_middle'
  | 'excluded_gaps'
  | 'excluded_no_start'
  | 'excluded_not_extracted'

export type Placement = Cohort | Exclusion

/** Every placement, in the order {@link placeCreative} decides them. */
export const PLACEMENTS = [
  'excluded_gaps',
  'excluded_no_start',
  'excluded_not_extracted',
  'short_lived',
  'long_lived',
  'excluded_middle',
] as const satisfies readonly Placement[]

/**
 * One creative as the analysis sees it: its survival outcome, its structural measurements,
 * and — separately — what could not be measured.
 *
 * `features` and `skippedFeatures` are two different facts and must stay two fields. A
 * `null` in `features` with no matching entry in `skippedFeatures` means *measured absent*
 * and is a real observation; a `null` with an entry means *not measurable* and is an
 * admission. Merging them into one optional field would delete the distinction the whole
 * extractor is built to preserve.
 */
export interface PanelCreative {
  readonly creativeId: string
  /** The stratum. Advertiser, always — see the van Elteren module for why. */
  readonly advertiserId: string
  /** Null when Meta gave no `ad_delivery_start_time`: no start, no duration, no cohort. */
  readonly daysActive: number | null
  /** True when the creative was still running at the last healthy look. */
  readonly isCensored: boolean
  readonly hasGaps: boolean
  /** Null when no current feature row exists — *not attempted*, distinct from either null. */
  readonly featureSchemaVersion: number | null
  /**
   * Which extractor build produced the measurements. Provenance only — nothing in this
   * module reads it, and nothing should: it records *how* a number was obtained, not what it
   * means, so two creatives measured by different builds are still comparable. It rides on
   * the panel rather than being queried separately so the versions a run records are exactly
   * the versions of the rows it read.
   */
  readonly extractorVersion: string | null
  readonly features: Readonly<Partial<Record<AnalysisFeature, number | null>>>
  readonly skippedFeatures: readonly string[]
}

export interface CohortMember {
  readonly creativeId: string
  readonly advertiserId: string
  readonly cohort: Cohort
  readonly isCensored: boolean
  readonly features: Readonly<Partial<Record<AnalysisFeature, number | null>>>
  readonly skippedFeatures: readonly string[]
}

export interface CohortAssembly {
  /** The single version every member's measurements were produced under. */
  readonly featureSchemaVersion: number | null
  /** Only `short_lived` and `long_lived` creatives, in panel order. */
  readonly members: readonly CohortMember[]
  /** Every placement with its count. Sums to {@link panelSize}. */
  readonly counts: Readonly<Record<Placement, number>>
  readonly panelSize: number
  /**
   * Share of `long_lived` creatives still running, 0–1; null when the cohort is empty.
   *
   * Gated on in UC-5: a `long_lived` cohort that is almost entirely censored is "things we
   * have not seen end", and contrasting that against an all-resolved `short_lived` cohort
   * measures partly when we started looking.
   */
  readonly censoringRateLong: number | null
  /** Advertisers contributing at least one cohort member, before any are dropped. */
  readonly strataTotal: number
  /**
   * Advertisers contributing to **both** cohorts — the only ones that inform the contrast.
   *
   * This is the number the `MIN_STRATA` gate reads, and it is deliberately not
   * {@link strataTotal}. On a thin panel most advertisers land entirely in one cohort, so a
   * gate reading the total would pass on a panel whose every comparison comes from one
   * advertiser.
   *
   * It is also not the per-feature `strataUsed` on a {@link ContrastResult}: dropping a
   * creative whose feature was never measurable can empty a stratum's cohort, so a feature
   * can use fewer strata than the run. The gate is per analysis, so it reads the run's.
   */
  readonly strataUsed: number
  /** Advertisers present in exactly one cohort, and therefore carrying no contrast. */
  readonly strataDropped: number
}

/**
 * Two feature rows at different `schema_version`s inside one run.
 *
 * Thrown rather than resolved. The versions exist because a threshold changed, so
 * `cuts_per_second` at v2 and at v3 are different quantities that happen to share a column
 * name — pooling them produces a contrast between two definitions and reports it as a
 * contrast between cohorts (`CLAUDE.md` rule 3, spec rule 3). The situation is ordinary and
 * temporary: a re-extraction in flight. Failing means the run is retried when it finishes,
 * which is the correct outcome; pooling would publish a number nobody could later explain.
 */
export class MixedFeatureVersionsError extends Error {
  readonly versions: readonly number[]

  constructor(versions: readonly number[]) {
    super(
      `analysis panel spans feature schema versions ${versions.join(', ')}; ` +
        'a run pins exactly one and never pools across them',
    )
    this.name = 'MixedFeatureVersionsError'
    this.versions = versions
  }
}

/**
 * Which bucket a creative belongs in, and why.
 *
 * The order of the checks is the specification, not an implementation detail, and it is why
 * the counts can be read as "the reason this creative is not in a cohort":
 *
 * 1. `has_gaps` — the span crosses a crawl we cannot recover, so the duration is unknown
 *    regardless of what the other columns say.
 * 2. no `days_active` — no start date, so there is no duration to bucket.
 * 3. no feature row — nothing to correlate; the creative is *not attempted*, and counting
 *    it toward a cohort n would tell the gate the panel is thicker than it is.
 * 4. the cohort rules themselves.
 *
 * Steps 1–3 are checked before the cohort rules so a creative that fails two of them is
 * counted under the more fundamental one, every time, for every panel.
 */
export function placeCreative(creative: PanelCreative): Placement {
  if (creative.hasGaps) return 'excluded_gaps'
  if (creative.daysActive === null) return 'excluded_no_start'
  if (creative.featureSchemaVersion === null) return 'excluded_not_extracted'

  // THE CENSORING TRAP, and the single most important line in this file.
  //
  // `isCensored` is required for `short_lived` and deliberately *not* consulted for
  // `long_lived`. A creative still running after 9 days has run 9 days so far; calling it
  // short-lived asserts it stopped, which is exactly the fact we do not have. A creative
  // still running after 90 days has already outlived the threshold — whether it stops
  // tomorrow changes nothing about it qualifying.
  //
  // The asymmetry is the point. Applying `not isCensored` to both edges would look tidier
  // and would throw away every long-runner still running, which on any young panel is most
  // of them, leaving `long_lived` to mean "long-lived and then died" — a cohort selected on
  // having ended.
  if (!creative.isCensored && creative.daysActive < SHORT_LIVED_BELOW_DAYS) return 'short_lived'
  if (creative.daysActive > LONG_LIVED_ABOVE_DAYS) return 'long_lived'

  return 'excluded_middle'
}

/** Group a panel into cohorts, or fail if it spans more than one feature schema version. */
export function assembleCohorts(panel: readonly PanelCreative[]): CohortAssembly {
  const counts = Object.fromEntries(PLACEMENTS.map((p) => [p, 0])) as Record<Placement, number>
  const members: CohortMember[] = []
  const versions = new Set<number>()
  // Which cohorts each advertiser reached, not merely that it appeared. `strataUsed` is a
  // question about both cohorts at once, so a Set of ids could not answer it.
  const advertisers = new Map<string, { long: boolean; short: boolean }>()
  let censoredLong = 0

  for (const creative of panel) {
    const placement = placeCreative(creative)
    counts[placement] += 1
    if (placement !== 'short_lived' && placement !== 'long_lived') continue

    // Non-null by construction: `excluded_not_extracted` is decided above.
    versions.add(creative.featureSchemaVersion!)

    let reached = advertisers.get(creative.advertiserId)
    if (!reached) {
      reached = { long: false, short: false }
      advertisers.set(creative.advertiserId, reached)
    }
    if (placement === 'long_lived') reached.long = true
    else reached.short = true

    if (placement === 'long_lived' && creative.isCensored) censoredLong += 1

    members.push({
      creativeId: creative.creativeId,
      advertiserId: creative.advertiserId,
      cohort: placement,
      isCensored: creative.isCensored,
      features: creative.features,
      skippedFeatures: creative.skippedFeatures,
    })
  }

  // Checked over the cohort members rather than the whole panel: a half-finished
  // re-extraction leaves stale-version rows on creatives the analysis excludes anyway, and
  // failing the run over a creative it was never going to read would make the analysis
  // permanently unavailable on any panel with one un-reprocessed image.
  if (versions.size > 1) {
    throw new MixedFeatureVersionsError([...versions].sort((a, b) => a - b))
  }

  const nLong = counts.long_lived
  let strataUsed = 0
  for (const reached of advertisers.values()) {
    if (reached.long && reached.short) strataUsed += 1
  }

  return {
    featureSchemaVersion: versions.size === 1 ? [...versions][0]! : null,
    members,
    counts,
    panelSize: panel.length,
    // Null, not 0, on an empty cohort. `0` would read as "no long-lived creative is still
    // running", which is a finding; the truth is that there is nothing to divide.
    censoringRateLong: nLong === 0 ? null : censoredLong / nLong,
    strataTotal: advertisers.size,
    strataUsed,
    strataDropped: advertisers.size - strataUsed,
  }
}

/**
 * How a *measured-absent* null orders within each feature.
 *
 * `'above-all'` means the absence is a real observation that sorts above every measured
 * value. It applies to exactly one feature and the reason is specific: the extractor writes
 * `first_cut_time_s = null` with no skip entry when a video has no cut at all
 * (`pipeline.py`), and "never cut" is unambiguously later than any observed first cut. A
 * rank test needs an ordering, not a magnitude, so this is exact rather than an imputation —
 * there is no number being invented, only a position.
 *
 * Every other feature is `null` here, meaning no measured-absent state is defined for it.
 * The extractor either produces a value or records a skip; `cuts_per_second` is `0.0` for
 * the same single-shot video, not null. A null arriving on one of those is a bug upstream,
 * and {@link stratify} drops that creative from that feature and counts it rather than
 * guessing a position for it.
 */
const MEASURED_ABSENT_ORDER: Readonly<Record<AnalysisFeature, 'above-all' | null>> = {
  duration_s: null,
  first_cut_time_s: 'above-all',
  cuts_per_second: null,
  text_in_first_2s: null,
  text_density: null,
  audio_energy_variance: null,
}

export interface FeatureStrata {
  readonly feature: AnalysisFeature
  /** One per advertiser with at least one member, sorted by advertiser for determinism. */
  readonly strata: readonly Stratum[]
  readonly nLong: number
  readonly nShort: number
  /** Members carrying this feature in `skipped_features`: measured nothing, excluded. */
  readonly droppedNotMeasurable: number
  /** Members with a null this feature has no defined absent-ordering for. Upstream bug. */
  readonly droppedUnexplained: number
}

/**
 * The stratified sample for one feature.
 *
 * Per feature, never per run. A creative whose `text_density` was never measurable is
 * dropped **here and only here** — it keeps its place in every other feature's test — which
 * is why `analysis_feature_results` carries its own `n_long`/`n_short` and the run-level
 * counts are not reused. One n for the whole analysis would overstate precisely the features
 * we measured least well.
 */
export function stratify(assembly: CohortAssembly, feature: AnalysisFeature): FeatureStrata {
  const byAdvertiser = new Map<string, { long: number[]; short: number[] }>()
  let droppedNotMeasurable = 0
  let droppedUnexplained = 0
  let nLong = 0
  let nShort = 0

  for (const member of assembly.members) {
    if (member.skippedFeatures.includes(feature)) {
      droppedNotMeasurable += 1
      continue
    }

    const raw = member.features[feature] ?? null
    let value: number
    if (raw === null) {
      if (MEASURED_ABSENT_ORDER[feature] !== 'above-all') {
        droppedUnexplained += 1
        continue
      }
      value = Number.POSITIVE_INFINITY
    } else {
      // NaN would sort unpredictably and poison a rank sum without ever being visible in
      // the output, so it fails loudly here instead.
      if (Number.isNaN(raw)) {
        throw new RangeError(`${feature} is NaN on creative ${member.creativeId}`)
      }
      value = raw
    }

    let bucket = byAdvertiser.get(member.advertiserId)
    if (!bucket) {
      bucket = { long: [], short: [] }
      byAdvertiser.set(member.advertiserId, bucket)
    }
    if (member.cohort === 'long_lived') {
      bucket.long.push(value)
      nLong += 1
    } else {
      bucket.short.push(value)
      nShort += 1
    }
  }

  const strata = [...byAdvertiser.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([stratum, bucket]) => ({ stratum, long: bucket.long, short: bucket.short }))

  return { feature, strata, nLong, nShort, droppedNotMeasurable, droppedUnexplained }
}
