#!/usr/bin/env node
/**
 * Force a crawl outside the cron schedule.
 *
 *   doppler run -- pnpm crawl:once --watchlist <id>
 *   doppler run -- pnpm crawl:once --watchlist <id> --date 2026-03-01
 *
 * This is an operator tool for recovering a day the scheduler missed, which is the only
 * recovery that exists — the panel cannot be backfilled from Meta after the fact
 * (ARCHITECTURE.md §3). It goes through exactly the same crawl and parse path as the
 * scheduled run, so a manual recovery cannot diverge from a normal day.
 */

import { newMessageId } from '@mini-crux/core'
import { fromPgClient } from '@mini-crux/db'
import { Client } from 'pg'

import { runCrawl } from './crawl.ts'
import { runParse } from './parse.ts'
import { createApifyProvider } from './providers/ad-library/index.ts'
import { createSupabaseStore } from './storage.ts'

interface Args {
  watchlistId: string
  runDate: string | null
}

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set. Secrets come from Doppler — try \`doppler run -- …\`.`)
  }
  return value
}

function parseArgs(argv: string[]): Args {
  let watchlistId: string | null = null
  let runDate: string | null = null

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--watchlist') watchlistId = argv[i + 1] ?? null
    if (argv[i] === '--date') runDate = argv[i + 1] ?? null
  }

  if (watchlistId === null) {
    throw new Error('Usage: crawl:once --watchlist <id> [--date YYYY-MM-DD]')
  }
  if (runDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(runDate)) {
    throw new Error(`--date must be YYYY-MM-DD, got "${runDate}"`)
  }

  return { watchlistId, runDate }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  const client = new Client({ connectionString: required('SUPABASE_DB_URL') })
  await client.connect()
  const db = fromPgClient(client)

  try {
    // Reuse the scheduler's own tick so the crawl_run row, the trace_id and the actor are
    // minted identically. Writing a second creation path here is how manual runs end up
    // subtly different from scheduled ones.
    await db.query('select app.enqueue_daily_crawls($1::date)', [args.runDate])

    const runs = await db.query<{ id: string; run_date: string; status: string }>(
      `select id, run_date::text as run_date, status
       from public.crawl_runs
       where watchlist_id = $1
         and run_date = coalesce($2::date, (now() at time zone 'America/Mexico_City')::date)`,
      [args.watchlistId, args.runDate],
    )
    const run = runs[0]
    if (run === undefined) {
      throw new Error(
        `No crawl_run for watchlist ${args.watchlistId}. Is the watchlist active?`,
      )
    }

    const provider = createApifyProvider({
      token: required('APIFY_TOKEN'),
      actorId: required('APIFY_AD_LIBRARY_ACTOR_ID'),
    })
    const store = createSupabaseStore(await openRawBucket())

    console.log(`[crawl:once] crawling ${run.run_date} (crawl_run ${run.id})`)
    const crawl = await runCrawl({ db, store, provider }, { crawlRunId: run.id })

    if (crawl.status === 'failed') {
      console.error(`[crawl:once] crawl failed: ${crawl.error}`)
      process.exitCode = 1
      return
    }

    console.log(`[crawl:once] landed ${crawl.status === 'landed' ? crawl.resultCount : '?'} ads`)

    const parse = await runParse({ db, store }, { crawlRunId: run.id, messageId: newMessageId() })
    if (!parse.applied) {
      console.log('[crawl:once] already parsed; nothing to do')
      return
    }

    console.log(
      `[crawl:once] ${parse.status}: ${parse.creatives} creatives, ` +
        `${parse.present} present, ${parse.absent} absent` +
        (parse.withheldAbsences > 0
          ? ` (${parse.withheldAbsences} absences withheld — run looks truncated)`
          : ''),
    )
  } finally {
    await client.end()
  }
}

/**
 * Imported lazily so the Supabase JS client is not a hard dependency of the library: the
 * worker and the tests use their own stores, and only this operator entrypoint needs it.
 */
async function openRawBucket(): Promise<Parameters<typeof createSupabaseStore>[0]> {
  const { createClient } = await import('@supabase/supabase-js')
  const supabase = createClient(
    required('SUPABASE_URL'),
    required('SUPABASE_SERVICE_ROLE_KEY'),
  )
  return supabase.storage.from(process.env['SUPABASE_RAW_BUCKET'] ?? 'raw')
}

main().catch((error: unknown) => {
  console.error(`[crawl:once] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
