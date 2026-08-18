import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { SqlExecutor } from './types.ts'

export { appendAuditEvent, findAuditEventsByTrace } from './audit.ts'
export type { AuditEvent, AuditEventInput } from './audit.ts'
export { enqueueJob, withIdempotency } from './jobs.ts'
export type {
  EnqueueJobInput,
  EnqueueJobResult,
  IdempotencyKey,
  IdempotentResult,
} from './jobs.ts'
export { checksum, loadMigrations, runMigrations } from './migrate.ts'
export { currentWorkspaceId, MissingTenantClaimsError, withTenant } from './tenant.ts'
export type { TenantClaims } from './tenant.ts'
export type {
  AppliedMigration,
  Logger,
  MigrationFile,
  MigrationResult,
  SqlExecutor,
} from './types.ts'

/** Absolute path to `supabase/migrations`, resolved from this package's location. */
export const MIGRATIONS_DIR: string = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'supabase',
  'migrations',
)

/** Shape of a node-postgres client/pool — declared structurally to avoid the dependency. */
interface PgLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>
}

/**
 * Adapt a node-postgres client to {@link SqlExecutor}.
 *
 * The connection MUST use a BYPASSRLS role (Supabase's `service_role` or `postgres`):
 * migrations create policies and touch every table, which an RLS-constrained role
 * cannot do.
 */
export function fromPgClient(client: PgLike): SqlExecutor {
  return {
    async exec(sql: string): Promise<void> {
      await client.query(sql)
    },
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      const result = await client.query(sql, params)
      return result.rows as T[]
    },
  }
}
