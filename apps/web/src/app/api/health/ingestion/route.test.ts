import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The alarm's HTTP surface.
 *
 * Three things are worth proving and none of them is "it returns JSON".
 *
 *   1. The status *code* tracks the verdict. A stock uptime checker reads nothing else, and
 *      the whole design rests on it going red without being configured to understand a body.
 *   2. A bad token is refused and told nothing — including whether the instance is healthy,
 *      which is the thing an unauthenticated caller would most like to learn.
 *   3. A database that cannot be reached is red, not green. "No unhealthy watchlists" and
 *      "no answer" are the same empty array if nobody separates them.
 *
 * `fetch` is stubbed rather than `@mini-crux/db`, so the real read, the real mapper, and the
 * real summarizer all run. Mocking the summarizer here would leave the route asserting
 * against its own stub.
 */

vi.mock('server-only', () => ({}))

const TOKEN = 'health-check-token-0123456789abcdef'

vi.mock('../../../../env.ts', () => ({
  serverEnv: () => ({
    clerkSecretKey: 'sk_test',
    supabaseUrl: 'https://example.supabase.co',
    supabaseServiceRoleKey: 'service-role-key',
    databaseUrl: 'postgresql://authenticator:pw@localhost:6543/postgres',
    healthCheckToken: TOKEN,
  }),
}))

const { GET } = await import('./route.ts')

/** One row as PostgREST would send it: snake_case, dates as ISO strings. */
function restRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspace_id: 'ws-1',
    watchlist_id: 'wl-1',
    label: 'Fintech MX',
    query: 'stori',
    country: 'MX',
    market_date: '2026-03-10',
    state: 'succeeded',
    crawl_run_id: 'run-1',
    attempt: 1,
    error: null,
    started_at: '2026-03-10T14:00:00.000Z',
    finished_at: '2026-03-10T14:05:00.000Z',
    ...overrides,
  }
}

function stubRest(rows: Record<string, unknown>[] | { status: number }): void {
  vi.stubGlobal('fetch', () => {
    if (Array.isArray(rows)) {
      return Promise.resolve(
        new Response(JSON.stringify(rows), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    return Promise.resolve(new Response('nope', { status: rows.status, statusText: 'Boom' }))
  })
}

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('https://app.example.test/api/health/ingestion', { headers })
}

const authed = { authorization: `Bearer ${TOKEN}` }

beforeEach(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GET /api/health/ingestion', () => {
  it('returns 200 when every active watchlist crawled today', async () => {
    stubRest([restRow(), restRow({ watchlist_id: 'wl-2', label: 'Nu MX' })])

    const response = await GET(request(authed))
    const body = (await response.json()) as { status: string; counts: { succeeded: number } }

    expect(response.status).toBe(200)
    expect(body.status).toBe('ok')
    expect(body.counts.succeeded).toBe(2)
  })

  it('returns 503 naming the watchlist that never started', async () => {
    stubRest([
      restRow(),
      restRow({
        watchlist_id: 'wl-2',
        label: 'Nu MX',
        state: 'never-started',
        crawl_run_id: null,
        attempt: null,
        started_at: null,
        finished_at: null,
      }),
    ])

    const response = await GET(request(authed))
    const body = (await response.json()) as {
      status: string
      offenders: { label: string; reason: string }[]
    }

    // 503, not 200-with-a-field. A checker nobody taught about this body must still go red.
    expect(response.status).toBe(503)
    expect(body.status).toBe('degraded')
    expect(body.offenders).toEqual([
      expect.objectContaining({ label: 'Nu MX', reason: 'never-started' }),
    ])
  })

  it('distinguishes a failed crawl from one that never started', async () => {
    stubRest([
      restRow({ state: 'failed', error: 'provider 503' }),
      restRow({
        watchlist_id: 'wl-2',
        label: 'Nu MX',
        state: 'never-started',
        crawl_run_id: null,
        started_at: null,
      }),
    ])

    const response = await GET(request(authed))
    const body = (await response.json()) as {
      offenders: { reason: string; error: string | null }[]
    }

    expect(response.status).toBe(503)
    expect(body.offenders.map((o) => o.reason)).toEqual(['failed', 'never-started'])
    expect(body.offenders[0]!.error).toBe('provider 503')
    expect(body.offenders[1]!.error).toBeNull()
  })

  it('is 200 for an instance with no active watchlists', async () => {
    stubRest([])

    const response = await GET(request(authed))

    // Nothing to crawl is not a missed crawl. Paging someone mid-onboarding is how the
    // pager gets ignored before it has ever been right.
    expect(response.status).toBe(200)
  })

  it('refuses a missing token and reveals nothing', async () => {
    stubRest([restRow({ state: 'failed' })])

    const response = await GET(request())
    const body = (await response.json()) as Record<string, unknown>

    expect(response.status).toBe(401)
    // No counts, no labels, no verdict — not even the fact that the instance is unhealthy.
    expect(Object.keys(body)).toEqual(['status'])
    expect(body['status']).toBe('unauthorized')
  })

  it('refuses a wrong token without reading the database', async () => {
    let called = false
    vi.stubGlobal('fetch', () => {
      called = true
      return Promise.resolve(new Response('[]', { status: 200 }))
    })

    const response = await GET(request({ authorization: 'Bearer not-the-token' }))

    expect(response.status).toBe(401)
    // An unauthenticated caller must not be able to make the instance do work, or the
    // endpoint is a free amplifier pointed at our own database.
    expect(called).toBe(false)
  })

  it('refuses a token of the right length but the wrong bytes', async () => {
    const wrong = `${'x'.repeat(TOKEN.length - 1)}y`
    expect(wrong).toHaveLength(TOKEN.length)
    stubRest([restRow()])

    const response = await GET(request({ authorization: `Bearer ${wrong}` }))

    // The constant-time compare must still compare. A length check alone accepts anything.
    expect(response.status).toBe(401)
  })

  it('is 503, not 200, when the database cannot be read', async () => {
    stubRest({ status: 500 })

    const response = await GET(request(authed))
    const body = (await response.json()) as { status: string }

    expect(response.status).toBe(503)
    // A separate word from `degraded`: the runbook's first question is whether ingestion
    // broke or whether the alarm lost sight of it.
    expect(body.status).toBe('unknown')
  })

  it('carries a trace_id on every answer it is willing to explain', async () => {
    stubRest([restRow()])

    const response = await GET(request(authed))
    const body = (await response.json()) as { traceId: string }

    expect(body.traceId).toMatch(/^trc_/)
  })
})
