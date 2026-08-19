import {
  ANALYSIS_FEATURES,
  HOOK_TYPES,
  TONES,
  type AnalysisFeature,
  type DescriptiveTag,
  type GateId,
  type TagBreakdown,
} from '@mini-crux/analysis'

import { asDate, instantAsDate } from './internal.ts'
import type { SqlExecutor } from '../types.ts'

/**
 * What the analysis last said, for the surface that renders it.
 *
 * This is the read half of UC-5 and it is deliberately dumb: one run, its feature results,
 * no arithmetic. Every number here was computed by the job and stored, and recomputing any
 * of them on read would break the one property the stored run exists to have — that a
 * finding on screen can be traced to the analysis that produced it, over the panel it read,
 * under the feature definitions in force at the time.
 *
 * The q-value is the sharpest case. It depends on the whole set of p-values in its run, so
 * deriving it here against whatever features happened to come back would silently change a
 * published number. It is selected, never adjusted.
 *
 * No workspace filter, like every other read in this directory: the caller is inside
 * `withTenant` and both tables carry RLS. See `internal.ts`.
 */

export interface AnalysisFeatureResult {
  feature: AnalysisFeature
  /** Per feature, not per run — a feature the extractor could not measure has a smaller n. */
  nLong: number
  nShort: number
  z: number
  /** Raw p. Rendered only beside its q; on its own it is one of six and means little. */
  p: number
  /** Benjamini-Hochberg adjusted across the features in this run. */
  qValue: number
  /** `P(long > short) + ½·P(equal)`, weighted the way the test weights strata. */
  probabilitySuperiority: number
  rankBiserial: number
  strataUsed: number
  strataDropped: number
}

export interface AnalysisExclusions {
  middle: number
  gaps: number
  noStart: number
  notExtracted: number
}

export interface LatestAnalysis {
  runId: string
  /** The market-calendar day the run was executed on. */
  runDate: string
  /** The logical day of the panel it read, from `crawl_runs.run_date`. */
  panelDate: string
  panelAgeDays: number
  featureSchemaVersion: number | null
  extractorVersions: string[]
  analysisVersion: string
  outcome: 'published' | 'refused'
  /** Null exactly when published. */
  failedGate: GateId | null
  /** The gate's shortfall, as the numbers the refusal copy is rendered from. */
  gateDetail: Record<string, number>
  nLong: number
  nShort: number
  excluded: AnalysisExclusions
  censoringRateLong: number | null
  strataTotal: number
  strataUsed: number
  strataDropped: number
  /**
   * Empty for a refused run, and that is a guarantee rather than a coincidence — the trigger
   * in migration 0007 refuses to store a result against a run that did not publish.
   */
  features: AnalysisFeatureResult[]
  /**
   * `hook_type` then `tone`, each a caption, never a claim — no p-value, no q-value, nothing
   * `vanElteren` produced (UC-8 spec §6). Empty for a refused run for the same reason
   * {@link features} is: migration 0014 attaches the same `assert_run_published` guard 0007
   * put on the statistical results.
   */
  tagBreakdowns: readonly TagBreakdown[]
}

interface RunRow {
  id: string
  run_date: string
  panel_date: string
  panel_age_days: number
  feature_schema_version: number | null
  extractor_versions: string[]
  analysis_version: string
  outcome: 'published' | 'refused'
  failed_gate: GateId | null
  gate_detail: Record<string, number>
  n_long: number
  n_short: number
  n_excluded_middle: number
  n_excluded_gaps: number
  n_excluded_no_start: number
  n_excluded_not_extracted: number
  censoring_rate_long: number | null
  strata_total: number
  strata_used: number
  strata_dropped: number
}

interface ResultRow {
  feature: AnalysisFeature
  n_long: number
  n_short: number
  z: number
  p_value: number
  q_value: number
  probability_superiority: number
  rank_biserial: number
  strata_used: number
  strata_dropped: number
}

interface TagResultRow {
  tag: DescriptiveTag
  value: string
  n_long: number
  n_short: number
}

const TAXONOMY: Readonly<Record<DescriptiveTag, readonly string[]>> = {
  hook_type: HOOK_TYPES,
  tone: TONES,
}

/**
 * Rows for one tag back into the shape {@link describeTagDistribution} produced when the job
 * wrote them — a read-side mirror, not a recomputation. `untagged` is its own taxonomy row in
 * the table (migration 0014) and is pulled back out into the dedicated fields here so the
 * surface reads the same {@link TagBreakdown} shape whether it came fresh off the job or back
 * off the database.
 */
