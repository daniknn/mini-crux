import type { AdLibraryAd, AdLibraryProvider, CrawlQuery, CrawlResult } from './types.ts'
import { ProviderError } from './types.ts'

/**
 * A provider that replays scripted days.
 *
 * This is what makes UC-1 testable at all. The behaviour that matters most — a creative
 * appearing on day 1, still there on day 2, gone on day 3 — is a property of a *sequence*
 * of crawls, so it cannot be observed by mocking a single HTTP call. Each `crawl()` here
 * consumes the next scripted day.
 */
export interface FixtureDay {
  ads: AdLibraryAd[]
  /** Simulates a provider outage for this day. */
  fail?: { message: string; retryable?: boolean }
}

export interface FixtureProvider extends AdLibraryProvider {
  /** Queries received so far, in order — lets a test assert the watchlist was honoured. */
  readonly calls: CrawlQuery[]
}

export function createFixtureProvider(days: FixtureDay[]): FixtureProvider {
  const calls: CrawlQuery[] = []
  let index = 0

  return {
    name: 'fixture',
    collectionMode: 'logged-off',
    calls,

    async crawl(query: CrawlQuery): Promise<CrawlResult> {
      calls.push(query)
      const day = days[Math.min(index, days.length - 1)]
      index += 1

      if (day === undefined) {
        throw new ProviderError('Fixture provider has no scripted days', { retryable: false })
      }
      if (day.fail !== undefined) {
        throw new ProviderError(day.fail.message, { retryable: day.fail.retryable ?? true })
      }

      return {
        ads: day.ads,
        providerRunId: `fixture-run-${index}`,
        raw: { fixtureDay: index, ads: day.ads },
      }
    },
  }
}

/** Build an ad with sane defaults, so a test only states the field it is exercising. */
export function fixtureAd(overrides: Partial<AdLibraryAd> & { adArchiveId: string }): AdLibraryAd {
  return {
    pageId: 'page_1',
    pageName: 'Stori',
    adDeliveryStartTime: '2026-01-15T00:00:00.000Z',
    mediaType: 'video',
    mediaUrl: `https://cdn.example.test/${overrides.adArchiveId}.mp4`,
    adCopy: 'Tu tarjeta de crédito sin buró.',
    publisherPlatforms: ['facebook', 'instagram'],
    variantCount: 1,
    ...overrides,
  }
}
