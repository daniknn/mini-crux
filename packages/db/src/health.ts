/**
 * Is today's crawl in?
 *
 * Two callers, one answer. `GET /api/health/ingestion` reads this as `service_role` and sees
 * every workspace; the dashboard reads it inside `withTenant` and sees one. Both go through
 * the same view (`public.ingestion_health`, migration 0010) and the same summarizer below, so
 * neither can drift into a different definition of "healthy" than the other.
 *
 * The split between the two functions here is deliberate and is the whole testing strategy:
 *
 *   * {@link getIngestionHealth} touches the database and does no judging.
 *   * {@link summarizeIngestionHealth} judges and touches nothing.
 *
 * Every interesting rule — what counts as an offender, when an in-flight crawl becomes a
 * stall — lives in the pure half, where a test hands it rows and a clock instead of trying to
 * arrange a real 09:00 against a real stalled worker.
 */

import type { SqlExecutor } from './types.ts'

/**
 * `crawl_runs.status` widened by the one value the view invents.
 *
 * `never-started` is not a status any row holds — it is the `coalesce` in migration 0010
 * turning the absence of a row into a value. That is the entire point: an alarm cannot read
 * an empty result set, and "nothing ran and nobody noticed" is the failure this endpoint
 * exists for.
 */
export type IngestionState = 'running' | 'succeeded' | 'suspect' | 'failed' | 'never-started'

/** One active watchlist and what today's crawl did, straight off the view. */
export interface IngestionHealthRow {
  workspaceId: string
  watchlistId: string
  label: string
  query: string
  country: string
  /** The market's calendar day (`app.market_date()`), never the reader's. */
  marketDate: string
  state: IngestionState
  crawlRunId: string | null
  attempt: number | null
  error: string | null
  startedAt: Date | null
  finishedAt: Date | null
}

/**
 * Why a watchlist is being named in a 503.
 *
 * These are separate values because rule 9 of the spec requires it: they have different
 * runbook entries and only one of them is fixed by retrying.
 *
 *   * `failed`        — the crawl ran and lost. Loud, already recorded, retry before midnight
 *                       in the market and the panel date is saved.
 *   * `never-started` — no row exists. Nothing is wrong with the crawler; something upstream
 *                       never asked. pg_cron, the tick, or a watchlist created after it fired.
 *   * `stalled`       — a run has been `running` past the grace window. The worker that
 *                       claimed it is gone, or the provider is hanging. Looks identical to a
 *                       healthy morning until you check the clock.
 *   * `suspect`       — data landed but the count fell off a cliff, so the analysis tick will
 *                       refuse this panel date. Silent by construction: the crawl looks fine
 *                       and the dashboard simply never updates.
 */
export type IngestionOffenceReason = 'failed' | 'never-started' | 'stalled' | 'suspect'

export interface IngestionOffender {
  workspaceId: string
  watchlistId: string
  label: string
  reason: IngestionOffenceReason
  /** `crawl_runs.error`, present only for `failed`. Never contains creative data. */
  error: string | null
  attempt: number | null
  startedAt: Date | null
}

export interface IngestionHealthSummary {
  status: 'ok' | 'degraded'
  /**
   * The market date every row was measured against, or `null` when there are no active
   * watchlists at all. Not derived from the reader's clock — see below.
   */
  marketDate: string | null
  counts: {
    watchlists: number
    succeeded: number
    inFlight: number
    offenders: number
  }
  offenders: IngestionOffender[]
}

export interface SummarizeOptions {
  /**
   * The instant to measure in-flight runs against. Injected rather than read from
   * `Date.now()` for the same reason `app.market_date` takes its instant as a parameter
   * (migration 0009): a rule that reads the clock itself can only ever be observed at
   * whatever o'clock the suite happens to run, and a fixture where two candidate
   * expressions coincide tests neither.
   */
  now?: Date
  /**
   * How long a `running` crawl stays healthy before it is called a stall.
   *
   * There has to be *some* window, and it has to be generous. Without one, the endpoint
   * returns 503 for the twenty minutes every morning while the crawl is legitimately
   * working, an operator learns within a week that the morning red means nothing, and the
   * alarm is muted — which is worse than having no alarm, because now nobody is watching
   * *and* everyone believes someone is.
   *
   * With it, a worker killed mid-crawl still surfaces, just later. An hour is far longer
   * than any real crawl and far shorter than the day it would otherwise cost.
   */
  inFlightGraceMs?: number
}

