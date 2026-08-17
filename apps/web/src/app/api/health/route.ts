import { newTraceId } from '@mini-crux/core'
import { NextResponse } from 'next/server'

/**
 * Liveness probe. Public (see `middleware.ts`) and deliberately incurious: it reports that
 * the process is up, not that any dependency is healthy, so a Supabase blip never takes
 * the deployment down with it.
 *
 * It mints a `trace_id` because every ingress does (DashOne §3) — including this one.
 */
export function GET(): NextResponse {
  return NextResponse.json({
    status: 'ok',
    traceId: newTraceId(),
    timestamp: new Date().toISOString(),
  })
}
