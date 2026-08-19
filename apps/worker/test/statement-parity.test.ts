import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createTestDb } from '@mini-crux/db/testing'
import type { TestDb } from '@mini-crux/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  CLAIM_JOB_SQL,
  COMPLETE_JOB_SQL,
  FAIL_JOB_PERMANENT_SQL,
  FAIL_JOB_SQL,
  HEARTBEAT_SQL,
} from '../src/store.ts'
import { HEARTBEAT_INTERVAL_MS } from '../src/worker.ts'

/**
 * Two workers, one `jobs` table, two languages.
 *
 * `src/store.ts` says out loud that its five lifecycle statements are copied verbatim from
 * `apps/extractor/src/extractor/statements/*.sql` and that this file fails if they drift.
 * This is that file. Without it the comment is a promise nothing keeps, and the failure it
 * guards against is close to invisible from the outside: a `fail_job` that clears
 * `heartbeat_at` in Python and not in TypeScript produces two rows that look identical in
 * `select *` and are treated differently by the reaper, depending on which runtime happened
 * to claim the job.
 *
 * The comparison strips leading `--` comments, because the SQL files carry the rationale and
 * the TypeScript constants carry it in the module header instead. Everything after the first
 * line of actual SQL must match character for character — including whitespace, since a
 * reformat is exactly the kind of edit that hides a semantic change.
 */

const STATEMENTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'extractor',
  'src',
  'extractor',
  'statements',
)

const WORKER_PY = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'extractor',
  'src',
  'extractor',
  'worker.py',
)

/** Drop the leading comment block; keep the statement exactly as written. */
function sqlBody(text: string): string {
  const lines = text.split('\n')
  let start = 0
  while (lines[start]?.trimStart().startsWith('--') === true) start += 1
  return lines.slice(start).join('\n').trim()
}

function pythonStatement(name: string): string {
  return sqlBody(readFileSync(join(STATEMENTS_DIR, `${name}.sql`), 'utf8'))
}

/** One migrated database for the whole file — nothing here writes, so nothing here isolates. */
let sharedDb: TestDb

beforeAll(async () => {
  sharedDb = await createTestDb()
})

afterAll(async () => {
  await sharedDb.close()
})

const PAIRS: { name: string; ts: string }[] = [
  { name: 'claim_job', ts: CLAIM_JOB_SQL },
  { name: 'heartbeat', ts: HEARTBEAT_SQL },
  { name: 'complete_job', ts: COMPLETE_JOB_SQL },
  { name: 'fail_job', ts: FAIL_JOB_SQL },
  { name: 'fail_job_permanent', ts: FAIL_JOB_PERMANENT_SQL },
]

describe('job lifecycle SQL parity across the two workers', () => {
  it.each(PAIRS)('$name matches the Python worker verbatim', ({ name, ts }) => {
    expect(ts.trim()).toBe(pythonStatement(name))
  })

  it('finds every file it claims to compare', () => {
    // Guards the guard. A renamed statement file would otherwise make `readFileSync` throw
    // inside a single case and leave the impression that four of five still agree, when in
    // fact the fifth is no longer being compared to anything.
    for (const { name } of PAIRS) {
      expect(pythonStatement(name).length).toBeGreaterThan(0)
    }
  })
})

describe('the heartbeat interval against the stall window', () => {
  /**
   * A constant is untested until something pins it. `HEARTBEAT_INTERVAL_MS` is meaningless on
   * its own — it only means "safely inside the window after which the reaper takes the job
   * back", and that window is an interval literal in a migration. Both numbers are read from
   * source here rather than copied, so bumping either one in isolation fails.
   */
  it('matches the Python worker, which shares the same table', () => {
    const source = readFileSync(WORKER_PY, 'utf8')
    const match = /^DEFAULT_HEARTBEAT_INTERVAL_S = ([\d.]+)$/m.exec(source)
    expect(match, 'DEFAULT_HEARTBEAT_INTERVAL_S not found in worker.py').not.toBeNull()
    expect(HEARTBEAT_INTERVAL_MS).toBe(Number(match![1]) * 1000)
  })

  it('leaves room for several missed beats inside the reaper stall window', async () => {
    // Read from the live catalog rather than from the migration text. Postgres canonicalizes
    // `interval '5 minutes'` to `'00:05:00'::interval`, so a regex over the SQL file is both
    // brittle and weaker: it would keep passing if a later migration redefined the reaper
    // with a different default, which is precisely the drift worth catching.
    const rows = await sharedDb.query<{ stall_s: number }>(
      `select extract(epoch from
                (regexp_match(pg_get_function_arguments(p.oid),
                              $$DEFAULT '([^']+)'::interval$$))[1]::interval)::float8 as stall_s
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and p.proname = 'reap_stalled_jobs'`,
    )
    expect(rows).toHaveLength(1)
    const stallMs = Number(rows[0]!.stall_s) * 1000
    expect(stallMs).toBeGreaterThan(0)

    // Not merely "smaller than". One beat under the window means a single GC pause costs a
    // job its claim, and a requeued crawl is a duplicate provider run against a rate limit.
    // Four beats is the margin.
    expect(stallMs / HEARTBEAT_INTERVAL_MS).toBeGreaterThanOrEqual(4)
    // And not so frequent that idle workers become a write load of their own.
    expect(HEARTBEAT_INTERVAL_MS).toBeGreaterThanOrEqual(5_000)
  })
})

describe('the statements against the real schema', () => {
  /**
   * `packages/db/test/worker-sql.test.ts` prepares the Python files. This prepares the
   * TypeScript constants — the same coverage for the other runtime, and the thing that
   * catches a column renamed out from under a string literal.
   */
  it.each(PAIRS)('$name prepares', async ({ name, ts }) => {
    await sharedDb.query(`prepare parity_${name} as ${ts}`)
    const rows = await sharedDb.query<{ name: string }>(
      'select name from pg_prepared_statements where name = $1',
      [`parity_${name}`],
    )
    expect(rows).toHaveLength(1)
  })
})
