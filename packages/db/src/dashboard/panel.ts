import { asDate } from './internal.ts'
import type { SqlExecutor } from '../types.ts'

/**
 * How much panel there is, and how much of it is still open-ended.
 *
 * This is the header of every surface that renders a duration, and it exists because
 * `days_active` is meaningless without it. A dashboard showing "promedio 12 días" over a
 * panel three weeks old with 90% of creatives still running is not reporting a short
 * average — it is reporting the length of its own observation window. `CLAUDE.md` rule 8:
 * every number ships with its n and its caveat, and these are the caveat.
 */

export interface PanelHealth {
  /** Earliest and latest crawl day in the workspace; null before the first crawl. */
  firstRunDate: string | null
  lastRunDate: string | null
  /** Calendar days spanned, inclusive. One crawl is a one-day-old panel, not a zero-day one. */
  panelAgeDays: number
  /** Days on which at least one crawl succeeded. Below `panelAgeDays` means outages. */
  healthyDays: number
  totalCreatives: number
  censoredCreatives: number
  /**
   * Share of creatives still running, 0–1. Null when there is nothing to measure — the
   * honest answer for an empty panel, and distinguishable from a real 0 by a consumer that
   * would otherwise render "0% censurado" over no data at all.
   */
  censoringRate: number | null
  creativesWithGaps: number
}

interface PanelHealthRow {
  first_run_date: string | null
  last_run_date: string | null
  panel_age_days: number
  healthy_days: number
  total_creatives: number
  censored_creatives: number
  censoring_rate: number | null
  creatives_with_gaps: number
}

export async function getPanelHealth(db: SqlExecutor): Promise<PanelHealth> {
  const [row] = await db.query<PanelHealthRow>(
    `with runs as (
       select min(run_date) as first_run_date,
              max(run_date) as last_run_date,
              count(distinct run_date) filter (where status = 'succeeded') as healthy_days
       from public.crawl_runs
     ),
     panel as (
       select count(*)                          as total_creatives,
              count(*) filter (where is_censored) as censored_creatives,
              count(*) filter (where has_gaps)    as creatives_with_gaps
       from public.creative_survival
     )
     select ${asDate('r.first_run_date')} as first_run_date,
            ${asDate('r.last_run_date')}  as last_run_date,
            -- Inclusive: a panel with one crawl day is one day deep, not zero.
            coalesce((r.last_run_date - r.first_run_date) + 1, 0)::int as panel_age_days,
            r.healthy_days::int          as healthy_days,
            p.total_creatives::int       as total_creatives,
            p.censored_creatives::int    as censored_creatives,
            -- nullif guards the empty panel: 0/0 would be a division error, and a
            -- coalesce to 0 would claim every creative had finished.
            (p.censored_creatives::float8 / nullif(p.total_creatives, 0)) as censoring_rate,
            p.creatives_with_gaps::int   as creatives_with_gaps
     from runs r cross join panel p`,
  )

  return {
    firstRunDate: row!.first_run_date,
    lastRunDate: row!.last_run_date,
    panelAgeDays: row!.panel_age_days,
    healthyDays: row!.healthy_days,
    totalCreatives: row!.total_creatives,
    censoredCreatives: row!.censored_creatives,
    censoringRate: row!.censoring_rate,
    creativesWithGaps: row!.creatives_with_gaps,
  }
}
