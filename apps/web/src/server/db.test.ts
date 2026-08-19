import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Connection hygiene for the dashboard's only door to Postgres.
 *
 * These are not tests of RLS — `packages/db/test/tenant.test.ts` proves the policies against
 * a live Postgres. These prove the wiring around them, which is where a correct policy still
 * ends up serving the wrong workspace: a transaction begun on one connection and queried on
 * another, or a connection returned to the pool still wearing the last tenant's claims.
 *
 * `withTenant` is deliberately NOT mocked. The point of the first test is that its whole
 * `begin` / `set local` / `commit` sequence lands on a single backend, and a mock would
 * assert only that we called something.
 */

vi.mock('server-only', () => ({}))

// Clerk types `orgId` as `string | null | undefined`, and the three are not
// interchangeable — see the undefined case below.
const authResult = {
  userId: null as string | null,
  orgId: null as string | null | undefined,
}
vi.mock('@clerk/nextjs/server', () => ({
  auth: () => Promise.resolve(authResult),
}))

vi.mock('../env.ts', () => ({
  serverEnv: () => ({
    clerkSecretKey: 'sk_test',
    supabaseUrl: 'https://example.supabase.co',
    supabaseServiceRoleKey: 'service',
    databaseUrl: 'postgresql://authenticator:pw@localhost:6543/postgres',
  }),
}))

/** One checked-out backend. Records every statement it was asked to run. */
interface FakeClient {
  statements: string[]
  /** Every `(sql, params)` pair, so the claims themselves can be inspected. */
  calls: { sql: string; params: unknown[] | undefined }[]
  released: boolean
  /** What `release()` was called with — truthy means "destroy, do not reuse". */
  destroyed: unknown
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>
  release: (err?: unknown) => void
}

let clients: FakeClient[] = []
/** Set to make the next `commit` fail, simulating a socket dropped mid-transaction. */
let failOn: string | null = null

function makeClient(): FakeClient {
  const client: FakeClient = {
    statements: [],
    calls: [],
    released: false,
    destroyed: undefined,
    query(sql: string, params?: unknown[]) {
      client.statements.push(sql)
      client.calls.push({ sql, params })
      if (failOn !== null && sql.includes(failOn)) {
        return Promise.reject(new Error(`connection lost during ${sql}`))
      }
      return Promise.resolve({ rows: [] })
    },
    release(err?: unknown) {
      client.released = true
      client.destroyed = err
    },
  }
  return client
}

const poolQuery = vi.fn()

vi.mock('pg', () => ({
  Pool: class {
    query = poolQuery
    connect(): Promise<FakeClient> {
      const client = makeClient()
      clients.push(client)
      return Promise.resolve(client)
    }
  },
}))

const { NoActiveWorkspaceError, withWorkspace } = await import('./db.ts')

describe('withWorkspace', () => {
  beforeEach(() => {
    clients = []
    failOn = null
    poolQuery.mockClear()
    authResult.userId = 'user_abc'
    authResult.orgId = 'org_xyz'
  })

  it('runs the whole transaction on one checked-out backend, never on the pool', async () => {
    await withWorkspace(async (db) => {
      await db.query('select 1 as one')
      await db.query('select 2 as two')
    })

    // A pool query here would mean some statement went to an arbitrary backend. `set local`
    // does not follow it, so that statement would run with no claims and RLS would return
    // zero rows — an empty dashboard that looks like an empty workspace.
    expect(poolQuery).not.toHaveBeenCalled()
    expect(clients).toHaveLength(1)
    expect(clients[0]!.statements).toEqual([
      'begin',
      'select set_config($1, $2, true)',
      'set local role authenticated',
      'select 1 as one',
      'select 2 as two',
      'commit',
    ])
  })

  it('takes the tenant from the Clerk session, not from anything a caller passed', async () => {
    authResult.userId = 'user_real'
    authResult.orgId = 'org_real'

    await withWorkspace((db) => db.query('select 1'))

    const setConfig = clients[0]!.calls.find((c) => c.sql.includes('set_config'))
    expect(setConfig?.params?.[0]).toBe('request.jwt.claims')
    expect(JSON.parse(String(setConfig?.params?.[1]))).toEqual({
      sub: 'user_real',
      org_id: 'org_real',
    })

    // `withWorkspace` has exactly one parameter — the callback. There is no argument through
    // which a request body could smuggle an org id, so no route handler can be the place the
    // tenant check was forgotten.
    expect(withWorkspace).toHaveLength(1)
  })

  it('returns the connection to the pool after a clean request', async () => {
    await withWorkspace(async (db) => {
      await db.query('select 1')
    })

    expect(clients[0]!.released).toBe(true)
    expect(clients[0]!.destroyed).toBeFalsy()
  })

  it('destroys the connection when the request fails, rather than recycling it', async () => {
    await expect(
      withWorkspace(async (db) => {
        await db.query('select 1')
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    // Recycling here is the leak: `withTenant` rolls back, but a rollback that itself fails
    // leaves the backend inside a transaction wearing this tenant's role and claims, and the
    // next request to draw it would run as this tenant.
    expect(clients[0]!.destroyed).toBe(true)
  })

  it('destroys the connection when the transaction cannot even be closed', async () => {
    failOn = 'commit'

    await expect(
      withWorkspace(async (db) => {
        await db.query('select 1')
      }),
    ).rejects.toThrow(/connection lost/)

    expect(clients[0]!.destroyed).toBe(true)
  })

  it('gives each request its own backend', async () => {
    await withWorkspace((db) => db.query('select 1'))
    await withWorkspace((db) => db.query('select 2'))

    expect(clients).toHaveLength(2)
    expect(clients[0]).not.toBe(clients[1])
  })

  it('refuses a session with no active organization, before opening a connection', async () => {
    authResult.orgId = null

    await expect(withWorkspace((db) => db.query('select 1'))).rejects.toBeInstanceOf(
      NoActiveWorkspaceError,
    )
    // Not merely "it threw": checking out a connection first would burn a pool slot on every
    // signed-in user who has not picked an org yet.
    expect(clients).toHaveLength(0)
  })

  it('refuses an undefined organization as firmly as a null one', async () => {
    // Clerk returns `undefined`, not `null`, when the session has not resolved an org yet.
    // Letting it through would put `org_id: undefined` into the claims, which
    // `JSON.stringify` drops entirely — so `app.current_workspace_id()` would resolve to
    // null and RLS would deny every row. The user sees an empty panel and reports lost data,
    // when the real answer is "you have not picked an organization".
    authResult.orgId = undefined

    await expect(withWorkspace((db) => db.query('select 1'))).rejects.toBeInstanceOf(
      NoActiveWorkspaceError,
    )
    expect(clients).toHaveLength(0)
  })

  it('refuses a request with no user, even if an organization is present', async () => {
    authResult.userId = null

    await expect(withWorkspace((db) => db.query('select 1'))).rejects.toBeInstanceOf(
      NoActiveWorkspaceError,
    )
    expect(clients).toHaveLength(0)
  })
})
