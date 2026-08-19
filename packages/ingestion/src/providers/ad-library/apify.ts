import type {
  AdLibraryAd,
  AdLibraryProvider,
  CrawlQuery,
  CrawlResult,
  MediaType,
} from './types.ts'
import { ProviderError } from './types.ts'

/**
 * Apify-backed Ad Library provider (v1).
 *
 * The actor is addressed by id from configuration rather than hardcoded: Ad Library actors
 * on the marketplace get abandoned and replaced, and swapping one must not be a code change.
 *
 * Nothing here reads a Meta session cookie, and nothing accepts one. The Ad Library is
 * public; our legal posture depends on keeping collection logged-off (ARCHITECTURE.md §9).
 */

const APIFY_BASE_URL = 'https://api.apify.com/v2'

/** Apify caps synchronous runs at 5 minutes; past that the run continues but the call 408s. */
const DEFAULT_TIMEOUT_MS = 4 * 60 * 1000

export interface ApifyProviderConfig {
  token: string
  /** e.g. `curious_coder~facebook-ads-library-scraper`. */
  actorId: string
  /** Cap on ads per crawl. Guards against an unbounded bill on a broad keyword. */
  maxResults?: number
  timeoutMs?: number
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
}

export function createApifyProvider(config: ApifyProviderConfig): AdLibraryProvider {
  const doFetch = config.fetchImpl ?? globalThis.fetch
  const maxResults = config.maxResults ?? 500
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    name: 'apify',
    collectionMode: 'logged-off',

    async crawl(query: CrawlQuery, options?: { signal?: AbortSignal }): Promise<CrawlResult> {
      const url =
        `${APIFY_BASE_URL}/acts/${encodeURIComponent(config.actorId)}` +
        `/run-sync-get-dataset-items?timeout=${Math.floor(timeoutMs / 1000)}`

      // Apify aborts the whole run on timeout; without this the caller's retry budget is
      // spent waiting on a run that has already stopped producing.
      const timeout = AbortSignal.timeout(timeoutMs)
      const signal =
        options?.signal === undefined
          ? timeout
          : AbortSignal.any([options.signal, timeout])

      let response: Response
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // Header, not a query param: query strings end up in proxy and CDN logs.
            authorization: `Bearer ${config.token}`,
          },
          body: JSON.stringify(buildActorInput(query, maxResults)),
          signal,
        })
      } catch (error) {
        throw new ProviderError(
          `Apify request failed for ${query.kind}:${query.query}`,
          { retryable: true, cause: error },
        )
      }

      if (!response.ok) {
        // 4xx other than 429 means our request is wrong; retrying it wastes the day's
        // retry budget on something that cannot succeed.
        const retryable = response.status === 429 || response.status >= 500
        throw new ProviderError(
          `Apify returned ${response.status} for ${query.kind}:${query.query}`,
          { retryable },
        )
      }

      const raw: unknown = await response.json()
      if (!Array.isArray(raw)) {
        throw new ProviderError('Apify dataset response was not an array', { retryable: false })
      }

      return {
        ads: raw.map(normalizeAd).filter((ad): ad is AdLibraryAd => ad !== null),
        providerRunId: response.headers.get('x-apify-run-id'),
        raw,
      }
    },
  }
}

function buildActorInput(query: CrawlQuery, maxResults: number): Record<string, unknown> {
  const base = {
    country: query.country,
    activeStatus: 'all',
    adType: 'all',
    count: maxResults,
  }
  return query.kind === 'keyword'
    ? { ...base, searchTerms: [query.query] }
    : { ...base, pageIds: [query.query] }
}

/**
 * Coerce one dataset item into {@link AdLibraryAd}.
 *
 * Deliberately tolerant of field-name drift: marketplace actors rename fields between
 * versions, and a rename must degrade one field rather than drop the day's crawl. An item
 * with no archive id is unusable and is skipped — but note the raw payload has already
 * been landed by then, so a normalization bug is always recoverable by reprocessing.
 */
export function normalizeAd(item: unknown): AdLibraryAd | null {
  if (typeof item !== 'object' || item === null) return null
  const record = item as Record<string, unknown>

  const adArchiveId = firstString(record, ['adArchiveId', 'ad_archive_id', 'adArchiveID', 'id'])
  if (adArchiveId === null) return null

  const snapshot = isRecord(record['snapshot']) ? record['snapshot'] : {}

  return {
    adArchiveId,
    pageId: firstString(record, ['pageId', 'page_id']) ?? firstString(snapshot, ['page_id']) ?? '',
    pageName:
      firstString(record, ['pageName', 'page_name']) ?? firstString(snapshot, ['page_name']) ?? '',
    adDeliveryStartTime: normalizeTimestamp(
      record['adDeliveryStartTime'] ??
        record['ad_delivery_start_time'] ??
        record['startDate'] ??
        record['start_date'],
    ),
    mediaType: normalizeMediaType(record, snapshot),
    mediaUrl: normalizeMediaUrl(snapshot),
    adCopy: normalizeAdCopy(record, snapshot),
    publisherPlatforms: normalizeStringArray(
      record['publisherPlatform'] ?? record['publisher_platform'] ?? record['publisherPlatforms'],
    ),
    variantCount: normalizeVariantCount(record),
    // EU-only (UC-7). Absent on every MX dataset item, so these come back `undefined` there
    // — never coerced to `null`, which would read as "Meta reported no stop time" rather
    // than "this field does not apply to this market" (see AdLibraryAd's own doc comment).
    ...normalizeEuFields(record),
  }
}

