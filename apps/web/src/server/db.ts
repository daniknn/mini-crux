import 'server-only'

import { auth } from '@clerk/nextjs/server'
import { fromPgClient, withTenant, type SqlExecutor, type TenantClaims } from '@mini-crux/db'
import { Pool, type PoolClient } from 'pg'

import { serverEnv } from '../env.ts'

/**
 * The dashboard's only door to Postgres.
 *
 * WHY A DEDICATED CONNECTION, NOT THE POOL
 *
 * `withTenant` works by setting the role and the JWT claims with `set local` inside an
 * explicit transaction. `set local` is scoped to the connection that ran it, so handing
 * `withTenant` a pool — whose `query` may land on a different backend each call — would
 * begin the transaction on one connection, set the claims on a second, and run the query on
 * a third with no claims at all. RLS would then return zero rows, which reads like an empty
 * workspace rather than like a bug. So every request checks out one client and holds it for
 * the whole callback.
 *
 * WHY THE CLIENT IS DESTROYED ON ERROR
 *
 * `withTenant` rolls back on the way out, but if the rollback itself fails — a dropped
 * socket, a statement timeout mid-transaction — the connection returns to the pool still
 * inside a transaction, still wearing the previous tenant's role and claims. The next
 * request to draw it would run as that tenant. `release(true)` destroys the connection
 * instead, and the pool opens a fresh one. A lost connection is cheap; a leaked workspace
 * is the whole product.
 *
 * WHY THE TENANT IS NEVER AN ARGUMENT
 *
 * Claims come from `auth()` — the Clerk session — and nothing here accepts a workspace or
 * an org id from the caller. A route handler cannot pass one in even by accident, so no
 * page or action can be the place the check was forgotten.
 */

/** Raised when a signed-in user has no active Clerk Organization. */
export class NoActiveWorkspaceError extends Error {
  constructor() {
    super('The session has no active organization, so there is no workspace to read.')
    this.name = 'NoActiveWorkspaceError'
  }
}

/**
 * One pool per process, cached on `globalThis` so Next's dev-mode module reloading does not
 * leak a pool per edit until Postgres refuses new connections.
 */
const POOL_KEY = Symbol.for('@mini-crux/web.pgPool')

interface PoolCarrier {
  [POOL_KEY]?: Pool
}

function pool(): Pool {
  const carrier = globalThis as PoolCarrier
  if (carrier[POOL_KEY] === undefined) {
    carrier[POOL_KEY] = new Pool({
      connectionString: serverEnv().databaseUrl,
      // Vercel runs many small instances; a large per-instance pool exhausts Postgres long
      // before any one instance needs the connections.
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // A request that hangs holds a connection and its tenant claims open. Bound both.
      statement_timeout: 15_000,
      idle_in_transaction_session_timeout: 15_000,
    })
  }
  return carrier[POOL_KEY]
}

/**
 * Run `fn` against the signed-in user's workspace, with RLS in force.
 *
 * Throws {@link NoActiveWorkspaceError} when the session carries no organization — the
 * caller decides whether that is a redirect to the org picker or a 403.
 */
export async function withWorkspace<T>(fn: (db: SqlExecutor) => Promise<T>): Promise<T> {
  const { userId, orgId } = await auth()
  if (userId === null || orgId === null || orgId === undefined) {
    throw new NoActiveWorkspaceError()
  }

  const claims: TenantClaims = { sub: userId, org_id: orgId }
  const client: PoolClient = await pool().connect()
  let poisoned = false
  try {
    return await withTenant(fromPgClient(client), claims, fn)
  } catch (error) {
    poisoned = true
    throw error
  } finally {
    client.release(poisoned)
  }
}

/** The Clerk user id of the caller, for stamping audit events on writes. */
export async function currentClerkUserId(): Promise<string> {
  const { userId } = await auth()
  if (userId === null) throw new NoActiveWorkspaceError()
  return userId
}
