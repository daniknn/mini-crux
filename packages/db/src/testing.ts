import { PGlite } from '@electric-sql/pglite'

import { MIGRATIONS_DIR } from './index.ts'
import { runMigrations } from './migrate.ts'
import type { SqlExecutor } from './types.ts'

/**
 * In-process Postgres for tests — PGlite is real Postgres compiled to WASM, so RLS,
 * policies and roles behave as they do in production. No Docker required.
 *
 * IMPORTANT: PGlite connects as a superuser, and superusers bypass RLS unconditionally
 * (even with FORCE ROW LEVEL SECURITY). A tenancy test that forgets {@link asAuthenticated}
 * will pass while proving nothing. Always assert isolation from inside that helper.
 */

export interface TestDb extends SqlExecutor {
  raw: PGlite
  close(): Promise<void>
}

export interface JwtClaims {
  /** Clerk user id — matches `app_users.clerk_user_id`. */
  sub: string
  /** Clerk organization id — matches `workspaces.clerk_org_id`. */
  org_id?: string
  [claim: string]: unknown
}

export async function createTestDb(options?: { migrate?: boolean }): Promise<TestDb> {
  const pg = new PGlite()
  await pg.waitReady

  const db: TestDb = {
    raw: pg,
    async exec(sql: string): Promise<void> {
      await pg.exec(sql)
    },
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      const result = await pg.query(sql, params)
      return result.rows as T[]
    },
    async close(): Promise<void> {
      await pg.close()
    },
  }

  if (options?.migrate !== false) {
    await runMigrations(db, { dir: MIGRATIONS_DIR })
  }

  return db
}

/**
 * Run `fn` as the `authenticated` role with the given JWT claims, exactly as a
 * Supabase client request would arrive. Resets the role afterwards even on failure.
 */
export async function asAuthenticated<T>(
  db: TestDb,
  claims: JwtClaims,
  fn: (db: TestDb) => Promise<T>,
): Promise<T> {
  await db.exec('reset role')
  await db.query('select set_config($1, $2, false)', [
    'request.jwt.claims',
    JSON.stringify(claims),
  ])
  await db.exec('set role authenticated')
  try {
    return await fn(db)
  } finally {
    await db.exec('reset role')
  }
}

/** Seed a workspace plus a member, returning their ids. Runs privileged (RLS bypassed). */
export async function seedWorkspace(
  db: TestDb,
  input: { slug: string; name: string; clerkOrgId: string; clerkUserId: string },
): Promise<{ workspaceId: string; userId: string }> {
  await db.exec('reset role')

  const [workspace] = await db.query<{ id: string }>(
    `insert into public.workspaces (clerk_org_id, slug, name)
     values ($1, $2, $3) returning id`,
    [input.clerkOrgId, input.slug, input.name],
  )
  const [user] = await db.query<{ id: string }>(
    `insert into public.app_users (clerk_user_id, email, full_name)
     values ($1, $2, $3) returning id`,
    [input.clerkUserId, `${input.clerkUserId}@example.test`, input.clerkUserId],
  )
  await db.query(
    `insert into public.workspace_members (workspace_id, user_id, role)
     values ($1, $2, 'owner')`,
    [workspace!.id, user!.id],
  )

  return { workspaceId: workspace!.id, userId: user!.id }
}