const ONE_HOUR_MS = 60 * 60 * 1000

/**
 * Read one row per active watchlist for today's market date.
 *
 * No workspace filter and no date parameter, both on purpose. The date comes from
 * `app.market_date()` inside the view so the market's calendar day has exactly one
 * definition; the workspace scoping comes from RLS, which is why the view is
 * `security_invoker` and why passing a BYPASSRLS executor here is what makes this an
 * instance-wide check rather than a bug.
 */
export async function getIngestionHealth(db: SqlExecutor): Promise<IngestionHealthRow[]> {
  return await db.query<IngestionHealthRow>(
    `select workspace_id   as "workspaceId",
            watchlist_id   as "watchlistId",
            label,
            query,
            country,
            market_date::text as "marketDate",
            state,
            crawl_run_id   as "crawlRunId",
            attempt,
            error,
            started_at     as "startedAt",
            finished_at    as "finishedAt"
     from public.ingestion_health
     order by label, watchlist_id`,
  )
}

/**
 * Turn rows into a verdict. Pure — no clock, no database, no I/O.
 *
 * An empty input is `ok`. That is a real decision and not an oversight: an instance with no
 * active watchlists has nothing to crawl, and paging someone because they have not finished
 * onboarding is the fastest way to teach them to ignore the pager. The distinction the
 * endpoint must never lose is between "nothing to do" and "something to do that nobody
 * did" — the first is this branch, the second is `never-started`.
 */
export function summarizeIngestionHealth(
  rows: readonly IngestionHealthRow[],
  options: SummarizeOptions = {},
): IngestionHealthSummary {
  const now = options.now ?? new Date()
  const graceMs = options.inFlightGraceMs ?? ONE_HOUR_MS

  const offenders: IngestionOffender[] = []
  let succeeded = 0
  let inFlight = 0

  for (const row of rows) {
    const reason = classify(row, now, graceMs)
    if (reason === null) {
      succeeded += 1
      continue
    }
    if (reason === 'in-flight') {
      inFlight += 1
      continue
    }
    offenders.push({
      workspaceId: row.workspaceId,
      watchlistId: row.watchlistId,
      label: row.label,
      reason,
      // Only a failure carries an error worth showing. Reading `row.error` unconditionally
      // would leak a stale message from a previous attempt onto a row that is currently
      // fine, and an operator reading a wrong error is worse off than one reading none.
      error: reason === 'failed' ? row.error : null,
      attempt: row.attempt,
      startedAt: row.startedAt,
    })
  }

  return {
    status: offenders.length === 0 ? 'ok' : 'degraded',
    marketDate: rows[0]?.marketDate ?? null,
    counts: {
      watchlists: rows.length,
      succeeded,
      inFlight,
      offenders: offenders.length,
    },
    offenders,
  }
}

/** `null` = healthy, `'in-flight'` = still working, otherwise the offence. */
function classify(
  row: IngestionHealthRow,
  now: Date,
  graceMs: number,
): IngestionOffenceReason | 'in-flight' | null {
  switch (row.state) {
    case 'succeeded':
      return null
    case 'failed':
      return 'failed'
    case 'suspect':
      return 'suspect'
    case 'never-started':
      return 'never-started'
    case 'running': {
      // A run with no `started_at` cannot be aged, and the safe reading of "we do not know
      // when this began" is that it began too long ago. `started_at` is `not null` in the
      // schema, so this is unreachable through the view — it is here because the column
      // being non-null is a fact about migration 0002, not about this function's input.
      if (row.startedAt === null) return 'stalled'
      return now.getTime() - row.startedAt.getTime() > graceMs ? 'stalled' : 'in-flight'
    }
  }
}