function toBreakdown(tag: DescriptiveTag, rows: readonly TagResultRow[]): TagBreakdown {
  const byValue = new Map(rows.map((r) => [r.value, r]))
  const untagged = byValue.get('untagged')

  const counts = TAXONOMY[tag].map((value) => {
    const row = byValue.get(value)
    return { value, nLong: row?.n_long ?? 0, nShort: row?.n_short ?? 0 }
  })

  const untaggedLong = untagged?.n_long ?? 0
  const untaggedShort = untagged?.n_short ?? 0

  return {
    tag,
    counts,
    untaggedLong,
    untaggedShort,
    nLong: counts.reduce((s, c) => s + c.nLong, 0) + untaggedLong,
    nShort: counts.reduce((s, c) => s + c.nShort, 0) + untaggedShort,
  }
}

/**
 * The most recent run in the workspace, published or refused, or null if none has ever run.
 *
 * Those three states are distinct and the surface renders three different things. A refused
 * run is a result — "we looked and the panel is 12 days short" — and collapsing it into the
 * same blank page as "nobody has ever run this" loses the only one of the two that tells an
 * operator what to do (rule 6, and `CLAUDE.md` rule 3 one layer up).
 */
export async function getLatestAnalysis(db: SqlExecutor): Promise<LatestAnalysis | null> {
  const [run] = await db.query<RunRow>(
    `select id,
            ${instantAsDate('created_at')}  as run_date,
            ${asDate('panel_date')}         as panel_date,
            panel_age_days,
            feature_schema_version,
            extractor_versions,
            analysis_version,
            outcome,
            failed_gate,
            gate_detail,
            n_long,
            n_short,
            n_excluded_middle,
            n_excluded_gaps,
            n_excluded_no_start,
            n_excluded_not_extracted,
            censoring_rate_long,
            strata_total,
            strata_used,
            strata_dropped
     from public.analysis_runs
     -- Newest run wins, and the id breaks the tie. Two runs inside the same clock tick is not
     -- hypothetical — a retry after a transient failure lands in the same millisecond often
     -- enough — and an unstable order there would flip the page between two loads, which is
     -- the exact instability the stored run exists to remove.
     order by created_at desc, id desc
     limit 1`,
  )

  if (run === undefined) return null

  const results = await db.query<ResultRow>(
    `select feature, n_long, n_short, z, p_value, q_value,
            probability_superiority, rank_biserial, strata_used, strata_dropped
     from public.analysis_feature_results
     where analysis_run_id = $1`,
    [run.id],
  )

  const byFeature = new Map(results.map((r) => [r.feature, r]))

  const tagRows = await db.query<TagResultRow>(
    `select tag, value, n_long, n_short
     from public.analysis_tag_results
     where analysis_run_id = $1`,
    [run.id],
  )
  const byTag = new Map<DescriptiveTag, TagResultRow[]>()
  for (const row of tagRows) {
    const bucket = byTag.get(row.tag)
    if (bucket) bucket.push(row)
    else byTag.set(row.tag, [row])
  }
  // Empty exactly when the run was refused — migration 0014 attaches the same
  // `assert_run_published` trigger 0007 put on `analysis_feature_results`, so no row for
  // either tag can exist under a refused run. hook_type then tone, always both, on a
  // published one: the job writes every taxonomy value for both (see run.ts).
  const tagBreakdowns: TagBreakdown[] =
    tagRows.length === 0
      ? []
      : (['hook_type', 'tone'] as const).map((tag) => toBreakdown(tag, byTag.get(tag) ?? []))

  return {
    runId: run.id,
    runDate: run.run_date,
    panelDate: run.panel_date,
    panelAgeDays: run.panel_age_days,
    featureSchemaVersion: run.feature_schema_version,
    extractorVersions: run.extractor_versions,
    analysisVersion: run.analysis_version,
    outcome: run.outcome,
    failedGate: run.failed_gate,
    gateDetail: run.gate_detail,
    nLong: run.n_long,
    nShort: run.n_short,
    excluded: {
      middle: run.n_excluded_middle,
      gaps: run.n_excluded_gaps,
      noStart: run.n_excluded_no_start,
      notExtracted: run.n_excluded_not_extracted,
    },
    censoringRateLong: run.censoring_rate_long,
    strataTotal: run.strata_total,
    strataUsed: run.strata_used,
    strataDropped: run.strata_dropped,
    // Ordered by the declared feature list rather than by q. Sorting by significance would
    // put the strongest result at the top of every page and rebuild the "winner of six
    // tests" reading that the BH adjustment exists to defuse — and it would reorder the page
    // between runs, so a reader could not compare two days by position. A feature with no
    // row (untestable in this run: no variance, or nothing left after the drops) is simply
    // absent, which the surface reports rather than papering over.
    features: ANALYSIS_FEATURES.flatMap((feature) => {
      const row = byFeature.get(feature)
      if (row === undefined) return []
      return [
        {
          feature,
          nLong: row.n_long,
          nShort: row.n_short,
          z: row.z,
          p: row.p_value,
          qValue: row.q_value,
          probabilitySuperiority: row.probability_superiority,
          rankBiserial: row.rank_biserial,
          strataUsed: row.strata_used,
          strataDropped: row.strata_dropped,
        },
      ]
    }),
    tagBreakdowns,
  }
}
