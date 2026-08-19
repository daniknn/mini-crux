import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

/**
 * Everything is private except the auth routes and the health check.
 *
 * The tenant is the Clerk Organization and is read from the session — never from a URL
 * segment. A route like `/w/:slug/...` would let a signed-in user of workspace A type
 * workspace B's slug; RLS would still deny the data, but the app would be asking the
 * wrong question. Keep the active org implicit.
 */

const isPublicRoute = createRouteMatcher([
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/health',
  // "Public" here means "Clerk does not gate it", not "ungated". The ingestion alarm is
  // called by an uptime checker that cannot hold a session, so it authenticates itself with
  // a shared secret inside the handler. Letting Clerk bounce it first would make the alarm
  // permanently red for a reason that has nothing to do with ingestion.
  '/api/health/ingestion',
  // Same sense of "public": the caller is Clerk itself and holds no session, so the session
  // gate cannot apply. The Svix signature is the gate, and it runs before anything in the
  // handler reads the body. Leaving this out would have Clerk bounced to the sign-in page,
  // every delivery answered 200-with-HTML, and no workspace ever provisioned — the exact
  // silent-empty-dashboard failure this route exists to prevent.
  '/api/webhooks/clerk',
  // The dev-only design preview (UC-10). Listed for the same reason the matcher below
  // excludes it — see there. Belt and braces: if the matcher is ever widened, this keeps
  // `/ux` out of the session gate instead of silently bouncing a design review to sign-in.
  '/ux(.*)',
])

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect()
  }
})

export const config = {
  matcher: [
    // Skip Next internals and static files unless they appear in search params.
    //
    // `ux` is excluded here, not just marked public above, because the two do different
    // things. Marking it public would still run `clerkMiddleware`, and `clerkMiddleware`
    // needs a Clerk instance — in keyless mode it provisions one over the network. The whole
    // premise of UC-10 is that the design review runs with no accounts and no network, so a
    // route that reaches Clerk at all is a route that can fail for a reason that has nothing
    // to do with the pixels under review. Excluded, the middleware never runs.
    //
    // `ux(?:/|$)` and not `ux` so that a future `/uxo-algo` product route stays gated.
    '/((?!_next|ux(?:/|$)|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}
