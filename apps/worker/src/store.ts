import type { SqlExecutor } from '@mini-crux/db'

/**
 * The job queue, as the TypeScript worker sees it.
 *
 * WHY THE SQL IS COPIED FROM THE PYTHON WORKER RATHER THAN INVENTED
 *
 * Both workers claim from one `jobs` table. If their lifecycle statements disagree — a
 * different backoff shape, a heartbeat that is not guarded on status, a failure path that
 * forgets to clear `heartbeat_at` — the disagreement shows up as jobs the reaper handles
 * inconsistently depending on which language happened to claim them. That is close to
 * undebuggable from the outside, because the row looks the same either way.
 *
 * So these four statements are the same text as
 * `apps/extractor/src/extractor/statements/*.sql`, and `test/statement-parity.test.ts`
 * fails if they drift. Copying with a test is worse than sharing, and better than copying
 * without one: `@mini-crux/db` cannot ship SQL to a Python process, and a shared file read
 * at runtime would couple a Fly image to a directory belonging to a different app.
 */

/** Types this worker answers to. `extract` belongs to the Python worker and is not claimed. */
export const JOB_TYPES = ['crawl', 'parse', 'analysis'] as const

export type JobType = (typeof JOB_TYPES)[number]

export interface JobRow {
  id: string
  workspaceId: string
  messageId: string
  type: string
  payload: Record<string, unknown>
  traceId: string
  actor: Record<string, unknown>
  attempts: number
  maxAttempts: number
}

export interface JobStore {
  claim(types: readonly string[]): Promise<JobRow | null>
  heartbeat(jobId: string): Promise<void>
  complete(jobId: string): Promise<void>
  fail(
    jobId: string,
    error: string,
    backoffS: number,
    options?: { permanent?: boolean },
  ): Promise<void>
}

export const CLAIM_JOB_SQL = `select id, workspace_id, message_id, type, payload, trace_id, actor, attempts, max_attempts
from app.claim_job($1::text[])`

export const HEARTBEAT_SQL = `update public.jobs
set heartbeat_at = now()
where id = $1::uuid
  and status = 'running'`

export const COMPLETE_JOB_SQL = `update public.jobs
set status       = 'succeeded',
    finished_at  = now(),
    heartbeat_at = null,
    last_error   = null
where id = $1::uuid`

export const FAIL_JOB_SQL = `update public.jobs
set status      = (case when attempts >= max_attempts then 'failed' else 'pending' end)::job_status,
    last_error  = $2::text,
    run_after   = now() + make_interval(secs => $3::double precision),
    finished_at = case when attempts >= max_attempts then now() else null end,
    heartbeat_at = null
where id = $1::uuid`

export const FAIL_JOB_PERMANENT_SQL = `update public.jobs
set status       = 'failed',
    last_error   = $2::text,
    finished_at  = now(),
    heartbeat_at = null
where id = $1::uuid`

interface RawJobRow {
  id: string
  workspace_id: string
  message_id: string
  type: string
  payload: Record<string, unknown>
  trace_id: string
  actor: Record<string, unknown>
  attempts: number
  max_attempts: number
}

export function createJobStore(db: SqlExecutor): JobStore {
  return {
    async claim(types: readonly string[]): Promise<JobRow | null> {
      const rows = await db.query<RawJobRow>(CLAIM_JOB_SQL, [[...types]])
      const row = rows[0]
      if (row === undefined) return null
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        messageId: row.message_id,
        type: row.type,
        payload: row.payload,
        traceId: row.trace_id,
        actor: row.actor,
        // node-postgres decodes int4 as a number and PGlite agrees, but the coercion is
        // free and the alternative — `attempts + 1` producing "11" — is a retry budget
        // that silently never exhausts.
        attempts: Number(row.attempts),
        maxAttempts: Number(row.max_attempts),
      }
    },

    async heartbeat(jobId: string): Promise<void> {
      await db.query(HEARTBEAT_SQL, [jobId])
    },

    async complete(jobId: string): Promise<void> {
      await db.query(COMPLETE_JOB_SQL, [jobId])
    },

    async fail(jobId, error, backoffS, options): Promise<void> {
      if (options?.permanent === true) {
        await db.query(FAIL_JOB_PERMANENT_SQL, [jobId, error])
        return
      }
      await db.query(FAIL_JOB_SQL, [jobId, error, backoffS])
    },
  }
}
