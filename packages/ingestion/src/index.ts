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
  DEFAULT_REACH_BOUND,
  PROXY_VALIDATION_JOB_TYPE,
  runProxyValidation,
} from './proxy-validation.ts'
export type {
  ProxyValidationDeps,
  RunProxyValidationInput,
  RunProxyValidationOutcome,
} from './proxy-validation.ts'
export {
  createMemoryStore,
  createSupabaseStore,
  getSnapshot,
  putSnapshot,
  proxyValidationSnapshotPath,
  SNAPSHOT_SCHEMA_VERSION,
  SnapshotExistsError,
  snapshotPath,
} from './storage.ts'
export type { ObjectStore, ProxyValidationSnapshotEnvelope, SnapshotEnvelope } from './storage.ts'
