/**
 * The provider boundary (CLAUDE.md rule 11).
 *
 * Everything downstream of this file — parsing, dedup, the panel, the analysis — is written
 * against these types and knows nothing about Apify. v1 rents an actor because the Ad Library
 * is React-rendered with active bot detection and a self-maintained scraper is a recurring
 * tax paid before the thesis is validated (ARCHITECTURE.md §9). When that trade flips, an
 * owned Playwright scraper implements this interface and nothing else changes.
 *
 * LEGAL POSTURE (ARCHITECTURE.md §9, CLAUDE.md rule 10): collection is logged-off only,
 * never with an authenticated Meta session. Renting a provider does not transfer that
 * obligation — see {@link AdLibraryProvider} for how it is asserted rather than assumed.
 */

/** The two ways the Ad Library can be queried. Mirrors `watchlist_kind` in migration 0002. */
export type WatchlistKind = 'keyword' | 'page'

export interface CrawlQuery {
  kind: WatchlistKind
  /** The search term for `keyword`, the Meta page id for `page`. */
  query: string
  /** ISO-3166 alpha-2, uppercase. */
  country: string
}

export type MediaType = 'video' | 'image' | 'unknown'

/**
 * One ad as the provider reports it, normalized.
 *
 * Note this is an *ad*, not a creative: the same creative appears here once per
 * `adArchiveId`. Collapsing ads into creatives is the parser's job, not the provider's,
 * because the dedup rule is a product decision that must not vary by provider.
 */
export interface AdLibraryAd {
  adArchiveId: string
  pageId: string
  pageName: string
  /**
   * Meta's own start date. This is the survival start (CLAUDE.md rule 5) — never
   * substitute our own first-seen timestamp, which would left-censor every ad that was
   * already running when we started crawling.
   */
  adDeliveryStartTime: string | null
  mediaType: MediaType
  mediaUrl: string | null
  adCopy: string | null
  publisherPlatforms: string[]
  /** How many variants Meta reports behind this archive id. Absent means one. */
  variantCount: number
}

export interface CrawlResult {
  ads: AdLibraryAd[]
  /** Provider-side run identifier, kept for support tickets and reprocessing. */
  providerRunId: string | null
  /** The provider's response verbatim. Landed to Storage before anything is parsed. */
  raw: unknown
}

export interface AdLibraryProvider {
  /** Stable identifier recorded on the snapshot envelope, e.g. `apify`. */
  readonly name: string
  /**
   * Asserts the collection mode. Kept as data rather than a comment so a provider that
   * ever needs a session cannot be wired in silently — the crawl handler refuses to run
   * a provider that does not declare `loggedOff`.
   */
  readonly collectionMode: 'logged-off'
  crawl(query: CrawlQuery, options?: { signal?: AbortSignal }): Promise<CrawlResult>
}

/** Raised for provider-side failures that a retry might fix (timeout, 5xx, rate limit). */
export class ProviderError extends Error {
  readonly retryable: boolean

  constructor(message: string, options?: { retryable?: boolean; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ProviderError'
    this.retryable = options?.retryable ?? true
  }
}
