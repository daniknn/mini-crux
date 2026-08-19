import type { PanelHealth } from '@mini-crux/db/dashboard'

/**
 * Panel health, invented.
 *
 * Typed with the query's own return type rather than a local shape, so a column added to
 * `getPanelHealth` fails `tsc` here instead of letting the preview keep rendering a panel the
 * product no longer has (`specs/UC-10-ux-preview.md` §3).
 *
 * The numbers are chosen to be *awkward*, not flattering. `healthyDays` sits below
 * `panelAgeDays` because outages are the normal case and the caveat that reports them is one
 * of the things being reviewed; the censoring rate is high because a young panel's is.
 */

/** A panel with real history and real gaps — the state most reviews should look at. */
export const PANEL_HEALTH: PanelHealth = {
  firstRunDate: '2026-06-01',
  lastRunDate: '2026-08-18',
  panelAgeDays: 79,
  healthyDays: 74,
  totalCreatives: 138,
  censoredCreatives: 91,
  censoringRate: 0.659,
  creativesWithGaps: 12,
}

/** Before the first crawl. Every count is zero and `censoringRate` is null, not 0. */
export const PANEL_HEALTH_EMPTY: PanelHealth = {
  firstRunDate: null,
  lastRunDate: null,
  panelAgeDays: 0,
  healthyDays: 0,
  totalCreatives: 0,
  censoredCreatives: 0,
  censoringRate: null,
  creativesWithGaps: 0,
}
