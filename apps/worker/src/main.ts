#!/usr/bin/env node
/**
 * The worker process.
 *
 *   doppler run -- pnpm --filter @mini-crux/worker serve
 *
 * One process, one loop, no HTTP surface. Liveness is observable from the `jobs` table and
 * from `/api/health/ingestion` on the web app, which reads the same rows — a health endpoint
 * on the worker itself would only prove the worker is up, and a worker that is up but not
 * claiming is the failure mode worth catching.
 */

import { fromPgClient } from '@mini-crux/db'
import { createApifyProvider, createSupabaseStore } from '@mini-crux/ingestion'
import pg from 'pg'

import { loadSettings, MissingConfig } from './config.ts'
import { createHandlers } from './handlers.ts'
import { createJobStore } from './store.ts'
import { createWorker } from './worker.ts'

async function main(): Promise<void> {
  const settings = loadSettings()

  const pool = new pg.Pool({
    connectionString: settings.databaseUrl,
    // Small on purpose. The loop claims one job at a time, so anything above a couple of
    // connections is idle capacity held against a Supabase connection limit shared with
    // every Vercel function.
    max: 4,
  })

  const { createClient } = await import('@supabase/supabase-js')
  const supabase = createClient(settings.supabaseUrl, settings.serviceRoleKey)

  const db = fromPgClient(pool)
  const worker = createWorker({
    store: createJobStore(db),
    handlers: createHandlers({
      db,
      store: createSupabaseStore(supabase.storage.from(settings.rawBucket)),
      provider: createApifyProvider({
        token: settings.apifyToken,
        actorId: settings.apifyActorId,
      }),
    }),
  })

  // SIGTERM is how Fly asks a machine to stop. Aborting the loop lets the job in flight
  // finish and report, rather than leaving a `running` row for the reaper to find five
  // minutes later — which on a deploy would mean every deploy costs one job a retry.
  const controller = new AbortController()
  const stop = (signal: string) => {
    console.log(`[worker] ${signal} received; finishing the current job and stopping`)
    controller.abort()
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))

  console.log(`[worker] polling every ${settings.pollIntervalMs}ms`)
  try {
    await worker.runForever({
      pollIntervalMs: settings.pollIntervalMs,
      signal: controller.signal,
    })
  } finally {
    await pool.end()
  }
  console.log('[worker] stopped')
}

main().catch((error: unknown) => {
  if (error instanceof MissingConfig) {
    console.error(`[worker] ${error.message}`)
    process.exitCode = 2
    return
  }
  console.error('[worker] fatal', error)
  process.exitCode = 1
})
