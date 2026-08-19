import { ANALYSIS_FEATURES, HOOK_TYPES, TONES } from '@mini-crux/analysis'
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

    it('constrains exactly the features the analysis knows how to compute', async () => {
      // Two lists in two languages that have to agree: `ANALYSIS_FEATURES` decides what the
      // job measures, this constraint decides what the table will store. A feature added to
      // one and not the other is either a run that crashes on its own output or a column
      // nothing ever writes — and neither shows up until someone bumps the feature set.
      //
      // Read out of the live catalog rather than grepped from the migration text, so it is
      // the constraint Postgres actually installed that is being compared.
      await db.exec('reset role')
      const [row] = await db.query<{ definition: string }>(
        `select pg_get_constraintdef(c.oid) as definition
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         where t.relname = 'analysis_feature_results' and c.contype = 'c'
           and pg_get_constraintdef(c.oid) like '%feature%ANY%'`,
      )

      const allowed = [...(row!.definition.matchAll(/'([a-z0-9_]+)'/g))].map((m) => m[1]!)
      expect(allowed.sort()).toEqual([...ANALYSIS_FEATURES].sort())
    })

    it('allows one result per feature per run and no more', async () => {
      const runId = await insertRun({ workspaceId: workspaceA, traceId: 'trc_dupe' })
      await insertResult(runId, workspaceA, { feature: 'text_density' })
      await expect(insertResult(runId, workspaceA, { feature: 'text_density' })).rejects.toThrow()
    })

    it('keeps the four exclusion reasons apart', async () => {
      // Four distinct values, not four zeroes. Each reason points at a different fix — wait
      // for the panel to age, fix the crawler, chase the provider, drain the extraction
      // queue — so a run that collapsed two of them, or wrote them into each other's
      // columns, would send an operator to work on the wrong thing. A fixture using the
      // same number for all four would be satisfied by any permutation of them.
      await db.exec('reset role')
      const [row] = await db.query<Record<string, number>>(
        `insert into public.analysis_runs (
           workspace_id, panel_date, panel_age_days, feature_schema_version,
           analysis_version, outcome, failed_gate, n_long, n_short,
           n_excluded_middle, n_excluded_gaps, n_excluded_no_start, n_excluded_not_extracted,
           trace_id, actor
         ) values ($1, '2026-08-17'::date, 200, 2, 'uc5.0', 'refused', 'MIN_STRATA',
                   11, 13, 17, 19, 23, 29, 'trc_excl', '{"type":"schedule"}'::jsonb)
         returning n_long, n_short, n_excluded_middle, n_excluded_gaps,
                   n_excluded_no_start, n_excluded_not_extracted`,
        [workspaceA],
      )

      expect(row).toEqual({
        n_long: 11,
        n_short: 13,
        n_excluded_middle: 17,
        n_excluded_gaps: 19,
        n_excluded_no_start: 23,
        n_excluded_not_extracted: 29,
      })
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

  describe('analysis_tag_results', () => {
    /**
     * UC-8's descriptive half, at the schema level. `analysis-run.test.ts` and
     * `dashboard-analysis.test.ts` already prove the job writes these rows and the surface
     * reads them back; what belongs here is what migration 0014 promises the table itself
     * refuses — the same posture as the `analysis_feature_results` block above, plus the
     * two guarantees specific to this table: a per-tag taxonomy check, and `'untagged'` as a
     * literal value rather than a null the unique constraint would let through twice.
     */
    async function insertTagResult(
      runId: string,
      workspaceId: string,
      overrides: Record<string, unknown> = {},
    ): Promise<void> {
      await db.exec('reset role')
      const values = {
        tag: 'hook_type',
        value: 'testimonial',
        n_long: 5,
        n_short: 3,
        ...overrides,
      }
      await db.query(
        `insert into public.analysis_tag_results (
           workspace_id, analysis_run_id, tag, value, n_long, n_short
         ) values ($1, $2, $3, $4, $5, $6)`,
        [workspaceId, runId, values.tag, values.value, values.n_long, values.n_short],
      )
    }

    it('accepts a breakdown row for a published run', async () => {
      const runId = await insertRun({ workspaceId: workspaceA, traceId: 'trc_tag_ok' })
      await insertTagResult(runId, workspaceA)
      const rows = await db.query(
        `select id from public.analysis_tag_results where analysis_run_id = $1`,
        [runId],
      )
      expect(rows).toHaveLength(1)
    })

    it('rejects a breakdown row for a refused run', async () => {
      // Same guard as the statistical results, reused rather than redefined — migration 0014
      // attaches `app.assert_run_published` a second time instead of copying it.
      const runId = await insertRun({
        workspaceId: workspaceA,
        outcome: 'refused',
        failedGate: 'MIN_STRATA',
        traceId: 'trc_tag_refused',
      })
      await expect(insertTagResult(runId, workspaceA)).rejects.toThrow(
        /run that refused publishes no feature results/,
      )
    })

    it('rejects a row filed against a run in another workspace', async () => {
      const runId = await insertRun({ workspaceId: workspaceB, traceId: 'trc_tag_tenant' })
      await expect(insertTagResult(runId, workspaceA)).rejects.toThrow(
        /does not match analysis run workspace/,
      )
    })

    it('rejects a hook_type-only value on a tone row, and a tone-only value on a hook_type row', async () => {
      // The compound check is per-tag on purpose (migration 0014's header): a flat
      // `value in (...)` across both lists would let a `tone` row carry a `hook_type`-only
      // value like `'ugc'` and nothing would catch it.
      const runId = await insertRun({ workspaceId: workspaceA, traceId: 'trc_tag_cross' })
      await expect(
        insertTagResult(runId, workspaceA, { tag: 'tone', value: 'ugc' }),
      ).rejects.toThrow()
      await expect(
        insertTagResult(runId, workspaceA, { tag: 'hook_type', value: 'urgente' }),
      ).rejects.toThrow()
    })

    it('constrains exactly the taxonomies the analysis knows how to count, plus untagged', async () => {
      // Same discipline as `constrains exactly the features...` above: read the constraint
      // Postgres actually installed, not the migration text, and compare it against the
      // module's own lists rather than a copy pasted into this file.
      await db.exec('reset role')
      const [row] = await db.query<{ definition: string }>(
        `select pg_get_constraintdef(c.oid) as definition
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         where t.relname = 'analysis_tag_results' and c.contype = 'c'
           and c.conname = 'analysis_tag_results_check'`,
      )

      // Both taxonomies, 'untagged', and the two tag names themselves all appear in this one
      // compound check — so assert containment of each list rather than equality against
      // either alone.
      const values = [...(row!.definition.matchAll(/'([a-z0-9_]+)'/g))].map((m) => m[1]!)
      for (const value of HOOK_TYPES) expect(values).toContain(value)
      for (const value of TONES) expect(values).toContain(value)
      expect(values).toContain('untagged')
    })

    it('treats untagged as one taxonomy row, not a null the unique constraint would miss twice', async () => {
      // The trap migration 0014's header calls out: a nullable `value` would let two
      // 'untagged' rows for the same (run, tag) both pass `unique (run, tag, value)`, since
      // Postgres treats every null as distinct from every other null. A literal string closes
      // it, and this proves the unique constraint actually fires on it.
      const runId = await insertRun({ workspaceId: workspaceA, traceId: 'trc_tag_untagged' })
      await insertTagResult(runId, workspaceA, { tag: 'hook_type', value: 'untagged' })
      await expect(
        insertTagResult(runId, workspaceA, { tag: 'hook_type', value: 'untagged' }),
      ).rejects.toThrow()
    })

    it('allows one row per (run, tag, value) and no more', async () => {
      const runId = await insertRun({ workspaceId: workspaceA, traceId: 'trc_tag_dupe' })
      await insertTagResult(runId, workspaceA, { tag: 'tone', value: 'urgente' })
      await expect(
        insertTagResult(runId, workspaceA, { tag: 'tone', value: 'urgente' }),
      ).rejects.toThrow()
    })

    it('rejects a negative count on either side', async () => {
      const runId = await insertRun({ workspaceId: workspaceA, traceId: 'trc_tag_neg' })
      await expect(insertTagResult(runId, workspaceA, { n_long: -1 })).rejects.toThrow(/n_long/)
      await expect(insertTagResult(runId, workspaceA, { n_short: -1 })).rejects.toThrow(
        /n_short/,
      )
    })

    it('refuses to rewrite a published breakdown row, even with the privilege granted back', async () => {
      const runId = await insertRun({ workspaceId: workspaceA, traceId: 'trc_tag_append' })
      await insertTagResult(runId, workspaceA, { tag: 'tone', value: 'emocional' })
      await db.exec('reset role')
      await db.exec('grant update, delete on public.analysis_tag_results to service_role')

      await expect(
        db.query(`update public.analysis_tag_results set n_long = 99 where analysis_run_id = $1`, [
          runId,
        ]),
      ).rejects.toThrow(/append-only/)

      await db.exec('revoke update, delete on public.analysis_tag_results from service_role')
    })

    it('grants no update or delete to any client role', async () => {
      const rows = await db.query<{
        table_name: string
        grantee: string
        privilege_type: string
      }>(
        `select table_name, grantee, privilege_type
         from information_schema.role_table_grants
         where table_schema = 'public'
           and table_name = 'analysis_tag_results'
           and grantee in ('anon', 'authenticated', 'service_role')
           and privilege_type in ('UPDATE', 'DELETE')`,
      )
      expect(rows).toEqual([])
    })

    it('shows a workspace only its own breakdown rows', async () => {
      const runA = await insertRun({ workspaceId: workspaceA, traceId: 'trc_tag_iso_a' })
      const runB = await insertRun({ workspaceId: workspaceB, traceId: 'trc_tag_iso_b' })
      await insertTagResult(runA, workspaceA, { tag: 'hook_type', value: 'demo' })
      await insertTagResult(runB, workspaceB, { tag: 'hook_type', value: 'demo' })

      const visibleToA = await asAuthenticated(db, { sub: USER_A, org_id: ORG_A }, (d) =>
        d.query<{ id: string }>(`select id from public.analysis_tag_results`),
      )
      const rowIdsB = await db.query<{ id: string }>(
        `select id from public.analysis_tag_results where analysis_run_id = $1`,
        [runB],
      )
      const visibleIds = visibleToA.map((r) => r.id)
      expect(visibleIds).not.toContain(rowIdsB[0]!.id)
      expect(visibleIds.length).toBeGreaterThan(0)
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
