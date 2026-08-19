import { isActor } from '@mini-crux/core'
import { createHmac } from 'node:crypto'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The provisioning webhook's HTTP surface.
 *
 * The signature is verified with the real `verifyWebhook`, against headers this file signs
 * itself with `node:crypto`. Stubbing `verifyWebhook` would delete the only security property
 * the route has — an unsigned caller could otherwise rename any workspace on the instance —
 * and would do it in a way no assertion here could notice. Signing independently (rather than
 * importing the library's own `sign`) also means the test is not asking `standardwebhooks` to
 * agree with itself.
 *
 * `fetch` is stubbed with a PostgREST stand-in holding rows in memory, so the real
 * `provisionWorkspace` and the real `postAuditEvent` run. What the *database* does with those
 * requests — the unique constraints, the cascade that `organization.deleted` must never
 * trigger, RLS — is proved against actual Postgres in
 * `packages/db/test/workspace-provisioning.test.ts`. What is proved here is the part that
 * only exists at this layer: which status code each outcome answers with, and that the audit
 * log gains exactly one entry when something happened and none when nothing did.
 *
 * Status codes are the substance, not the packaging. Clerk redelivers on any non-2xx and
 * disables an endpoint that keeps failing, so a route that answers 500 where it should answer
 * 200 eventually takes provisioning down for every future customer, and one that answers 200
 * where it should answer 500 loses a workspace with nothing anywhere recording that it did.
 */

vi.mock('server-only', () => ({}))

const SIGNING_SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'

vi.mock('../../../../env.ts', () => ({
  serverEnv: () => ({
    clerkSecretKey: 'sk_test',
    clerkWebhookSecret: SIGNING_SECRET,
    supabaseUrl: 'https://example.supabase.co',
    supabaseServiceRoleKey: 'service-role-key',
    databaseUrl: 'postgresql://authenticator:pw@localhost:6543/postgres',
    healthCheckToken: 'health-check-token',
  }),
}))

const { POST } = await import('./route.ts')

/* -------------------------------------------------------------------------- */
/* Signing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The Standard Webhooks scheme Clerk signs with: HMAC-SHA256 over `{id}.{timestamp}.{body}`,
 * keyed by the base64-decoded secret. Written out rather than imported so that a change in
 * how the route verifies cannot be matched by a change in how the test signs.
 */
function signature(secret: string, id: string, timestamp: number, payload: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const mac = createHmac('sha256', key).update(`${id}.${timestamp}.${payload}`).digest('base64')
  return `v1,${mac}`
}

interface SignOptions {
  /** Sign with a secret other than the configured one — a forged delivery. */
  secret?: string
  /** Sign this instead of the body that is actually sent — a tampered payload. */
  signedBody?: string
  /** Drop the svix headers entirely. */
  unsigned?: boolean
}

function webhookRequest(event: unknown, options: SignOptions = {}): NextRequest {
  const body = JSON.stringify(event)
  const url = 'https://app.example.test/api/webhooks/clerk'

  if (options.unsigned === true) {
    return new NextRequest(url, { method: 'POST', body })
  }

  const id = 'msg_2abcDEF'
  const timestamp = Math.floor(Date.now() / 1000)
  const signed = options.signedBody ?? body

  return new NextRequest(url, {
    method: 'POST',
    body,
    headers: {
      'svix-id': id,
      'svix-timestamp': String(timestamp),
      'svix-signature': signature(options.secret ?? SIGNING_SECRET, id, timestamp, signed),
    },
  })
}

/* -------------------------------------------------------------------------- */
/* Events                                                                      */
/* -------------------------------------------------------------------------- */

function orgEvent(
  type: 'organization.created' | 'organization.updated' | 'organization.deleted',
  data: Record<string, unknown>,
): Record<string, unknown> {
  return { type, object: 'event', data }
}

/* -------------------------------------------------------------------------- */
/* PostgREST stand-in                                                          */
/* -------------------------------------------------------------------------- */

interface WorkspaceRow {
  id: string
  clerk_org_id: string
  name: string
  slug: string
}

interface WatchlistRow {
  id: string
  workspace_id: string
  is_active: boolean
}

interface RecordedCall {
  method: string
  path: string
  body: unknown
  headers: Record<string, string>
}

interface Store {
  workspaces: WorkspaceRow[]
  watchlists: WatchlistRow[]
  auditEvents: Record<string, unknown>[]
  calls: RecordedCall[]
  /** Set to make the next matching write fail, standing in for a database that is down. */
  failWrites: boolean
}

function eqFilter(query: URLSearchParams, column: string): string | null {
  const raw = query.get(column)
  if (raw === null) return null
  if (!raw.startsWith('eq.')) throw new Error(`stand-in only supports eq. filters: ${raw}`)
  return raw.slice(3)
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** PostgREST's shape for a unique violation, which `provisionWorkspace` branches on. */
function uniqueViolation(constraint: string): Response {
  return json(
    { code: '23505', message: `duplicate key value violates unique constraint "${constraint}"` },
    409,
  )
}

function newStore(): Store {
  return { workspaces: [], watchlists: [], auditEvents: [], calls: [], failWrites: false }
}

let nextId = 0
function mintId(prefix: string): string {
  nextId += 1
  return `${prefix}-${String(nextId).padStart(4, '0')}`
}

function stubRest(store: Store): void {
  vi.stubGlobal('fetch', (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const path = url.pathname.replace('/rest/v1/', '')
    const method = init.method ?? 'GET'
    const body: unknown = init.body === undefined ? undefined : JSON.parse(String(init.body))
    const headers = init.headers as Record<string, string>

    store.calls.push({ method, path, body, headers })

    if (method !== 'GET' && store.failWrites) {
      return Promise.resolve(json({ message: 'the database is not available' }, 500))
    }

    if (path === 'workspaces' && method === 'GET') {
      const orgId = eqFilter(url.searchParams, 'clerk_org_id')
      return Promise.resolve(
        json(
          store.workspaces.filter((w) => w.clerk_org_id === orgId),
          200,
        ),
      )
    }

    if (path === 'workspaces' && method === 'POST') {
      const row = body as { clerk_org_id: string; name: string; slug: string }
      if (store.workspaces.some((w) => w.clerk_org_id === row.clerk_org_id)) {
        return Promise.resolve(uniqueViolation('workspaces_clerk_org_id_key'))
      }
      if (store.workspaces.some((w) => w.slug === row.slug)) {
        return Promise.resolve(uniqueViolation('workspaces_slug_key'))
      }
      const inserted: WorkspaceRow = { id: mintId('ws'), ...row }
      store.workspaces.push(inserted)
      return Promise.resolve(json([inserted], 201))
    }

    if (path === 'workspaces' && method === 'PATCH') {
      const orgId = eqFilter(url.searchParams, 'clerk_org_id')
      const patch = body as { name: string; slug: string }
      const touched = store.workspaces.filter((w) => w.clerk_org_id === orgId)
      for (const row of touched) {
        row.name = patch.name
        row.slug = patch.slug
      }
      return Promise.resolve(json(touched, 200))
    }

    if (path === 'watchlists' && method === 'PATCH') {
      const workspaceId = eqFilter(url.searchParams, 'workspace_id')
      const activeFilter = eqFilter(url.searchParams, 'is_active')
      const touched = store.watchlists.filter(
        (w) =>
          w.workspace_id === workspaceId &&
          (activeFilter === null || String(w.is_active) === activeFilter),
      )
      const patch = body as { is_active: boolean }
      for (const row of touched) row.is_active = patch.is_active
      return Promise.resolve(json(touched, 200))
    }

    if (path === 'audit_events' && method === 'POST') {
      store.auditEvents.push(body as Record<string, unknown>)
      // `Prefer: return=minimal`, exactly as PostgREST answers it: 201 and an empty body.
      return Promise.resolve(new Response('', { status: 201 }))
    }

    throw new Error(`stand-in received an unexpected request: ${method} ${path}`)
  })
}

/** Every request that could have changed the database. The redelivery tests turn on this. */
function writes(store: Store): RecordedCall[] {
  return store.calls.filter((call) => call.method !== 'GET')
}

let store: Store

beforeEach(() => {
  vi.unstubAllGlobals()
  store = newStore()
  stubRest(store)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('POST /api/webhooks/clerk', () => {
  describe('organization.created', () => {
    it('provisions the workspace and records it once', async () => {
      const response = await POST(
        webhookRequest(
          orgEvent('organization.created', {
            id: 'org_2abcDEF',
            name: 'Grupo Salinas',
            slug: 'grupo-salinas',
          }),
        ),
      )
      const body = (await response.json()) as { outcome: string; traceId: string }

      expect(response.status).toBe(200)
      expect(body.outcome).toBe('created')
      expect(store.workspaces).toEqual([
        expect.objectContaining({ clerk_org_id: 'org_2abcDEF', slug: 'grupo-salinas' }),
      ])

      // Without this row, `app.current_workspace_id()` resolves to null for a session that
      // looks perfectly valid, and every query in the product returns zero rows in silence.
      expect(store.auditEvents).toHaveLength(1)
      expect(store.auditEvents[0]).toMatchObject({
        type: 'workspace.provisioned',
        workspace_id: store.workspaces[0]!.id,
        trace_id: body.traceId,
      })
    })

    it('stamps an actor the shared contract accepts', async () => {
      await POST(
        webhookRequest(
          orgEvent('organization.created', { id: 'org_1', name: 'Acme', slug: 'acme' }),
        ),
      )

      // Against `isActor`, not against the fields this route happens to set. Migration 0009
      // shipped an actor missing `id` with a test that asserted the two fields it did set.
      expect(isActor(store.auditEvents[0]!['actor'])).toBe(true)
    })

    it('derives a slug when Clerk sends none, rather than dropping the event', async () => {
      const response = await POST(
        webhookRequest(
          orgEvent('organization.created', { id: 'org_9', name: 'Diseño Creativo MX', slug: null }),
        ),
      )

      expect(response.status).toBe(200)
      // A missing display string must not cost a customer their workspace.
      expect(store.workspaces[0]!.slug).toBe('diseno-creativo-mx')
      expect(store.auditEvents[0]!['payload']).toMatchObject({ slugSource: 'name' })
    })

    it('writes nothing at all on a redelivery', async () => {
      const event = orgEvent('organization.created', {
        id: 'org_2abcDEF',
        name: 'Grupo Salinas',
        slug: 'grupo-salinas',
      })

      await POST(webhookRequest(event))
      const writesAfterFirst = writes(store).length

      const response = await POST(webhookRequest(event))
      const body = (await response.json()) as { outcome: string }

      expect(response.status).toBe(200)
      expect(body.outcome).toBe('unchanged')
      // Counted in requests, not in rows: an upsert plus a second audit append would leave
      // one workspace too, and would still be a log claiming provisioning happened twice.
      expect(writes(store)).toHaveLength(writesAfterFirst)
      expect(store.auditEvents).toHaveLength(1)
    })

    it('answers 5xx when the write fails, because that is what makes Clerk retry', async () => {
      store.failWrites = true

      const response = await POST(
        webhookRequest(
          orgEvent('organization.created', { id: 'org_5', name: 'Acme', slug: 'acme' }),
        ),
      )

      // A customer whose workspace was never created has no second chance to notice. 200
      // here would consume the only delivery that could have fixed it.
      expect(response.status).toBe(500)
      expect(store.workspaces).toEqual([])
    })
  })

  describe('organization.updated', () => {
    beforeEach(async () => {
      await POST(
        webhookRequest(
          orgEvent('organization.created', { id: 'org_7', name: 'Acme', slug: 'acme' }),
        ),
      )
    })

    it('renames the workspace and records the rename', async () => {
      const response = await POST(
        webhookRequest(
          orgEvent('organization.updated', { id: 'org_7', name: 'Acme México', slug: 'acme-mx' }),
        ),
      )
      const body = (await response.json()) as { outcome: string }

      expect(response.status).toBe(200)
      expect(body.outcome).toBe('renamed')
      expect(store.workspaces).toHaveLength(1)
      expect(store.workspaces[0]).toMatchObject({ name: 'Acme México', slug: 'acme-mx' })
      expect(store.auditEvents.map((e) => e['type'])).toEqual([
        'workspace.provisioned',
        'workspace.renamed',
      ])
    })

    it('writes nothing for an update that changes nothing', async () => {
      const writesBefore = writes(store).length

      const response = await POST(
        webhookRequest(
          orgEvent('organization.updated', { id: 'org_7', name: 'Acme', slug: 'acme' }),
        ),
      )

      expect(response.status).toBe(200)
      expect(writes(store)).toHaveLength(writesBefore)
      expect(store.auditEvents).toHaveLength(1)
    })
  })

  describe('organization.deleted', () => {
    beforeEach(async () => {
      await POST(
        webhookRequest(
          orgEvent('organization.created', { id: 'org_8', name: 'Acme', slug: 'acme' }),
        ),
      )
      const workspaceId = store.workspaces[0]!.id
      store.watchlists.push(
        { id: 'wl-1', workspace_id: workspaceId, is_active: true },
        { id: 'wl-2', workspace_id: workspaceId, is_active: true },
        { id: 'wl-3', workspace_id: workspaceId, is_active: false },
      )
    })

    it('stops the spending without deleting anything', async () => {
      const response = await POST(
        webhookRequest(orgEvent('organization.deleted', { id: 'org_8', deleted: true })),
      )
      const body = (await response.json()) as { outcome: string; deactivated: number }

      expect(response.status).toBe(200)
      expect(body.outcome).toBe('deactivated')
      // Only the two that were running. A count of three would overstate what this delivery
      // did, in an append-only log where that cannot be corrected later.
      expect(body.deactivated).toBe(2)

      // The workspace survives. Every table cascades from it, and the Ad Library has no
      // history — a delete here costs weeks of panel that cannot be re-crawled at any price.
      expect(store.workspaces).toHaveLength(1)
      expect(store.watchlists.every((w) => !w.is_active)).toBe(true)
      expect(writes(store).some((call) => call.method === 'DELETE')).toBe(false)

      expect(store.auditEvents.at(-1)).toMatchObject({
        type: 'workspace.deactivated',
        payload: { clerkOrgId: 'org_8', watchlistsDeactivated: 2 },
      })
    })

    it('accepts a delete for an organization it never provisioned', async () => {
      const response = await POST(
        webhookRequest(orgEvent('organization.deleted', { id: 'org_never_seen', deleted: true })),
      )
      const body = (await response.json()) as { outcome: string }

      // 200, not 404: retrying this forever fixes nothing and costs the endpoint the
      // reputation that provisioning depends on.
      expect(response.status).toBe(200)
      expect(body.outcome).toBe('unknown-organization')
      expect(store.auditEvents).toHaveLength(1)
    })
  })

  describe('the signature is the gate', () => {
    const event = orgEvent('organization.created', {
      id: 'org_evil',
      name: 'Attacker',
      slug: 'attacker',
    })

    it('refuses a delivery signed with the wrong secret', async () => {
      const response = await POST(
        webhookRequest(event, { secret: 'whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
      )
      const body = (await response.json()) as Record<string, unknown>

      expect(response.status).toBe(401)
      // Nothing about why, and nothing about the instance. A caller who cannot sign learns
      // only that the route exists, which they knew by reaching it.
      expect(Object.keys(body)).toEqual(['status'])
      expect(store.calls).toEqual([])
    })

    it('refuses a body that was swapped after signing', async () => {
      const innocent = JSON.stringify(
        orgEvent('organization.updated', { id: 'org_7', name: 'Acme', slug: 'acme' }),
      )

      const response = await POST(webhookRequest(event, { signedBody: innocent }))

      // The signature covers the payload, not just the headers. Without this, a valid
      // delivery could be replayed with its body rewritten to point at any organization.
      expect(response.status).toBe(401)
      expect(store.calls).toEqual([])
    })

    it('refuses an unsigned delivery without touching the database', async () => {
      const response = await POST(webhookRequest(event, { unsigned: true }))

      expect(response.status).toBe(401)
      // Not merely "no rows written": no request made. An unauthenticated caller must not be
      // able to make the instance do work on its behalf.
      expect(store.calls).toEqual([])
    })
  })

  describe('events it does not handle', () => {
    it('accepts and ignores an event type it was subscribed to by mistake', async () => {
      const response = await POST(
        webhookRequest({ type: 'user.created', object: 'event', data: { id: 'user_1' } }),
      )
      const body = (await response.json()) as { outcome: string; type: string }

      // 4xx would have Clerk retry an event we will never process, until it disables the
      // endpoint provisioning depends on.
      expect(response.status).toBe(200)
      expect(body.outcome).toBe('ignored')
      expect(body.type).toBe('user.created')
      expect(store.calls).toEqual([])
    })
  })

  it('carries a trace_id on every answer', async () => {
    const response = await POST(
      webhookRequest(orgEvent('organization.created', { id: 'org_t', name: 'Acme', slug: 'acme' })),
    )
    const body = (await response.json()) as { traceId: string }

    expect(body.traceId).toMatch(/^trc_/)
  })

  it('sends the service-role key on every request it makes', async () => {
    await POST(
      webhookRequest(orgEvent('organization.created', { id: 'org_h', name: 'Acme', slug: 'acme' })),
    )

    expect(store.calls.length).toBeGreaterThan(0)
    for (const call of store.calls) {
      expect(call.headers['apikey']).toBe('service-role-key')
      expect(call.headers['authorization']).toBe('Bearer service-role-key')
    }
  })
})
