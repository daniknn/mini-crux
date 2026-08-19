import 'server-only'

import { serverEnv } from '../env.ts'

/**
 * Short-lived signed URLs for poster frames.
 *
 * WHY THERE IS NO `/api/poster?path=…` ROUTE
 *
 * The obvious design is a route handler that takes a storage path and streams the object.
 * It is also the design where a bug is a cross-tenant image leak: the path arrives from the
 * request, so *something* has to prove the caller may see it, and that proof is a check a
 * future page can forget to trigger. Here the paths are only ever the `posterStoragePath`
 * values that came back from an RLS-filtered query in the same request. A caller cannot
 * name a path it was not already allowed to read, so — as with the gallery's advertiser
 * filter — there is no ownership check to write and therefore none to forget.
 *
 * WHY THE SERVICE-ROLE KEY IS SAFE HERE
 *
 * Signing happens on the server and only the signed URL crosses to the browser. The key
 * bypasses RLS, which is exactly why it must never be the thing sent to the client, and why
 * this module is `server-only`: importing it from a client component is a build error
 * rather than a leak.
 *
 * WHY SIGNING FAILURE IS NOT AN ERROR
 *
 * A poster is decoration. Storage being unreachable must cost the gallery its images and
 * nothing else — the same rule the extractor follows when the upload fails. Every helper
 * here degrades to `null`, which the UI renders as the text card it already renders for
 * creatives that never had a poster.
 */

/** Matches the extractor's `DEFAULT_MEDIA_BUCKET`. */
const BUCKET = 'media'

/**
 * Long enough that a slow page render and a slow image fetch cannot race the expiry, short
 * enough that a URL copied out of devtools is worthless by the time it is pasted anywhere.
 * These pages are per-request dynamic (they read the Clerk session), so the HTML is never
 * cached past the URLs embedded in it.
 */
const EXPIRES_IN_S = 600

type SignedRow = { path?: string; signedURL?: string; error?: string | null }

/**
 * Sign many paths in one request.
 *
 * One round trip rather than one per creative: a 60-card gallery signing serially would add
 * 60 sequential HTTP hops to the render, which is the kind of thing that reads as "the
 * dashboard is slow" long before anyone suspects the thumbnails.
 */
export async function signPosterUrls(
  paths: readonly (string | null)[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(paths.filter((p): p is string => p !== null && p !== ''))]
  const signed = new Map<string, string>()
  if (wanted.length === 0) return signed

  const { supabaseUrl, supabaseServiceRoleKey } = serverEnv()

  let rows: SignedRow[]
  try {
    const response = await fetch(`${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/sign/${BUCKET}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${supabaseServiceRoleKey}`,
        apikey: supabaseServiceRoleKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ paths: wanted, expiresIn: EXPIRES_IN_S }),
      cache: 'no-store',
    })
    if (!response.ok) return signed
    rows = (await response.json()) as SignedRow[]
  } catch {
    // Storage unreachable. Callers get an empty map and render text cards.
    return signed
  }

  if (!Array.isArray(rows)) return signed

  for (const row of rows) {
    // Supabase reports per-path failures inside a 200 response: a path that 404s comes back
    // with `error` set and no `signedURL`. Skipping those individually is what stops one
    // creative whose object was never uploaded from blanking every other poster on the page.
    if (typeof row.path !== 'string' || typeof row.signedURL !== 'string') continue
    if (row.error !== null && row.error !== undefined) continue
    signed.set(row.path, absolute(row.signedURL, supabaseUrl))
  }

  return signed
}

/** Sign exactly one path. Same degradation: `null` rather than a throw. */
export async function signPosterUrl(path: string | null): Promise<string | null> {
  if (path === null || path === '') return null
  return (await signPosterUrls([path])).get(path) ?? null
}

/**
 * Supabase returns the signed URL relative to the storage root (`/object/sign/…`), so it
 * has to be joined back onto the project URL. Rendering the relative form would point the
 * browser at the *dashboard's* origin, where it 404s — a broken image that looks like a
 * missing poster rather than like the bug it is.
 */
function absolute(signedUrl: string, supabaseUrl: string): string {
  if (signedUrl.startsWith('http://') || signedUrl.startsWith('https://')) return signedUrl
  const base = supabaseUrl.replace(/\/$/, '')
  const suffix = signedUrl.startsWith('/') ? signedUrl : `/${signedUrl}`
  return suffix.startsWith('/storage/v1') ? `${base}${suffix}` : `${base}/storage/v1${suffix}`
}
