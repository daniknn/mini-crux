import { describe, expect, it } from 'vitest'

import {
  classifyProxyAd,
  classifyProxyCorpus,
  deriveVerdict,
  evaluateProxyValidationGate,
  MIN_ADVERTISERS_USED,
  MIN_FINISHED_ADS,
  type RawProxyAd,
} from '../src/proxy-validation.ts'
import { CONFIDENCE_ALPHA, type WithinAdvertiserRegression } from '../src/regression.ts'

let seq = 0

const rawAd = (over: Partial<RawProxyAd> = {}): RawProxyAd => ({
  advertiserPageId: `page-${(seq += 1)}`,
  adDeliveryStartTime: '2025-01-01T00:00:00Z',
  adDeliveryStopTime: '2025-01-15T00:00:00Z',
  euTotalReachMin: 1000,
  euTotalReachMax: 1500,
  ...over,
})

describe('classifyProxyAd', () => {
  it('classifies a normal finished ad, using the min bound by default choice of caller', () => {
    const result = classifyProxyAd(rawAd(), 'min')
    expect(result.exclusionReason).toBeNull()
    expect(result.finishedAd).not.toBeNull()
    expect(result.finishedAd?.reach).toBe(1000)
    expect(result.finishedAd?.daysActive).toBeCloseTo(14, 6)
  })

  it('uses the max bound when asked (spec rule 7: which bound was used is recorded, not fixed)', () => {
    const result = classifyProxyAd(rawAd(), 'max')
    expect(result.finishedAd?.reach).toBe(1500)
  })

  it('excludes a still-running ad (no stop time) as still_running', () => {
    const result = classifyProxyAd(rawAd({ adDeliveryStopTime: null }), 'min')
    expect(result.exclusionReason).toBe('still_running')
    expect(result.finishedAd).toBeNull()
  })

  it('excludes an ad with no start time as still_running (no duration to classify)', () => {
    const result = classifyProxyAd(rawAd({ adDeliveryStartTime: null }), 'min')
    expect(result.exclusionReason).toBe('still_running')
  })

  it('excludes zero reach', () => {
    const result = classifyProxyAd(rawAd({ euTotalReachMin: 0 }), 'min')
    expect(result.exclusionReason).toBe('zero_reach')
  })

  it('excludes null reach for the bound in use', () => {
    const result = classifyProxyAd(rawAd({ euTotalReachMin: null }), 'min')
    expect(result.exclusionReason).toBe('zero_reach')
  })

  it('excludes sub-day duration', () => {
    const result = classifyProxyAd(
      rawAd({
        adDeliveryStartTime: '2025-01-01T00:00:00Z',
        adDeliveryStopTime: '2025-01-01T12:00:00Z',
      }),
      'min',
    )
    expect(result.exclusionReason).toBe('sub_day_duration')
  })

  it('admits an ad at exactly one day (the boundary is inclusive on the admitted side)', () => {
    const result = classifyProxyAd(
      rawAd({
        adDeliveryStartTime: '2025-01-01T00:00:00Z',
        adDeliveryStopTime: '2025-01-02T00:00:00Z',
      }),
      'min',
    )
    expect(result.exclusionReason).toBeNull()
    expect(result.finishedAd?.daysActive).toBeCloseTo(1, 9)
  })

  it('precedence: still_running beats zero_reach and sub_day_duration when several apply', () => {
    const result = classifyProxyAd(
      rawAd({
        adDeliveryStopTime: null,
        euTotalReachMin: 0,
      }),
      'min',
    )
    expect(result.exclusionReason).toBe('still_running')
  })

  it('precedence: zero_reach beats sub_day_duration when both apply', () => {
    const result = classifyProxyAd(
      rawAd({
        euTotalReachMin: 0,
        adDeliveryStartTime: '2025-01-01T00:00:00Z',
        adDeliveryStopTime: '2025-01-01T06:00:00Z',
      }),
      'min',
    )
    expect(result.exclusionReason).toBe('zero_reach')
  })
})

