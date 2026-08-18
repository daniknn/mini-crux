import { newMessageId } from '@mini-crux/core'
import type { TestDb } from '@mini-crux/db/testing'

/**
 * Harness for driving a sequence of crawl days against a real Postgres.
 *
 * UC-1's interesting behaviour lives in the *sequence* — a creative present on day 1 and
 * gone on day 3 — so the helpers here are shaped around scripting days rather than around
 * single calls.
 */

import { runCrawl } from './crawl.ts'
import type { CrawlAlert, CrawlDeps } from './crawl.ts'
import { runParse } from './parse.ts'
import type { ParseSummary } from './parse.ts'

export interface SeededWatchlist {
  workspaceId: string
  watchlistId: string
}

export async function seedWatchlist(
  db: TestDb,
  input: { workspaceId: string; query?: string; label?: string },
): Promise<SeededWatchlist> {
  await db.exec('reset role')
  const rows = await db.query<{ id: string }>(
    `insert into public.watchlists (workspace_id, kind, query, country, label)
     values ($1, 'keyword', $2, 'MX', $3)
     returning id`,
    [input.workspaceId, input.query ?? 'stori', input.label ?? 'Fintech MX'],
  )
  return { workspaceId: input.workspaceId, watchlistId: rows[0]!.id }
}

/** Fire the daily tick for an explicit date, as pg_cron would. */
export async function tick(db: TestDb, runDate: string): Promise<number> {
  await db.exec('reset role')
  const rows = await db.query<{ n: number }>(
    'select app.enqueue_daily_crawls($1::date) as n',
    [runDate],
  )
  return Number(rows[0]!.n)
}

export interface DayOutcome {
  crawlRunId: string
  crawl: Awaited<ReturnType<typeof runCrawl>>
  parse?: ParseSummary
}

/**
 * Run one full day: tick → crawl → parse.
 *
 * Parse is only attempted when the crawl landed, mirroring production — a failed crawl
 * enqueues no parse job, which is precisely why a failed day writes no observations.
 */
export async function runDay(
  deps: CrawlDeps & { db: TestDb },
  input: { watchlistId: string; runDate: string },
): Promise<DayOutcome> {
  await tick(deps.db, input.runDate)

  const rows = await deps.db.query<{ id: string }>(
    'select id from public.crawl_runs where watchlist_id = $1 and run_date = $2::date',
    [input.watchlistId, input.runDate],
  )
  const crawlRunId = rows[0]!.id

  const crawl = await runCrawl(deps, { crawlRunId })
  if (crawl.status !== 'landed') return { crawlRunId, crawl }

  const parse = await runParse(
    { db: deps.db, store: deps.store, ...(deps.now === undefined ? {} : { now: deps.now }) },
    { crawlRunId, messageId: newMessageId() },
  )

  return {
    crawlRunId,
    crawl,
    ...(parse.applied ? { parse } : {}),
  }
}

/** Collect P0 alerts so a test can assert the failure path actually escalated. */
export function collectAlerts(): { alerts: CrawlAlert[]; onAlert: (a: CrawlAlert) => void } {
  const alerts: CrawlAlert[] = []
  return { alerts, onAlert: (alert) => void alerts.push(alert) }
}

/** No real waiting: the retry path is exercised for behaviour, not for wall-clock timing. */
export const instantSleep = async (): Promise<void> => {}
