import { NextRequest } from 'next/server'
import { describe, expect, it, vi } from 'vitest'

/**
 * Which routes Clerk's session gate applies to.
 *
 * This is asserted rather than read off the array because the failure it guards against is
 * silent in both directions.
 *
 * A machine endpoint left *out* of the public list is not refused — it is redirected to the
 * sign-in page, so Clerk's webhook delivery gets a 200 with an HTML body, records a
 * successful delivery, and never retries. Provisioning would then be broken for every new
 * customer while the webhook dashboard showed a column of green checkmarks, and the symptom
 * at the other end is the empty dashboard with no error anywhere that UC-9 exists to remove.
 *
 * A product route accidentally *in* it is worse and quieter still: RLS would deny the data,
 * so the page renders empty rather than wrong, and looks like any other workspace with no
 * crawls yet.
 *
 * `clerkMiddleware` is replaced with the identity function so the exported handler can be
 * called directly. `createRouteMatcher` is the real one — it is the thing under test.
 */

vi.mock('@clerk/nextjs/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/nextjs/server')>()
  return {
    ...actual,
    clerkMiddleware: (handler: unknown) => handler,
  }
})

/**
 * Through `unknown` because the module's *static* type is `clerkMiddleware`'s return — a
 * `NextMiddleware` taking one argument. The mock above replaces that at runtime with the
 * handler itself, which takes two. The types cannot overlap; only the runtime value changed.
 */
const middlewareModule = await import('./middleware.ts')

const middleware = middlewareModule.default as unknown as (
  auth: { protect: () => Promise<void> },
  request: NextRequest,
) => Promise<unknown>

/** The real export, not a copy — the matcher tests below are worthless against a restatement. */
const { config } = middlewareModule

/** Runs the middleware and reports whether it demanded a session. */
async function requiresSession(pathname: string): Promise<boolean> {
  let protectCalled = false
  const auth = {
    protect: async (): Promise<void> => {
      protectCalled = true
    },
  }

  await middleware(auth, new NextRequest(`https://app.example.test${pathname}`))
  return protectCalled
}

describe('middleware', () => {
  it.each([
    ['/api/webhooks/clerk', 'Clerk itself holds no session; the Svix signature is the gate'],
    ['/api/health/ingestion', 'an uptime checker cannot hold a session; a shared secret gates it'],
    ['/api/health', 'liveness must answer before anything else works'],
    ['/sign-in', 'the sign-in page cannot require being signed in'],
    ['/sign-up/continue', 'nor can any step of the sign-up flow'],
    ['/ux', 'the design preview has no database and no session to gate'],
    ['/ux/creativos', 'and neither does any surface under it'],
  ])('leaves %s to its own gate — %s', async (pathname) => {
    expect(await requiresSession(pathname)).toBe(false)
  })

  it.each([
    ['/'],
    ['/listas'],
    ['/creativos'],
    ['/creativos/abc-123'],
    ['/analisis'],
    ['/estructura'],
    ['/novedades'],
    ['/validacion-proxy'],
  ])('protects %s', async (pathname) => {
    expect(await requiresSession(pathname)).toBe(true)
  })

  /**
   * The public-route list is the second line for `/ux`. The first is the matcher, which keeps
   * the middleware — and therefore Clerk — from running on those requests at all.
   *
   * Asserted through a compiled `RegExp` rather than by reading the string, because the string
   * is the one thing that cannot be wrong in a way anybody notices: a matcher that
   * accidentally still covers `/ux` produces a preview that works on a laptop with Clerk
   * keyless mode reachable and redirects to sign-in on one without a network, which is the
   * machine the design review is most likely to happen on.
   */
  describe('matcher', () => {
    const pattern = new RegExp(`^${config.matcher[0]!}$`)

    it.each([['/ux'], ['/ux/creativos'], ['/ux/creativos/abc-123']])(
      'does not run at all on %s',
      (pathname) => {
        expect(pattern.test(pathname)).toBe(false)
      },
    )

    it.each([['/listas'], ['/creativos'], ['/uxo-algo']])('still runs on %s', (pathname) => {
      // `/uxo-algo` is the one that matters: the exclusion is `ux` followed by a slash or the
      // end of the path, so a future product route whose name starts with those two letters
      // does not fall out of the session gate by accident.
      expect(pattern.test(pathname)).toBe(true)
    })
  })

  it('does not open the whole webhook namespace', async () => {
    // The entry is an exact path, not `/api/webhooks(.*)`. A future webhook gets its own line
    // once it has its own signature check — it must not inherit this one's exemption.
    expect(await requiresSession('/api/webhooks/anything-else')).toBe(true)
  })
})
