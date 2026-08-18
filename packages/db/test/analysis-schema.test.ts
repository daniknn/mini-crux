import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { asAuthenticated, createTestDb, seedWorkspace, type TestDb } from '../src/testing.ts'

/**
 * What migration 0007 promises, proved against a live database.
 *
 * The interesting assertions here are the ones about what the schema *refuses*. UC-5's
 * whole posture is that the analysis must be structurally incapable of publishing something
 * it has not earned — so "a refused run cannot carry feature results" and "a result cannot
 * be filed under the wrong workspace" are database guarantees, not code conventions, and
 * they get tested like guarantees.
 *
 * Every tenancy assertion runs inside `asAuthenticated`. PGlite's default connection is a
 * superuser and bypasses RLS unconditionally; a query run directly would pass while proving
 * nothing at all.
 */

const ORG_A = 'org_analysisaaaaaaaaaaaa'
const ORG_B = 'org_analysisbbbbbbbbbbbb'
const USER_A = 'user_analysisaaaaaaaaaaa'
const USER_B = 'user_analysisbbbbbbbbbbb'

const PUBLISHED = {
  outcome: 'published',
  failedGate: null as string | null,
}

interface RunInput {
  workspaceId: string
  outcome?: string
  failedGate?: string | null
  gateDetail?: Record<string, unknown>
  panelDate?: string
  panelAgeDays?: number
  traceId?: string
}

