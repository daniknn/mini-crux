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
])

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect()
  }
})

export const config = {
  matcher: [
    // Skip Next internals and static files unless they appear in search params.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}
