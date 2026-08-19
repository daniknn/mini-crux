import type { Actor, TraceId } from '@mini-crux/core'
import type { AnalysisFeature, CohortAssembly, GateDetail, GateId } from '@mini-crux/analysis'
import {
  ANALYSIS_VERSION,
  assembleCohorts,
  evaluateGates,
  runContrasts,
} from '@mini-crux/analysis'

import { appendAuditEvent } from '../audit.ts'
import type { SqlExecutor } from '../types.ts'
import { getAnalysisPanel, getPanelWindow } from './panel.ts'

/**
 * The analysis job: read a workspace's panel, decide whether it may speak, write what it says.
 *
 * WHY THIS IS A JOB AND NOT A QUERY BEHIND THE PAGE
 *
 * Not cost — the arithmetic is milliseconds. Reproducibility. A number that changes between
 * two page loads with no record of why is not a finding an operator can act on or argue with,
 * and the first time a result looks surprising the question is "which analysis produced this,
 * over which panel, under which feature definitions". A figure recomputed on render cannot
 * answer that; a stored run can, and the sequence of runs becomes its own audit trail.
 *
 * WHY THIS LIVES IN THE DB PACKAGE
 *
 * `@mini-crux/db` already depends on `@mini-crux/analysis` — the panel query builds its
 * feature map from `ANALYSIS_FEATURES` — so the reverse dependency is not available and the
 * orchestration cannot sit next to the statistics. That is the right way round anyway: every
 * line below is either a read, a write, or a call into the pure functions, and the pure
 * functions stay testable in milliseconds without a database. `crawl.ts` has the same shape
 * one package up.
 *
 * WHAT THIS DELIBERATELY DOES NOT WRITE
 *
 * Two failures write nothing at all, and they are not the same as a refusal:
 *
 * - **No healthy crawl.** There is no panel, so there is no `panel_date` to date a run to.
 *   Inventing today's date would file a run against a panel that does not exist. This is the
 *   crawler's "we did not look" one layer up.
 * - **Mixed feature schema versions.** `assembleCohorts` throws, and the throw is allowed to
 *   propagate so the job fails and is retried. The situation is ordinary and temporary — a
 *   re-extraction in flight — and the correct outcome is to run again when it finishes. A
 *   `refused` row would be wrong twice over: the panel is not thin, and `failed_gate` has no
 *   value that would be true.
 *
 * Neither is `outcome = 'errored'`, because there is no such outcome. A run that could not
 * happen is not a finding, and putting it in the table an operator reads as findings is how
 * a crash starts looking like a result.
 */

/** The `jobs.type` this handler answers to. */
export const ANALYSIS_JOB_TYPE = 'analysis'

export interface AnalysisDeps {
  /**
   * MUST be a BYPASSRLS worker connection. The job writes `analysis_runs`, on which
   * `authenticated` holds select and nothing else, and it scopes its read with an explicit
   * `workspace_id` rather than a policy — see the header of `panel.ts`.
   */
  db: SqlExecutor
}

export interface RunAnalysisInput {
  workspaceId: string
  traceId: TraceId
  actor: Actor
}

export type RunAnalysisOutcome =
  | {
      status: 'published'
      analysisRunId: string
      /** Features that produced a testable contrast. Not always six. */
      featureCount: number
      untestable: readonly AnalysisFeature[]
    }
  | { status: 'refused'; analysisRunId: string; failedGate: GateId; detail: GateDetail }
  /** No healthy crawl for this workspace: nothing was written, and that is correct. */
  | { status: 'no-panel' }

