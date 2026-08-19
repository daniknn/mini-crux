import { describe, expect, it } from 'vitest'

import type { Cohort, CohortMember } from '../src/cohorts.ts'
import { describeTagDistribution, HOOK_TYPES, TONES } from '../src/tag-distribution.ts'

let seq = 0

const member = (cohort: Cohort, over: Partial<CohortMember> = {}): CohortMember => ({
  creativeId: `crv-${(seq += 1)}`,
  advertiserId: 'adv-a',
  cohort,
  isCensored: false,
  features: {},
  skippedFeatures: [],
  hookType: null,
  tone: null,
  ...over,
})

describe('describeTagDistribution', () => {
  it('counts a mixed hook_type per cohort, and sums to the tagged n', () => {
    const members = [
      member('long_lived', { hookType: 'testimonial' }),
      member('long_lived', { hookType: 'testimonial' }),
      member('long_lived', { hookType: 'demo' }),
      member('long_lived', { hookType: null }),
      member('short_lived', { hookType: 'demo' }),
      member('short_lived', { hookType: null }),
    ]

    const breakdown = describeTagDistribution(members, 'hook_type')

    expect(breakdown.tag).toBe('hook_type')
    expect(breakdown.nLong).toBe(4)
    expect(breakdown.nShort).toBe(2)
    expect(breakdown.untaggedLong).toBe(1)
    expect(breakdown.untaggedShort).toBe(1)

    const testimonial = breakdown.counts.find((c) => c.value === 'testimonial')!
    expect(testimonial).toEqual({ value: 'testimonial', nLong: 2, nShort: 0 })
    const demo = breakdown.counts.find((c) => c.value === 'demo')!
    expect(demo).toEqual({ value: 'demo', nLong: 1, nShort: 1 })

    // "counts sum to tagged n" as a structural check, not a one-off arithmetic assertion: the
    // acceptance criterion is that the per-value counts plus the untagged bucket account for
    // every member of the cohort, not just that the numbers above happen to add up.
    const summedLong = breakdown.counts.reduce((s, c) => s + c.nLong, 0) + breakdown.untaggedLong
    const summedShort = breakdown.counts.reduce((s, c) => s + c.nShort, 0) + breakdown.untaggedShort
    expect(summedLong).toBe(breakdown.nLong)
    expect(summedShort).toBe(breakdown.nShort)
  })

  it('reports every taxonomy value, including one nobody in this panel used', () => {
    const breakdown = describeTagDistribution(
      [member('long_lived', { hookType: 'offer' })],
      'hook_type',
    )
    // Not just the values that appeared — the full HOOK_TYPES list, in taxonomy order, so a
    // reader sees a zero for "ugc" rather than the caption silently omitting it.
    expect(breakdown.counts.map((c) => c.value)).toEqual([...HOOK_TYPES])
  })

  it('attaches no p-value, no q-value, and no statistic of any kind', () => {
    const breakdown = describeTagDistribution(
      [member('long_lived', { tone: 'urgente' }), member('short_lived', { tone: 'emocional' })],
      'tone',
    )
    // The acceptance criterion made structural: the returned shape has nothing a rank test
    // would produce, so there is no field to forget to omit.
    expect(Object.keys(breakdown).sort()).toEqual(
      ['tag', 'counts', 'untaggedLong', 'untaggedShort', 'nLong', 'nShort'].sort(),
    )
    for (const count of breakdown.counts) {
      expect(Object.keys(count).sort()).toEqual(['value', 'nLong', 'nShort'].sort())
    }
  })

  it('counts tone independently of hook_type on the same members', () => {
    const members = [
      member('long_lived', { hookType: 'demo', tone: 'humoristico' }),
      member('long_lived', { hookType: 'demo', tone: null }),
    ]
    const tone = describeTagDistribution(members, 'tone')
    expect(tone.tag).toBe('tone')
    expect(tone.untaggedLong).toBe(1)
    expect(tone.counts.find((c) => c.value === 'humoristico')).toEqual({
      value: 'humoristico',
      nLong: 1,
      nShort: 0,
    })
    expect([...TONES]).toContain('humoristico')
  })

  it('returns an all-zero, all-taxonomy breakdown for an empty panel', () => {
    const breakdown = describeTagDistribution([], 'hook_type')
    expect(breakdown.nLong).toBe(0)
    expect(breakdown.nShort).toBe(0)
    expect(breakdown.untaggedLong).toBe(0)
    expect(breakdown.untaggedShort).toBe(0)
    expect(breakdown.counts.every((c) => c.nLong === 0 && c.nShort === 0)).toBe(true)
    expect(breakdown.counts).toHaveLength(HOOK_TYPES.length)
  })
})
