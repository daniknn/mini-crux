import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type TestDb } from '../src/testing.ts'

/**
 * The Python extractor's SQL, validated against the real schema.
 *
 * The worker is the one component whose database access is not covered by this harness —
 * PGlite is a JavaScript package and cannot be imported from Python, and standing up a
 * Postgres service container to test eight statements would make the fastest CI job the
 * slowest and the only one needing a daemon.
 *
 * That gap has a specific shape: a column renamed in a migration, or mistyped in the
 * worker, is invisible until it runs in production against data that cannot be re-crawled.
 *
 * `PREPARE` closes it. It parses and plans a statement without executing it, so every
 * table, column and parameter cast is checked against the schema the migrations actually
 * produce — no fixtures, no cleanup, and it fails the moment the two drift apart.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const STATEMENTS_DIR = path.resolve(
  here,
  '../../../apps/extractor/src/extractor/statements',
)

function loadStatements(): { name: string; sql: string }[] {
  return readdirSync(STATEMENTS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => ({
      name: path.basename(file, '.sql'),
      sql: readFileSync(path.join(STATEMENTS_DIR, file), 'utf8').trim(),
    }))
}

describe('extractor worker SQL', () => {
  let db: TestDb
  const statements = loadStatements()

  beforeAll(async () => {
    db = await createTestDb()
  })

  afterAll(async () => {
    await db.close()
  })

  it('finds the statements the worker loads', () => {
    // Guards the path above. If the directory moves, the glob silently returns nothing and
    // every `it.each` below would vanish rather than fail — a suite that tests nothing and
    // reports success.
    expect(statements.map((s) => s.name)).toEqual([
      'already_extracted',
      'append_audit',
      'claim_job',
      'complete_job',
      'fail_job',
      'fail_job_permanent',
      'heartbeat',
      'insert_features',
      'load_creative',
      'record_message',
    ])
  })

  it.each(statements)('prepares $name against the migrated schema', async ({ name, sql }) => {
    // Quoted identifier: statement names come from filenames and some are reserved-ish.
    await db.exec(`prepare "wsql_${name}" as ${sql}`)

    const [prepared] = await db.query<{ name: string }>(
      'select name from pg_prepared_statements where name = $1',
      [`wsql_${name}`],
    )
    expect(prepared?.name).toBe(`wsql_${name}`)
  })
})
