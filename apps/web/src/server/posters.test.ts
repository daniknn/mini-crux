import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Poster signing: what crosses to the browser, and what happens when Storage does not answer.
 *
 * Two things are worth proving here and neither is "it returns a URL". The first is that the
 * service-role key — which bypasses RLS entirely — stays on the server and never appears in
 * anything a caller renders. The second is that every failure mode degrades to a missing
 * image rather than a thrown error: a poster is decoration, and a Storage outage that takes
 * the whole gallery down with it would turn a cosmetic problem into an unavailable product.
 *
 * `fetch` is stubbed rather than the module under test, so the request that would really go
 * out is inspectable — including the header the key travels in.
 */

vi.mock('server-only', () => ({}))

const SERVICE_KEY = 'service-role-key-that-bypasses-rls'

vi.mock('../env.ts', () => ({
  serverEnv: () => ({
    clerkSecretKey: 'sk_test',
    supabaseUrl: 'https://example.supabase.co',
    supabaseServiceRoleKey: SERVICE_KEY,
    databaseUrl: 'postgresql://authenticator:pw@localhost:6543/postgres',
  }),
}))

const { signPosterUrl, signPosterUrls } = await import('./posters.ts')

interface Recorded {
  url: string
  init: RequestInit
}

let recorded: Recorded[] = []

/** Stub `fetch` with a canned response, recording what was sent. */
function stubFetch(respond: () => Promise<Response> | Response): void {
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    recorded.push({ url, init })
    return Promise.resolve(respond())
  })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  recorded = []
  vi.unstubAllGlobals()
})

