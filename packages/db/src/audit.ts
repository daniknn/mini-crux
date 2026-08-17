import type { Actor, TraceId } from '@mini-crux/core'

import type { SqlExecutor } from './types.ts'

/**
 * Append-only event log, queryable by actor / trace_id / type / date (DashOne §3).
 *
 * There is deliberately no update or delete helper here: `update` and `delete` are
 * revoked on the table in migration 0001, so the absence is structural rather than a
 * matter of discipline.
 */

export interface AuditEventInput {
  workspaceId: string
  traceId: TraceId
  actor: Actor
  /** Dotted event name, e.g. `crawl.completed`, `watchlist.created`. */
  type: string
  subjectType?: string
  subjectId?: string
  payload?: Record<string, unknown>
  schemaVersion?: number
}

export interface AuditEvent {
  id: string
  workspace_id: string
  trace_id: string
  actor: Actor
  type: string
  subject_type: string | null
  subject_id: string | null
  payload: Record<string, unknown>
  schema_version: number
  created_at: string
}

export async function appendAuditEvent(
  db: SqlExecutor,
  input: AuditEventInput,
): Promise<{ id: string }> {
  const rows = await db.query<{ id: string }>(
    `insert into public.audit_events
       (workspace_id, trace_id, actor, type, subject_type, subject_id, payload, schema_version)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id`,
    [
      input.workspaceId,
      input.traceId,
      JSON.stringify(input.actor),
      input.type,
      input.subjectType ?? null,
      input.subjectId ?? null,
      JSON.stringify(input.payload ?? {}),
      input.schemaVersion ?? 1,
    ],
  )
  return { id: rows[0]!.id }
}

/** Every event in one trace, oldest first — the "what happened in this run" query. */
export async function findAuditEventsByTrace(
  db: SqlExecutor,
  traceId: TraceId,
): Promise<AuditEvent[]> {
  return db.query<AuditEvent>(
    `select id, workspace_id, trace_id, actor, type, subject_type, subject_id,
            payload, schema_version, created_at
     from public.audit_events
     where trace_id = $1
     order by created_at asc, id asc`,
    [traceId],
  )
}
