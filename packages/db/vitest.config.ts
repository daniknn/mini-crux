import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // PGlite boots a WASM Postgres per suite; the default 5s timeout is not enough on a
    // cold start. Suites run in separate processes, so each gets its own database.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
