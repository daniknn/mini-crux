import { describe, expect, it } from 'vitest'

import {
  ANALYSIS_FEATURES,
  assembleCohorts,
  LONG_LIVED_ABOVE_DAYS,
  MixedFeatureVersionsError,
  placeCreative,
  PLACEMENTS,
  SHORT_LIVED_BELOW_DAYS,
  stratify,
  type PanelCreative,
} from '../src/cohorts.ts'
import { vanElteren } from '../src/van-elteren.ts'

let seq = 0

/**
 * A creative that lands in the excluded middle unless something is overridden, so every
 * fixture below states only the fact it is testing. The defaults are deliberately *not* a
 * cohort member: a helper whose default lands in `long_lived` makes half these tests pass
 * for the wrong reason.
 */
const creative = (over: Partial<PanelCreative> = {}): PanelCreative => ({
  creativeId: `crv-${(seq += 1)}`,
  advertiserId: 'adv-a',
  daysActive: 30,
  isCensored: false,
  hasGaps: false,
  featureSchemaVersion: 2,
  features: {
    duration_s: 15,
    first_cut_time_s: 1.2,
    cuts_per_second: 0.4,
    text_in_first_2s: 1,
    text_density: 0.3,
    audio_energy_variance: 0.02,
  },
  skippedFeatures: [],
  ...over,
})

describe('placement', () => {
  it('puts a stopped short creative in short_lived and a stopped long one in long_lived', () => {
    expect(placeCreative(creative({ daysActive: 13, isCensored: false }))).toBe('short_lived')
    expect(placeCreative(creative({ daysActive: 61, isCensored: false }))).toBe('long_lived')
  })

  // THE CENSORING TRAP (CLAUDE.md rule 6, spec acceptance criterion 1). This creative has
  // run 9 days *so far*. Everything else about it says short_lived; the one fact that
  // matters says we do not know.
  it('refuses to call a still-running 9-day creative short_lived', () => {
    const stillRunning = creative({ daysActive: 9, isCensored: true })
    const stopped = creative({ daysActive: 9, isCensored: false })

    expect(placeCreative(stillRunning)).toBe('excluded_middle')
    expect(placeCreative(stopped)).toBe('short_lived')
  })

  // The other half of the asymmetry, and the one that keeps the cohort from being selected
  // on having ended. On a young panel most long-runners are still running.
  it('admits a still-running 90-day creative to long_lived', () => {
    expect(placeCreative(creative({ daysActive: 90, isCensored: true }))).toBe('long_lived')
  })

  // Both edges are strict, and this is the fixture where `<` and `<=` stop agreeing. Without
  // it either comparison passes the suite and the cohorts quietly gain a member each.
  it('excludes a creative sitting exactly on either edge', () => {
    expect(SHORT_LIVED_BELOW_DAYS).toBe(14)
    expect(LONG_LIVED_ABOVE_DAYS).toBe(60)

    expect(placeCreative(creative({ daysActive: 14, isCensored: false }))).toBe('excluded_middle')
    expect(placeCreative(creative({ daysActive: 13, isCensored: false }))).toBe('short_lived')

    expect(placeCreative(creative({ daysActive: 60, isCensored: false }))).toBe('excluded_middle')
    expect(placeCreative(creative({ daysActive: 61, isCensored: false }))).toBe('long_lived')
  })

  it('excludes a creative whose span crosses an unrecoverable crawl', () => {
    expect(placeCreative(creative({ hasGaps: true, daysActive: 90 }))).toBe('excluded_gaps')
  })

  it('excludes a creative Meta gave no start date for', () => {
    expect(placeCreative(creative({ daysActive: null }))).toBe('excluded_no_start')
  })

  it('excludes a creative with no current feature row, separately from the rest', () => {
    // Not-attempted, the third kind of null. It would be a textbook short_lived on the
    // survival side, and there is nothing to correlate.
    const notExtracted = creative({
      daysActive: 5,
      isCensored: false,
      featureSchemaVersion: null,
      features: {},
    })
    expect(placeCreative(notExtracted)).toBe('excluded_not_extracted')
  })

  // Each of these creatives qualifies for two exclusions at once. The order is documented
  // and load-bearing: without pinning it, a refactor can move a creative between two
  // counts an operator reads as "wait longer" versus "fix the crawler".
  it('counts a creative under the most fundamental reason it was excluded', () => {
    const gapsAndShort = creative({ hasGaps: true, daysActive: 5, isCensored: false })
    expect(placeCreative(gapsAndShort)).toBe('excluded_gaps')

    const gapsAndNoStart = creative({ hasGaps: true, daysActive: null })
    expect(placeCreative(gapsAndNoStart)).toBe('excluded_gaps')

    const noStartAndNotExtracted = creative({ daysActive: null, featureSchemaVersion: null })
    expect(placeCreative(noStartAndNotExtracted)).toBe('excluded_no_start')
  })
})

