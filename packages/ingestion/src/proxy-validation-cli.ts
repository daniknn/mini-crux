#!/usr/bin/env node
/**
 * Trigger UC-7's ES validation crawl deliberately.
 *
 *   doppler run -- pnpm proxy-validation:once --workspace <id> --kind keyword --query "moda"
 *   doppler run -- pnpm proxy-validation:once --workspace <id> --kind page --query <meta-page-id> \
 *     --reach-bound max
 *
 * This is the only trigger for `proxy_validation` — there is no cron entry (spec: "in the EU,
 * longitudinal data can be backfilled... this is a research instrument, run deliberately, not
 * a daily tick"). Like `crawl:once`, it runs the whole thing in-process rather than enqueuing
 * a job and waiting for a worker to pick it up: an operator watching this run is the point.
 *
 * No `jobs` row backs this call, so `RunProxyValidationInput.jobId` is left unset — the
 * `processed_messages` ledger row it writes has a null `job_id`, same as `parse:once` would.
 */

import { newMessageId, newTraceId, operatorActor } from '@mini-crux/core'
import { fromPgClient } from '@mini-crux/db'
import { Client } from 'pg'

import { DEFAULT_REACH_BOUND, runProxyValidation } from './proxy-validation.ts'
import { createApifyProvider } from './providers/ad-library/index.ts'
import type { WatchlistKind } from './providers/ad-library/index.ts'
import { createSupabaseStore } from './storage.ts'

interface Args {
  workspaceId: string
  kind: WatchlistKind
  query: string
  reachBound: 'min' | 'max'
  operatorId: string
}

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set. Secrets come from Doppler — try \`doppler run -- …\`.`)
  }
  return value
}

function parseArgs(argv: string[]): Args {
  let workspaceId: string | null = null
  let kind: string | null = null
  let query: string | null = null
  let reachBound: string | null = null
  let operatorId: string | null = null

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--workspace') workspaceId = argv[i + 1] ?? null
    if (argv[i] === '--kind') kind = argv[i + 1] ?? null
    if (argv[i] === '--query') query = argv[i + 1] ?? null
    if (argv[i] === '--reach-bound') reachBound = argv[i + 1] ?? null
    if (argv[i] === '--operator') operatorId = argv[i + 1] ?? null
  }

  if (workspaceId === null || kind === null || query === null) {
    throw new Error(
      'Usage: proxy-validation:once --workspace <id> --kind keyword|page --query <term> ' +
        '[--reach-bound min|max] [--operator <id>]',
    )
  }
  if (kind !== 'keyword' && kind !== 'page') {
    throw new Error(`--kind must be "keyword" or "page", got "${kind}"`)
  }
  if (reachBound !== null && reachBound !== 'min' && reachBound !== 'max') {
    throw new Error(`--reach-bound must be "min" or "max", got "${reachBound}"`)
  }

  return {
    workspaceId,
    kind,
    query,
    reachBound: reachBound ?? DEFAULT_REACH_BOUND,
    // Falls back to a fixed id rather than requiring a flag every time: this is a research
    // tool run by whoever has the terminal, and the audit trail cares that it says
    // "operator", not which engineer's shell it was.
    operatorId: operatorId ?? process.env['OPERATOR_USER_ID'] ?? 'cli',
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  const client = new Client({ connectionString: required('SUPABASE_DB_URL') })
  await client.connect()
  const db = fromPgClient(client)

  try {
    const provider = createApifyProvider({
      token: required('APIFY_TOKEN'),
      actorId: required('APIFY_AD_LIBRARY_ACTOR_ID'),
    })
    const store = createSupabaseStore(await openRawBucket())

    console.log(`[proxy-validation:once] crawling ES ${args.kind}:${args.query}`)
    const outcome = await runProxyValidation(
      { db, store, provider },
      {
        workspaceId: args.workspaceId,
        traceId: newTraceId(),
        actor: operatorActor(args.operatorId, 'proxy-validation:once'),
        messageId: newMessageId(),
        query: { kind: args.kind, query: args.query, country: 'ES' },
        reachBoundUsed: args.reachBound,
      },
    )

    switch (outcome.status) {
      case 'published':
        console.log(
          `[proxy-validation:once] published run ${outcome.runId}: n=${outcome.nIncluded} ` +
            `(corpus ${outcome.corpusSize}), advertisers=${outcome.advertisersUsed}, ` +
            `beta=${outcome.beta.toFixed(3)}, verdict=${outcome.verdict}`,
        )
        break
      case 'refused':
        console.log(
          `[proxy-validation:once] refused run ${outcome.runId}: failed gate "${outcome.failedGate}"`,
        )
        console.log(JSON.stringify(outcome.detail, null, 2))
        break
      case 'already-processed':
        console.log('[proxy-validation:once] already processed; nothing to do')
        break
    }
  } finally {
    await client.end()
  }
}

/**
 * Imported lazily so the Supabase JS client is not a hard dependency of the library — same
 * reasoning as `cli.ts`'s `openRawBucket`.
 */
async function openRawBucket(): Promise<Parameters<typeof createSupabaseStore>[0]> {
  const { createClient } = await import('@supabase/supabase-js')
  const supabase = createClient(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'))
  return supabase.storage.from(process.env['SUPABASE_RAW_BUCKET'] ?? 'raw')
}

main().catch((error: unknown) => {
  console.error(`[proxy-validation:once] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