describe('analysis schema', () => {
  let db: TestDb
  let workspaceA: string
  let workspaceB: string

  /** Insert a run privileged (the job writes through the service role). */
  async function insertRun(input: RunInput): Promise<string> {
    await db.exec('reset role')
    const [row] = await db.query<{ id: string }>(
      `insert into public.analysis_runs (
         workspace_id, panel_date, panel_age_days,
         feature_schema_version, extractor_versions, analysis_version,
         outcome, failed_gate, gate_detail,
         n_long, n_short, censoring_rate_long,
         strata_total, strata_used, strata_dropped,
         trace_id, actor
       ) values (
         $1, $2::date, $3, 2, array['uc4.1'], 'uc5.0',
         $4, $5, $6::jsonb,
         24, 31, 0.5,
         9, 5, 4,
         $7, '{"type":"schedule"}'::jsonb
       ) returning id`,
      [
        input.workspaceId,
        input.panelDate ?? '2026-08-17',
        input.panelAgeDays ?? 120,
        input.outcome ?? PUBLISHED.outcome,
        input.failedGate ?? PUBLISHED.failedGate,
        JSON.stringify(input.gateDetail ?? {}),
        input.traceId ?? 'trc_0000000000000000000000RUN',
      ],
    )
    return row!.id
  }

  async function insertResult(
    runId: string,
    workspaceId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<void> {
    await db.exec('reset role')
    const values = {
      feature: 'cuts_per_second',
      n_long: 24,
      n_short: 31,
      z: 2.4776,
      p_value: 0.0132,
      q_value: 0.0396,
      probability_superiority: 0.836,
      rank_biserial: 0.672,
      strata_used: 5,
      strata_dropped: 4,
      ...overrides,
    }
    await db.query(
      `insert into public.analysis_feature_results (
         workspace_id, analysis_run_id, feature, n_long, n_short,
         z, p_value, q_value, probability_superiority, rank_biserial,
         strata_used, strata_dropped
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [workspaceId, runId, ...Object.values(values)],
    )
  }

  beforeAll(async () => {
    db = await createTestDb()
    const a = await seedWorkspace(db, {
      slug: 'acme-analysis',
      name: 'Acme',
      clerkOrgId: ORG_A,
      clerkUserId: USER_A,
    })
    const b = await seedWorkspace(db, {
      slug: 'globex-analysis',
      name: 'Globex',
      clerkOrgId: ORG_B,
      clerkUserId: USER_B,
    })
    workspaceA = a.workspaceId
    workspaceB = b.workspaceId
  })

  afterAll(async () => {
    await db.close()
  })

  describe('a refused run is a stored result, not an absence', () => {
    it('stores which gate failed and what the panel would need', async () => {
      const runId = await insertRun({
        workspaceId: workspaceA,
        outcome: 'refused',
        failedGate: 'MIN_PANEL_AGE_DAYS',
        gateDetail: { required: 61, actual: 12, shortfallDays: 49 },
        panelAgeDays: 12,
      })

      const [row] = await db.query<{
        outcome: string
        failed_gate: string
        gate_detail: Record<string, number>
      }>(
        `select outcome, failed_gate, gate_detail from public.analysis_runs where id = $1`,
        [runId],
      )
      expect(row?.outcome).toBe('refused')
      expect(row?.failed_gate).toBe('MIN_PANEL_AGE_DAYS')
      // The shortfall is the whole point: "faltan 49 días" is only renderable because the
      // run wrote down how far short it was, not merely that it stopped.
      expect(row?.gate_detail).toEqual({ required: 61, actual: 12, shortfallDays: 49 })
    })

    it('refuses a refusal that does not name its gate', async () => {
      // Otherwise the UI renders "no se pudo ejecutar" with no reason — the blank screen
      // this table exists to prevent, wearing a row.
      await expect(
        insertRun({ workspaceId: workspaceA, outcome: 'refused', failedGate: null }),
      ).rejects.toThrow(/analysis_runs_gate_matches_outcome/)
    })

    it('refuses a published run that also claims a failed gate', async () => {
      await expect(
        insertRun({
          workspaceId: workspaceA,
          outcome: 'published',
          failedGate: 'MIN_COHORT_N',
        }),
      ).rejects.toThrow(/analysis_runs_gate_matches_outcome/)
    })

    it('has no third outcome — a crash is not a finding', async () => {
      /**
       * The constraint is asserted **by name**, and that is not pedantry. Any unknown
       * outcome also violates `analysis_runs_gate_matches_outcome`, whose name happens to
       * contain the word "outcome" — so a loose `/outcome/` match was satisfied by the
       * wrong rejection, and deleting the `outcome in (…)` check entirely left this test
       * green. Two guards firing on the same fixture test neither (`CLAUDE.md`).
       */
      await expect(
        insertRun({ workspaceId: workspaceA, outcome: 'errored', failedGate: 'boom' }),
      ).rejects.toThrow(/analysis_runs_outcome_known/)
    })
  })

  describe('rule 7: no feature result from a run that failed a gate', () => {
    it('accepts results for a published run', async () => {
      const runId = await insertRun({ workspaceId: workspaceA })
      await insertResult(runId, workspaceA)
      const rows = await db.query(
        `select id from public.analysis_feature_results where analysis_run_id = $1`,
        [runId],
      )
      expect(rows).toHaveLength(1)
    })

    it('rejects results for a refused run', async () => {
      /**
       * The failure mode this prevents is not a writer that ignores the gate outright — it
       * is a well-meaning change that publishes "just the features that cleared their own
       * n". That is a garden of forking paths with extra steps, and it looks like a
       * kindness in a diff. Making it impossible in the database means the argument only
       * has to be won once.
       */
      const runId = await insertRun({
        workspaceId: workspaceA,
        outcome: 'refused',
        failedGate: 'MIN_STRATA',
      })
      await expect(insertResult(runId, workspaceA)).rejects.toThrow(
        /run that refused publishes no feature results/,
      )
    })

    it('rejects a result filed against a run in another workspace', async () => {
      /**
       * Both tables carry `workspace_id` so each is independently filterable by RLS, and
       * that denormalization is exactly what makes this possible: a result under workspace
       * A pointing at a run owned by B passes the foreign key and passes both tenancy
       * policies. The analysis surface would then show another tenant's finding, and
       * nothing in the schema would object.
       */
      const runId = await insertRun({ workspaceId: workspaceB })
      await expect(insertResult(runId, workspaceA)).rejects.toThrow(
        /does not match analysis run workspace/,
      )
    })

    it('rejects a result pointing at no run at all', async () => {
      await expect(
        insertResult('00000000-0000-0000-0000-000000000000', workspaceA),
      ).rejects.toThrow()
    })
  })

  describe('the ranges a published number has to live in', () => {
    it('rejects a p-value or q-value outside [0, 1]', async () => {
      const runId = await insertRun({ workspaceId: workspaceA, traceId: 'trc_ranges' })
      await expect(insertResult(runId, workspaceA, { p_value: 1.4 })).rejects.toThrow(/p_value/)
      await expect(insertResult(runId, workspaceA, { q_value: -0.1 })).rejects.toThrow(/q_value/)
    })

    it('rejects a rank-biserial outside [-1, 1] and a PS outside [0, 1]', async () => {
      const runId = await insertRun({ workspaceId: workspaceA, traceId: 'trc_ranges2' })
      await expect(insertResult(runId, workspaceA, { rank_biserial: 1.5 })).rejects.toThrow(
        /rank_biserial/,
      )
      await expect(
        insertResult(runId, workspaceA, { probability_superiority: 1.2 }),
      ).rejects.toThrow(/probability_superiority/)
    })

    it('rejects a feature name that is not one of the measured six', async () => {
      // A typo would otherwise land as a seventh feature that renders once and never again.
      const runId = await insertRun({ workspaceId: workspaceA, traceId: 'trc_feature' })
      await expect(insertResult(runId, workspaceA, { feature: 'cuts_per_sec' })).rejects.toThrow(
        /feature/,
      )
    })

    it('allows one result per feature per run and no more', async () => {
      const runId = await insertRun({ workspaceId: workspaceA, traceId: 'trc_dupe' })
      await insertResult(runId, workspaceA, { feature: 'text_density' })
      await expect(insertResult(runId, workspaceA, { feature: 'text_density' })).rejects.toThrow()
    })

    it('allows a null censoring rate, because an empty cohort has no rate', async () => {
      // 0/0 is not 0. Writing 0 would report "nothing is still running" for a cohort with
      // no members — a plausible-looking number describing nothing.
      await db.exec('reset role')
      const [row] = await db.query<{ censoring_rate_long: number | null }>(
        `insert into public.analysis_runs (
           workspace_id, panel_date, panel_age_days, feature_schema_version,
           analysis_version, outcome, failed_gate, n_long, n_short, trace_id, actor
         ) values ($1, '2026-08-17'::date, 3, 2, 'uc5.0', 'refused', 'MIN_COHORT_N',
                   0, 0, 'trc_empty', '{"type":"schedule"}'::jsonb)
         returning censoring_rate_long`,
        [workspaceA],
      )
      expect(row?.censoring_rate_long).toBeNull()
    })
  })

  describe('append-only', () => {
    /**
     * A re-run writes a new row; nothing in the system edits what the analysis said
     * yesterday. That is the only reason the run history can be read as an audit trail.
     *
     * The migration revokes UPDATE and DELETE from every client role including
     * `service_role`, and those revokes are the real defence in production — but they
     * cannot be tested here and the first version of this block pretended otherwise.
     * Supabase grants those privileges by default on a new table, so the revoke takes them
     * away; PGlite never grants them, so the revoke is a no-op and an assertion that "no
     * update grant exists" passes with the revoke lines deleted. It was, verified by
     * deleting them.
     *
     * So the tests below go the other way: grant the privileges back, as hostile as
     * production's defaults, and prove the write still fails.
     */
    it('refuses an update even when the privilege has been granted back', async () => {
      const runId = await insertRun({ workspaceId: workspaceA, traceId: 'trc_append_upd' })
      await db.exec('reset role')
      await db.exec('grant update, delete on public.analysis_runs to service_role')

      await expect(
        db.query(`update public.analysis_runs set outcome = 'refused' where id = $1`, [runId]),
      ).rejects.toThrow(/append-only/)

      await expect(
        db.query(`delete from public.analysis_runs where id = $1`, [runId]),
      ).rejects.toThrow(/append-only/)

      await db.exec('revoke update, delete on public.analysis_runs from service_role')
    })

    it('refuses to rewrite a published feature result', async () => {
      // The one that would matter most: quietly editing a q-value on a result an operator
      // has already read and acted on.
      const runId = await insertRun({ workspaceId: workspaceA, traceId: 'trc_append_res' })
      await insertResult(runId, workspaceA, { feature: 'first_cut_time_s' })
      await db.exec('reset role')

      await expect(
        db.query(
          `update public.analysis_feature_results set q_value = 0.001
           where analysis_run_id = $1`,
          [runId],
        ),
      ).rejects.toThrow(/append-only/)
    })

    it('grants no update or delete on either table, to any client role', async () => {
      // Kept alongside the trigger tests, and honestly labelled: this one is vacuous under
      // PGlite and only means something against a real Supabase project, where the default
      // privileges it is revoking actually exist.
      const rows = await db.query<{ table_name: string; grantee: string; privilege_type: string }>(
        `select table_name, grantee, privilege_type
         from information_schema.role_table_grants
         where table_schema = 'public'
           and table_name in ('analysis_runs', 'analysis_feature_results')
           and grantee in ('anon', 'authenticated', 'service_role')
           and privilege_type in ('UPDATE', 'DELETE')`,
      )
      expect(rows).toEqual([])
    })

    it('carries no updated_at column, because nothing can update these rows', async () => {
      const rows = await db.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = 'public'
           and table_name in ('analysis_runs', 'analysis_feature_results')
           and column_name = 'updated_at'`,
      )
      expect(rows).toEqual([])
    })
  })

  describe('tenancy', () => {
    it('shows a workspace only its own runs and results', async () => {
      const runA = await insertRun({ workspaceId: workspaceA, traceId: 'trc_iso_a' })
      const runB = await insertRun({ workspaceId: workspaceB, traceId: 'trc_iso_b' })
      await insertResult(runA, workspaceA, { feature: 'duration_s' })
      await insertResult(runB, workspaceB, { feature: 'duration_s' })

      const visibleToA = await asAuthenticated(db, { sub: USER_A, org_id: ORG_A }, async (d) => ({
        runs: await d.query<{ id: string }>(`select id from public.analysis_runs`),
        results: await d.query<{ id: string }>(`select id from public.analysis_feature_results`),
      }))

      expect(visibleToA.runs.map((r) => r.id)).toContain(runA)
      expect(visibleToA.runs.map((r) => r.id)).not.toContain(runB)

      const resultIdsB = await db.query<{ id: string }>(
        `select id from public.analysis_feature_results where analysis_run_id = $1`,
        [runB],
      )
      const visibleResultIds = visibleToA.results.map((r) => r.id)
      expect(visibleResultIds).not.toContain(resultIdsB[0]!.id)
      expect(visibleResultIds.length).toBeGreaterThan(0)
    })

    it('cannot be reached by naming another workspace explicitly', async () => {
      // The policy filters rows; it is not a default that a `where` clause can talk past.
      const rows = await asAuthenticated(db, { sub: USER_A, org_id: ORG_A }, (d) =>
        d.query(`select id from public.analysis_runs where workspace_id = $1`, [workspaceB]),
      )
      expect(rows).toEqual([])
    })

    it('does not let an authenticated caller write a run of its own', async () => {
      // Findings come from the job, never from a browser session. Without a matching
      // insert policy the grant would be dead anyway — this pins that no future grant
      // quietly opens it.
      await expect(
        asAuthenticated(db, { sub: USER_A, org_id: ORG_A }, (d) =>
          d.query(
            `insert into public.analysis_runs (
               workspace_id, panel_date, panel_age_days, feature_schema_version,
               analysis_version, outcome, n_long, n_short, trace_id, actor
             ) values ($1, '2026-08-17'::date, 120, 2, 'uc5.0', 'published', 24, 31,
                       'trc_forged', '{"type":"user"}'::jsonb)`,
            [workspaceA],
          ),
        ),
      ).rejects.toThrow()
    })
  })
})
