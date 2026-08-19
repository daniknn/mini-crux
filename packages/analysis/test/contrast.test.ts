import { describe, expect, it } from 'vitest'

import {
  ANALYSIS_FEATURES,
  assembleCohorts,
  LONG_LIVED_ABOVE_DAYS,
  type PanelCreative,
} from '../src/cohorts.ts'
import { ANALYSIS_VERSION, runContrasts } from '../src/contrast.ts'
import { benjaminiHochberg } from '../src/fdr.ts'

let seq = 0

/**
 * Three advertisers, eight long-lived and eight short-lived creatives each, with the feature
 * values chosen so the seven contrasts come back materially different from one another:
 *
 * - `cuts_per_second` separates the cohorts perfectly, so its p is the smallest in the run.
 * - `duration_s` is the same number on every creative, so its variance is exactly zero and
 *   `vanElteren` returns null. It is the untestable one.
 * - the rest are interleaved to varying degrees, so their p-values land in between.
 *
 * The spread is the point. A fixture where every feature returns the same p cannot tell a
 * correct q-to-feature mapping from a shuffled one.
 */
const panel = (): PanelCreative[] => {
  const rows: PanelCreative[] = []
  for (let a = 0; a < 3; a += 1) {
    for (let i = 0; i < 8; i += 1) {
      for (const cohort of ['long', 'short'] as const) {
        const long = cohort === 'long'
        rows.push({
          creativeId: `crv-${(seq += 1)}`,
          advertiserId: `adv-${a}`,
          daysActive: long ? LONG_LIVED_ABOVE_DAYS + 30 : 5,
          isCensored: false,
          hasGaps: false,
          featureSchemaVersion: 2,
          extractorVersion: '0.3.1',
          features: {
            // Constant everywhere: no variance, no contrast, no result.
            duration_s: 15,
            // Perfect separation: every long-lived value above every short-lived one.
            cuts_per_second: (long ? 1 : 0) + i * 0.01,
            // A lean, but overlapping.
            first_cut_time_s: i + (long ? 0 : 0.5),
            // Barely anything: alternating by index, identical between cohorts.
            text_density: i % 2 === 0 ? 0.2 : 0.6,
            text_in_first_2s: i % 2,
            audio_energy_variance: (i * 7) % 5,
            // UC-8: leans toward the long-lived cohort (6 of 8 vs. 3 of 8) but overlaps —
            // some short-lived creatives show people too — so it needs the same rank test as
            // every continuous feature above, not a perfect split like cuts_per_second.
            has_people_on_screen: (long ? i % 3 !== 0 : i % 3 === 0) ? 1 : 0,
          },
          skippedFeatures: [],
          hookType: null,
          tone: null,
        })
      }
    }
  }
  return rows
}

describe('the analysis version', () => {
  it('is pinned', () => {
    // Stored on every run. Two runs carrying the same value claim to be comparable, so this
    // changing is a deliberate act rather than a side effect of editing the module.
    expect(ANALYSIS_VERSION).toBe('1.0.0')
  })
})

describe('running every feature', () => {
  it('returns the testable features in the order the UI lists them', () => {
    const { features, untestable } = runContrasts(assembleCohorts(panel()))

    // Not a sorted-by-p order and not a Map iteration order: the declared order, so the
    // surface can render straight down the array without re-sorting and the stored rows
    // read the same way twice.
    expect(features.map((f) => f.feature)).toEqual(
      ANALYSIS_FEATURES.filter((f) => !untestable.includes(f)),
    )
  })

  it('drops a feature with no variance instead of publishing a NaN', () => {
    const { features, untestable } = runContrasts(assembleCohorts(panel()))

    expect(untestable).toEqual(['duration_s'])
    expect(features.map((f) => f.feature)).not.toContain('duration_s')
    // Every published number is finite. A zero variance divides into a NaN z, which renders
    // as a blank cell rather than as an error and is exactly the shape of bug this UC exists
    // to keep off the page.
    for (const f of features) {
      expect(Number.isFinite(f.z)).toBe(true)
      expect(Number.isFinite(f.p)).toBe(true)
      expect(Number.isFinite(f.qValue)).toBe(true)
    }
  })

  it('adjusts across the features that ran, not across the ones that were asked for', () => {
    const { features } = runContrasts(assembleCohorts(panel()))
    const ps = features.map((f) => f.p)

    expect(features.map((f) => f.qValue)).toEqual(benjaminiHochberg(ps))

    // And the size of that set is load-bearing on this fixture: standing the untestable
    // feature back up with a placeholder p — the obvious "keep all seven" fix — changes the
    // published q-values. Without this the assertion above would hold for m = 6 and m = 7
    // alike and the whole argument in the module header would be untested.
    const withPlaceholder = benjaminiHochberg([...ps, 1]).slice(0, ps.length)
    expect(withPlaceholder).not.toEqual(features.map((f) => f.qValue))
  })

  it('keeps each q with the feature whose p produced it', () => {
    const { features } = runContrasts(assembleCohorts(panel()))

    // Benjamini-Hochberg is monotone in p, so a correct mapping ranks the features the same
    // way by p and by q. A relabelling that shuffles q across features leaves every value in
    // the run correct and every attribution wrong — no assertion on the numbers alone would
    // notice, which is why this compares two orderings instead.
    const byP = [...features].sort((a, b) => a.p - b.p).map((f) => f.feature)
    const byQ = [...features].sort((a, b) => a.qValue - b.qValue).map((f) => f.feature)
    expect(byQ).toEqual(byP)

    // The perfectly separated feature is the one at the top, which pins the ordering to the
    // fixture rather than to whatever the sort happened to produce.
    expect(byP[0]).toBe('cuts_per_second')
  })

  it('reports a perfectly separated feature as long-lived scoring higher', () => {
    const { features } = runContrasts(assembleCohorts(panel()))
    const cuts = features.find((f) => f.feature === 'cuts_per_second')!

    // The sign convention, end to end. Every long-lived value in the fixture is above every
    // short-lived one, so this must be a probability of superiority of exactly 1 and a
    // positive z. Reversed, every magnitude in the product stays correct and every
    // conclusion inverts.
    expect(cuts.probabilitySuperiority).toBe(1)
    expect(cuts.rankBiserial).toBe(1)
    expect(cuts.z).toBeGreaterThan(0)
  })

  it('carries the per-feature drop counts through to the result', () => {
    const rows = panel()
    // One creative whose text_density was never measurable, and one whose audio feature is
    // an unexplained null. They must land on their own feature's row and nowhere else.
    rows[0] = { ...rows[0]!, skippedFeatures: ['text_density'] }
    rows[1] = {
      ...rows[1]!,
      features: { ...rows[1]!.features, audio_energy_variance: null },
    }

    const { features } = runContrasts(assembleCohorts(rows))
    const by = (name: string) => features.find((f) => f.feature === name)!

    expect(by('text_density').droppedNotMeasurable).toBe(1)
    expect(by('text_density').droppedUnexplained).toBe(0)
    expect(by('audio_energy_variance').droppedUnexplained).toBe(1)
    expect(by('audio_energy_variance').droppedNotMeasurable).toBe(0)

    // 48 creatives, so 24 per cohort. Each drop shrinks exactly one feature's n and leaves
    // its neighbours alone — the whole reason `analysis_feature_results` carries its own n.
    expect(by('text_density').nLong + by('text_density').nShort).toBe(47)
    expect(by('cuts_per_second').nLong + by('cuts_per_second').nShort).toBe(48)
  })
})
