#!/usr/bin/env node
/**
 * Static tenancy gate (DashOne §3: "CI SHOULD grep migrations for missing policies").
 *
 * Reads every migration and fails if a table created in `public` lacks either
 * `enable row level security` or a `create policy` targeting it. This runs without a
 * database so it can gate a PR in seconds; `packages/db/test/rls.test.ts` proves the same
 * invariant against a live catalog, and proves the policies actually isolate.
 *
 * Both exist on purpose. The grep catches a table added with no policy at all — the common
 * mistake — before anyone waits for a test run.
 */

import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'supabase',
  'migrations',
)

const CREATE_TABLE = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z0-9_]+)/gi
const ENABLE_RLS = /alter\s+table\s+(?:public\.)?([a-z0-9_]+)\s+enable\s+row\s+level\s+security/gi
const CREATE_POLICY = /create\s+policy\s+[a-z0-9_]+\s+on\s+(?:public\.)?([a-z0-9_]+)/gi

/** Strip `--` line comments so a commented-out policy never satisfies the check. */
function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, '')
}

function matchAll(pattern, sql) {
  return new Set(Array.from(sql.matchAll(pattern), (match) => match[1]))
}

const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()

if (files.length === 0) {
  console.error(`No migrations found in ${MIGRATIONS_DIR}`)
  process.exit(1)
}

const tables = new Set()
const rlsEnabled = new Set()
const hasPolicy = new Set()

for (const file of files) {
  const sql = stripComments(await readFile(join(MIGRATIONS_DIR, file), 'utf8'))
  for (const table of matchAll(CREATE_TABLE, sql)) tables.add(table)
  for (const table of matchAll(ENABLE_RLS, sql)) rlsEnabled.add(table)
  for (const table of matchAll(CREATE_POLICY, sql)) hasPolicy.add(table)
}

const failures = []
for (const table of [...tables].sort()) {
  if (!rlsEnabled.has(table)) {
    failures.push(`${table}: no "alter table ... enable row level security"`)
  }
  if (!hasPolicy.has(table)) {
    failures.push(`${table}: no "create policy ... on ${table}"`)
  }
}

if (failures.length > 0) {
  console.error(`RLS check failed across ${files.length} migration(s):\n`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  console.error(
    '\nEvery table is multi-tenant by default. If a table is genuinely not tenant data,' +
      '\nit still needs RLS enabled and a deny-all policy — see schema_migrations in 0001.',
  )
  process.exit(1)
}

console.log(
  `RLS check passed: ${tables.size} table(s) across ${files.length} migration(s), ` +
    'all with RLS enabled and at least one policy.',
)