describe('classifyProxyCorpus', () => {
  it('every ad lands in exactly one bucket, and the buckets sum to the corpus (invariant)', () => {
    const ads: RawProxyAd[] = [
      rawAd(),
      rawAd(),
      rawAd({ adDeliveryStopTime: null }),
      rawAd({ euTotalReachMin: 0 }),
      rawAd({ adDeliveryStopTime: '2025-01-01T06:00:00Z' }),
    ]
    const result = classifyProxyCorpus(ads, 'min')
    const total =
      result.finishedAds.length +
      result.nExcludedStillRunning +
      result.nExcludedZeroReach +
      result.nExcludedSubDay
    expect(total).toBe(ads.length)
    expect(result.finishedAds.length).toBe(2)
    expect(result.nExcludedStillRunning).toBe(1)
    expect(result.nExcludedZeroReach).toBe(1)
    expect(result.nExcludedSubDay).toBe(1)
  })

  it('handles an empty corpus', () => {
    const result = classifyProxyCorpus([], 'min')
    expect(result.finishedAds).toEqual([])
    expect(result.nExcludedStillRunning).toBe(0)
    expect(result.nExcludedZeroReach).toBe(0)
    expect(result.nExcludedSubDay).toBe(0)
  })
})

describe('evaluateProxyValidationGate', () => {
  const finishedAd = (advertiser: string) => ({ advertiser, daysActive: 10, reach: 1000 })

  it('refuses on corpus_size below the floor, reporting the shortfall', () => {
    const ads = Array.from({ length: MIN_FINISHED_ADS - 1 }, (_, i) => finishedAd(`adv-${i}`))
    const verdict = evaluateProxyValidationGate({ finishedAds: ads })
    expect(verdict.outcome).toBe('refused')
    if (verdict.outcome !== 'refused') throw new Error('expected a refusal')
    expect(verdict.failedGate).toBe('corpus_size')
    expect(verdict.detail.shortfall_n).toBe(1)
  })

  it('refuses on advertisers when corpus size clears but too few advertisers contribute a contrast', () => {
    // Enough ads, but they all belong to advertisers with only one ad each (no advertiser
    // contributes a within-advertiser contrast) -- corpus_size passes, advertisers must fail.
    const ads = Array.from({ length: MIN_FINISHED_ADS }, (_, i) => finishedAd(`solo-${i}`))
    const verdict = evaluateProxyValidationGate({ finishedAds: ads })
    expect(verdict.outcome).toBe('refused')
    if (verdict.outcome !== 'refused') throw new Error('expected a refusal')
    expect(verdict.failedGate).toBe('advertisers')
    expect(verdict.detail.actual_advertisers).toBe(0)
  })

  it('publishes once both floors clear', () => {
    const ads: ReturnType<typeof finishedAd>[] = []
    for (let i = 0; i < MIN_ADVERTISERS_USED; i += 1) {
      ads.push(finishedAd(`adv-${i}`), finishedAd(`adv-${i}`))
    }
    while (ads.length < MIN_FINISHED_ADS) {
      ads.push(finishedAd(`filler-${ads.length}`))
    }
    const verdict = evaluateProxyValidationGate({ finishedAds: ads })
    expect(verdict.outcome).toBe('published')
    expect(verdict.failedGate).toBeNull()
  })

  it('order: corpus_size is checked before advertisers', () => {
    // Thin on both counts -- corpus_size must be the one reported, per the same
    // most-fundamental-first ordering gating.ts documents for UC-5.
    const verdict = evaluateProxyValidationGate({ finishedAds: [finishedAd('solo')] })
    expect(verdict.outcome).toBe('refused')
    if (verdict.outcome !== 'refused') throw new Error('expected a refusal')
    expect(verdict.failedGate).toBe('corpus_size')
  })
})

describe('deriveVerdict', () => {
  const regressionOf = (over: Partial<WithinAdvertiserRegression>): WithinAdvertiserRegression => ({
    beta: 1,
    betaMinusOne: 0,
    se: 0.1,
    ciLow: 0.8,
    ciHigh: 1.2,
    tStat: 0,
    pValue: 1,
    df: 10,
    n: 20,
    advertisersUsed: 5,
    advertisersDropped: 0,
    ...over,
  })

  it('is inertia when the p-value does not clear significance, regardless of point estimate side', () => {
    expect(deriveVerdict(regressionOf({ beta: 1.4, pValue: 0.2 }))).toBe('inertia')
    expect(deriveVerdict(regressionOf({ beta: 0.6, pValue: 0.2 }))).toBe('inertia')
  })

  it('is inertia exactly at the significance boundary (p = alpha does not reject)', () => {
    expect(deriveVerdict(regressionOf({ beta: 1.4, pValue: CONFIDENCE_ALPHA }))).toBe('inertia')
  })

  it('is reflects_effort when significant and beta > 1', () => {
    expect(deriveVerdict(regressionOf({ beta: 1.6, pValue: 0.001 }))).toBe('reflects_effort')
  })

  it('is throttled when significant and beta < 1', () => {
    expect(deriveVerdict(regressionOf({ beta: 0.4, pValue: 0.001 }))).toBe('throttled')
  })
})
