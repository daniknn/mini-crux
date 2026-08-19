import type { SqlExecutor } from './types.ts'

/**
 * Run tenant-scoped work as the `authenticated` role, with the caller's Clerk claims
 * visible to RLS — the same way a request arrives from the web app.
 *
 * WHY THIS EXISTS AND NOT A SUPABASE/POSTGREST CLIENT
 *
 * Everything the dashboard reads is guarded by RLS policies that resolve
 * `app.current_workspace_id()`, which reads `request.jwt.claims`. Those policies are only
 * as trustworthy as the tests that exercise them, and a test can only exercise them by
 * entering the database the same way production does. Going through PostgREST would mean
 * the tenancy suite proves something about `set role` in PGlite while production's
 * isolation rests on a wholly different mechanism that no test in this repo touches.
 * So: one helper, used by `packages/db/test` and by `apps/web` alike.
 *
 * WHY EVERYTHING IS TRANSACTION-LOCAL
 *
 * `set role authenticated` and a session-scoped `set_config(..., false)` both outlive the
 * statement, the request, and — critically — the connection's return to the pool. Under
 * Supabase's transaction pooler the next checkout of that connection is a *different
 * tenant*, which would inherit the previous one's role and claims and read their panel.
 * `set local` and `set_config(..., true)` are unwound by COMMIT and by ROLLBACK, so the
 * connection is handed back clean on both paths. `resets the connection …` in
 * `tenant.test.ts` is what holds this in place: it asserts the role and the claim are gone
 * *after* the helper returns, which is the only assertion a session-scoped implementation
 * cannot satisfy.
 *
 * The executor MUST be a single connection, never a pool — `begin` and `commit` issued
 * against a pool can land on different backends. Callers hold a client for the duration.
 */

export interface TenantClaims {
  /** Clerk user id — matches `app_users.clerk_user_id`. */
  sub: string
  /** Clerk organization id — matches `workspaces.clerk_org_id`. */
  org_id: string
  [claim: string]: unknown
}

export class MissingTenantClaimsError extends Error {
  constructor(claim: string) {
    super(
      `Cannot open a tenant transaction without a ${claim} claim. ` +
        `The active organization comes from the Clerk session (UC-0 middleware); ` +
        `a request without one is unauthenticated, not empty.`,
    )
    this.name = 'MissingTenantClaimsError'
  }
}

function assertClaims(claims: TenantClaims): void {
  // Fail loudly rather than leaning on the policies to save us. Without `org_id`,
  // `app.current_workspace_id()` returns null, every policy compares against null, and the
  // caller gets zero rows — which renders as "this workspace has no data yet" rather than
  // "you are not signed in". Same page, opposite meaning.
  if (claims.sub === undefined || claims.sub === '') throw new MissingTenantClaimsError('sub')
  if (claims.org_id === undefined || claims.org_id === '') {
    throw new MissingTenantClaimsError('org_id')
  }
}

/**
 * The caller's workspace id, as RLS resolves it. Null when the active organization has no
 * workspace provisioned here.
 *
 * Callers know their Clerk `org_id`, not the workspace uuid, and the two are only related
 * through `public.workspaces` — which is itself behind RLS. Asking the database rather than
 * accepting an id from the request is the whole point: there is no code path where a
 * workspace id arrives from outside and is trusted.
 */
export async function currentWorkspaceId(db: SqlExecutor): Promise<string | null> {
  const [row] = await db.query<{ workspace_id: string | null }>(
    'select app.current_workspace_id() as workspace_id',
  )
  return row?.workspace_id ?? null
}

export async function withTenant<T>(
  connection: SqlExecutor,
  claims: TenantClaims,
  fn: (db: SqlExecutor) => Promise<T>,
): Promise<T> {
  assertClaims(claims)

  await connection.exec('begin')
  try {
    // Claims before role: this runs while still privileged, so a failure here leaves the
    // transaction un-escalated rather than authenticated-with-no-claims.
    await connection.query('select set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify(claims),
    ])
    await connection.exec('set local role authenticated')

    const result = await fn(connection)

    await connection.exec('commit')
    return result
  } catch (error) {
    // A rollback failure means the connection is already unusable; surface the original
    // cause rather than replacing it with the symptom.
    await connection.exec('rollback').catch(() => undefined)
    throw error
  }
}
