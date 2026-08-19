#!/usr/bin/env node
/**
 * Apply migrations. Runs as the worker app's release command, once per deploy.
 *
 *   doppler run -- pnpm --filter @mini-crux/worker migrate
 *
 * DashOne §3 says migrations apply automatically and never by hand. This is where "at
 * startup" is interpreted for this stack: a release command runs once, before the new
 * process serves, and the platform aborts the deploy if it exits non-zero.
 *
 * It deliberately does NOT run inside `main.ts`. The worker can be scaled to two machines
 * on a bad day, and two processes racing the same tracking table is how a half-applied
 * migration happens. It equally does not run on the web app, which is many short-lived
 * Vercel functions — the same race, with more runners.
 */

import { MIGRATIONS_DIR, fromPgClient, runMigrations } from '@mini-crux/db'
import pg from 'pg'

import { loadSettings, MissingConfig } from './config.ts'

async function main(): Promise<void> {
  const settings = loadSettings()

  // A single Client, not a Pool: migrations issue DDL and the advisory lock below has to be
  // held by one session for the whole run. A pool is free to hand the next statement to a
  // different connection, which would release the lock early and defeat the point.
  const client = new pg.Client({ connectionString: settings.databaseUrl })
  await client.connect()
  const db = fromPgClient(client)

  try {
    // Belt and braces against the race the release command already mostly prevents. Fly
    // will not run two release commands for one deploy, but it will happily run one while
    // a previous deploy's is still finishing if a human retries — and DDL half-applied is
    // the one failure in this system with no clean automatic recovery.
    await db.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY])
    const result = await runMigrations(db, {
      dir: MIGRATIONS_DIR,
      logger: (message) => console.log(`[migrate] ${message}`),
    })
    console.log(
      result.applied.length === 0
        ? `[migrate] already up to date (${result.skipped.length} known)`
        : `[migrate] applied ${result.applied.length}: ${result.applied.join(', ')}`,
    )
  } finally {
    await client.end()
  }
}

/**
 * Arbitrary but fixed. Any other session taking the same key blocks; nothing else in this
 * system takes advisory locks, so a collision would have to be deliberate.
 */
const MIGRATION_LOCK_KEY = 4_814_201

main().catch((error: unknown) => {
  if (error instanceof MissingConfig) {
    console.error(`[migrate] ${error.message}`)
    process.exitCode = 2
    return
  }
  console.error('[migrate] failed', error)
  process.exitCode = 1
})
