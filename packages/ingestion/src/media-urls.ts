/**
 * Short-lived signed URLs for the media bucket — the bytes a creative's features (and now its
 * semantic tags) were measured from, not the poster-frame decoration `apps/web/src/server/
 * posters.ts` signs.
 *
 * WHY THIS IS A SEPARATE MODULE FROM `posters.ts` RATHER THAN A SHARED IMPORT
 *
 * `posters.ts` is `server-only`: it reads `serverEnv()` (a Next.js-request-scoped helper) and
 * is built to be unreachable from a client bundle. The semantic-tagging job runs inside
 * `apps/worker`, a standalone Node process with no Next.js runtime and no request to scope
 * anything to — importing a `server-only` module there is either a build error or, if the
 * guard were ever weakened, a silent way to end up depending on a helper that assumes an HTTP
 * request exists. So this module re-implements the same signing call — Supabase Storage's
 * `POST /storage/v1/object/sign/{bucket}`, batched, service-role key, degrade-to-absent on any
 * failure — as a small, explicitly-configured, dependency-free adapter, matching the shape of
 * every other provider in this package (config in, `fetchImpl` injectable for tests).
 *
 * WHY SIGNING FAILURE DOES NOT THROW
 *
 * A signed URL that never arrives is not the semantic-tagging job's problem to solve — it is
 * `runSemanticTag`'s problem to *decide* what to do about (retry, since a storage hiccup is
 * transient; never guess a tag from a URL that might 404). Collapsing "storage unreachable"
 * and "path never existed" into a thrown error here would force every caller to catch and
 * re-interpret the same failure; returning whichever paths *did* sign, and leaving the rest
 * absent from the map, lets the caller answer that question with its own domain knowledge
 * instead of parsing an error message.
 */

const DEFAULT_BUCKET = 'media'

/**
 * Long enough that a job's provider call (up to `DEFAULT_TIMEOUT_MS` in
 * `providers/vlm/openai.ts`) cannot outlive the URL it is still fetching frames through; short
 * enough that a URL logged anywhere is worthless within the hour.
 */
const DEFAULT_EXPIRES_IN_S = 3600

export interface MediaUrlSignerConfig {
  supabaseUrl: string
  /** Service-role key. Signing bypasses RLS by design — see the module doc comment. */
  serviceRoleKey: string
  /** Matches the extractor's `DEFAULT_MEDIA_BUCKET`. */
  bucket?: string
  expiresInS?: number
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
}

export interface MediaUrlSigner {
  /** Sign many paths in one request. Paths that fail to sign are simply absent from the map. */
  sign(paths: readonly string[]): Promise<Map<string, string>>
}

type SignedRow = { path?: string; signedURL?: string; error?: string | null }

export function createSupabaseMediaUrlSigner(config: MediaUrlSignerConfig): MediaUrlSigner {
  const doFetch = config.fetchImpl ?? globalThis.fetch
  const bucket = config.bucket ?? DEFAULT_BUCKET
  const expiresInS = config.expiresInS ?? DEFAULT_EXPIRES_IN_S
  const supabaseUrl = config.supabaseUrl.replace(/\/$/, '')

  return {
    async sign(paths: readonly string[]): Promise<Map<string, string>> {
      const wanted = [...new Set(paths.filter((p) => p !== ''))]
      const signed = new Map<string, string>()
      if (wanted.length === 0) return signed

      let rows: SignedRow[]
      try {
        const response = await doFetch(`${supabaseUrl}/storage/v1/object/sign/${bucket}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.serviceRoleKey}`,
            apikey: config.serviceRoleKey,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ paths: wanted, expiresIn: expiresInS }),
        })
        if (!response.ok) return signed
        rows = (await response.json()) as SignedRow[]
      } catch {
        // Storage unreachable. Caller gets an empty map and decides what that means for it —
        // see the module doc comment.
        return signed
      }

      if (!Array.isArray(rows)) return signed

      for (const row of rows) {
        // Supabase reports per-path failures inside a 200 response: a path that 404s comes
        // back with `error` set and no `signedURL`. Skipping those individually is what stops
        // one missing frame from blanking every other frame this call also asked for.
        if (typeof row.path !== 'string' || typeof row.signedURL !== 'string') continue
        if (row.error !== null && row.error !== undefined) continue
        signed.set(row.path, absolute(row.signedURL, supabaseUrl))
      }

      return signed
    },
  }
}

/**
 * Deterministic signer for tests: returns exactly the mapping it was given, no network call.
 * A path with no entry in `urls` comes back absent from the result map — the same "failed to
 * sign" shape a real Storage 404 produces — so a test can exercise the caller's degrade path
 * without faking an HTTP response.
 */
export function createFixtureMediaUrlSigner(urls: Record<string, string> = {}): MediaUrlSigner {
  return {
    async sign(paths: readonly string[]): Promise<Map<string, string>> {
      const signed = new Map<string, string>()
      for (const path of paths) {
        const url = urls[path]
        if (url !== undefined) signed.set(path, url)
      }
      return signed
    },
  }
}

/**
 * Supabase returns the signed URL relative to the storage root (`/object/sign/…`), so it has
 * to be joined back onto the project URL — the same fixup `posters.ts` applies, for the same
 * reason: a relative URL would point the caller at its own origin, not Supabase's.
 */
function absolute(signedUrl: string, supabaseUrl: string): string {
  if (signedUrl.startsWith('http://') || signedUrl.startsWith('https://')) return signedUrl
  const suffix = signedUrl.startsWith('/') ? signedUrl : `/${signedUrl}`
  return suffix.startsWith('/storage/v1') ? `${supabaseUrl}${suffix}` : `${supabaseUrl}/storage/v1${suffix}`
}
