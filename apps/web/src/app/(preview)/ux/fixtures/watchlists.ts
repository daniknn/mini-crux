import type { IngestionHealthSummary } from '@mini-crux/db'
import type { Watchlist } from '@mini-crux/db/dashboard'

/**
 * Watchlists and ingestion health, invented.
 *
 * The two offenders are `failed` and `suspect`, which is the pair worth putting side by side:
 * they render almost identically and are not the same problem. A failed crawl wrote nothing
 * and a retry before midnight in the market still saves the panel date; a suspect one wrote
 * the creatives it saw and withheld every absence, so nothing is broken and the panel is
 * quietly thinner. If the card makes those look the same, the review should catch it here.
 *
 * `startedAt` is a fixed instant rather than `new Date()`. A fixture that reads the clock
 * renders a different card every time it is opened, and a design review needs the screenshot
 * from Tuesday to be the screen from Tuesday.
 */

export const WATCHLISTS: Watchlist[] = [
  {
    id: 'wl-0001',
    kind: 'keyword',
    query: 'seguro de auto',
    country: 'MX',
    label: 'Seguros de auto — genérico',
    isActive: true,
    lastRunDate: '2026-08-19',
    lastRunStatus: 'succeeded',
    succeededRuns: 74,
    failedRuns: 3,
    suspectRuns: 2,
  },
  {
    id: 'wl-0002',
    kind: 'page',
    query: '104928374650192',
    country: 'MX',
    label: 'Bodega Aurora (página)',
    isActive: true,
    lastRunDate: '2026-08-19',
    lastRunStatus: 'suspect',
    succeededRuns: 68,
    failedRuns: 2,
    // Nine days where the payload came back at a fraction of the day before. Present
    // creatives were recorded and every absence was withheld — the panel is thinner, not
    // wrong, and the operator has to be able to see the difference.
    suspectRuns: 9,
  },
  {
    id: 'wl-0003',
    kind: 'keyword',
    query: 'café de especialidad',
    country: 'MX',
    label: 'Café de especialidad',
    isActive: true,
    lastRunDate: '2026-08-18',
    lastRunStatus: 'failed',
    succeededRuns: 51,
    failedRuns: 12,
    suspectRuns: 0,
  },
  {
    id: 'wl-0004',
    kind: 'keyword',
    query: 'despensa a domicilio',
    country: 'MX',
    label: 'Despensa a domicilio (pausada)',
    isActive: false,
    lastRunDate: '2026-07-04',
    lastRunStatus: 'succeeded',
    succeededRuns: 31,
    failedRuns: 1,
    suspectRuns: 0,
  },
]

export const INGESTION_HEALTH: IngestionHealthSummary = {
  status: 'degraded',
  marketDate: '2026-08-19',
  counts: {
    watchlists: 3,
    succeeded: 1,
    inFlight: 0,
    offenders: 2,
  },
  offenders: [
    {
      workspaceId: 'ws-preview',
      watchlistId: 'wl-0003',
      label: 'Café de especialidad',
      reason: 'failed',
      // Provider errors only. Never creative data — this string is rendered verbatim.
      error: 'provider timeout after 120s',
      attempt: 2,
      startedAt: new Date('2026-08-19T13:12:00Z'),
    },
    {
      workspaceId: 'ws-preview',
      watchlistId: 'wl-0002',
      label: 'Bodega Aurora (página)',
      reason: 'suspect',
      error: null,
      attempt: 1,
      startedAt: new Date('2026-08-19T13:04:00Z'),
    },
  ],
}

/** A workspace on its first day: no lists, so no market date to measure anything against. */
export const INGESTION_HEALTH_EMPTY: IngestionHealthSummary = {
  status: 'ok',
  marketDate: null,
  counts: { watchlists: 0, succeeded: 0, inFlight: 0, offenders: 0 },
  offenders: [],
}