describe('signPosterUrls', () => {
  it('signs every path in a single request', async () => {
    stubFetch(() =>
      json([
        { path: 'ws/a.poster.v2.jpg', signedURL: '/object/sign/media/ws/a.poster.v2.jpg?token=1' },
        { path: 'ws/b.poster.v2.jpg', signedURL: '/object/sign/media/ws/b.poster.v2.jpg?token=2' },
      ]),
    )

    const signed = await signPosterUrls(['ws/a.poster.v2.jpg', 'ws/b.poster.v2.jpg'])

    // One hop, not one per creative: a gallery page signing serially is a page that gets
    // slower with every creative the workspace succeeds at tracking.
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.url).toBe('https://example.supabase.co/storage/v1/object/sign/media')
    expect(signed.size).toBe(2)
    expect(signed.get('ws/a.poster.v2.jpg')).toBe(
      'https://example.supabase.co/storage/v1/object/sign/media/ws/a.poster.v2.jpg?token=1',
    )
  })

  it('sends the service-role key as a header and never anywhere it could be rendered', async () => {
    stubFetch(() =>
      json([{ path: 'ws/a.poster.v2.jpg', signedURL: '/object/sign/media/ws/a.poster.v2.jpg?t=1' }]),
    )

    const signed = await signPosterUrls(['ws/a.poster.v2.jpg'])

    const headers = recorded[0]?.init.headers as Record<string, string>
    expect(headers['authorization']).toBe(`Bearer ${SERVICE_KEY}`)
    // The key bypasses RLS. It travels in a header on a server-to-server call; a key that
    // reached the query string would end up in the signed URL, in the HTML, and in every
    // proxy log between here and the browser.
    expect(recorded[0]?.url).not.toContain(SERVICE_KEY)
    for (const url of signed.values()) expect(url).not.toContain(SERVICE_KEY)
  })

  it('makes no request at all when there is nothing to sign', async () => {
    stubFetch(() => json([]))

    expect((await signPosterUrls([])).size).toBe(0)
    expect((await signPosterUrls([null, null])).size).toBe(0)
    expect(recorded).toHaveLength(0)
  })

  it('deduplicates repeated paths', async () => {
    stubFetch(() =>
      json([{ path: 'ws/a.poster.v2.jpg', signedURL: '/object/sign/media/ws/a.poster.v2.jpg?t=1' }]),
    )

    await signPosterUrls(['ws/a.poster.v2.jpg', 'ws/a.poster.v2.jpg'])

    const body = JSON.parse(String(recorded[0]?.init.body)) as { paths: string[] }
    expect(body.paths).toEqual(['ws/a.poster.v2.jpg'])
  })

  it('drops only the paths Storage could not sign, not the whole page', async () => {
    // Supabase reports per-path failures inside a 200. One creative whose object was never
    // uploaded must not blank every other poster in the gallery.
    stubFetch(() =>
      json([
        { path: 'ws/a.poster.v2.jpg', signedURL: '/object/sign/media/ws/a.poster.v2.jpg?t=1' },
        { path: 'ws/gone.poster.v2.jpg', error: 'Object not found', signedURL: null },
      ]),
    )

    const signed = await signPosterUrls(['ws/a.poster.v2.jpg', 'ws/gone.poster.v2.jpg'])

    expect([...signed.keys()]).toEqual(['ws/a.poster.v2.jpg'])
  })

  it('refuses a URL that arrives alongside an error', async () => {
    /**
     * Split out from the test above on purpose. There, the failing row had *both* `error`
     * set and a null `signedURL`, so the missing URL alone was enough to drop it and the
     * error check was never what did the work — deleting that check left the suite green.
     * A fixture where two guards coincide tests neither (CLAUDE.md, panel guardrails).
     *
     * Here the row carries a usable-looking URL *and* an error, so only the error check can
     * reject it. Honoring such a URL means handing the browser something the storage layer
     * explicitly refused to vouch for.
     */
    stubFetch(() =>
      json([
        {
          path: 'ws/refused.poster.v2.jpg',
          error: 'Object not found',
          signedURL: '/object/sign/media/ws/refused.poster.v2.jpg?t=stale',
        },
      ]),
    )

    const signed = await signPosterUrls(['ws/refused.poster.v2.jpg'])

    expect(signed.size).toBe(0)
  })

  it('degrades to an empty map when Storage errors, rather than failing the page', async () => {
    stubFetch(() => json({ message: 'service unavailable' }, 503))

    await expect(signPosterUrls(['ws/a.poster.v2.jpg'])).resolves.toEqual(new Map())
  })

  it('degrades to an empty map when the network throws', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')))

    await expect(signPosterUrls(['ws/a.poster.v2.jpg'])).resolves.toEqual(new Map())
  })

  it('degrades when the response is not the array shape it claims to be', async () => {
    stubFetch(() => json({ unexpected: true }))

    await expect(signPosterUrls(['ws/a.poster.v2.jpg'])).resolves.toEqual(new Map())
  })

  it('passes an absolute signed URL through untouched', async () => {
    // Supabase has returned both shapes across versions. Prefixing an already-absolute URL
    // would produce `https://…co/storage/v1https://…`, a broken image on every card.
    stubFetch(() =>
      json([{ path: 'ws/a.poster.v2.jpg', signedURL: 'https://cdn.example.test/signed?t=1' }]),
    )

    const signed = await signPosterUrls(['ws/a.poster.v2.jpg'])

    expect(signed.get('ws/a.poster.v2.jpg')).toBe('https://cdn.example.test/signed?t=1')
  })
})

describe('signPosterUrl', () => {
  it('returns null for a creative with no poster without asking Storage', async () => {
    stubFetch(() => json([]))

    expect(await signPosterUrl(null)).toBeNull()
    expect(await signPosterUrl('')).toBeNull()
    expect(recorded).toHaveLength(0)
  })

  it('returns null when the one path could not be signed', async () => {
    stubFetch(() => json([{ path: 'ws/a.poster.v2.jpg', error: 'Object not found' }]))

    expect(await signPosterUrl('ws/a.poster.v2.jpg')).toBeNull()
  })

  it('returns the signed URL when it can be signed', async () => {
    stubFetch(() =>
      json([{ path: 'ws/a.poster.v2.jpg', signedURL: '/object/sign/media/ws/a.poster.v2.jpg?t=9' }]),
    )

    expect(await signPosterUrl('ws/a.poster.v2.jpg')).toBe(
      'https://example.supabase.co/storage/v1/object/sign/media/ws/a.poster.v2.jpg?t=9',
    )
  })
})
