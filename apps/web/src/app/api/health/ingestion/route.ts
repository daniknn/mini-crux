import { newTraceId } from '@mini-crux/core'
import { fetchIngestionHealth, summarizeIngestionHealth } from '@mini-crux/db'
import { NextResponse, type NextRequest } from 'next/server'

import { serverEnv } from '../../../../env.ts'

/**
 * The alarm.
 *
 * `/api/health` next door is a liveness probe and deliberately incurious. This one is the
 * opposite: it asks the only question whose wrong answer is silent — did today's crawl
 * actually happen, for every active watchlist, in every workspace?
 *
 * WHY A SHARED SECRET AND NOT CLERK
 *
 * The caller is an uptime checker. It cannot hold a session, and giving it one would mean
 * minting a service user with a real workspace, which is a larger blast radius than a token
 * that can only ever read this. The route is listed as public in `middleware.ts` so Clerk
 * does not bounce it before the token is examined — "public" there means "Clerk does not
 * gate it", not "ungated".
 *
 * WHY THIS IS SAFE TO ANSWER INSTANCE-WIDE
 *
 * The body carries watchlist labels, queries and crawl states. It carries no creative data,
 * no ad copy, no advertiser panel — nothing that is anyone's competitive intelligence. It is
 * still gated, because a competitor list is a hint about the customer even when it is not
 * data about the market.
 *
 * WHY 503 AND NOT 200-WITH-A-STATUS-FIELD
 *
 * The whole value here is that a stock uptime checker, configured by someone who will never
 * read this file, goes red without being taught anything. A `200 {"status":"degraded"}` is
 * green to every such checker on the market.
 */

/**
 * Never prerendered and never cached. A cached alarm reports the state of the last build,
 * which is the most confidently wrong thing an alarm can do.
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Constant-time compare, so the response time cannot be used to recover the token one byte
 * at a time. Length is compared first and separately — that much is unavoidably observable,
 * and it leaks nothing an attacker cannot guess from the documented generator.
 */
function tokenMatches(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < presented.length; i += 1) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0
}

function bearer(request: NextRequest): string | null {
  const header = request.headers.get('authorization')
  if (header === null) return null
  const match = /^Bearer (.+)$/i.exec(header.trim())
  return match?.[1] ?? null
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const traceId = newTraceId()

  let env: ReturnType<typeof serverEnv>
  try {
    env = serverEnv()
  } catch {
    // A missing `HEALTH_CHECK_TOKEN` must not present as an open endpoint, and must not
    // present as "healthy" either. 500 is honest: the alarm itself is misconfigured.
    return NextResponse.json({ status: 'misconfigured', traceId }, { status: 500 })
  }

  const presented = bearer(request)
  if (presented === null || !tokenMatches(presented, env.healthCheckToken)) {
    // Says nothing: not whether the token was absent or wrong, not whether any watchlist
    // exists, not whether the instance is healthy. An unauthenticated caller learns only
    // that the route is there, which they already knew by asking.
    return NextResponse.json({ status: 'unauthorized' }, { status: 401 })
  }

  let summary: ReturnType<typeof summarizeIngestionHealth>
  try {
    const rows = await fetchIngestionHealth({
      supabaseUrl: env.supabaseUrl,
      serviceRoleKey: env.supabaseServiceRoleKey,
    })
    summary = summarizeIngestionHealth(rows)
  } catch (error) {
    // Unreachable database is not "no watchlists are unhealthy". Both are red, and the
    // distinction is the first thing the runbook asks for.
    return NextResponse.json(
      {
        status: 'unknown',
        traceId,
        error: error instanceof Error ? error.message : 'ingestion health read failed',
      },
      { status: 503 },
    )
  }

  return NextResponse.json(
    { ...summary, traceId, checkedAt: new Date().toISOString() },
    { status: summary.status === 'ok' ? 200 : 503 },
  )
}
