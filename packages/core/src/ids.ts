import { ulid } from 'ulid'

/**
 * Prefixed ULIDs. The prefix makes an id self-describing in logs and stack traces —
 * `trc_01J…` is immediately recognizable in a way a bare UUID is not — while the ULID
 * body keeps ids lexicographically sortable by creation time.
 */

export const TRACE_PREFIX = 'trc_'
export const MESSAGE_PREFIX = 'msg_'

export type TraceId = `trc_${string}`
export type MessageId = `msg_${string}`

/**
 * Mint a trace id. Called once at ingress (cron tick, HTTP request, webhook) and then
 * propagated unchanged — it is the join key across logs, traces, jobs and audit
 * (DashOne §3). Never mint a second one mid-chain.
 */
export function newTraceId(): TraceId {
  return `${TRACE_PREFIX}${ulid()}`
}

/**
 * Mint a message id — the idempotency key for a unit of durable work. Uniqueness is
 * enforced by the database (`jobs.message_id` unique + `processed_messages` primary key),
 * not by application-level checking.
 */
export function newMessageId(): MessageId {
  return `${MESSAGE_PREFIX}${ulid()}`
}

export function isTraceId(value: string): value is TraceId {
  return value.startsWith(TRACE_PREFIX) && value.length === TRACE_PREFIX.length + 26
}

export function isMessageId(value: string): value is MessageId {
  return value.startsWith(MESSAGE_PREFIX) && value.length === MESSAGE_PREFIX.length + 26
}
