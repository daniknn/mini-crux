/**
 * Read and write paths for the UC-4 dashboard.
 *
 * Every function here takes a {@link SqlExecutor} that is already inside `withTenant`, and
 * none of them filter by workspace: RLS does that. See `internal.ts` for why a redundant
 * app-level filter would be camouflage rather than defence in depth.
 */

export { getChangeFeed } from './change-feed.ts'
export type {
  ChangeFeed,
  ChangeFeedEntry,
  ChangeFeedWindow,
  ChangeKind,
} from './change-feed.ts'

export { getCreativeDetail, listAdvertisers, listCreatives } from './creatives.ts'
export type {
  CreativeDetail,
  CreativeObservation,
  CreativeSummary,
  GalleryFilter,
  GallerySort,
} from './creatives.ts'

export { getPanelHealth } from './panel.ts'
export type { PanelHealth } from './panel.ts'

export { getStructuralProfile } from './structure.ts'
export type {
  MetricDistribution,
  StructuralComparison,
  StructuralProfile,
  StructuralProfileFilter,
} from './structure.ts'

export { createWatchlist, listWatchlists, renameWatchlist, setWatchlistActive } from './watchlists.ts'
export type { CreateWatchlistInput, Watchlist, WatchlistKind } from './watchlists.ts'