/**
 * Coerce one timestamp field. Shared by start and stop time because both come from Meta in
 * the same two shapes (epoch seconds or an ISO string) and must fail the same way.
 */
function normalizeTimestamp(value: unknown): string | null {
  if (typeof value === 'number') {
    // Meta reports epoch seconds; JS Date wants milliseconds. Getting this wrong dates
    // every ad to 1970 and silently destroys the survival start (or, for a stop time,
    // makes every ad look like it ended before it began).
    return new Date(value * 1000).toISOString()
  }
  if (typeof value === 'string' && value !== '') {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }
  return null
}

/**
 * The EU-only fields (UC-7). Returns an empty object — not `{ field: undefined }` for each
 * one — on a dataset item that carries none of them, so `AdLibraryAd`'s optional fields stay
 * genuinely absent (`in` returns false) on every ordinary MX item rather than present-but-
 * undefined, which `JSON.stringify` and `structuredClone` would treat differently.
 */
function normalizeEuFields(
  record: Record<string, unknown>,
): Pick<AdLibraryAd, 'adDeliveryStopTime' | 'euTotalReachMin' | 'euTotalReachMax'> | object {
  const stopValue =
    record['adDeliveryStopTime'] ?? record['ad_delivery_stop_time'] ?? record['endDate'] ?? record['end_date']
  const reach = record['euTotalReach'] ?? record['eu_total_reach']

  const hasStop = stopValue !== undefined
  const hasReach = reach !== undefined
  if (!hasStop && !hasReach) return {}

  const out: Pick<AdLibraryAd, 'adDeliveryStopTime' | 'euTotalReachMin' | 'euTotalReachMax'> = {}
  if (hasStop) out.adDeliveryStopTime = normalizeTimestamp(stopValue)
  if (hasReach) {
    const [min, max] = normalizeReachRange(reach)
    out.euTotalReachMin = min
    out.euTotalReachMax = max
  }
  return out
}

/**
 * Meta reports EU reach as a bucketed range (spec rule 7: never collapsed to a midpoint).
 * Tolerant of the shapes a marketplace actor might hand back: a `{lower_bound, upper_bound}`
 * object, snake or camel case, or occasionally a single point value with no range at all —
 * in which case both bounds are set to it rather than guessing a spread.
 */
function normalizeReachRange(value: unknown): [number | null, number | null] {
  if (isRecord(value)) {
    const min = firstNumber(value, ['lower_bound', 'lowerBound', 'min', 'eu_total_reach_min'])
    const max = firstNumber(value, ['upper_bound', 'upperBound', 'max', 'eu_total_reach_max'])
    if (min !== null || max !== null) return [min, max]
  }
  if (typeof value === 'number' && Number.isFinite(value)) return [value, value]
  return [null, null]
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function normalizeMediaType(
  record: Record<string, unknown>,
  snapshot: Record<string, unknown>,
): MediaType {
  const videos = snapshot['videos']
  if (Array.isArray(videos) && videos.length > 0) return 'video'
  const images = snapshot['images']
  if (Array.isArray(images) && images.length > 0) return 'image'

  const declared = firstString(record, ['mediaType', 'media_type'])?.toLowerCase()
  if (declared === 'video' || declared === 'image') return declared
  return 'unknown'
}

function normalizeMediaUrl(snapshot: Record<string, unknown>): string | null {
  const videos = snapshot['videos']
  if (Array.isArray(videos) && isRecord(videos[0])) {
    const url = firstString(videos[0], ['video_hd_url', 'video_sd_url', 'videoHdUrl', 'url'])
    if (url !== null) return url
  }
  const images = snapshot['images']
  if (Array.isArray(images) && isRecord(images[0])) {
    const url = firstString(images[0], ['original_image_url', 'resized_image_url', 'url'])
    if (url !== null) return url
  }
  return null
}

function normalizeAdCopy(
  record: Record<string, unknown>,
  snapshot: Record<string, unknown>,
): string | null {
  const bodies = snapshot['body']
  if (isRecord(bodies)) {
    const text = firstString(bodies, ['text', 'markup'])
    if (text !== null) return text
  }
  return firstString(record, ['adCopy', 'ad_copy', 'body', 'text'])
}

function normalizeVariantCount(record: Record<string, unknown>): number {
  const value =
    record['variantCount'] ??
    record['variant_count'] ??
    record['collationCount'] ??
    record['collation_count']

  if (typeof value === 'number' && Number.isFinite(value) && value >= 1) {
    return Math.floor(value)
  }
  return 1
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string')
  }
  return typeof value === 'string' && value !== '' ? [value] : []
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return value
    if (typeof value === 'number') return String(value)
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
