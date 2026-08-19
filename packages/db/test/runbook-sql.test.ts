import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type TestDb } from '../src/testing.ts'

/**
 * The runbook's SQL, validated against the real schema.
 *
 * `RUNBOOK.md` is read by one person, once, while something is broken. Every query in it is
 * therefore run at the worst possible moment to discover that a column was renamed three
 * migrations ago — and nothing else in the suite names these columns, because they are
 * diagnostic reads that no product code performs.
 *
 * Same mechanism as {@link ../test/worker-sql.test.ts}: `PREPARE` parses and plans a
 * statement without executing it, so every table, column, function and cast is checked
 * against the schema the migrations actually produce. No fixtures, no cleanup.
 *
 * This is not decoration. The first run of this file failed on the `stalled` response in §3,
 * which had told the operator to select `jobs.locked_by` — a column the table has never had,
 * in the query for the alarm state that is *already* an outage.
 *
 * WHAT THIS DOES NOT COVER, and the reason it is worth saying out loud: `PREPARE` checks that
 * a statement is well-formed against the schema, not that the prose around it is true. The
 * "Re-run an analysis by hand" section once told the operator to force a re-analysis with
 * `select app.enqueue_daily_analysis('<date>')`, which by construction returns 0 for a date
 * that already has an `analysis_runs` row. That SQL prepares, executes, and is wrong — this
 * file would have passed it (commit 8e7c87c fixed it by hand). Schema drift is caught here;
 * semantic drift is still caught only by a human re-reading the section.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const RUNBOOK = path.resolve(here, '../../../RUNBOOK.md')

/**
 * Values for the `<…>` placeholders the runbook asks the operator to fill in.
 *
 * They must be *type-valid*, not merely present: `'<id>'` compared against a `uuid` column is
 * rejected during parse analysis, which is the same failure Postgres reports for a column
 * that does not exist. Substituting a real UUID keeps the type checking that makes this file
 * worth running, rather than reaching for `null` — which coerces to anything and would quietly
 * stop checking the one thing each placeholder is positioned to check.
 *
 * Unregistered placeholders fail the test below rather than being passed through, because a
 * literal `<workspace-id>` reaching Postgres surfaces as `invalid input syntax for type uuid`
 * — a message that reads like schema drift and sends the reader to the migrations.
 */
const PLACEHOLDERS: Record<string, string> = {
  '<id>': '00000000-0000-0000-0000-000000000001',
  '<workspace-uuid>': '00000000-0000-0000-0000-000000000002',
  '<your-name>': 'operator',
}

interface SqlBlock {
  /** Nearest preceding Markdown heading — the section an operator would be reading. */
  section: string
  /** 1-based position within that section, so two blocks under one heading stay distinct. */
  ordinal: number
  sql: string
}

/**
 * Fenced ```sql blocks, including those indented inside numbered lists.
 *
 * The indentation is not a detail: three of the thirteen blocks live under the numbered steps
 * in §3, and a first version of this matcher anchored on `^```` silently collected ten instead
 * of thirteen. A suite that tests less than it claims and reports success is the failure mode
 * this whole file exists to prevent, which is why the inventory below is asserted explicitly
 * rather than trusted.
 */
function parseBlocks(markdown: string): SqlBlock[] {
  const fence = /^([ \t]*)```(\w+)[^\n]*\n([\s\S]*?)^\1```/gm
  const blocks: SqlBlock[] = []
  let section = '(preamble)'
  let ordinal = 0
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = fence.exec(markdown))) {
    const [, indent = '', lang = '', body = ''] = match

    // Headings between the previous fence and this one. Scanned rather than pre-indexed so a
    // heading inside a fence (a `#` comment in a bash block) cannot be mistaken for a section.
    for (const line of markdown.slice(cursor, match.index).split('\n')) {
      const heading = /^#{1,6}\s+(.*)$/.exec(line)
      if (heading) {
        section = heading[1]!.trim()
        ordinal = 0
      }
    }
    cursor = fence.lastIndex

    if (lang !== 'sql') continue

    ordinal += 1
    const dedented = body
      .split('\n')
      .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
      .join('\n')
    blocks.push({ section, ordinal, sql: dedented.trim() })
  }

  return blocks
}

