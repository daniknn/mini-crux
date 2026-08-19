import type { Actor, TraceId } from '@mini-crux/core'

import type { RestCredentials } from './health.ts'

/**
 * Workspace provisioning, written over PostgREST with the service-role key.
 *
 * WHY NOT THE `authenticator` POOL
 *
 * Every other write in the web app goes through `withTenant`, which switches the connection
 * to `authenticated` and lets RLS scope it. That cannot express this one: a webhook carries
 * no session, and for `organization.created` the workspace whose id the policies would scope
 * to is precisely what is being created. Teaching the pool to `set role service_role` would
 * put a "write every workspace" primitive inside the process whose whole job is to never
 * have one.
 *
 * So this is the third instance of the pattern `fetchIngestionHealth` and `posters.ts`
 * already established: a privileged, instance-wide operation done as a server-only `fetch`
 * with the service-role key, reusing their {@link RestCredentials}.
 *
 * WHY READ-THEN-WRITE RATHER THAN AN UPSERT
 *
 * Clerk redelivers on any non-2xx and on a timeout, so this code sees the same event more
 * than once. An upsert would be idempotent in the row and *not* in the audit log: a retry
 * would append a second `workspace.provisioned`, which is not a duplicate write but a false
 * claim that something happened twice. Reading first lets an unchanged delivery write
 * nothing at all — see {@link provisionWorkspace}'s `unchanged` outcome.
 *
 * The read is an optimization, not the guarantee. `workspaces.clerk_org_id` is
 * `unique not null` and two concurrent deliveries can still race between the select and the
 * insert; the loser is absorbed by handling PostgREST's `409` the same way the ledger in
 * `jobs.ts` handles `isUniqueViolation`.
 */

/** PostgREST's code for `unique_violation`, surfaced in the JSON body of a 409. */
const UNIQUE_VIOLATION = '23505'

/**
 * Which source the stored slug came from.
 *
 * Recorded on the audit event rather than inferred later: `workspaces.slug` is
 * `not null unique` and Clerk's organization slug is optional, so a derived value is normal
 * rather than exceptional, and "why is this workspace called `org_2ab…`" is a question
 * somebody eventually asks.
 */
export type SlugSource = 'clerk' | 'name' | 'org-id' | 'name-disambiguated'

export interface WorkspaceUpsertInput {
  clerkOrgId: string
  name: string
  /** Clerk's slug, which is optional and genuinely arrives null. */
  slug: string | null
}

export interface WorkspaceRow {
  id: string
  clerk_org_id: string
  name: string
  slug: string
}

export interface ProvisionResult {
  /** `unchanged` means nothing was written — the caller must not append an audit event. */
  outcome: 'created' | 'renamed' | 'unchanged'
  workspaceId: string
  name: string
  slug: string
  slugSource: SlugSource
}

export interface DeactivationResult {
  workspaceId: string
  /** Watchlists that were active and are not any more. Zero is a normal answer. */
  deactivated: number
}

export class RestError extends Error {
  readonly status: number
  readonly code: string | null

  constructor(message: string, status: number, code: string | null) {
    super(message)
    this.name = 'RestError'
    this.status = status
    this.code = code
  }
}

interface PostgrestErrorBody {
  code?: string
  message?: string
  details?: string
}

