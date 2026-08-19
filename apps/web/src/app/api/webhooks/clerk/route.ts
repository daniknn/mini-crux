import { verifyWebhook } from '@clerk/nextjs/webhooks'
import type { Actor } from '@mini-crux/core'
import { newTraceId } from '@mini-crux/core'
import { deactivateWorkspace, postAuditEvent, provisionWorkspace } from '@mini-crux/db'
import { NextResponse, type NextRequest } from 'next/server'

import { serverEnv } from '../../../../env.ts'

/**
 * The Clerk organization webhook — the writer migration `0001` always assumed.
 *
 * `workspaces.clerk_org_id` is what every RLS policy in the product resolves against, via
 * `app.current_workspace_id()`. Without a row, a perfectly valid session with a real
 * `org_id` claim resolves to null and every query returns zero rows: the dashboard renders
 * empty, with no error in the browser, the server log, or `audit_events` — appending to
 * which needs a `workspace_id` too. That silence is the whole reason this route exists.
 *
 * WHY THE SIGNATURE CHECK COMES FIRST AND FROM CLERK
 *
 * `verifyWebhook` is Clerk's own Svix verification, bundled with `@clerk/nextjs`. Nothing
 * here parses the body before it returns: an unsigned caller could otherwise rename any
 * workspace on the instance, or point one at an org id it controls.
 *
 * WHY THE ROUTE IS "PUBLIC" IN `middleware.ts`
 *
 * Same sense as `/api/health/ingestion`: Clerk's *session* gate does not apply, because the
 * caller is Clerk itself and holds no session. It is not ungated — the signature is the gate.
 *
 * WHY EVERY BRANCH IS DELIBERATE ABOUT ITS STATUS CODE
 *
 * Clerk redelivers on any non-2xx and eventually disables an endpoint that keeps failing.
 * So: a real write failure answers 5xx *because* we want the retry (a customer with no
 * workspace has no second chance to notice); an event we do not handle, or one for an
 * organization we have never seen, answers 200, because retrying it forever costs the
 * endpoint its reputation and fixes nothing.
 */

export const dynamic = 'force-dynamic'
export const revalidate = 0

/** `id` is the agent's name, per the `Actor` contract in `@mini-crux/core`. */
function webhookActor(eventType: string): Actor {
  return { type: 'agent', id: 'clerk-webhook', label: eventType }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const traceId = newTraceId()

  let env: ReturnType<typeof serverEnv>
  try {
    env = serverEnv()
  } catch {
    // Misconfiguration must not present as "accepted". A 500 gets retried, which is right:
    // the deliveries queue up and land once the secret is set, rather than being lost.
    return NextResponse.json({ status: 'misconfigured', traceId }, { status: 500 })
  }

  let event: Awaited<ReturnType<typeof verifyWebhook>>
  try {
    event = await verifyWebhook(request, { signingSecret: env.clerkWebhookSecret })
  } catch {
    // Says nothing about why. A caller who cannot sign a request learns only that the route
    // exists, which they already knew by reaching it.
    return NextResponse.json({ status: 'unauthorized' }, { status: 401 })
  }

  const credentials = {
    supabaseUrl: env.supabaseUrl,
    serviceRoleKey: env.supabaseServiceRoleKey,
  }

  try {
    if (event.type === 'organization.created' || event.type === 'organization.updated') {
      const result = await provisionWorkspace(credentials, {
        clerkOrgId: event.data.id,
        name: event.data.name,
        slug: event.data.slug ?? null,
      })

      // An `unchanged` outcome wrote nothing, and must not append an audit event either: a
      // redelivery that logs a second `workspace.provisioned` is not a duplicate write, it
      // is a false claim that something happened twice in an append-only log.
      if (result.outcome !== 'unchanged') {
        await postAuditEvent(credentials, {
          workspaceId: result.workspaceId,
          traceId,
          actor: webhookActor(event.type),
          type: result.outcome === 'created' ? 'workspace.provisioned' : 'workspace.renamed',
          subjectType: 'workspace',
          subjectId: result.workspaceId,
          payload: {
            clerkOrgId: event.data.id,
            name: result.name,
            slug: result.slug,
            slugSource: result.slugSource,
          },
        })
      }

      return NextResponse.json({ outcome: result.outcome, traceId }, { status: 200 })
    }

    if (event.type === 'organization.deleted') {
      const clerkOrgId = event.data.id
      if (clerkOrgId === undefined) {
        return NextResponse.json({ outcome: 'ignored', traceId }, { status: 200 })
      }

      // Deliberately not a delete. Every table in the product cascades from `workspaces`,
      // and the Ad Library has no history (domain rule 1) — a cascade takes weeks of panel
      // that cannot be re-crawled at any price, triggered by two clicks in a settings page
      // we do not own. What has to stop is the spending, so the watchlists are deactivated
      // and everything else is left exactly where it is.
      const result = await deactivateWorkspace(credentials, clerkOrgId)
      if (result === null) {
        // An organization we never provisioned. Not an error, and not worth a retry.
        return NextResponse.json({ outcome: 'unknown-organization', traceId }, { status: 200 })
      }

      await postAuditEvent(credentials, {
        workspaceId: result.workspaceId,
        traceId,
        actor: webhookActor(event.type),
        type: 'workspace.deactivated',
        subjectType: 'workspace',
        subjectId: result.workspaceId,
        payload: { clerkOrgId, watchlistsDeactivated: result.deactivated },
      })

      return NextResponse.json(
        { outcome: 'deactivated', deactivated: result.deactivated, traceId },
        { status: 200 },
      )
    }

    // Clerk's dashboard makes it easy to subscribe an endpoint to more than it handles.
    // Answering 4xx would have Clerk retry an event we will never process, and eventually
    // disable the endpoint that provisioning depends on.
    return NextResponse.json({ outcome: 'ignored', type: event.type, traceId }, { status: 200 })
  } catch (error) {
    return NextResponse.json(
      {
        status: 'error',
        traceId,
        error: error instanceof Error ? error.message : 'workspace provisioning failed',
      },
      { status: 500 },
    )
  }
}
