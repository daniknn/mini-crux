import { describe, expect, it } from 'vitest'

import { normalizeAd } from '../src/providers/ad-library/apify.ts'

/**
 * `normalizeAd` had no direct test before UC-7 — it was only exercised indirectly through
 * the MX crawl fixtures. UC-7 adds real new branches (EU reach range parsing, stop-time
 * coercion) that a fixture-provider test never reaches, since the fixture provider never
 * calls `normalizeAd` at all. This file is scoped to exactly what UC-7 touched, not a
 * retroactive full-coverage pass on the MX fields.
 */

describe('normalizeAd — EU fields (UC-7)', () => {
  it('is absent (not undefined-but-present) on an ordinary MX item with no EU fields', () => {
    const ad = normalizeAd({ adArchiveId: '123', pageId: 'p1', pageName: 'Stori' })
    expect(ad).not.toBeNull()
    expect('adDeliveryStopTime' in (ad as object)).toBe(false)
    expect('euTotalReachMin' in (ad as object)).toBe(false)
    expect('euTotalReachMax' in (ad as object)).toBe(false)
  })

  it('parses a snake_case lower/upper bound range', () => {
    const ad = normalizeAd({
      adArchiveId: '123',
      ad_delivery_stop_time: '2025-03-01T00:00:00Z',
      eu_total_reach: { lower_bound: 10000, upper_bound: 15000 },
    })
    expect(ad?.adDeliveryStopTime).toBe('2025-03-01T00:00:00.000Z')
    expect(ad?.euTotalReachMin).toBe(10000)
    expect(ad?.euTotalReachMax).toBe(15000)
  })

  it('parses a camelCase lower/upper bound range', () => {
    const ad = normalizeAd({
      adArchiveId: '123',
      adDeliveryStopTime: '2025-03-01T00:00:00Z',
      euTotalReach: { lowerBound: 20000, upperBound: 25000 },
    })
    expect(ad?.euTotalReachMin).toBe(20000)
    expect(ad?.euTotalReachMax).toBe(25000)
  })

  it('treats a bare point value as both bounds rather than guessing a spread', () => {
    const ad = normalizeAd({ adArchiveId: '123', eu_total_reach: 5000 })
    expect(ad?.euTotalReachMin).toBe(5000)
    expect(ad?.euTotalReachMax).toBe(5000)
  })

  it('converts an epoch-seconds stop time the same way it converts start time', () => {
    const ad = normalizeAd({ adArchiveId: '123', ad_delivery_stop_time: 1735689600 })
    expect(ad?.adDeliveryStopTime).toBe('2025-01-01T00:00:00.000Z')
  })

  it('is null, not absent, when a stop-time field is present but unparseable', () => {
    const ad = normalizeAd({ adArchiveId: '123', ad_delivery_stop_time: 'not-a-date' })
    expect(ad).not.toBeNull()
    expect('adDeliveryStopTime' in (ad as object)).toBe(true)
    expect(ad?.adDeliveryStopTime).toBeNull()
  })

  it('still returns null for an item with no archive id, EU fields or not', () => {
    expect(normalizeAd({ eu_total_reach: { lower_bound: 1, upper_bound: 2 } })).toBeNull()
  })
})
