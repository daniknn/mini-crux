import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  AppliedMigration,
  Logger,
  MigrationFile,
  MigrationResult,
  SqlExecutor,
} from './types.ts'

/**
 * Migrations are applied automatically at startup (DashOne §3 — never ask a human to
 * run them). The runner is idempotent: already-applied versions are skipped, so calling
 * it on every boot is the intended usage, not a special case.
 */

const MIGRATION_FILENAME = /^(\d{4})_([a-z0-9_]+)\.sql$/

/** Bootstrap: the tracking table must exist before we can consult it. */
const TRACKING_TABLE_DDL = `
  create table if not exists public.schema_migrations (
    version     text primary key,
    checksum    text not null,
    applied_at  timestamptz not null default now()
  );
`

export function checksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex')
}

export async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const entries = await readdir(dir)
  const files: MigrationFile[] = []

  for (const entry of entries.sort()) {
    const match = MIGRATION_FILENAME.exec(entry)
    if (!match) {
      if (entry.endsWith('.sql')) {
        throw new Error(
          `Migration "${entry}" does not match the required NNNN_snake_case.sql naming.`,
        )
      }
      continue
    }
    const [, version, name] = match
    const sql = await readFile(join(dir, entry), 'utf8')
    files.push({ version: version!, name: name!, sql, checksum: checksum(sql) })
  }

  const seen = new Set<string>()
  for (const file of files) {
    if (seen.has(file.version)) {
      throw new Error(`Duplicate migration version ${file.version} in ${dir}.`)
    }
    seen.add(file.version)
  }

  return files
}

export async function runMigrations(
  db: SqlExecutor,
  options: { dir: string; logger?: Logger },
): Promise<MigrationResult> {
  const log = options.logger ?? (() => {})

  await db.exec(TRACKING_TABLE_DDL)

  const files = await loadMigrations(options.dir)
  const appliedRows = await db.query<AppliedMigration>(
    'select version, checksum, applied_at from public.schema_migrations',
  )
  const applied = new Map(appliedRows.map((row) => [row.version, row.checksum]))

  const result: MigrationResult = { applied: [], skipped: [] }

  for (const file of files) {
    const priorChecksum = applied.get(file.version)

    if (priorChecksum !== undefined) {
      // Drift detection. An edited migration means the database and the repo disagree
      // about what schema is deployed — silently continuing would make every later
      // assumption unreliable, so this is fatal rather than a warning.
      if (priorChecksum !== file.checksum) {
        throw new Error(
          `Migration ${file.version}_${file.name} was already applied with a different ` +
            `checksum (db=${priorChecksum.slice(0, 12)}…, file=${file.checksum.slice(0, 12)}…). ` +
            `Applied migrations are immutable — add a new migration instead of editing this one.`,
        )
      }
      result.skipped.push(file.version)
      continue
    }

    log(`applying ${file.version}_${file.name}`)

    // Each migration is one transaction: it applies completely or not at all, and the
    // tracking row lands in the same transaction as the DDL it records.
    await db.exec('begin')
    try {
      await db.exec(file.sql)
      await db.query(
        'insert into public.schema_migrations (version, checksum) values ($1, $2)',
        [file.version, file.checksum],
      )
      await db.exec('commit')
    } catch (error) {
      await db.exec('rollback')
      throw new Error(
        `Migration ${file.version}_${file.name} failed and was rolled back: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      )
    }

    result.applied.push(file.version)
  }

  log(
    result.applied.length === 0
      ? `schema up to date (${result.skipped.length} migrations)`
      : `applied ${result.applied.length} migration(s)`,
  )

  return result
}
