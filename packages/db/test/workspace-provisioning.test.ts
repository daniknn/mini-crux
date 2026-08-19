import { isActor, newTraceId } from '@mini-crux/core'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { RestCredentials } from '../src/health.ts'
import { asAuthenticated, createTestDb, type TestDb } from '../src/testing.ts'
import {
  deactivateWorkspace,
  postAuditEvent,
  provisionWorkspace,
  resolveSlug,
  slugify,
} from '../src/workspaces.ts'

/**
 * Workspace provisioning, tested against real Postgres rather than against a mock of it.
 *
 * The interesting behaviour here is *entirely* about constraints: `clerk_org_id` is unique,
 * `slug` is unique, `slug` is `not null`, and everything in the product cascades from
 * `workspaces`. A hand-written fetch mock would have to assert that Postgres raises 23505 on
 * a duplicate org id — which is the mock restating the assumption under test, and would stay
 * green if the unique constraint were dropped from `0001` tomorrow.
 *
 * So the injected `fetchImpl` below is a small PostgREST stand-in that executes against the
 * migrated PGlite database. The 409s are Postgres's, the cascade behaviour is Postgres's, and
 * the `asAuthenticated` read at the bottom goes through the real RLS policy.
 *
 * WHAT THIS DOES NOT COVER, said plainly for the same reason `runbook-sql.test.ts` says it:
 * the translator below is *our* reading of PostgREST's URL grammar, not PostgREST. It covers
 * the five request shapes `workspaces.ts` actually issues and nothing else. A future call
 * that uses a filter operator it does not implement fails loudly here (`unsupported filter`)
 * rather than passing vacuously — that is the property that keeps it honest, and it is
 * asserted in its own test below.
 */

const BASE = 'https://fake.supabase.co'
const SERVICE_KEY = 'service-role-key'

interface RestCall {
  method: string
  table: string
  query: string
}

/** Column names whose Postgres type is `jsonb` — objects must be stringified, not passed raw. */
const JSONB_COLUMNS = new Set(['actor', 'payload'])

function postgrestOver(db: TestDb): { credentials: RestCredentials; calls: RestCall[] } {
  const calls: RestCall[] = []

  const fetchImpl = (async (url: string, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(url)
    const table = parsed.pathname.replace('/rest/v1/', '')
    const method = init?.method ?? 'GET'
    calls.push({ method, table, query: parsed.search.replace(/^\?/, '') })

    const filters: string[] = []
    const params: unknown[] = []
    let select = '*'

    for (const [key, value] of parsed.searchParams) {
      if (key === 'select') {
        select = value
        continue
      }
      const match = /^eq\.(.*)$/.exec(value)
      if (match === null) {
        // Deliberately not a silent pass-through. See the header note.
        return json({ message: `unsupported filter: ${key}=${value}` }, 400)
      }
      params.push(match[1])
      filters.push(`${key} = $${params.length}`)
    }

    const where = filters.length === 0 ? '' : ` where ${filters.join(' and ')}`
    const prefer = (init?.headers as Record<string, string> | undefined)?.['prefer'] ?? ''
    const returning = prefer.includes('return=representation') ? ' returning *' : ''
    const body =
      init?.body === undefined ? {} : (JSON.parse(init.body as string) as Record<string, unknown>)

    try {
      if (method === 'GET') {
        const rows = await db.query(`select ${select} from public.${table}${where}`, params)
        return json(rows, 200)
      }

      if (method === 'POST') {
        const columns = Object.keys(body)
        const values = columns.map((c) => shape(c, body[c]))
        const placeholders = columns.map((_, i) => `$${i + 1}`)
        const rows = await db.query(
          `insert into public.${table} (${columns.join(', ')})
           values (${placeholders.join(', ')})${returning}`,
          values,
        )
        // PostgREST answers `return=minimal` with 201 and an empty body — the case that made
        // `rest()` read the body as text before parsing it.
        return returning === '' ? new Response('', { status: 201 }) : json(rows, 201)
      }

      if (method === 'PATCH') {
        const columns = Object.keys(body)
        const assignments = columns.map((c, i) => `${c} = $${params.length + i + 1}`)
        const rows = await db.query(
          `update public.${table} set ${assignments.join(', ')}${where}${returning}`,
          [...params, ...columns.map((c) => shape(c, body[c]))],
        )
        return json(rows, 200)
      }

      return json({ message: `unsupported method ${method}` }, 405)
    } catch (error) {
      // PGlite surfaces the Postgres error fields, so the status and code the client sees are
      // the ones a real 23505 would carry.
      const pg = error as { code?: string; message?: string }
      const status = pg.code === '23505' ? 409 : 400
      return json({ code: pg.code ?? null, message: pg.message ?? 'error' }, status)
    }
  }) as unknown as typeof fetch

  return { credentials: { supabaseUrl: BASE, serviceRoleKey: SERVICE_KEY, fetchImpl }, calls }
}

