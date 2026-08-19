import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { MissingTenantClaimsError, withTenant } from '../src/tenant.ts'
import { createTestDb, seedWorkspace, type TestDb } from '../src/testing.ts'

/**
 * The door every dashboard query walks through.
 *
 * PGlite is a *single* connection, which makes it an unusually faithful stand-in for one
 * checkout of a pooled Postgres connection: whatever `withTenant` leaves behind here is
 * exactly what the next tenant would inherit in production. So the assertions that matter
 * most in this file are not "tenant A saw its own rows" — a session-scoped implementation
 * passes those too — but the ones that inspect the connection *after* the helper returns.
 */

const ORG_A = 'org_tenantaaaaaaaaaaaaaa'
const ORG_B = 'org_tenantbbbbbbbbbbbbbb'
const USER_A = 'user_tenantaaaaaaaaaaaaa'
const USER_B = 'user_tenantbbbbbbbbbbbbb'

const claimsA = { sub: USER_A, org_id: ORG_A }
const claimsB = { sub: USER_B, org_id: ORG_B }

interface ConnectionState {
  role: string
  claims: string | null
}

describe('withTenant', () => {
  let db: TestDb
  let workspaceA: string
  let workspaceB: string
  /** The role PGlite connects as. Captured rather than hardcoded so the reset assertions
   *  say "back to where it started" instead of "equal to some name we guessed". */
  let baseRole: string

  /** Reads the two pieces of session state the helper is responsible for unwinding. */
  const connectionState = async (): Promise<ConnectionState> => {
    const [row] = await db.query<ConnectionState>(
      `select current_user as role,
              nullif(current_setting('request.jwt.claims', true), '') as claims`,
    )
    return row!
  }

  beforeAll(async () => {
    db = await createTestDb()
    ;[baseRole] = [(await connectionState()).role]
  })

  afterAll(async () => {
    await db.close()
  })

  beforeEach(async () => {
    await db.exec('reset role')
    await db.exec(`truncate public.watchlists, public.workspace_members,
                            public.app_users, public.workspaces cascade`)

    ;({ workspaceId: workspaceA } = await seedWorkspace(db, {
      slug: 'tenant-a',
      name: 'Tenant A',
      clerkOrgId: ORG_A,
      clerkUserId: USER_A,
    }))
    ;({ workspaceId: workspaceB } = await seedWorkspace(db, {
      slug: 'tenant-b',
      name: 'Tenant B',
      clerkOrgId: ORG_B,
      clerkUserId: USER_B,
    }))

    await db.query(
      `insert into public.watchlists (workspace_id, kind, query, label)
       values ($1, 'keyword', 'zapatos', 'Zapatos'), ($2, 'keyword', 'tenis', 'Tenis')`,
      [workspaceA, workspaceB],
    )
  })

  describe('isolation', () => {
    it('returns only the calling workspace rows', async () => {
      const rows = await withTenant(db, claimsA, (t) =>
        t.query<{ workspace_id: string; label: string }>(
          'select workspace_id, label from public.watchlists',
        ),
      )

      expect(rows).toEqual([{ workspace_id: workspaceA, label: 'Zapatos' }])
    })

    it('gives each of two tenants served in sequence only its own rows', async () => {
      // One connection, two requests — the pooled-reuse case, in order.
      const a = await withTenant(db, claimsA, (t) =>
        t.query<{ label: string }>('select label from public.watchlists'),
      )
      const b = await withTenant(db, claimsB, (t) =>
        t.query<{ label: string }>('select label from public.watchlists'),
      )

      expect(a).toEqual([{ label: 'Zapatos' }])
      expect(b).toEqual([{ label: 'Tenis' }])
    })

    it('cannot reach another workspace row by its primary key', async () => {
      const [other] = await db.query<{ id: string }>(
        'select id from public.watchlists where workspace_id = $1',
        [workspaceB],
      )

      const rows = await withTenant(db, claimsA, (t) =>
        t.query('select id from public.watchlists where id = $1', [other!.id]),
      )

      expect(rows).toEqual([])
    })

    it('denies a write that names another workspace', async () => {
      // The forged `workspace_id` is refused by the policy's WITH CHECK, not by app code —
      // which is the point: there is no app code between the browser and this.
      await expect(
        withTenant(db, claimsA, (t) =>
          t.query(
            `insert into public.watchlists (workspace_id, kind, query, label)
             values ($1, 'keyword', 'forjado', 'Forjado')`,
            [workspaceB],
          ),
        ),
      ).rejects.toThrow(/row-level security/i)

      const survivors = await db.query('select id from public.watchlists where query = $1', [
        'forjado',
      ])
      expect(survivors).toEqual([])
    })
  })

  describe('connection hygiene', () => {
    it('resets the role and the claims after a successful transaction', async () => {
      await withTenant(db, claimsA, (t) => t.query('select 1'))

      // A session-scoped `set role` / `set_config(..., false)` leaves both of these set,
      // and every isolation test above still passes. This is the one that catches it.
      expect(await connectionState()).toEqual({ role: baseRole, claims: null })
    })

    it('resets the role and the claims after a failed transaction', async () => {
      await expect(
        withTenant(db, claimsA, (t) => t.query('select * from public.no_such_table')),
      ).rejects.toThrow()

      expect(await connectionState()).toEqual({ role: baseRole, claims: null })
    })

    it('rolls back a write when the callback throws', async () => {
      await expect(
        withTenant(db, claimsA, async (t) => {
          await t.query(
            `insert into public.watchlists (workspace_id, kind, query, label)
             values ($1, 'keyword', 'a-medias', 'A medias')`,
            [workspaceA],
          )
          throw new Error('boom')
        }),
      ).rejects.toThrow('boom')

      const rows = await db.query('select id from public.watchlists where query = $1', ['a-medias'])
      expect(rows).toEqual([])
    })

    it('commits a write that the callback completes', async () => {
      await withTenant(db, claimsA, (t) =>
        t.query(
          `insert into public.watchlists (workspace_id, kind, query, label)
           values ($1, 'keyword', 'completo', 'Completo')`,
          [workspaceA],
        ),
      )

      const rows = await db.query<{ workspace_id: string }>(
        'select workspace_id from public.watchlists where query = $1',
        ['completo'],
      )
      expect(rows).toEqual([{ workspace_id: workspaceA }])
    })
  })

  describe('claims', () => {
    it('refuses to open a transaction with no org_id', async () => {
      await expect(
        withTenant(db, { sub: USER_A, org_id: '' }, (t) => t.query('select 1')),
      ).rejects.toBeInstanceOf(MissingTenantClaimsError)
    })

    it('refuses to open a transaction with no sub', async () => {
      await expect(
        withTenant(db, { sub: '', org_id: ORG_A }, (t) => t.query('select 1')),
      ).rejects.toBeInstanceOf(MissingTenantClaimsError)
    })

    it('leaves the connection untouched when the claims are rejected', async () => {
      await expect(
        withTenant(db, { sub: USER_A, org_id: '' }, (t) => t.query('select 1')),
      ).rejects.toBeInstanceOf(MissingTenantClaimsError)

      // No dangling `begin`: the next statement must not be inside an aborted transaction.
      expect(await connectionState()).toEqual({ role: baseRole, claims: null })
      await expect(db.query('select 1 as ok')).resolves.toEqual([{ ok: 1 }])
    })

    it('returns nothing for an org that has no workspace', async () => {
      // A valid Clerk session whose active org was never provisioned here. Zero rows is the
      // right answer; an error would leak whether the org exists.
      const rows = await withTenant(db, { sub: USER_A, org_id: 'org_neverprovisioned' }, (t) =>
        t.query('select id from public.watchlists'),
      )
      expect(rows).toEqual([])
    })
  })
})
