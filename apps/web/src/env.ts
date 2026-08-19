/**
 * Environment contract. Every secret comes from Doppler (DashOne §3); this module's only
 * job is to fail loudly at boot when one is missing, rather than at 3am on a code path
 * nobody exercised.
 *
 * Server-only values are read lazily so that importing this file from a client component
 * cannot leak them.
 */

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Values live in Doppler — start the app with \`doppler run -- pnpm dev\`.`,
    )
  }
  return value
}

/** Safe to reference from the browser: Next.js inlines NEXT_PUBLIC_* at build time. */
export const publicEnv = {
  clerkPublishableKey: process.env['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY'] ?? '',
} as const

export function serverEnv(): {
  clerkSecretKey: string
  clerkWebhookSecret: string
  supabaseUrl: string
  supabaseServiceRoleKey: string
  databaseUrl: string
  healthCheckToken: string
} {
  return {
    clerkSecretKey: required('CLERK_SECRET_KEY'),
    // Signs the organization webhook. `required` rather than optional for the same reason
    // as the health token: the failure mode of a default is an endpoint that accepts
    // unsigned requests, and this one writes the row every RLS policy resolves against.
    clerkWebhookSecret: required('CLERK_WEBHOOK_SECRET'),
    supabaseUrl: required('SUPABASE_URL'),
    supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    // The ingestion alarm's only credential. It is a shared secret rather than a Clerk
    // session because an uptime checker cannot hold one, and `required` rather than
    // optional-with-a-default because the failure mode of a default is an open endpoint
    // that nobody notices is open.
    healthCheckToken: required('HEALTH_CHECK_TOKEN'),
    // Deliberately NOT `SUPABASE_DB_URL`. That one is the migration runner's connection:
    // a direct session as `postgres`, which is BYPASSRLS because it has to create policies.
    // Pointing the dashboard at it would disable every tenancy guarantee in the product
    // while every test still passed, because the tests connect as `authenticated`.
    databaseUrl: required('SUPABASE_DB_AUTHENTICATOR_URL'),
  }
}