export async function runAnalysis(
  deps: AnalysisDeps,
  input: RunAnalysisInput,
): Promise<RunAnalysisOutcome> {
  const window = await getPanelWindow(deps.db, input.workspaceId)
  if (window === null) return { status: 'no-panel' }

  const panel = await getAnalysisPanel(deps.db, input.workspaceId)
  const assembly = assembleCohorts(panel)
  const verdict = evaluateGates({ panelAgeDays: window.panelAgeDays, assembly })

  // The versions of the rows the run actually read, which is what the column means. Taken
  // over cohort *members* rather than the whole panel: a creative excluded for having gaps
  // was never measured by this analysis, so recording its extractor build as provenance for
  // this run's numbers would be a small lie in the one place provenance is kept.
  const memberIds = new Set(assembly.members.map((m) => m.creativeId))
  const extractorVersions = [
    ...new Set(
      panel
        .filter((c) => memberIds.has(c.creativeId))
        .map((c) => c.extractorVersion)
        .filter((v): v is string => v !== null),
    ),
  ].sort()

  const analysisRunId = await insertRun(deps.db, {
    input,
    window,
    assembly,
    extractorVersions,
    verdict,
  })

  if (verdict.outcome === 'refused') {
    await appendAuditEvent(deps.db, {
      workspaceId: input.workspaceId,
      traceId: input.traceId,
      actor: input.actor,
      type: 'analysis.refused',
      subjectType: 'analysis_run',
      subjectId: analysisRunId,
      payload: {
        panel_date: window.panelDate,
        failed_gate: verdict.failedGate,
        gate_detail: verdict.detail,
      },
    })
    return {
      status: 'refused',
      analysisRunId,
      failedGate: verdict.failedGate,
      detail: verdict.detail,
    }
  }

  // Only reached once every gate has passed. `runContrasts` is the first line in this
  // function that computes a p-value, and that ordering is the rule "no feature result is
  // published from a run that failed any gate" expressed as control flow rather than as a
  // filter applied afterwards — there is no set of results sitting in a variable waiting for
  // someone to forget to check the verdict. `app.assert_run_published` enforces it a second
  // time in the database, on the assumption that this ordering will eventually be disturbed.
  const contrasts = runContrasts(assembly)

  for (const feature of contrasts.features) {
    await deps.db.query(
      `insert into public.analysis_feature_results
         (workspace_id, analysis_run_id, feature, n_long, n_short, z, p_value, q_value,
          probability_superiority, rank_biserial, strata_used, strata_dropped)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        input.workspaceId,
        analysisRunId,
        feature.feature,
        feature.nLong,
        feature.nShort,
        feature.z,
        feature.p,
        feature.qValue,
        feature.probabilitySuperiority,
        feature.rankBiserial,
        feature.strataUsed,
        feature.strataDropped,
      ],
    )
  }

  await appendAuditEvent(deps.db, {
    workspaceId: input.workspaceId,
    traceId: input.traceId,
    actor: input.actor,
    type: 'analysis.published',
    subjectType: 'analysis_run',
    subjectId: analysisRunId,
    payload: {
      panel_date: window.panelDate,
      feature_count: contrasts.features.length,
      untestable: contrasts.untestable,
      n_long: assembly.counts.long_lived,
      n_short: assembly.counts.short_lived,
    },
  })

  return {
    status: 'published',
    analysisRunId,
    featureCount: contrasts.features.length,
    untestable: contrasts.untestable,
  }
}

interface InsertRunArgs {
  input: RunAnalysisInput
  window: { panelDate: string; panelAgeDays: number }
  assembly: CohortAssembly
  extractorVersions: readonly string[]
  verdict: ReturnType<typeof evaluateGates>
}

async function insertRun(db: SqlExecutor, args: InsertRunArgs): Promise<string> {
  const { input, window, assembly, extractorVersions, verdict } = args
  const counts = assembly.counts

  const [row] = await db.query<{ id: string }>(
    `insert into public.analysis_runs
       (workspace_id, panel_date, panel_age_days,
        feature_schema_version, extractor_versions, analysis_version,
        outcome, failed_gate, gate_detail,
        n_long, n_short,
        n_excluded_middle, n_excluded_gaps, n_excluded_no_start, n_excluded_not_extracted,
        censoring_rate_long, strata_total, strata_used, strata_dropped,
        trace_id, actor)
     values ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             $16, $17, $18, $19, $20, $21)
     returning id`,
    [
      input.workspaceId,
      window.panelDate,
      window.panelAgeDays,
      // Null only when no creative reached a cohort, which the schema permits exactly
      // because that run can never be published. See the column comment in 0007.
      assembly.featureSchemaVersion,
      extractorVersions,
      ANALYSIS_VERSION,
      verdict.outcome,
      verdict.failedGate,
      JSON.stringify(verdict.detail),
      counts.long_lived,
      counts.short_lived,
      counts.excluded_middle,
      counts.excluded_gaps,
      counts.excluded_no_start,
      counts.excluded_not_extracted,
      assembly.censoringRateLong,
      assembly.strataTotal,
      assembly.strataUsed,
      assembly.strataDropped,
      input.traceId,
      JSON.stringify(input.actor),
    ],
  )
  return row!.id
}
