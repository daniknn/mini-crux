import { newTraceId, userActor, type TraceId } from '@mini-crux/core'

import { appendAuditEvent } from '../audit.ts'
import { currentWorkspaceId } from '../tenant.ts'
import { asDate } from './internal.ts'
import type { SqlExecutor } from '../types.ts'

/**
 * Watchlist management — the one place the dashboard writes.
 *
 * WHY `workspace_id` IS NEVER A PARAMETER
 *
 * Every insert here takes its workspace from `app.current_workspace_id()` inside the SQL,
 * so there is no field for a caller to forge and no app-level check that could be forgotten.
 * A request body carrying someone else's workspace has nowhere to land. The tenancy test
 * still tries it through a raw insert, because the policy — not this convention — is what
 * has to hold.
 *
 * WHY DEACTIVATION IS NOT DELETION
 *
 * `is_active = false` stops the crawl scheduler picking the watchlist up and leaves every
 * observation it ever produced in place. Deleting the row would cascade the crawl runs and
 * take the panel with it, and longitudinal data cannot be backfilled (CLAUDE.md rule 1) —
 * an operator tidying up their watchlists would be destroying the only copy of months of
 * history. There is deliberately no delete function in this module.
 */

export type WatchlistKind = 'keyword' | 'page'

export interface Watchlist {
  id: string
  kind: WatchlistKind
  query: string
  country: string
  label: string
  isActive: boolean
  /** Crawl health, so the list doubles as the "is ingestion alive" surface. */
  lastRunDate: string | null
  lastRunStatus: string | null
  succeededRuns: number
  failedRuns: number
  suspectRuns: number
}

export interface CreateWatchlistInput {
  kind: WatchlistKind
  query: string
  label: string
  country?: string
  /** Clerk user id of whoever clicked. Stamped on the audit event (DashOne §3). */
  clerkUserId: string
  traceId?: TraceId
}

interface WatchlistRow {
  id: string
  kind: WatchlistKind
  query: string
  country: string
  label: string
  is_active: boolean
  last_run_date: string | null
  last_run_status: string | null
  succeeded_runs: number
  failed_runs: number
  suspect_runs: number
}

export async function listWatchlists(db: SqlExecutor): Promise<Watchlist[]> {
  const rows = await db.query<WatchlistRow>(
    `select w.id,
            w.kind::text    as kind,
            w.query,
            w.country,
            w.label,
            w.is_active,
            ${asDate('r.last_run_date')} as last_run_date,
            r.last_run_status,
            coalesce(r.succeeded_runs, 0)::int as succeeded_runs,
            coalesce(r.failed_runs, 0)::int    as failed_runs,
            coalesce(r.suspect_runs, 0)::int   as suspect_runs
     from public.watchlists w
     left join lateral (
       select max(run_date) as last_run_date,
              -- The status of the most recent run, not of any run: "last crawl failed" is
              -- the operator's actual question, and max(status) would answer a different one.
              (array_agg(status::text order by run_date desc, started_at desc))[1]
                as last_run_status,
              count(*) filter (where status = 'succeeded') as succeeded_runs,
              count(*) filter (where status = 'failed')    as failed_runs,
              count(*) filter (where status = 'suspect')   as suspect_runs
       from public.crawl_runs
       where watchlist_id = w.id
     ) r on true
     order by w.is_active desc, w.label asc`,
  )

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    query: r.query,
    country: r.country,
    label: r.label,
    isActive: r.is_active,
    lastRunDate: r.last_run_date,
    lastRunStatus: r.last_run_status,
    succeededRuns: r.succeeded_runs,
    failedRuns: r.failed_runs,
    suspectRuns: r.suspect_runs,
  }))
}

export async function createWatchlist(
  db: SqlExecutor,
  input: CreateWatchlistInput,
): Promise<{ id: string; traceId: TraceId }> {
  const traceId = input.traceId ?? newTraceId()

  const [created] = await db.query<{ id: string }>(
    `insert into public.watchlists (workspace_id, kind, query, country, label)
     values (app.current_workspace_id(), $1::watchlist_kind, $2, $3, $4)
     returning id`,
    [input.kind, input.query.trim(), (input.country ?? 'MX').toUpperCase(), input.label.trim()],
  )

  await recordChange(db, {
    traceId,
    clerkUserId: input.clerkUserId,
    type: 'watchlist.created',
    watchlistId: created!.id,
    payload: { kind: input.kind, query: input.query.trim(), label: input.label.trim() },
  })

  return { id: created!.id, traceId }
}

export async function renameWatchlist(
  db: SqlExecutor,
  input: { id: string; label: string; clerkUserId: string; traceId?: TraceId },
): Promise<boolean> {
  const traceId = input.traceId ?? newTraceId()

  const updated = await db.query<{ id: string }>(
    `update public.watchlists set label = $2 where id = $1::uuid returning id`,
    [input.id, input.label.trim()],
  )
  // Zero rows means the row is not ours — RLS filtered it. Report it as "not found" rather
  // than raising, so the caller cannot distinguish a missing id from someone else's id.
  if (updated.length === 0) return false

  await recordChange(db, {
    traceId,
    clerkUserId: input.clerkUserId,
    type: 'watchlist.renamed',
    watchlistId: input.id,
    payload: { label: input.label.trim() },
  })
  return true
}

export async function setWatchlistActive(
  db: SqlExecutor,
  input: { id: string; isActive: boolean; clerkUserId: string; traceId?: TraceId },
): Promise<boolean> {
  const traceId = input.traceId ?? newTraceId()

  const updated = await db.query<{ id: string }>(
    `update public.watchlists set is_active = $2 where id = $1::uuid returning id`,
    [input.id, input.isActive],
  )
  if (updated.length === 0) return false

  await recordChange(db, {
    traceId,
    clerkUserId: input.clerkUserId,
    type: input.isActive ? 'watchlist.activated' : 'watchlist.deactivated',
    watchlistId: input.id,
    payload: { is_active: input.isActive },
  })
  return true
}

async function recordChange(
  db: SqlExecutor,
  input: {
    traceId: TraceId
    clerkUserId: string
    type: string
    watchlistId: string
    payload: Record<string, unknown>
  },
): Promise<void> {
  const workspaceId = await currentWorkspaceId(db)
  // Unreachable in practice: the write above would already have been refused by RLS if the
  // caller had no workspace. Asserted rather than defaulted, because an audit row written
  // against the wrong workspace is worse than a failed write.
  if (workspaceId === null) {
    throw new Error('Cannot audit a watchlist change without a resolvable workspace.')
  }

  await appendAuditEvent(db, {
    workspaceId,
    traceId: input.traceId,
    actor: userActor(input.clerkUserId),
    type: input.type,
    subjectType: 'watchlist',
    subjectId: input.watchlistId,
    payload: input.payload,
  })
}
