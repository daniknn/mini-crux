import type { ProxyGateId, ProxyVerdict, ReachBound } from '@mini-crux/analysis'

import { instantAsDate } from './internal.ts'
import type { SqlExecutor } from '../types.ts'

/**
 * What the last ES validation run said, for the surface that renders it (UC-7).
 *
 * Simpler than `analysis.ts`'s read in one respect and identical in the ones that matter.
 * Simpler: there is no results table to join — `proxy_validation_runs` stores the whole
 * regression on one row, so this is a single `select`, no `Map` to build. Identical: every
 * number here was computed by the job and stored, not recomputed on read, for the same reason
 * — a figure a reader can no longer trace to the run and corpus that produced it is a figure
 * that quietly changes under a page nobody asked to change. `betaMinusOne` is the one
 * exception, and it earns it: `beta - 1` is arithmetic, not a second pass over the corpus, the
 * same status `dateLabel`'s day/month reordering or `percentLabel`'s `Math.round` already have
 * on the render side elsewhere in this app. It is computed here rather than there only so
 * every consumer of this row sees the same figure the spec's own framing is built around
 * (spec: "beta is an elasticity, so beta - 1 is the number to report").
 *
 * No workspace filter, like every other read in this directory: the caller is inside
 * `withTenant` and the table carries RLS. See `internal.ts`.
 */

export interface LatestProxyValidation {
  runId: string
  /** The market-calendar day the run was executed on. */
  runDate: string
  reachBoundUsed: ReachBound
  outcome: 'published' | 'refused'
  /** Null exactly when published. */
  failedGate: ProxyGateId | null
  /** The gate's shortfall, as the numbers the refusal copy is rendered from. */
  gateDetail: Record<string, number>
  corpusSize: number
  excluded: {
    stillRunning: number
    zeroReach: number
    subDay: number
  }
  nIncluded: number
  advertisersTotal: number
  advertisersUsed: number
  advertisersDropped: number
  /** Null exactly when refused — there is no partial regression over a corpus too thin. */
  beta: number | null
  /** `beta - 1`, the effect size the spec actually reports. See the file header. */
  betaMinusOne: number | null
  betaSe: number | null
  betaCiLow: number | null
  betaCiHigh: number | null
  tStat: number | null
  pValue: number | null
  df: number | null
  /** The exhibit, never the headline — shown alongside the within-advertiser estimate. */
  naivePooledBeta: number | null
  naivePearsonR: number | null
  verdict: ProxyVerdict | null
}

interface RunRow {
  id: string
  run_date: string
  reach_bound_used: ReachBound
  outcome: 'published' | 'refused'
  failed_gate: ProxyGateId | null
  gate_detail: Record<string, number>
  corpus_size: number
  n_excluded_still_running: number
  n_excluded_zero_reach: number
  n_excluded_sub_day: number
  n_included: number
  advertisers_total: number
  advertisers_used: number
  advertisers_dropped: number
  beta: number | null
  beta_se: number | null
  beta_ci_low: number | null
  beta_ci_high: number | null
  t_stat: number | null
  p_value: number | null
  df: number | null
  naive_pooled_beta: number | null
  naive_pearson_r: number | null
  verdict: ProxyVerdict | null
}

/**
 * The most recent ES validation run in the workspace, published or refused, or null if the
 * validation crawl has never been triggered.
 *
 * Same three states as `getLatestAnalysis`, for the same reason (rule 6): a refused run is a
 * result — "we crawled and the corpus is 12 advertisers short" — and collapsing it into the
 * same blank page as "nobody has ever run this" loses the one that tells an operator what to
 * do next.
 */
export async function getLatestProxyValidation(
  db: SqlExecutor,
): Promise<LatestProxyValidation | null> {
  const [run] = await db.query<RunRow>(
    `select id,
            ${instantAsDate('created_at')} as run_date,
            reach_bound_used,
            outcome,
            failed_gate,
            gate_detail,
            corpus_size,
            n_excluded_still_running,
            n_excluded_zero_reach,
            n_excluded_sub_day,
            n_included,
            advertisers_total,
            advertisers_used,
            advertisers_dropped,
            beta,
            beta_se,
            beta_ci_low,
            beta_ci_high,
            t_stat,
            p_value,
            df,
            naive_pooled_beta,
            naive_pearson_r,
            verdict
     from public.proxy_validation_runs
     -- Newest run wins, id breaks the tie — same instability this protects against as in
     -- getLatestAnalysis: two runs inside the same clock tick is not hypothetical.
     order by created_at desc, id desc
     limit 1`,
  )

  if (run === undefined) return null

  return {
    runId: run.id,
    runDate: run.run_date,
    reachBoundUsed: run.reach_bound_used,
    outcome: run.outcome,
    failedGate: run.failed_gate,
    gateDetail: run.gate_detail,
    corpusSize: run.corpus_size,
    excluded: {
      stillRunning: run.n_excluded_still_running,
      zeroReach: run.n_excluded_zero_reach,
      subDay: run.n_excluded_sub_day,
    },
    nIncluded: run.n_included,
    advertisersTotal: run.advertisers_total,
    advertisersUsed: run.advertisers_used,
    advertisersDropped: run.advertisers_dropped,
    beta: run.beta,
    betaMinusOne: run.beta === null ? null : run.beta - 1,
    betaSe: run.beta_se,
    betaCiLow: run.beta_ci_low,
    betaCiHigh: run.beta_ci_high,
    tStat: run.t_stat,
    pValue: run.p_value,
    df: run.df,
    naivePooledBeta: run.naive_pooled_beta,
    naivePearsonR: run.naive_pearson_r,
    verdict: run.verdict,
  }
}
