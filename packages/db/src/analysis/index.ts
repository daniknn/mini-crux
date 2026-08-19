/**
 * The database side of UC-5: reading the panel, and recording what the analysis said about it.
 *
 * Every cohort rule, every gate threshold and every statistic lives in `@mini-crux/analysis`,
 * in pure TypeScript a mutation test can reach in milliseconds. This directory moves rows
 * across the driver boundary already shaped, and orders the two decisions — gate, then
 * publish — so that the second cannot happen without the first.
 */

export { getAnalysisPanel, getPanelWindow } from './panel.ts'
export type { PanelWindow } from './panel.ts'
export { ANALYSIS_JOB_TYPE, runAnalysis } from './run.ts'
export type { AnalysisDeps, RunAnalysisInput, RunAnalysisOutcome } from './run.ts'
