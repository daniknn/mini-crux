#!/usr/bin/env node
/**
 * Migration entrypoint. Runs on deploy and on worker boot — never by hand (DashOne §3).
 *
 *   pnpm --filter @mini-crux/db migrate
 *   doppler run -- pnpm --filter @mini-crux/db migrate
 *
 * Reads `SUPABASE_DB_URL` and fails fast if it is missing, rather than silently
 * connecting somewhere else. The runner itself is idempotent, so re-running on every boot
 * is the intended usage.
 */

import { Client } from 'pg'

import { fromPgClient, MIGRATIONS_DIR } from './index.ts'
import { runMigrations } from './migrate.ts'

const DATABASE_URL_VAR = 'SUPABASE_DB_URL'

async function main(): Promise<void> {
  const connectionString = process.env[DATABASE_URL_VAR]
  if (connectionString === undefined || connectionString === '') {
    throw new Error(
      `${DATABASE_URL_VAR} is not set. Secrets come from Doppler — try ` +
        `\`doppler run -- pnpm --filter @mini-crux/db migrate\`.`,
    )
  }

  // Migrations create policies and alter every table, so this must be a BYPASSRLS role
  // (Supabase's `postgres` user). The pooled connection string will not do — DDL needs a
  // direct session.
  const client = new Client({ connectionString })
  await client.connect()

  try {
    const result = await runMigrations(fromPgClient(client), {
      dir: MIGRATIONS_DIR,
      logger: (message) => console.log(`[migrate] ${message}`),
    })

    if (result.applied.length === 0) {
      console.log(`[migrate] nothing to do (${result.skipped.length} already applied)`)
    } else {
      console.log(`[migrate] applied: ${result.applied.join(', ')}`)
    }
  } finally {
    await client.end()
  }
}

main().catch((error: unknown) => {
  console.error(`[migrate] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
