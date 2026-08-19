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
export { createFixtureMediaUrlSigner, createSupabaseMediaUrlSigner } from './media-urls.ts'
export type { MediaUrlSigner, MediaUrlSignerConfig } from './media-urls.ts'
export {
  runSemanticTag,
  SEMANTIC_SCHEMA_VERSION,
  SEMANTIC_TAG_JOB_TYPE,
} from './semantic-tagging.ts'
export type {
  RunSemanticTagInput,
  RunSemanticTagOutcome,
  SemanticTagDeps,
} from './semantic-tagging.ts'
// Named, not `export *`: `createFixtureProvider`/`FixtureVlmProvider` collide by name with
// the ad-library provider's own fixture exports (two different providers, same fixture
// vocabulary). Re-exported under a `Vlm`-prefixed name so both fixtures are reachable from
// this barrel without ambiguity.
export {
  createFixtureProvider as createVlmFixtureProvider,
  createOpenAiVlmProvider,
  fixtureTagResponse,
  HOOK_TYPES,
  TONES,
} from './providers/vlm/index.ts'
export type {
  FixtureResponse as VlmFixtureResponse,
  FixtureVlmProvider,
  HookType,
  OpenAiVlmProviderConfig,
  TagCreativeInput,
  Tone,
  VlmProvider,
  VlmRawResponse,
} from './providers/vlm/index.ts'
