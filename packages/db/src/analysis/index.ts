/**
 * The database side of UC-5: reading the panel the cohort contrast runs over.
 *
 * The statistics and every cohort rule live in `@mini-crux/analysis`. This directory only
 * moves rows across the driver boundary, already shaped.
 */

export { getAnalysisPanel } from './panel.ts'
