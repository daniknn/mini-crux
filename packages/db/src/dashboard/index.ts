/**
 * Read and write paths for the dashboard surfaces.
 *
 * Every function here takes a {@link SqlExecutor} that is already inside `withTenant`, and
 * none of them filter by workspace: RLS does that. See `internal.ts` for why a redundant
 * app-level filter would be camouflage rather than defence in depth.
 *
 * `analysis.ts` reads what the UC-5 job wrote. The job itself lives in `../analysis/`, runs
 * on a BYPASSRLS worker, and filters by workspace explicitly — the two directories look
 * similar and follow opposite rules for good reasons, both documented at their heads.
 */

export { getLatestAnalysis } from './analysis.ts'
export type {
  AnalysisExclusions,
  AnalysisFeatureResult,
  LatestAnalysis,
} from './analysis.ts'

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

export { getLatestProxyValidation } from './proxy-validation.ts'
export type { LatestProxyValidation } from './proxy-validation.ts'

export { getStructuralProfile } from './structure.ts'
export type {
  MetricDistribution,
  StructuralComparison,
  StructuralProfile,
  StructuralProfileFilter,
} from './structure.ts'

export { createWatchlist, listWatchlists, renameWatchlist, setWatchlistActive } from './watchlists.ts'
export type { CreateWatchlistInput, Watchlist, WatchlistKind } from './watchlists.ts'
