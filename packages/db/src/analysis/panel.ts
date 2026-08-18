import { ANALYSIS_FEATURES, type PanelCreative } from '@mini-crux/analysis'

import { LATEST_FEATURES } from '../dashboard/internal.ts'
import type { SqlExecutor } from '../types.ts'

/**
 * The panel the cohort contrast reads: every creative's survival outcome next to its current
 * structural measurements.
 *
 * WHY THIS RETURNS ROWS AND NOT AN ANSWER
 *
 * Nothing is bucketed, filtered or counted here. Every cohort rule — the censoring trap, the
 * `has_gaps` exclusion, the three kinds of null — lives in `@mini-crux/analysis`, in plain
 * TypeScript, where a mutation test can reach it in milliseconds. Expressing the same rules
 * as a `case` in this query would put the most consequential logic in the product behind a
 * database round-trip and a fixture, which is where subtle bugs go to survive.
 *
 * The cost is that a run reads the whole panel into memory. That is acceptable and will stay
 * acceptable: this is a job, not a page load, and a panel large enough to strain it is a
 * panel large enough to have earned Kaplan-Meier instead.
 *
 * WHY NO WORKSPACE FILTER
 *
 * The caller is inside `withTenant`, and `creative_survival` runs as the invoker with the
 * base tables' RLS applying. Adding `where workspace_id = $1` here would look like defence
 * in depth and act as camouflage the day a policy breaks. See `dashboard/internal.ts`.
 */

interface PanelRow {
  creative_id: string
  advertiser_id: string
  days_active: number | null
  is_censored: boolean
  has_gaps: boolean
  feature_schema_version: number | null
  /** Never null: the query coalesces it, and the mapping below relies on that. */
  skipped_features: string[]
  duration_s: number | null
  first_cut_time_s: number | null
  cuts_per_second: number | null
  text_in_first_2s: number | null
  text_density: number | null
  audio_energy_variance: number | null
}

export async function getAnalysisPanel(db: SqlExecutor): Promise<PanelCreative[]> {
  const rows = await db.query<PanelRow>(
    `select s.creative_id,
            s.advertiser_id,
            -- No cast, and the absence is deliberate. The house rule is that nothing crosses
            -- the driver boundary able to be decoded two ways (CLAUDE.md's table), and this
            -- column already satisfies it: date minus date is int4, which both PGlite and
            -- node-postgres hand back as a JS number. A count needs an ::int cast because it
            -- is int8 and node-postgres returns that as a string; an ::int here would be a
            -- guard no test could ever fire, which is the same mistake as the q-value clamp
            -- in fdr.ts. The contract is asserted in analysis-panel.test.ts instead, so a
            -- future change to the view's type fails there rather than silently.
            s.days_active,
            s.is_censored,
            s.has_gaps,
            f.schema_version::int           as feature_schema_version,
            -- Coalesced because a creative with no feature row joins to all-nulls, and an
            -- absent array must read as "nothing was skipped" rather than as a null the
            -- caller has to re-interpret. The creative is excluded upstream either way, by
            -- its null feature_schema_version.
            coalesce(f.skipped_features, '{}') as skipped_features,
            f.duration_s,
            f.first_cut_time_s,
            f.cuts_per_second,
            -- The rank test needs an ordering, and a boolean has one: 0 < 1. Cast in SQL
            -- rather than in JavaScript so the column arrives the same shape as its five
            -- neighbours and no consumer has to remember which one is different. The heavy
            -- tying this produces is exactly what the tie-corrected variance is for.
            f.text_in_first_2s::int         as text_in_first_2s,
            f.text_density,
            f.audio_energy_variance
     from public.creative_survival s
     ${LATEST_FEATURES}
     -- Deterministic, so a re-run over an unchanged panel builds byte-identical strata and
     -- any difference between two runs is a difference in the panel.
     order by s.creative_id`,
  )

  return rows.map((row) => ({
    creativeId: row.creative_id,
    advertiserId: row.advertiser_id,
    daysActive: row.days_active,
    isCensored: row.is_censored,
    hasGaps: row.has_gaps,
    featureSchemaVersion: row.feature_schema_version,
    // Built from ANALYSIS_FEATURES rather than written out, so a seventh feature is wired
    // through by adding it to that list and its column below — not by remembering this
    // object exists. A missing column surfaces as a null, which `stratify` counts under
    // `droppedUnexplained` instead of silently shrinking an n.
    features: Object.fromEntries(
      ANALYSIS_FEATURES.map((feature) => [feature, row[feature] ?? null]),
    ),
    // No `?? []` fallback. The coalesce above is the one place the empty case is handled;
    // a second guard here would make the first untestable — delete the SQL coalesce and the
    // fallback keeps the suite green while production reads a null it was told could not
    // arrive.
    skippedFeatures: row.skipped_features,
  }))
}
