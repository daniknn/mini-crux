import type { Actor, MessageId, TraceId } from '@mini-crux/core'
import { newMessageId } from '@mini-crux/core'

import type { SqlExecutor } from './types.ts'

/** Postgres unique-violation. The idempotency guarantee rests on this, not on a pre-check. */
const UNIQUE_VIOLATION = '23505'

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  )
}

export interface EnqueueJobInput {
  workspaceId: string
  type: string
  traceId: TraceId
  actor: Actor
  payload?: Record<string, unknown>
  /** Supply to make enqueueing itself idempotent (e.g. one crawl per watchlist per day). */
  messageId?: MessageId
  schemaVersion?: number
  runAfter?: Date
  maxAttempts?: number
}

export interface EnqueueJobResult {
  jobId: string
  messageId: string
  /** False when a job with this `message_id` already existed — the call was a no-op. */
  enqueued: boolean
}

/**
 * Enqueue a unit of durable work.
 *
 * `on conflict do nothing` makes redelivery safe at the database level: a duplicate
 * `message_id` produces no second row and no error. Callers that need "exactly one crawl
 * per watchlist per day" pass a deterministic `messageId` derived from those facts.
 */
export async function enqueueJob(
  db: SqlExecutor,
  input: EnqueueJobInput,
): Promise<EnqueueJobResult> {
  const messageId = input.messageId ?? newMessageId()

  const inserted = await db.query<{ id: string }>(
    `insert into public.jobs
       (workspace_id, message_id, type, payload, schema_version, trace_id, actor, run_after, max_attempts)
     values ($1, $2, $3, $4, $5, $6, $7, coalesce($8, now()), coalesce($9, 3))
     on conflict (message_id) do nothing
     returning id`,
    [
      input.workspaceId,
      messageId,
      input.type,
      JSON.stringify(input.payload ?? {}),
      input.schemaVersion ?? 1,
      input.traceId,
      JSON.stringify(input.actor),
      input.runAfter ?? null,
      input.maxAttempts ?? null,
    ],
  )

  if (inserted.length > 0) {
    return { jobId: inserted[0]!.id, messageId, enqueued: true }
  }

  const existing = await db.query<{ id: string }>(
    'select id from public.jobs where message_id = $1',
    [messageId],
  )
  return { jobId: existing[0]!.id, messageId, enqueued: false }
}

export interface IdempotencyKey {
  messageId: string
  workspaceId: string
  traceId: TraceId
  jobId?: string
}

export interface IdempotentResult<T> {
  /** False when this `message_id` was already processed — `sideEffect` did not run. */
  applied: boolean
  result?: T
}

/**
 * Run `sideEffect` at most once for a given `message_id`.
 *
 * The ledger row and the side effect share one transaction (DashOne §3). That is the whole
 * point: writing the ledger separately — before or after — leaves a window where a crash
 * either replays the effect or suppresses one that never happened.
 *
 * The connection must be able to write `processed_messages`, i.e. a BYPASSRLS worker role.
 */
export async function withIdempotency<T>(
  db: SqlExecutor,
  key: IdempotencyKey,
  sideEffect: (db: SqlExecutor) => Promise<T>,
): Promise<IdempotentResult<T>> {
  await db.exec('begin')

  try {
    await db.query(
      `insert into public.processed_messages (message_id, workspace_id, job_id, trace_id)
       values ($1, $2, $3, $4)`,
      [key.messageId, key.workspaceId, key.jobId ?? null, key.traceId],
    )
  } catch (error) {
    await db.exec('rollback')
    if (isUniqueViolation(error)) {
      return { applied: false }
    }
    throw error
  }

  try {
    const result = await sideEffect(db)
    await db.exec('commit')
    return { applied: true, result }
  } catch (error) {
    await db.exec('rollback')
    throw error
  }
}
