import type { Actor, TraceId } from '@mini-crux/core'

/**
 * Land raw, parse later (CLAUDE.md rule 2).
 *
 * The provider payload is written here verbatim *before* a single row is parsed. The
 * asymmetry that justifies it: a parsing bug found next month costs a reprocess, while a
 * payload never stored is a day of the panel that cannot be recovered at any price.
 *
 * Snapshots are therefore write-once. {@link ObjectStore.put} rejects an existing path
 * rather than overwriting, so "immutable" is enforced by the store instead of being a rule
 * every future caller has to remember.
 */

export const SNAPSHOT_SCHEMA_VERSION = 1

/** Raised when a write targets a path that already holds a snapshot. */
export class SnapshotExistsError extends Error {
  constructor(readonly path: string) {
    super(`Snapshot already exists at ${path}; raw snapshots are immutable.`)
    this.name = 'SnapshotExistsError'
  }
}

export interface ObjectStore {
  /** Write-once. MUST throw {@link SnapshotExistsError} if `path` already exists. */
  put(path: string, body: string): Promise<void>
  get(path: string): Promise<string | null>
}

/**
 * The stored envelope. `schema_version` is what makes a future shape change survivable:
 * a reprocess can branch on it instead of guessing from the payload's structure
 * (DashOne §3, versioned envelopes).
 */
export interface SnapshotEnvelope {
  schema_version: number
  trace_id: TraceId
  actor: Actor
  workspace_id: string
  watchlist_id: string
  crawl_run_id: string
  run_date: string
  provider: string
  provider_run_id: string | null
  captured_at: string
  payload: unknown
}

/**
 * `raw/{workspace}/{watchlist}/{YYYY-MM-DD}/{crawl_run}.json`.
 *
 * Workspace-first so a Storage policy can scope access by path prefix, and date before the
 * run id so a day's snapshots list as a directory without a database query.
 */
export function snapshotPath(input: {
  workspaceId: string
  watchlistId: string
  runDate: string
  crawlRunId: string
}): string {
  return `raw/${input.workspaceId}/${input.watchlistId}/${input.runDate}/${input.crawlRunId}.json`
}

/**
 * Generic over the envelope shape so a second crawl kind (UC-7's ES validation crawl, which
 * has no `watchlist_id` or `crawl_run_id` to carry) can land raw through the same write-once
 * mechanism with its own envelope, rather than forcing an envelope with fields that do not
 * apply to it — see {@link ProxyValidationSnapshotEnvelope}.
 */
export async function putSnapshot<T>(store: ObjectStore, path: string, envelope: T): Promise<void> {
  await store.put(path, JSON.stringify(envelope))
}

export async function getSnapshot<T = SnapshotEnvelope>(
  store: ObjectStore,
  path: string,
): Promise<T | null> {
  const body = await store.get(path)
  return body === null ? null : (JSON.parse(body) as T)
}

/**
 * The ES validation crawl's envelope (UC-7). Deliberately not {@link SnapshotEnvelope}: there
 * is no `watchlist_id` or `crawl_run_id` in the quarantined corpus, and reusing the MX shape
 * with those fields set to a placeholder would be exactly the kind of accidental coupling the
 * quarantine (migration 0011's header) exists to prevent.
 */
export interface ProxyValidationSnapshotEnvelope {
  schema_version: number
  trace_id: TraceId
  actor: Actor
  workspace_id: string
  /**
   * The crawl job's own `message_id`, not a `proxy_validation_runs` row id. That table is
   * append-only and its row is only inserted once the regression over the whole corpus has
   * been computed — there is nothing to reference yet at the moment this snapshot lands.
   * `message_id` is available up front, unique per job invocation, and stable across a
   * redelivery of the *same* job, which is exactly what a write-once path needs.
   */
  run_id: string
  provider: string
  provider_run_id: string | null
  captured_at: string
  payload: unknown
}

/**
 * `raw/{workspace}/proxy-validation/{run_id}.json`, where `run_id` is the crawl job's
 * `message_id` (see {@link ProxyValidationSnapshotEnvelope.run_id}). No watchlist or date
 * component — the ES corpus is not a daily longitudinal panel (spec: "in the EU,
 * longitudinal data *can* be backfilled"), so there is no crawl-day directory structure to
 * mirror.
 */
export function proxyValidationSnapshotPath(input: { workspaceId: string; runId: string }): string {
  return `raw/${input.workspaceId}/proxy-validation/${input.runId}.json`
}

/** In-memory store for tests and for `crawl:once --dry-run`. */
export function createMemoryStore(): ObjectStore & { readonly paths: string[] } {
  const objects = new Map<string, string>()

  return {
    get paths() {
      return [...objects.keys()]
    },
    async put(path: string, body: string): Promise<void> {
      if (objects.has(path)) throw new SnapshotExistsError(path)
      objects.set(path, body)
    },
    async get(path: string): Promise<string | null> {
      return objects.get(path) ?? null
    },
  }
}

/** Minimal shape of `supabase.storage.from(bucket)` — declared structurally, no dependency. */
interface SupabaseBucket {
  upload(
    path: string,
    body: string | Blob,
    options?: { contentType?: string; upsert?: boolean },
  ): Promise<{ error: { message: string; statusCode?: string } | null }>
  download(path: string): Promise<{ data: Blob | null; error: { message: string } | null }>
}

/**
 * Supabase Storage store.
 *
 * `upsert: false` is the immutability guarantee — the bucket refuses the second write, so
 * a buggy retry cannot overwrite a good snapshot with a truncated one.
 */
export function createSupabaseStore(bucket: SupabaseBucket): ObjectStore {
  return {
    async put(path: string, body: string): Promise<void> {
      const { error } = await bucket.upload(path, body, {
        contentType: 'application/json',
        upsert: false,
      })
      if (error !== null) {
        // Supabase reports a duplicate as 409 / "Duplicate". Surfaced as its own error so
        // the caller can treat "already landed" as success on a redelivered job.
        if (error.statusCode === '409' || /duplicate|already exists/i.test(error.message)) {
          throw new SnapshotExistsError(path)
        }
        throw new Error(`Storage upload failed for ${path}: ${error.message}`)
      }
    },

    async get(path: string): Promise<string | null> {
      const { data, error } = await bucket.download(path)
      if (error !== null) return null
      return data === null ? null : await data.text()
    },
  }
}
