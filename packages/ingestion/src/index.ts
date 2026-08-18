export { classifyRun, MAX_CRAWL_ATTEMPTS, runCrawl, SUSPECT_VOLUME_RATIO } from './crawl.ts'
export type {
  CrawlAlert,
  CrawlDeps,
  CrawlRunRow,
  RunCrawlInput,
  RunCrawlOutcome,
} from './crawl.ts'
export {
  creativeIdentityFromAd,
  creativeIdentityFromMedia,
  normalizeCopy,
} from './creative-hash.ts'
export type { CreativeHashBasis, CreativeIdentity } from './creative-hash.ts'
export { extractAds, runParse } from './parse.ts'
export type { ParseDeps, ParseSummary, RunParseInput, RunParseOutcome } from './parse.ts'
export * from './providers/ad-library/index.ts'
export {
  createMemoryStore,
  createSupabaseStore,
  getSnapshot,
  putSnapshot,
  SNAPSHOT_SCHEMA_VERSION,
  SnapshotExistsError,
  snapshotPath,
} from './storage.ts'
export type { ObjectStore, SnapshotEnvelope } from './storage.ts'
