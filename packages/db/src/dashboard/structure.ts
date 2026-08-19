import { LATEST_FEATURES } from './internal.ts'
import type { SqlExecutor } from '../types.ts'

/**
 * How one advertiser's creatives are built, against the rest of the panel.
 *
 * WHY EVERY METRIC CARRIES ITS OWN n
 *
 * A creative can be missing `text_density` and have a perfectly good `cuts_per_second` —
 * UC-2 degrades per analyzer, so a row is routinely part measurement and part admission.
 * Reporting one n for the whole profile would therefore be wrong for every metric but one,
 * and reporting the *creative* count as if it were the sample size would inflate every
 * distribution built on a partially-skipped feature.
 *
 * Nothing here coalesces a null to zero. `percentile_cont` and `count(col)` both ignore
 * nulls, which is exactly right: a feature that could not be measured must shrink the
 * sample, never drag the median toward zero. Zero-filling would silently move an advertiser
 * between cohorts (CLAUDE.md, three-kinds-of-null).
 *
 * WHY MEDIANS AND QUARTILES RATHER THAN MEANS
 *
 * These distributions are small and skewed — one 3-minute explainer among twenty 15-second
 * ads moves a mean and leaves a median alone. The operator is asking "what does this
 * competitor usually do", which is a question about the middle, not the average.
 */

export interface MetricDistribution {
  /** Creatives with this metric actually measured. Not the creative count. */
  n: number
  p25: number | null
  p50: number | null
  p75: number | null
}

export interface StructuralProfile {
  scope: 'advertiser' | 'baseline'
  /** Creatives in scope, measured or not. */
  creatives: number
  /** Of those, how many the extractor produced a feature row for. */
  extracted: number
  /** Of those, how many outran the sampling cap — their rates are over a shorter span. */
  truncated: number
  durationS: MetricDistribution
  firstCutTimeS: MetricDistribution
  cutsPerSecond: MetricDistribution
  textDensity: MetricDistribution
  /** Share of measured creatives with text on screen in the first 2 seconds, 0–1. */
  hookText: { n: number; share: number | null }
}

export interface StructuralComparison {
  advertiser: StructuralProfile
  baseline: StructuralProfile
}

const distribution = (col: string): string => `
  count(${col})::int                                                as ${col}_n,
  percentile_cont(0.25) within group (order by ${col})::float8      as ${col}_p25,
  percentile_cont(0.50) within group (order by ${col})::float8      as ${col}_p50,
  percentile_cont(0.75) within group (order by ${col})::float8      as ${col}_p75`

const METRICS = ['duration_s', 'first_cut_time_s', 'cuts_per_second', 'text_density'] as const

const STATS = `
  count(*)::int                                          as creatives,
  count(schema_version)::int                             as extracted,
  count(*) filter (where truncated)::int                 as truncated,
  ${METRICS.map(distribution).join(',\n  ')},
  count(text_in_first_2s)::int                           as hook_n,
  (count(*) filter (where text_in_first_2s)::float8
     / nullif(count(text_in_first_2s), 0))               as hook_share`

interface ProfileRow {
  scope: 'advertiser' | 'baseline'
  creatives: number
  extracted: number
  truncated: number
  hook_n: number
  hook_share: number | null
  [column: string]: unknown
}

export interface StructuralProfileFilter {
  advertiserId: string
  /**
   * Restrict to creatives still running. Defaults to true: "what is this competitor doing
   * *now*" is the question this surface answers, and a profile that averages in every ad
   * they retired two months ago answers a different one.
   */
  activeOnly?: boolean
}

export async function getStructuralProfile(
  db: SqlExecutor,
  filter: StructuralProfileFilter,
): Promise<StructuralComparison> {
  const activeOnly = filter.activeOnly ?? true

  const rows = await db.query<ProfileRow>(
    `with pool as (
       select s.advertiser_id,
              s.is_censored,
              f.schema_version,
              coalesce(f.truncated, false) as truncated,
              f.duration_s,
              f.first_cut_time_s,
              f.cuts_per_second,
              f.text_density,
              f.text_in_first_2s
       from public.creative_survival s
       ${LATEST_FEATURES}
       where (not $2::boolean or s.is_censored)
     )
     select 'advertiser'::text as scope, ${STATS}
     from pool where advertiser_id = $1::uuid
     union all
     -- The baseline is the whole workspace, this advertiser included. Excluding them would
     -- make the comparison "you vs. everyone else", which moves with how many creatives
     -- they happen to have; including them keeps it "you vs. the market we watch".
     select 'baseline'::text, ${STATS}
     from pool`,
    [filter.advertiserId, activeOnly],
  )

  const byScope = new Map(rows.map((r) => [r.scope, r]))
  return {
    advertiser: toProfile('advertiser', byScope.get('advertiser')!),
    baseline: toProfile('baseline', byScope.get('baseline')!),
  }
}

function toProfile(scope: 'advertiser' | 'baseline', row: ProfileRow): StructuralProfile {
  const dist = (col: string): MetricDistribution => ({
    n: row[`${col}_n`] as number,
    p25: row[`${col}_p25`] as number | null,
    p50: row[`${col}_p50`] as number | null,
    p75: row[`${col}_p75`] as number | null,
  })

  return {
    scope,
    creatives: row.creatives,
    extracted: row.extracted,
    truncated: row.truncated,
    durationS: dist('duration_s'),
    firstCutTimeS: dist('first_cut_time_s'),
    cutsPerSecond: dist('cuts_per_second'),
    textDensity: dist('text_density'),
    hookText: { n: row.hook_n, share: row.hook_share },
  }
}
