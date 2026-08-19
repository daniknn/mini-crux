import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Same reason as packages/db: each suite boots its own WASM Postgres.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
