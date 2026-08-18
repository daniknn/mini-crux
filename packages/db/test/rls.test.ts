import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { asAuthenticated, createTestDb, seedWorkspace, type TestDb } from '../src/testing.ts'

/**
 * Tenancy proof.
 *
 * Every assertion here runs inside {@link asAuthenticated}. PGlite's default connection is a
 * superuser, and superusers bypass RLS unconditionally — a test that queries directly would
 * pass while proving nothing. If one of these ever starts passing outside the helper, the
 * test is broken, not the policy.
 */

const ORG_A = 'org_aaaaaaaaaaaaaaaaaaaaaa'
const ORG_B = 'org_bbbbbbbbbbbbbbbbbbbbbb'
const USER_A = 'user_aaaaaaaaaaaaaaaaaaaaaa'
const USER_B = 'user_bbbbbbbbbbbbbbbbbbbbbb'

describe('row-level security', () => {
  let db: TestDb
  let workspaceA: string
  let workspaceB: string

  beforeAll(async () => {
    db = await createTestDb()

    const a = await seedWorkspace(db, {
      slug: 'acme',
      name: 'Acme',
      clerkOrgId: ORG_A,
      clerkUserId: USER_A,
    })
    const b = await seedWorkspace(db, {
      slug: 'globex',
      name: 'Globex',
      clerkOrgId: ORG_B,
      clerkUserId: USER_B,
    })
    workspaceA = a.workspaceId
    workspaceB = b.workspaceId

    // Seeded privileged, on purpose: the point is that A cannot see B's row afterwards.
    for (const [workspaceId, traceId] of [
      [workspaceA, 'trc_00000000000000000000000AAA'],
      [workspaceB, 'trc_00000000000000000000000BBB'],
    ] as const) {
      await db.query(
        `insert into public.audit_events (workspace_id, trace_id, actor, type)
         values ($1, $2, $3, 'test.seeded')`,
        [workspaceId, traceId, JSON.stringify({ type: 'operator', id: 'seed' })],
      )
      await db.query(
        `insert into public.jobs (workspace_id, message_id, type, trace_id, actor)
         values ($1, $2, 'test.job', $3, $4)`,
        [
          workspaceId,
          `msg_seed_${workspaceId}`,
          traceId,
          JSON.stringify({ type: 'operator', id: 'seed' }),
        ],
      )
    }
  })

  afterAll(async () => {
    await db.close()
  })

  describe('catalog invariants', () => {
    it('has RLS enabled on every table in public', async () => {
      const unprotected = await db.query<{ tablename: string }>(
        `select c.relname as tablename
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
         order by 1`,
      )
      expect(unprotected.map((r) => r.tablename)).toEqual([])
    })

    it('has at least one policy on every table in public', async () => {
      const policyless = await db.query<{ tablename: string }>(
        `select c.relname as tablename
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'
           and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
         order by 1`,
      )
      expect(policyless.map((r) => r.tablename)).toEqual([])
    })
  })

  describe('tenant isolation', () => {
    it('shows a member only their own workspace', async () => {
      const rows = await asAuthenticated(db, { sub: USER_A, org_id: ORG_A }, (tx) =>
        tx.query<{ slug: string }>('select slug from public.workspaces'),
      )
      expect(rows.map((r) => r.slug)).toEqual(['acme'])
    })

    it('never returns another tenant audit rows', async () => {
      const asA = await asAuthenticated(db, { sub: USER_A, org_id: ORG_A }, (tx) =>
        tx.query<{ workspace_id: string }>('select workspace_id from public.audit_events'),
      )
      const asB = await asAuthenticated(db, { sub: USER_B, org_id: ORG_B }, (tx) =>
        tx.query<{ workspace_id: string }>('select workspace_id from public.audit_events'),
      )

      expect(asA.map((r) => r.workspace_id)).toEqual([workspaceA])
      expect(asB.map((r) => r.workspace_id)).toEqual([workspaceB])
    })

    it('never returns another tenant jobs', async () => {
      const rows = await asAuthenticated(db, { sub: USER_A, org_id: ORG_A }, (tx) =>
        tx.query<{ workspace_id: string }>('select workspace_id from public.jobs'),
      )
      expect(rows.map((r) => r.workspace_id)).toEqual([workspaceA])
    })

    it('rejects an append aimed at another tenant', async () => {
      await expect(
        asAuthenticated(db, { sub: USER_A, org_id: ORG_A }, (tx) =>
          tx.query(
            `insert into public.audit_events (workspace_id, trace_id, actor, type)
             values ($1, 'trc_smuggled', $2, 'test.smuggled')`,
            [workspaceB, JSON.stringify({ type: 'user', id: USER_A })],
          ),
        ),
      ).rejects.toThrow(/row-level security/i)
    })

    it('allows an append into the caller own workspace', async () => {
      const rows = await asAuthenticated(db, { sub: USER_A, org_id: ORG_A }, (tx) =>
        tx.query<{ id: string }>(
          `insert into public.audit_events (workspace_id, trace_id, actor, type)
           values ($1, 'trc_own', $2, 'test.own') returning id`,
          [workspaceA, JSON.stringify({ type: 'user', id: USER_A })],
        ),
      )
      expect(rows).toHaveLength(1)
    })

    it('sees nothing at all without an org claim', async () => {
      const rows = await asAuthenticated(db, { sub: USER_A }, (tx) =>
        tx.query('select id from public.audit_events'),
      )
      expect(rows).toEqual([])
    })
  })

  describe('append-only audit', () => {
    /**
     * The two tests immediately below are honestly labelled: they are close to vacuous under
     * PGlite and only mean something against a real Supabase project.
     *
     * 0001 revokes UPDATE and DELETE from every client role, and in production that revoke is
     * the real defence — Supabase's bootstrap grants those privileges by default on a new
     * table, so the revoke is what takes them away. PGlite has no such bootstrap: the
     * privileges were never granted, the revoke is a no-op, and "permission denied" is what
     * happens with or without the revoke line in the migration. Measured, not assumed, while
     * building 0007: deleting the equivalent revokes from that file left the suite green.
     *
     * They are kept because they are the production behaviour. What proves the guarantee is
     * the trigger test after them, which goes the other way — grant the privileges back, as
     * hostile as production's defaults, and show the write fails anyway.
     */
    it('denies update to every client role', async () => {
      await expect(
        asAuthenticated(db, { sub: USER_A, org_id: ORG_A }, (tx) =>
          tx.query(`update public.audit_events set type = 'tampered'`),
        ),
      ).rejects.toThrow(/permission denied/i)
    })

    it('denies delete to every client role', async () => {
      await expect(
        asAuthenticated(db, { sub: USER_A, org_id: ORG_A }, (tx) =>
          tx.query('delete from public.audit_events'),
        ),
      ).rejects.toThrow(/permission denied/i)
    })

    it('refuses an update and a delete even when the privilege has been granted back', async () => {
      // Privileged throughout: this is the writer the audit log actually has. Every event is
      // appended by a background job through the service role, which is exactly the role a
      // revoke stops protecting the moment someone re-grants it. The trigger from 0008 does
      // not consult grants at all, so it holds for that role, for the table owner, and for
      // whoever is in psql at 2am.
      await db.exec('reset role')
      const [seeded] = await db.query<{ id: string }>(
        `insert into public.audit_events (workspace_id, trace_id, actor, type)
         values ($1, 'trc_append_only', $2, 'test.append_only') returning id`,
        [workspaceA, JSON.stringify({ type: 'operator', id: 'seed' })],
      )
      await db.exec('grant update, delete on public.audit_events to authenticated, service_role')

      try {
        await expect(
          db.query(`update public.audit_events set type = 'tampered' where id = $1`, [seeded!.id]),
        ).rejects.toThrow(/append-only/)

        await expect(
          db.query('delete from public.audit_events where id = $1', [seeded!.id]),
        ).rejects.toThrow(/append-only/)

        // The row is still there, still saying what it said.
        const rows = await db.query<{ type: string }>(
          'select type from public.audit_events where id = $1',
          [seeded!.id],
        )
        expect(rows.map((r) => r.type)).toEqual(['test.append_only'])
      } finally {
        // Restore the migration's posture, or the two tests above stop meaning anything for
        // whoever adds a case after this one.
        await db.exec('reset role')
        await db.exec(
          'revoke update, delete on public.audit_events from authenticated, service_role',
        )
      }
    })
  })

  describe('infrastructure tables', () => {
    it('hides schema_migrations from clients', async () => {
      await expect(
        asAuthenticated(db, { sub: USER_A, org_id: ORG_A }, (tx) =>
          tx.query('select version from public.schema_migrations'),
        ),
      ).rejects.toThrow(/permission denied/i)
    })
  })
})
