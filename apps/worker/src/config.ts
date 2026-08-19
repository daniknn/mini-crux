/**
 * Environment, read once and validated loudly.
 *
 * DashOne §3: code reads env and fails fast if missing. "Fails fast" is doing real work
 * here — a worker that starts with no `SUPABASE_DB_URL` and discovers it on the first claim
 * looks healthy in the platform dashboard while the queue silently backs up, and the thing
 * backing up is the one job in this system that cannot be run late.
 */

export class MissingConfig extends Error {
  override readonly name = 'MissingConfig'
}

export interface WorkerSettings {
  /** BYPASSRLS. Never the authenticator URL the web app uses — see spec rule 5. */
  databaseUrl: string
  supabaseUrl: string
  serviceRoleKey: string
  rawBucket: string
  mediaBucket: string
  apifyToken: string
  apifyActorId: string
  /** UC-8 semantic tagging. */
  openaiApiKey: string
  vlmModel: string
  pollIntervalMs: number
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (value === undefined || value === '') {
    throw new MissingConfig(
      `${name} is not set. Secrets come from Doppler — try \`doppler run -- …\`.`,
    )
  }
  return value
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): WorkerSettings {
  const databaseUrl = required(env, 'SUPABASE_DB_URL')

  // Spec rule 5, enforced rather than reviewed. Handing the worker the authenticator URL
  // would not fail — every query would run, RLS would apply, and the crawl would write
  // nothing while reporting success, because a role with no rows visible sees an empty
  // watchlist rather than an error. The failure is silent in both directions, so the check
  // has to happen before the first query rather than be inferred from one.
  if (databaseUrl.includes('authenticator@')) {
    throw new MissingConfig(
      'SUPABASE_DB_URL points at the `authenticator` role. The worker needs the BYPASSRLS ' +
        'connection; the authenticator URL belongs to the web app and would make every ' +
        'cross-tenant write silently do nothing.',
    )
  }

  const pollRaw = env['WORKER_POLL_INTERVAL_MS'] ?? '2000'
  const pollIntervalMs = Number(pollRaw)
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new MissingConfig(`WORKER_POLL_INTERVAL_MS must be a positive number, got "${pollRaw}"`)
  }

  return {
    databaseUrl,
    supabaseUrl: required(env, 'SUPABASE_URL'),
    serviceRoleKey: required(env, 'SUPABASE_SERVICE_ROLE_KEY'),
    rawBucket: env['SUPABASE_RAW_BUCKET'] ?? 'raw',
    mediaBucket: env['SUPABASE_MEDIA_BUCKET'] ?? 'media',
    apifyToken: required(env, 'APIFY_TOKEN'),
    apifyActorId: required(env, 'APIFY_AD_LIBRARY_ACTOR_ID'),
    openaiApiKey: required(env, 'OPENAI_API_KEY'),
    vlmModel: env['VLM_MODEL'] ?? 'gpt-4o-mini',
    pollIntervalMs,
  }
}