function shape(column: string, value: unknown): unknown {
  return JSONB_COLUMNS.has(column) ? JSON.stringify(value) : value
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const ORG = 'org_2ab3cd4ef5gh'

describe('workspace provisioning', () => {
  let db: TestDb
  let rest: ReturnType<typeof postgrestOver>

  beforeAll(async () => {
    db = await createTestDb()
  })

  afterAll(async () => {
    await db.close()
  })

  beforeEach(async () => {
    await db.exec('reset role')
    await db.exec(`truncate public.workspaces cascade`)
    rest = postgrestOver(db)
  })

  async function workspaces(): Promise<{ id: string; clerk_org_id: string; name: string; slug: string }[]> {
    return db.query('select id, clerk_org_id, name, slug from public.workspaces order by created_at')
  }

  describe('slugify and resolveSlug', () => {
    it('strips accents rather than dropping the letters under them', () => {
      // `Diseño` → `diseno`, not `disen`. This is a Mexican-market product; a name with an
      // accent is the normal case, and a slug that silently loses a letter is a support ticket.
      expect(slugify('Diseño Creativo MX')).toBe('diseno-creativo-mx')
      expect(slugify('  Águila & Sol  ')).toBe('aguila-sol')
    })

    it('prefers Clerk’s slug, then the name, then the org id', () => {
      expect(resolveSlug({ clerkOrgId: ORG, name: 'Acme MX', slug: 'acme-mx' })).toEqual({
        slug: 'acme-mx',
        source: 'clerk',
      })
      expect(resolveSlug({ clerkOrgId: ORG, name: 'Acme MX', slug: null })).toEqual({
        slug: 'acme-mx',
        source: 'name',
      })
      // A name the slugifier cannot render at all. Falling back to the org id keeps the
      // provisioning alive over a column that only has to be unique.
      expect(resolveSlug({ clerkOrgId: ORG, name: '株式会社', slug: null })).toEqual({
        slug: ORG.toLowerCase(),
        source: 'org-id',
      })
    })
  })

  describe('provisionWorkspace', () => {
    it('creates the row a Clerk organization needs, and reports what it did', async () => {
      const result = await provisionWorkspace(rest.credentials, {
        clerkOrgId: ORG,
        name: 'Acme MX',
        slug: 'acme-mx',
      })

      expect(result.outcome).toBe('created')
      expect(result.slug).toBe('acme-mx')
      expect(result.slugSource).toBe('clerk')

      const rows = await workspaces()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ clerk_org_id: ORG, name: 'Acme MX', slug: 'acme-mx' })
      expect(result.workspaceId).toBe(rows[0]!.id)
    })

    it('is silent on a redelivery — no write, and nothing for the audit log to claim', async () => {
      await provisionWorkspace(rest.credentials, { clerkOrgId: ORG, name: 'Acme MX', slug: 'acme-mx' })
      const writesAfterFirst = rest.calls.filter((c) => c.method !== 'GET').length

      const second = await provisionWorkspace(rest.credentials, {
        clerkOrgId: ORG,
        name: 'Acme MX',
        slug: 'acme-mx',
      })

      expect(second.outcome).toBe('unchanged')
      expect(await workspaces()).toHaveLength(1)
      // The assertion that matters is not "one row" — an upsert would satisfy that too, and
      // would still have appended a second `workspace.provisioned` to an append-only log.
      // It is that the redelivery issued no write at all.
      expect(rest.calls.filter((c) => c.method !== 'GET')).toHaveLength(writesAfterFirst)
    })

    it('patches a renamed organization and says so', async () => {
      await provisionWorkspace(rest.credentials, { clerkOrgId: ORG, name: 'Acme MX', slug: 'acme-mx' })

      const renamed = await provisionWorkspace(rest.credentials, {
        clerkOrgId: ORG,
        name: 'Acme México',
        slug: 'acme-mexico',
      })

      expect(renamed.outcome).toBe('renamed')
      expect(renamed.name).toBe('Acme México')
      expect(renamed.slug).toBe('acme-mexico')
      const rows = await workspaces()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ name: 'Acme México', slug: 'acme-mexico' })
    })

    it('upgrades a fallback slug once Clerk gains a real one', async () => {
      // The stored slug is compared against the *resolved* one, not against the raw payload.
      // Comparing against `input.slug` would leave this workspace called `acme-mx` forever.
      await provisionWorkspace(rest.credentials, { clerkOrgId: ORG, name: 'Acme MX', slug: null })
      expect((await workspaces())[0]!.slug).toBe('acme-mx')

      const result = await provisionWorkspace(rest.credentials, {
        clerkOrgId: ORG,
        name: 'Acme MX',
        slug: 'acme-oficial',
      })

      expect(result.outcome).toBe('renamed')
      expect(result.slugSource).toBe('clerk')
      expect((await workspaces())[0]!.slug).toBe('acme-oficial')
    })

    it('absorbs a concurrent duplicate delivery instead of failing it', async () => {
      // Simulates the race the read-then-write cannot close: the row appears between our
      // select and our insert. Postgres raises 23505 on `clerk_org_id`; answering 500 here
      // would make Clerk retry a delivery that already succeeded, forever.
      await db.query(
        `insert into public.workspaces (clerk_org_id, name, slug) values ($1, $2, $3)`,
        [ORG, 'Acme MX', 'acme-mx'],
      )
      const raced = postgrestOver(db)
      let inserted = false
      const original = raced.credentials.fetchImpl!
      raced.credentials.fetchImpl = (async (url: string, init?: RequestInit) => {
        // Hide the existing row from the initial read only, so the insert is the first place
        // the conflict can surface — which is exactly the shape of the real race.
        if ((init?.method ?? 'GET') === 'GET' && !inserted) {
          inserted = true
          return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return original(url, init as RequestInit)
      }) as unknown as typeof fetch

      const result = await provisionWorkspace(raced.credentials, {
        clerkOrgId: ORG,
        name: 'Acme MX',
        slug: 'acme-mx',
      })

      expect(result.outcome).toBe('unchanged')
      expect(await workspaces()).toHaveLength(1)
    })

    it('disambiguates a slug two different organizations both want', async () => {
      await provisionWorkspace(rest.credentials, {
        clerkOrgId: 'org_first',
        name: 'Acme',
        slug: null,
      })

      // Same derived slug, different organization. Dropping this event would leave the second
      // customer permanently unprovisioned over a display string.
      const second = await provisionWorkspace(rest.credentials, {
        clerkOrgId: 'org_second99',
        name: 'Acme',
        slug: null,
      })

      expect(second.outcome).toBe('created')
      expect(second.slug).not.toBe('acme')
      expect(second.slugSource).toBe('name-disambiguated')
      const rows = await workspaces()
      expect(rows).toHaveLength(2)
      expect(new Set(rows.map((r) => r.slug)).size).toBe(2)
    })

    it('sends the service-role key on every request', async () => {
      const seen: Record<string, string>[] = []
      const credentials: RestCredentials = {
        supabaseUrl: BASE,
        serviceRoleKey: SERVICE_KEY,
        fetchImpl: (async (url: string, init?: RequestInit) => {
          seen.push(init?.headers as Record<string, string>)
          return rest.credentials.fetchImpl!(url, init as RequestInit)
        }) as unknown as typeof fetch,
      }

      await provisionWorkspace(credentials, { clerkOrgId: ORG, name: 'Acme MX', slug: 'acme-mx' })

      expect(seen.length).toBeGreaterThan(0)
      for (const headers of seen) {
        expect(headers['apikey']).toBe(SERVICE_KEY)
        expect(headers['authorization']).toBe(`Bearer ${SERVICE_KEY}`)
      }
    })
  })

  describe('deactivateWorkspace — what organization.deleted actually does', () => {
    async function seedPanel(): Promise<string> {
      const created = await provisionWorkspace(rest.credentials, {
        clerkOrgId: ORG,
        name: 'Acme MX',
        slug: 'acme-mx',
      })
      const workspaceId = created.workspaceId

      await db.query(
        `insert into public.watchlists (workspace_id, kind, query, label)
         values ($1, 'keyword', 'stori', 'Fintech MX'), ($1, 'keyword', 'nu', 'Nu MX')`,
        [workspaceId],
      )
      const [advertiser] = await db.query<{ id: string }>(
        `insert into public.advertisers (workspace_id, meta_page_id, name)
         values ($1, '123', 'Stori') returning id`,
        [workspaceId],
      )
      await db.query(
        `insert into public.creatives (workspace_id, advertiser_id, creative_hash, media_type)
         values ($1, $2, 'hash-1', 'video')`,
        [workspaceId, advertiser!.id],
      )
      return workspaceId
    }

    it('stops the spending and keeps every row', async () => {
      const workspaceId = await seedPanel()

      const result = await deactivateWorkspace(rest.credentials, ORG)

      expect(result).toEqual({ workspaceId, deactivated: 2 })

      // The whole point. `on delete cascade` runs from `workspaces` to every table in the
      // product, and domain rule 1 makes that unrecoverable — the Ad Library has no history.
      expect(await workspaces()).toHaveLength(1)
      const [creatives] = await db.query<{ n: number }>(
        'select count(*)::int as n from public.creatives where workspace_id = $1',
        [workspaceId],
      )
      expect(creatives!.n).toBe(1)

      // And the part that had to happen: `app.enqueue_daily_crawls` reads `where is_active`,
      // so these are what would otherwise bill Apify every morning forever.
      const [active] = await db.query<{ n: number }>(
        'select count(*)::int as n from public.watchlists where workspace_id = $1 and is_active',
        [workspaceId],
      )
      expect(active!.n).toBe(0)
    })

    it('counts only what this delivery changed', async () => {
      await seedPanel()
      await deactivateWorkspace(rest.credentials, ORG)

      // A redelivery must not claim it stopped two watchlists a second time.
      expect(await deactivateWorkspace(rest.credentials, ORG)).toEqual({
        workspaceId: (await workspaces())[0]!.id,
        deactivated: 0,
      })
    })

    it('is a no-op for an organization that was never provisioned', async () => {
      // A delete for something we never had is not an error, and answering one would make
      // Clerk retry it until the endpoint gave up.
      expect(await deactivateWorkspace(rest.credentials, 'org_never_seen')).toBeNull()
    })
  })

  describe('postAuditEvent', () => {
    it('appends an event the audit log can answer questions from', async () => {
      const { workspaceId } = await provisionWorkspace(rest.credentials, {
        clerkOrgId: ORG,
        name: 'Acme MX',
        slug: 'acme-mx',
      })
      const traceId = newTraceId()
      const actor = { type: 'agent' as const, id: 'clerk-webhook', label: 'organization.created' }

      await postAuditEvent(rest.credentials, {
        workspaceId,
        traceId,
        actor,
        type: 'workspace.provisioned',
        subjectType: 'workspace',
        subjectId: workspaceId,
        payload: { slugSource: 'clerk' },
      })

      const rows = await db.query<{ type: string; actor: unknown; payload: Record<string, unknown>; trace_id: string }>(
        'select type, actor, payload, trace_id from public.audit_events where workspace_id = $1',
        [workspaceId],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]!.type).toBe('workspace.provisioned')
      expect(rows[0]!.trace_id).toBe(traceId)
      expect(rows[0]!.payload).toEqual({ slugSource: 'clerk' })
      // Against the contract, not against the fields this file happens to set: `isActor` is
      // what every consumer validates with, and a producer that satisfies a restatement of it
      // is a cross-boundary gap waiting to happen (migration 0009 shipped exactly that bug).
      expect(isActor(rows[0]!.actor)).toBe(true)
    })
  })

  describe('end to end: the row the whole product resolves against', () => {
    it('makes app.current_workspace_id() resolve for a session carrying that org', async () => {
      // Before: this is the silent empty dashboard UC-9 exists to remove — a valid session,
      // a real org id, and every RLS policy in the product evaluating against null.
      const before = await asAuthenticated(db, { sub: 'user_1', org_id: ORG }, async (tenant) =>
        tenant.query<{ id: string | null }>('select app.current_workspace_id() as id'),
      )
      expect(before[0]!.id).toBeNull()

      const { workspaceId } = await provisionWorkspace(rest.credentials, {
        clerkOrgId: ORG,
        name: 'Acme MX',
        slug: 'acme-mx',
      })

      const after = await asAuthenticated(db, { sub: 'user_1', org_id: ORG }, async (tenant) => ({
        resolved: await tenant.query<{ id: string }>('select app.current_workspace_id() as id'),
        visible: await tenant.query<{ slug: string }>('select slug from public.workspaces'),
      }))

      expect(after.resolved[0]!.id).toBe(workspaceId)
      // Through the real policy, from inside `asAuthenticated`: the default PGlite connection
      // is a superuser and would see this row regardless of whether RLS worked at all.
      expect(after.visible.map((r) => r.slug)).toEqual(['acme-mx'])
    })

    it('shows a provisioned workspace nothing that belongs to another organization', async () => {
      await provisionWorkspace(rest.credentials, { clerkOrgId: ORG, name: 'Acme MX', slug: 'acme-mx' })
      await provisionWorkspace(rest.credentials, {
        clerkOrgId: 'org_other',
        name: 'Otra Agencia',
        slug: 'otra',
      })

      const seen = await asAuthenticated(db, { sub: 'user_1', org_id: ORG }, async (tenant) =>
        tenant.query<{ slug: string }>('select slug from public.workspaces'),
      )

      expect(seen.map((r) => r.slug)).toEqual(['acme-mx'])
    })
  })

  describe('the PostgREST stand-in itself', () => {
    it('refuses a filter it does not implement rather than ignoring it', async () => {
      // Guards the harness. A translator that silently dropped an unrecognised filter would
      // turn "patch the active watchlists" into "patch every watchlist" and still pass.
      const response = await rest.credentials.fetchImpl!(
        `${BASE}/rest/v1/workspaces?name=like.*acme*`,
        { method: 'GET' },
      )
      expect(response.status).toBe(400)
      expect(await response.text()).toMatch(/unsupported filter/)
    })
  })
})