/**
 * Split a block into statements on top-level semicolons.
 *
 * Quote-aware because a `;` inside a string literal is not a terminator, and `''` is how a
 * quote is escaped inside one. Dollar-quoting is not handled: the runbook contains no
 * function bodies, and a splitter that silently mis-parses one is worse than a block that has
 * to be written as two — so the assertion on the inventory would catch the change first.
 */
function splitStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let inString = false

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i]!

    if (inString) {
      current += char
      if (char !== "'") continue
      if (sql[i + 1] === "'") {
        // Doubled quote: an escaped `'`, not the end of the string.
        current += sql[i + 1]
        i += 1
      } else {
        inString = false
      }
      continue
    }
    if (char === "'") {
      inString = true
      current += char
      continue
    }
    // Line comments can contain anything, semicolons included.
    if (char === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i)
      i = end === -1 ? sql.length : end
      continue
    }
    if (char === ';') {
      statements.push(current)
      current = ''
      continue
    }
    current += char
  }
  statements.push(current)

  return statements.map((s) => s.trim()).filter(Boolean)
}

function label(block: SqlBlock): string {
  return `${block.section} #${block.ordinal}`
}

/**
 * `pg_cron` is a Supabase-managed extension that does not exist in PGlite — which is why
 * migrations 0003 and 0009 guard their `cron.schedule` calls behind `pg_available_extensions`
 * rather than calling it unconditionally. Queries against the `cron` schema therefore cannot
 * be planned here at all, and are listed by name below so that a *new* unverifiable block has
 * to be added deliberately instead of joining a silent skip list.
 */
function needsPgCron(block: SqlBlock): boolean {
  return /\bcron\./i.test(block.sql)
}

const blocks = parseBlocks(readFileSync(RUNBOOK, 'utf8'))
const verifiable = blocks.filter((b) => !needsPgCron(b))

describe('runbook SQL', () => {
  let db: TestDb

  beforeAll(async () => {
    db = await createTestDb()
  })

  afterAll(async () => {
    await db.close()
  })

  it('finds every SQL block in the runbook', () => {
    // Guards the matcher above. If a fence style changes or a heading moves, the parser
    // returns fewer blocks and every `it.each` below quietly vanishes rather than failing.
    // Adding a query to the runbook is expected to fail this assertion once — that is the
    // prompt to confirm the new block is one this file can actually check.
    expect(blocks.map(label)).toEqual([
      'The daily clock #1',
      '`never-started` — no crawl was attempted #1',
      '`never-started` — no crawl was attempted #2',
      '`never-started` — no crawl was attempted #3',
      '`stalled` — running for over an hour #1',
      '`suspect` — results fell off a cliff #1',
      'Migrations #1',
      'When a migration fails #1',
      '5. Common operations #1',
      '5. Common operations #2',
      '5. Common operations #3',
      '5. Common operations #4',
      '5. Common operations #5',
      '5. Common operations #6',
      '5. Common operations #7',
      '5. Common operations #8',
      '5. Common operations #9',
    ])
  })

  it('skips only the blocks that need pg_cron', () => {
    expect(blocks.filter(needsPgCron).map(label)).toEqual([
      'The daily clock #1',
      '`never-started` — no crawl was attempted #2',
    ])
  })

  it('has a sample value for every placeholder an operator fills in', () => {
    // Runs over the raw blocks, before substitution, so an unregistered placeholder is
    // reported as itself rather than as whatever type error it happens to provoke.
    const unregistered = verifiable.flatMap((block) =>
      (block.sql.match(/<[^>\s]+>/g) ?? []).filter((token) => !(token in PLACEHOLDERS)),
    )
    expect(unregistered).toEqual([])
  })

  it.each(verifiable.map((block, id) => ({ ...block, id })))(
    'prepares $section #$ordinal against the migrated schema',
    async (block) => {
      const filled = Object.entries(PLACEHOLDERS).reduce(
        (sql, [token, value]) => sql.replaceAll(token, value),
        block.sql,
      )
      const statements = splitStatements(filled)
      expect(statements.length).toBeGreaterThan(0)

      for (const [index, statement] of statements.entries()) {
        // Name is positional and quoted: section headings are prose, not identifiers.
        const name = `rbsql_${block.id}_${index}`
        await db.exec(`prepare "${name}" as ${statement}`)

        const [prepared] = await db.query<{ name: string }>(
          'select name from pg_prepared_statements where name = $1',
          [name],
        )
        expect(prepared?.name, statement).toBe(name)
      }
    },
  )
})