describe('assembly', () => {
  const panel = [
    creative({ creativeId: 'short-1', daysActive: 3, isCensored: false }),
    creative({ creativeId: 'short-2', daysActive: 12, isCensored: false, advertiserId: 'adv-b' }),
    creative({ creativeId: 'long-1', daysActive: 90, isCensored: true }),
    creative({ creativeId: 'long-2', daysActive: 75, isCensored: false, advertiserId: 'adv-b' }),
    creative({ creativeId: 'long-3', daysActive: 61, isCensored: true, advertiserId: 'adv-b' }),
    creative({ creativeId: 'middle', daysActive: 30 }),
    creative({ creativeId: 'gaps', hasGaps: true, advertiserId: 'adv-c' }),
    creative({ creativeId: 'no-start', daysActive: null, advertiserId: 'adv-d' }),
    creative({ creativeId: 'raw', featureSchemaVersion: null, daysActive: 5, isCensored: false }),
  ]

  it('counts every placement and loses nobody', () => {
    const assembly = assembleCohorts(panel)

    expect(assembly.counts).toEqual({
      short_lived: 2,
      long_lived: 3,
      excluded_middle: 1,
      excluded_gaps: 1,
      excluded_no_start: 1,
      excluded_not_extracted: 1,
    })

    // The invariant that catches a creative falling out of every bucket — which is what a
    // mis-ordered chain of `if`s produces, and which no individual count would reveal.
    const total = PLACEMENTS.reduce((sum, p) => sum + assembly.counts[p], 0)
    expect(total).toBe(assembly.panelSize)
    expect(assembly.panelSize).toBe(9)
  })

  it('keeps only cohort members, in panel order', () => {
    const assembly = assembleCohorts(panel)
    expect(assembly.members.map((m) => m.creativeId)).toEqual([
      'short-1',
      'short-2',
      'long-1',
      'long-2',
      'long-3',
    ])
  })

  it('counts strata over cohort members only, not over the panel', () => {
    // adv-c and adv-d appear in the panel and in no cohort. Counting them would report the
    // analysis as drawing on four advertisers when it draws on two.
    expect(assembleCohorts(panel).strataTotal).toBe(2)
  })

  it('reports the censoring rate of the long-lived cohort', () => {
    // long-1 and long-3 censored, long-2 not.
    expect(assembleCohorts(panel).censoringRateLong).toBeCloseTo(2 / 3, 12)
  })

  it('reports a null censoring rate for an empty long-lived cohort, never a zero', () => {
    const shortOnly = assembleCohorts([creative({ daysActive: 3, isCensored: false })])
    expect(shortOnly.counts.long_lived).toBe(0)
    // `0` here would read as "no long-lived creative is still running", which is a finding.
    expect(shortOnly.censoringRateLong).toBeNull()
    expect(assembleCohorts([]).censoringRateLong).toBeNull()
  })

  it('pins the one feature schema version its members were measured under', () => {
    expect(assembleCohorts(panel).featureSchemaVersion).toBe(2)
    expect(assembleCohorts([]).featureSchemaVersion).toBeNull()
  })

  it('fails rather than pooling two feature schema versions', () => {
    const mixed = [
      creative({ daysActive: 3, isCensored: false, featureSchemaVersion: 2 }),
      creative({ daysActive: 90, isCensored: true, featureSchemaVersion: 3 }),
    ]

    expect(() => assembleCohorts(mixed)).toThrow(MixedFeatureVersionsError)
    try {
      assembleCohorts(mixed)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as MixedFeatureVersionsError).versions).toEqual([2, 3])
    }
  })

  // A half-finished re-extraction leaves old-version rows on creatives the analysis excludes
  // anyway. Failing over one of those would make the analysis permanently unavailable on any
  // panel holding a single un-reprocessed image.
  it('ignores versions on creatives no cohort would have read', () => {
    const assembly = assembleCohorts([
      creative({ daysActive: 3, isCensored: false, featureSchemaVersion: 2 }),
      creative({ daysActive: 90, isCensored: true, featureSchemaVersion: 2 }),
      creative({ hasGaps: true, featureSchemaVersion: 3 }),
      creative({ daysActive: 30, featureSchemaVersion: 7 }),
    ])
    expect(assembly.featureSchemaVersion).toBe(2)
  })
})

