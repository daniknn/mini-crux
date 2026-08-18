import { ANALYSIS_FEATURES, type PanelCreative } from '@mini-crux/analysis'

import { asDate, LATEST_FEATURES } from '../dashboard/internal.ts'
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
 * WHY THIS ONE TAKES AN EXPLICIT WORKSPACE FILTER AND THE DASHBOARD READS DO NOT
 *
 * `dashboard/internal.ts` argues at length that a `where workspace_id = $1` beside an RLS
 * policy is camouflage: it keeps the pages looking right on the day the policy breaks, so
 * the leak is discovered by someone else. That argument holds for a request arriving through
 * `withTenant` as `authenticated`, which is every dashboard read.
 *
 * It does not hold here. The only caller is the analysis job, which runs on a BYPASSRLS
 * worker connection — the same connection the crawler uses — because it must write
 * `analysis_runs`, and `authenticated` is granted select on that table and nothing else.
 * There is no policy to be redundant with. Without this filter the job would assemble one
 * cohort out of every tenant's creatives and publish it to whichever workspace the payload
 * named, which is a cross-tenant leak with an audit trail.
 *
 * So the filter is the isolation, not a second layer over it, and `analysis-panel.test.ts`
 * proves both readings: the job path scoped by the parameter, and the `withTenant` path
 * where a caller naming another workspace's id gets nothing, because there the parameter and
 * the policy have to agree.
 */

interface PanelRow {
  creative_id: string
  advertiser_id: string
  days_active: number | null
  is_censored: boolean
  has_gaps: boolean
  feature_schema_version: number | null
  extractor_version: string | null
  /** Never null: the query coalesces it, and the mapping below relies on that. */
  skipped_features: string[]
  duration_s: number | null
  first_cut_time_s: number | null
  cuts_per_second: number | null
  text_in_first_2s: number | null
  text_density: number | null
  audio_energy_variance: number | null
}

export async function getAnalysisPanel(
  db: SqlExecutor,
  workspaceId: string,
): Promise<PanelCreative[]> {
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
            -- Provenance, never arithmetic. Which build produced the measurement, as opposed
            -- to schema_version which pins what it means. A panel spanning a sampler bug fix
            -- legitimately carries two, so the run records an array of them.
            f.extractor_version,
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
     where s.workspace_id = $1
     -- Deterministic, so a re-run over an unchanged panel builds byte-identical strata and
     -- any difference between two runs is a difference in the panel.
     order by s.creative_id`,
    [workspaceId],
  )

  return rows.map((row) => ({
    creativeId: row.creative_id,
    advertiserId: row.advertiser_id,
    daysActive: row.days_active,
    isCensored: row.is_censored,
    hasGaps: row.has_gaps,
    featureSchemaVersion: row.feature_schema_version,
    extractorVersion: row.extractor_version,
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

/**
 * How long this workspace has actually been looking, and which day the panel is dated to.
 *
 * `panelAgeDays` is a **count of distinct healthy crawl days**, not the calendar span
 * between the first and the last. The two coincide on a panel that never missed a day and
 * diverge exactly when it matters: a workspace crawled once in January and once in July has
 * a span of 181 days and has observed two, and only the second number describes a panel that
 * could support a survival contrast. The gate reads the conservative one.
 *
 * Only `succeeded` runs count, for the reason the survival view gives at length: a `suspect`
 * run withheld its absences and a `failed` run wrote nothing, so neither is a day on which we
 * could have watched a creative stop. Counting them would let a stretch of crawler outages
 * age the panel past the gate without adding a single observation.
 *
 * Returns null when there is no healthy crawl at all. That is not an age of zero — a
 * workspace that has never been crawled has no panel to date a run to, and the caller writes
 * nothing rather than inventing a `panel_date`.
 */
export interface PanelWindow {
  /** Logical day of the most recent healthy crawl, from `crawl_runs.run_date`. */
  readonly panelDate: string
  readonly panelAgeDays: number
}

export async function getPanelWindow(
  db: SqlExecutor,
  workspaceId: string,
): Promise<PanelWindow | null> {
  const [row] = await db.query<{ panel_date: string | null; panel_age_days: number }>(
    `select ${asDate('max(run_date)')}       as panel_date,
            count(distinct run_date)::int    as panel_age_days
     from public.crawl_runs
     where workspace_id = $1
       and status = 'succeeded'`,
    [workspaceId],
  )

  // An aggregate over no rows still returns one row, with a null max and a count of zero —
  // so the emptiness has to be read off the value, not off the row count. Keying on
  // `panel_date` rather than on `panel_age_days === 0` because the two are equivalent here
  // only by luck: a future filter that keeps rows but no dates would separate them.
  if (row === undefined || row.panel_date === null) return null
  return { panelDate: row.panel_date, panelAgeDays: row.panel_age_days }
}