async function rest(
  credentials: RestCredentials,
  path: string,
  init: { method: string; body?: unknown; prefer?: string },
): Promise<unknown> {
  const doFetch = credentials.fetchImpl ?? fetch
  const url = `${credentials.supabaseUrl.replace(/\/$/, '')}/rest/v1/${path}`

  const response = await doFetch(url, {
    method: init.method,
    headers: {
      apikey: credentials.serviceRoleKey,
      authorization: `Bearer ${credentials.serviceRoleKey}`,
      accept: 'application/json',
      'content-type': 'application/json',
      ...(init.prefer === undefined ? {} : { prefer: init.prefer }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    // A webhook that hangs is redelivered anyway; hanging just holds a Vercel function open
    // until it is killed, and Clerk retries either way. Fail fast and let it retry.
    signal: AbortSignal.timeout(10_000),
  })

  if (!response.ok) {
    let body: PostgrestErrorBody = {}
    try {
      body = (await response.json()) as PostgrestErrorBody
    } catch {
      // A non-JSON error body (a gateway page, say) is still a failure; it just carries no
      // Postgres error code, and `code: null` is what the caller checks against.
    }
    throw new RestError(
      `${init.method} ${path} failed: ${response.status} ${body.message ?? response.statusText}`,
      response.status,
      body.code ?? null,
    )
  }

  // `Prefer: return=minimal` answers 201 with an empty body, and `response.json()` on an
  // empty body throws a SyntaxError that would surface as "the audit append failed" on a
  // write that in fact succeeded — a retry storm caused entirely by how the success was read.
  if (response.status === 204) return []
  const text = await response.text()
  if (text === '') return []
  return JSON.parse(text) as unknown
}

/**
 * A URL-safe slug from an organization name.
 *
 * Accents are stripped rather than dropped, so "Diseño" becomes `diseno` and not `disen`:
 * this is a Mexican-market product and an advertiser name without accents is the common
 * case, not the exotic one.
 */
export function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
}

/**
 * Pick the slug to store, and say where it came from.
 *
 * Falling back rather than rejecting the event is the point. `slug` is a display string;
 * refusing to provision over a missing one would leave the user in exactly the silent
 * empty-dashboard state this whole use case exists to remove, over a cosmetic column.
 */
export function resolveSlug(input: WorkspaceUpsertInput): { slug: string; source: SlugSource } {
  const fromClerk = input.slug === null ? '' : slugify(input.slug)
  if (fromClerk !== '') return { slug: fromClerk, source: 'clerk' }

  const fromName = slugify(input.name)
  if (fromName !== '') return { slug: fromName, source: 'name' }

  // Neither is usable — an org named entirely in a script the slugifier strips, say. The
  // org id is unique by construction, which is the only property this column actually needs.
  return { slug: input.clerkOrgId.toLowerCase(), source: 'org-id' }
}

/**
 * Two organizations can legitimately be called the same thing, and `workspaces.slug` is
 * unique. Suffixing with a fragment of the org id keeps the slug recognisable while making
 * the collision impossible, rather than failing the provisioning over a display string.
 */
function disambiguate(slug: string, clerkOrgId: string): string {
  const suffix = clerkOrgId.replace(/[^a-zA-Z0-9]/g, '').slice(-6).toLowerCase()
  return `${slug.slice(0, 40)}-${suffix}`
}

async function findByOrgId(
  credentials: RestCredentials,
  clerkOrgId: string,
): Promise<WorkspaceRow | null> {
  const rows = (await rest(
    credentials,
    `workspaces?clerk_org_id=eq.${encodeURIComponent(clerkOrgId)}&select=id,clerk_org_id,name,slug`,
    { method: 'GET' },
  )) as WorkspaceRow[]
  return rows[0] ?? null
}

/**
 * Create or update the workspace behind a Clerk organization.
 *
 * Returns `unchanged` when the stored row already says exactly this, so that a Svix
 * redelivery is silent all the way down to the audit log.
 */
export async function provisionWorkspace(
  credentials: RestCredentials,
  input: WorkspaceUpsertInput,
): Promise<ProvisionResult> {
  const existing = await findByOrgId(credentials, input.clerkOrgId)
  const resolved = resolveSlug(input)

  if (existing !== null) {
    // The stored slug is compared against the *resolved* one, so an org that later gains a
    // real slug in Clerk stops being called by its fallback.
    if (existing.name === input.name && existing.slug === resolved.slug) {
      return {
        outcome: 'unchanged',
        workspaceId: existing.id,
        name: existing.name,
        slug: existing.slug,
        slugSource: resolved.source,
      }
    }

    const patched = (await rest(
      credentials,
      `workspaces?clerk_org_id=eq.${encodeURIComponent(input.clerkOrgId)}`,
      {
        method: 'PATCH',
        body: { name: input.name, slug: resolved.slug },
        prefer: 'return=representation',
      },
    )) as WorkspaceRow[]

    const row = patched[0] ?? { ...existing, name: input.name, slug: resolved.slug }
    return {
      outcome: 'renamed',
      workspaceId: row.id,
      name: row.name,
      slug: row.slug,
      slugSource: resolved.source,
    }
  }

  try {
    return await insertWorkspace(credentials, input, resolved.slug, resolved.source)
  } catch (error) {
    if (!(error instanceof RestError) || error.code !== UNIQUE_VIOLATION) throw error

    // Two different conflicts arrive as the same status, and they need opposite responses.
    // A concurrent delivery of the *same* event is already-provisioned and must answer 200,
    // or Clerk retries a success forever. A slug collision with a *different* organization
    // is ours to resolve, and dropping the event over it would leave that org unprovisioned.
    const raced = await findByOrgId(credentials, input.clerkOrgId)
    if (raced !== null) {
      return {
        outcome: 'unchanged',
        workspaceId: raced.id,
        name: raced.name,
        slug: raced.slug,
        slugSource: resolved.source,
      }
    }

    return await insertWorkspace(
      credentials,
      input,
      disambiguate(resolved.slug, input.clerkOrgId),
      'name-disambiguated',
    )
  }
}

async function insertWorkspace(
  credentials: RestCredentials,
  input: WorkspaceUpsertInput,
  slug: string,
  slugSource: SlugSource,
): Promise<ProvisionResult> {
  const inserted = (await rest(credentials, 'workspaces', {
    method: 'POST',
    body: { clerk_org_id: input.clerkOrgId, name: input.name, slug },
    prefer: 'return=representation',
  })) as WorkspaceRow[]

  const row = inserted[0]
  if (row === undefined) {
    throw new RestError('workspace insert returned no row', 500, null)
  }
  return {
    outcome: 'created',
    workspaceId: row.id,
    name: row.name,
    slug: row.slug,
    slugSource,
  }
}

/**
 * What `organization.deleted` does — which is emphatically not a delete.
 *
 * Every table in the product cascades from `workspaces`, and domain rule 1 is what makes
 * that unrecoverable rather than merely expensive: the Ad Library has no history, so a
 * cascade takes weeks of panel that cannot be re-crawled at any price. Deleting a Clerk
 * organization is two clicks in a settings page we do not own and cannot add a confirmation
 * to; wiring it to that cascade puts the panel behind someone else's UI.
 *
 * What genuinely has to stop is the spending. `app.enqueue_daily_crawls` reads
 * `where is_active`, so a dead organization's watchlists would otherwise mint a crawl job
 * every morning forever and bill Apify for data nobody can sign in to read.
 *
 * Returns `null` for an organization that was never provisioned — a delete for something we
 * never had is not an error, and must not be retried.
 */
export async function deactivateWorkspace(
  credentials: RestCredentials,
  clerkOrgId: string,
): Promise<DeactivationResult | null> {
  const existing = await findByOrgId(credentials, clerkOrgId)
  if (existing === null) return null

  // Filtered on `is_active=eq.true` so the returned representation counts what actually
  // changed. Patching every watchlist would report a number that includes ones already
  // stopped, and the audit event would overstate what this delivery did.
  const stopped = (await rest(
    credentials,
    `watchlists?workspace_id=eq.${encodeURIComponent(existing.id)}&is_active=eq.true`,
    { method: 'PATCH', body: { is_active: false }, prefer: 'return=representation' },
  )) as { id: string }[]

  return { workspaceId: existing.id, deactivated: stopped.length }
}

export interface RestAuditEventInput {
  workspaceId: string
  traceId: TraceId
  actor: Actor
  type: string
  subjectType?: string
  subjectId?: string
  payload?: Record<string, unknown>
}

/**
 * `appendAuditEvent` over PostgREST, for the same reason this file exists at all.
 *
 * The SQL version in `audit.ts` stays the one every other caller uses; this is the webhook's
 * only option, since it has no tenant connection to append through. Same table, same
 * append-only guarantees — those live on the table, not in the client.
 */
export async function postAuditEvent(
  credentials: RestCredentials,
  input: RestAuditEventInput,
): Promise<void> {
  await rest(credentials, 'audit_events', {
    method: 'POST',
    body: {
      workspace_id: input.workspaceId,
      trace_id: input.traceId,
      actor: input.actor,
      type: input.type,
      subject_type: input.subjectType ?? null,
      subject_id: input.subjectId ?? null,
      payload: input.payload ?? {},
    },
    prefer: 'return=minimal',
  })
}
