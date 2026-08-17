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
  supabaseUrl: string
  supabaseServiceRoleKey: string
} {
  return {
    clerkSecretKey: required('CLERK_SECRET_KEY'),
    supabaseUrl: required('SUPABASE_URL'),
    supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  }
}