describe('stratification', () => {
  const twoByTwo = () => [
    creative({ creativeId: 's1', daysActive: 3, isCensored: false, features: values(1) }),
    creative({ creativeId: 's2', daysActive: 4, isCensored: false, features: values(2) }),
    creative({ creativeId: 'l1', daysActive: 90, isCensored: true, features: values(3) }),
    creative({ creativeId: 'l2', daysActive: 80, isCensored: true, features: values(4) }),
  ]

  const values = (n: number): PanelCreative['features'] =>
    Object.fromEntries(ANALYSIS_FEATURES.map((f) => [f, n]))

  it('groups cohort members by advertiser', () => {
    const assembly = assembleCohorts([
      creative({ daysActive: 3, isCensored: false, advertiserId: 'adv-b', features: values(1) }),
      creative({ daysActive: 90, isCensored: true, advertiserId: 'adv-b', features: values(2) }),
      creative({ daysActive: 5, isCensored: false, advertiserId: 'adv-a', features: values(3) }),
      creative({ daysActive: 70, isCensored: true, advertiserId: 'adv-a', features: values(4) }),
    ])

    const strata = stratify(assembly, 'cuts_per_second').strata
    // Sorted, not insertion-ordered: two runs over the same panel must build identical
    // strata, so any difference between two stored runs is a difference in the panel.
    expect(strata.map((s) => s.stratum)).toEqual(['adv-a', 'adv-b'])
    expect(strata[0]).toEqual({ stratum: 'adv-a', long: [4], short: [3] })
    expect(strata[1]).toEqual({ stratum: 'adv-b', long: [2], short: [1] })
  })

  // The spec's fourth cohort criterion, stated as an exact comparison rather than as a
  // property. "n went down" is satisfied by dropping the creative from every feature.
  it('drops a skipped feature from that feature only, changing that n and no other', () => {
    const panel = twoByTwo()
    panel[0] = creative({
      creativeId: 's1',
      daysActive: 3,
      isCensored: false,
      features: { ...values(1), text_density: null },
      skippedFeatures: ['text_density'],
    })
    const assembly = assembleCohorts(panel)

    const skipped = stratify(assembly, 'text_density')
    expect(skipped.nShort).toBe(1)
    expect(skipped.nLong).toBe(2)
    expect(skipped.droppedNotMeasurable).toBe(1)
    expect(skipped.droppedUnexplained).toBe(0)
    expect(skipped.strata[0]!.short).toEqual([2])

    for (const feature of ANALYSIS_FEATURES) {
      if (feature === 'text_density') continue
      const intact = stratify(assembly, feature)
      expect(intact.nShort).toBe(2)
      expect(intact.nLong).toBe(2)
      expect(intact.droppedNotMeasurable).toBe(0)
    }
  })

  // Measured-absent: a single-shot video really has no cut. It is an observation, and the
  // cohort it belongs in is the one it is in — dropping it would remove a whole structural
  // style (the single-shot ad) from the first-cut test and from nowhere else.
  it('keeps a video that never cut, ordered above every video that did', () => {
    const panel = twoByTwo()
    panel[3] = creative({
      creativeId: 'l2',
      daysActive: 80,
      isCensored: true,
      features: { ...values(4), first_cut_time_s: null },
      skippedFeatures: [],
    })

    const result = stratify(assembleCohorts(panel), 'first_cut_time_s')
    expect(result.nLong).toBe(2)
    expect(result.droppedNotMeasurable).toBe(0)
    expect(result.droppedUnexplained).toBe(0)
    expect(result.strata[0]!.long).toEqual([3, Number.POSITIVE_INFINITY])
  })

  // Two never-cut videos are tied at the top, not ordered against each other. A rank test
  // has to say so: they take the same midrank, and the tie correction has to see the tie.
  it('ties two videos that both never cut', () => {
    const panel = [
      creative({ daysActive: 3, isCensored: false, features: values(1) }),
      creative({ daysActive: 6, isCensored: false, features: values(2) }),
      creative({
        daysActive: 90,
        isCensored: true,
        features: { ...values(5), first_cut_time_s: null },
      }),
      creative({
        daysActive: 80,
        isCensored: true,
        features: { ...values(9), first_cut_time_s: null },
      }),
    ]
    const strata = stratify(assembleCohorts(panel), 'first_cut_time_s').strata
    expect(strata[0]!.long).toEqual([Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY])

    // Both long-lived values sit above both short-lived ones and are indistinguishable from
    // each other: every pair is a long-lived win, so the probability of superiority is 1 —
    // and the two tied values must not contribute a tie *correction* against each other in
    // a way that reorders them, which a value-swapped implementation would.
    const result = vanElteren(strata)
    expect(result!.probabilitySuperiority).toBe(1)
    expect(result!.z).toBeGreaterThan(0)
  })

  // The infinity is a *position*, not a magnitude, and this is the assertion that says so:
  // replace it with any finite value larger than the rest and every number the test reports
  // is identical. If it ever leaked into the arithmetic this comes back NaN.
  it('treats the never-cut position as ordinal, not as a number', () => {
    const build = (absent: number | null) =>
      assembleCohorts([
        creative({ advertiserId: 'a', daysActive: 3, isCensored: false, features: values(1) }),
        creative({ advertiserId: 'a', daysActive: 6, isCensored: false, features: values(2) }),
        creative({ advertiserId: 'a', daysActive: 90, isCensored: true, features: values(5) }),
        creative({
          advertiserId: 'a',
          daysActive: 80,
          isCensored: true,
          features: { ...values(9), first_cut_time_s: absent },
        }),
        creative({ advertiserId: 'b', daysActive: 2, isCensored: false, features: values(7) }),
        creative({ advertiserId: 'b', daysActive: 70, isCensored: true, features: values(3) }),
      ])

    const infinite = vanElteren(stratify(build(null), 'first_cut_time_s').strata)
    const finite = vanElteren(stratify(build(1000), 'first_cut_time_s').strata)

    expect(infinite).not.toBeNull()
    expect(Number.isFinite(infinite!.z)).toBe(true)
    expect(infinite).toEqual(finite)
  })

  // A null with no skip entry on a feature that has no measured-absent state is an extractor
  // bug. Guessing a position for it would be an imputation; counting it keeps the mistake
  // visible in the run instead of hiding it inside a shrunken n.
  it('drops and counts a null it has no defined position for', () => {
    const panel = twoByTwo()
    panel[2] = creative({
      creativeId: 'l1',
      daysActive: 90,
      isCensored: true,
      features: { ...values(3), text_density: null },
      skippedFeatures: [],
    })

    const result = stratify(assembleCohorts(panel), 'text_density')
    expect(result.nLong).toBe(1)
    expect(result.droppedUnexplained).toBe(1)
    expect(result.droppedNotMeasurable).toBe(0)
  })

  it('refuses a NaN rather than ranking it', () => {
    const panel = twoByTwo()
    panel[1] = creative({
      creativeId: 's2',
      daysActive: 4,
      isCensored: false,
      features: { ...values(2), cuts_per_second: Number.NaN },
    })

    expect(() => stratify(assembleCohorts(panel), 'cuts_per_second')).toThrow(
      /cuts_per_second is NaN on creative s2/,
    )
  })

  it('builds nothing from an empty panel and does not throw', () => {
    const result = stratify(assembleCohorts([]), 'duration_s')
    expect(result).toEqual({
      feature: 'duration_s',
      strata: [],
      nLong: 0,
      nShort: 0,
      droppedNotMeasurable: 0,
      droppedUnexplained: 0,
    })
    expect(vanElteren(result.strata)).toBeNull()
  })
})

describe('the feature list', () => {
  it('is the six structural features, in one order', () => {
    // Pinned rather than asserted by length. This array is the contract the DB check
    // constraint, the results table and the UI all key off; a silent reorder or rename here
    // is a relabelling that no assertion on the numbers themselves would catch.
    expect([...ANALYSIS_FEATURES]).toEqual([
      'duration_s',
      'first_cut_time_s',
      'cuts_per_second',
      'text_in_first_2s',
      'text_density',
      'audio_energy_variance',
    ])
  })
})
