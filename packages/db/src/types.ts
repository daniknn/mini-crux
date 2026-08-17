/**
 * Minimal Postgres surface the migration runner needs.
 *
 * Deliberately structural rather than tied to a driver: production runs against
 * node-postgres, the test suite runs against PGlite (real Postgres, WASM), and neither
 * is a dependency of this package.
 */
export interface SqlExecutor {
  /** Run one or more statements with no parameters. */
  exec(sql: string): Promise<void>
  /** Run a single parameterized statement and return its rows. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
}

export interface AppliedMigration {
  version: string
  checksum: string
  applied_at: string
}

export interface MigrationFile {
  version: string
  name: string
  sql: string
  checksum: string
}

export interface MigrationResult {
  applied: string[]
  skipped: string[]
}

export type Logger = (message: string) => void
