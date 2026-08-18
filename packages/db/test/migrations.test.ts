import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MIGRATIONS_DIR } from '../src/index.ts'
import { checksum, loadMigrations, runMigrations } from '../src/migrate.ts'
import { createTestDb, type TestDb } from '../src/testing.ts'

describe('migration runner', () => {
  let db: TestDb

  beforeEach(async () => {
    // migrate:false — these tests drive the runner themselves.
    db = await createTestDb({ migrate: false })
  })

  afterEach(async () => {
    await db.close()
  })

  it('applies the repo migrations to a fresh database', async () => {
    const result = await runMigrations(db, { dir: MIGRATIONS_DIR })

    expect(result.applied).toContain('0001')
    expect(result.skipped).toEqual([])

    const tables = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
    )
    // An exact list, not a subset: adding a table must be a deliberate edit here. That is
    // the point — a new business table is also a new tenancy surface, and this assertion
    // forces someone to look at it alongside `rls.test.ts`.
    expect(tables.map((t) => t.table_name)).toEqual([
      'advertisers',
      'app_users',
      'audit_events',
      'crawl_runs',
      'creative_features',
      'creative_observations',
      'creatives',
      'jobs',
      'processed_messages',
      'schema_migrations',
      'watchlists',
      'workspace_members',
      'workspaces',
    ])

    // Views are listed separately because their tenancy rule is a different one. A table is
    // safe once it has RLS and a policy; a view has neither of its own and is safe only if
    // it runs as the caller. Filtering `table_type` above rather than folding views into the
    // list keeps a new view from looking like a new table and inheriting the wrong review.
    const views = await db.query<{ table_name: string; is_invoker: boolean }>(
      `select c.relname as table_name,
              coalesce(
                (select option_value = 'true'
                 from pg_options_to_table(c.reloptions)
                 where option_name = 'security_invoker'),
                false
              ) as is_invoker
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'v'
       order by c.relname`,
    )
    expect(views.map((v) => v.table_name)).toEqual(['creative_survival'])
    // Read out of the live catalog, not out of the migration text. `check-rls-policies.mjs`
    // greps the SQL; this proves Postgres actually accepted the option, which is what
    // decides whether the view leaks every workspace's panel to any caller.
    expect(views.every((v) => v.is_invoker)).toBe(true)
  })

  it('is a no-op on the second run (safe to call on every boot)', async () => {
    const first = await runMigrations(db, { dir: MIGRATIONS_DIR })
    const before = await db.query<{ version: string; applied_at: string }>(
      'select version, applied_at from public.schema_migrations order by version',
    )

    const second = await runMigrations(db, { dir: MIGRATIONS_DIR })

    expect(second.applied).toEqual([])
    expect(second.skipped).toEqual(first.applied)

    const after = await db.query<{ version: string; applied_at: string }>(
      'select version, applied_at from public.schema_migrations order by version',
    )
    // Same rows, same timestamps — nothing was re-applied.
    expect(after).toEqual(before)
  })

  it('records a checksum matching the file on disk', async () => {
    await runMigrations(db, { dir: MIGRATIONS_DIR })

    const files = await loadMigrations(MIGRATIONS_DIR)
    const rows = await db.query<{ version: string; checksum: string }>(
      'select version, checksum from public.schema_migrations',
    )
    const recorded = new Map(rows.map((row) => [row.version, row.checksum]))

    for (const file of files) {
      expect(recorded.get(file.version)).toBe(checksum(file.sql))
    }
  })
})

describe('migration drift detection', () => {
  let db: TestDb
  let dir: string

  beforeEach(async () => {
    db = await createTestDb({ migrate: false })
    dir = await mkdtemp(join(tmpdir(), 'mini-crux-migrations-'))
  })

  afterEach(async () => {
    await db.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('refuses to continue when an applied migration was edited', async () => {
    const file = join(dir, '0001_probe.sql')
    await writeFile(file, 'create table public.probe (id int primary key);')
    await runMigrations(db, { dir })

    // Edit in place — exactly the mistake the checksum guard exists to catch.
    await writeFile(file, 'create table public.probe (id int primary key, extra text);')

    await expect(runMigrations(db, { dir })).rejects.toThrow(/immutable/i)
  })

  it('rolls the whole migration back when its SQL fails', async () => {
    await writeFile(
      join(dir, '0001_broken.sql'),
      `create table public.kept (id int primary key);
       create table public.kept (id int primary key);`, // duplicate → error
    )

    await expect(runMigrations(db, { dir })).rejects.toThrow(/rolled back/i)

    const kept = await db.query<{ count: string }>(
      `select count(*)::text as count from information_schema.tables
       where table_schema = 'public' and table_name = 'kept'`,
    )
    expect(kept[0]!.count).toBe('0')

    // No tracking row either — the DDL and its bookkeeping share one transaction.
    const applied = await db.query('select version from public.schema_migrations')
    expect(applied).toEqual([])
  })

  it('rejects a migration file that ignores the naming convention', async () => {
    await writeFile(join(dir, 'add-some-table.sql'), 'select 1;')

    await expect(loadMigrations(dir)).rejects.toThrow(/NNNN_snake_case\.sql/)
  })

  it('rejects two migrations claiming the same version', async () => {
    await writeFile(join(dir, '0001_first.sql'), 'select 1;')
    await writeFile(join(dir, '0001_second.sql'), 'select 1;')

    await expect(loadMigrations(dir)).rejects.toThrow(/Duplicate migration version 0001/)
  })
})
