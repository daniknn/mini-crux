import { describe, expect, it } from 'vitest'

import {
  assembleCohorts,
  LONG_LIVED_ABOVE_DAYS,
  type PanelCreative,
} from '../src/cohorts.ts'
import {
  evaluateGates,
  MAX_CENSORING_RATE,
  MIN_COHORT_N,
  MIN_PANEL_AGE_DAYS,
  MIN_STRATA,
} from '../src/gating.ts'

let seq = 0

const creative = (over: Partial<PanelCreative>): PanelCreative => ({
  creativeId: `crv-${(seq += 1)}`,
  advertiserId: 'adv-a',
  daysActive: 30,
  isCensored: false,
  hasGaps: false,
  featureSchemaVersion: 2,
  extractorVersion: '0.3.1',
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

/**
 * A panel with a known shape: `advertisers` strata, each contributing `long` long-lived and
 * `short` short-lived creatives, of which `censoredLong` are still running.
 *
 * Every gate below is failed by changing exactly one of these numbers away from a passing
 * baseline, which is the only way to know a gate fires on its own rather than being carried
 * by a fixture that fails three of them at once.
 */
const panelOf = (opts: {
  advertisers: number
  long: number
  short: number
  censoredLong?: number
}): PanelCreative[] => {
  const rows: PanelCreative[] = []
  for (let a = 0; a < opts.advertisers; a += 1) {
    const advertiserId = `adv-${a}`
    for (let i = 0; i < opts.long; i += 1) {
      rows.push(
        creative({
          advertiserId,
          daysActive: LONG_LIVED_ABOVE_DAYS + 30,
          isCensored: i < (opts.censoredLong ?? 0),
        }),
      )
    }
    for (let i = 0; i < opts.short; i += 1) {
      rows.push(creative({ advertiserId, daysActive: 5, isCensored: false }))
    }
  }
  return rows
}

/** Clears every gate. Each test below breaks exactly one thing about it. */
const HEALTHY = { advertisers: 3, long: 7, short: 7 } as const
const HEALTHY_AGE = MIN_PANEL_AGE_DAYS + 40

const verdictFor = (
  panelAgeDays: number,
  opts: Parameters<typeof panelOf>[0],
): ReturnType<typeof evaluateGates> =>
  evaluateGates({ panelAgeDays, assembly: assembleCohorts(panelOf(opts)) })

describe('the thresholds', () => {
  it('derives the panel age gate from the long-lived edge instead of restating it', () => {
    // Not a tautology: the point is that the two cannot drift. A panel is old enough to hold
    // a resolved long-lived creative exactly when it has been observed for one day longer
    // than the threshold that creative had to clear, and typing 61 next to a 60 that someone
    // later tunes to 45 is how those two numbers stop meaning the same thing.
    expect(MIN_PANEL_AGE_DAYS).toBe(LONG_LIVED_ABOVE_DAYS + 1)
  })

  it('pins the shipped values', () => {
    // A constant is untested until something pins it (CLAUDE.md). These are the numbers the
    // product refuses on, and the spec defers tuning them — so a change to any of them
    // should have to be a deliberate edit here, not a silent one there.
    expect(MIN_COHORT_N).toBe(20)
    expect(MIN_STRATA).toBe(3)
    expect(MAX_CENSORING_RATE).toBe(0.8)
  })
})

describe('the baseline publishes', () => {
  it('passes every gate and names none', () => {
    // Load-bearing. Without it every refusal test below is satisfied by a gate that refuses
    // unconditionally, and the whole module would read as correct while never publishing.
    const verdict = verdictFor(HEALTHY_AGE, HEALTHY)

    expect(verdict.outcome).toBe('published')
    expect(verdict.failedGate).toBeNull()
    expect(verdict.detail).toEqual({})
  })

  it('publishes at exactly the thresholds, because they are floors and not ceilings', () => {
    // The edges themselves. `< MIN` and `<= MIN` differ by exactly this fixture, and a panel
    // that has just barely earned its analysis is the one an operator is watching.
    const verdict = verdictFor(MIN_PANEL_AGE_DAYS, {
      advertisers: MIN_STRATA,
      long: MIN_COHORT_N,
      short: MIN_COHORT_N,
      // 0.8 exactly. The gate is `>`, so the boundary publishes.
      censoredLong: MIN_COHORT_N * MAX_CENSORING_RATE,
    })

    expect(verdict.outcome).toBe('published')
  })
})

describe('each gate refuses on its own', () => {
  it('refuses a young panel and reports how many days are missing', () => {
    const verdict = verdictFor(12, HEALTHY)

    expect(verdict.outcome).toBe('refused')
    expect(verdict.failedGate).toBe('panel_age')
    // The exact numbers, because "faltan N días" is rendered from them. A shortfall that is
    // merely positive would be satisfied by any subtraction in either direction.
    expect(verdict.detail).toEqual({
      required_days: 61,
      actual_days: 12,
      shortfall_days: 49,
    })
  })

  it('refuses a thin cohort and reports the shortfall against the smaller one', () => {
    // 30 long, 3 short. The binding constraint is the 3, and a gate that read `n_long` or
    // whichever cohort it happened to check first would publish this.
    const verdict = verdictFor(HEALTHY_AGE, { advertisers: 3, long: 10, short: 1 })

    expect(verdict.outcome).toBe('refused')
    expect(verdict.failedGate).toBe('cohort_n')
    expect(verdict.detail).toEqual({
      required_n: 20,
      n_long: 30,
      n_short: 3,
      shortfall_n: 17,
    })
  })

  it('refuses two advertisers even when both cohorts are large', () => {
    // 20 and 20 — clears the n gate outright — from two advertisers. This is the fixture the
    // whole stratification argument is about: it looks like a well-powered panel and is a
    // comparison of two house styles.
    const verdict = verdictFor(HEALTHY_AGE, { advertisers: 2, long: 10, short: 10 })

    expect(verdict.outcome).toBe('refused')
    expect(verdict.failedGate).toBe('strata')
    expect(verdict.detail).toEqual({
      required_strata: 3,
      strata_used: 2,
      strata_dropped: 0,
      shortfall_strata: 1,
    })
  })

  it('counts the strata that inform the contrast, not the advertisers merely present', () => {
    // Four advertisers, two of which contribute long-lived creatives only. The total clears
    // MIN_STRATA and the used count does not, and this is the *only* arrangement that
    // separates them: on every other fixture here the two numbers coincide, so the gate could
    // read either one with the suite still green — measured, by mutating it. Both cohorts
    // clear their own gate outright (40 and 20), so nothing else can be the cause.
    const panel = [
      ...panelOf({ advertisers: 2, long: 10, short: 10 }),
      ...panelOf({ advertisers: 1, long: 10, short: 0 }).map((c) => ({
        ...c,
        advertiserId: 'adv-solo-a',
      })),
      ...panelOf({ advertisers: 1, long: 10, short: 0 }).map((c) => ({
        ...c,
        advertiserId: 'adv-solo-b',
      })),
    ]
    const assembly = assembleCohorts(panel)

    expect(assembly.strataTotal).toBe(4)
    expect(assembly.strataUsed).toBe(2)

    const verdict = evaluateGates({ panelAgeDays: HEALTHY_AGE, assembly })

    expect(verdict.outcome).toBe('refused')
    expect(verdict.failedGate).toBe('strata')
    expect(verdict.detail).toEqual({
      required_strata: 3,
      strata_used: 2,
      strata_dropped: 2,
      shortfall_strata: 1,
    })
  })

  it('refuses when the long-lived cohort is almost entirely still running', () => {
    // 21 long of which 18 are censored: 0.857. Three long-lived creatives in the whole panel
    // have actually been watched to stop.
    const verdict = verdictFor(HEALTHY_AGE, {
      advertisers: 3,
      long: 7,
      short: 7,
      censoredLong: 6,
    })

    expect(verdict.outcome).toBe('refused')
    expect(verdict.failedGate).toBe('censoring')
    expect(verdict.detail).toEqual({
      max_rate: 0.8,
      actual_rate: 18 / 21,
      resolved_long: 3,
      n_long: 21,
    })
  })

  it('counts an advertiser in only one cohort as dropped, not as a stratum', () => {
    // Four advertisers, but the fourth contributes long-lived creatives only. It appears in
    // `strata_total` and informs nothing, which is why the gate reads `strata_used`.
    const panel = [
      ...panelOf({ advertisers: 3, long: 7, short: 7 }),
      ...panelOf({ advertisers: 1, long: 7, short: 0 }).map((c) => ({
        ...c,
        advertiserId: 'adv-lonely',
      })),
    ]
    const assembly = assembleCohorts(panel)

    expect(assembly.strataTotal).toBe(4)
    expect(assembly.strataUsed).toBe(3)
    expect(assembly.strataDropped).toBe(1)
    expect(evaluateGates({ panelAgeDays: HEALTHY_AGE, assembly }).outcome).toBe('published')
  })
})

describe('which gate gets reported', () => {
  it('reports the panel age when the panel is both young and thin', () => {
    // A twelve-day panel has small cohorts *because* it is twelve days old. Reporting
    // `cohort_n` would send an operator to add watchlists when the only cure is waiting.
    const verdict = verdictFor(12, { advertisers: 1, long: 1, short: 1 })

    expect(verdict.failedGate).toBe('panel_age')
  })

  it('reports the cohort size before the strata count', () => {
    // Two advertisers with one creative each fails both. Strata are bounded above by n, so
    // the strata number is a consequence; the n is the thing to fix.
    const verdict = verdictFor(HEALTHY_AGE, { advertisers: 2, long: 1, short: 1 })

    expect(verdict.failedGate).toBe('cohort_n')
  })

  it('reports the cohort size before the censoring rate', () => {
    // One long-lived creative, still running: a censoring rate of 1.0, which is a fact about
    // a cohort of one and not about the panel. The n gate owns this.
    const verdict = verdictFor(HEALTHY_AGE, {
      advertisers: 3,
      long: 1,
      short: 1,
      censoredLong: 1,
    })

    expect(verdict.failedGate).toBe('cohort_n')
  })

  it('refuses an empty panel on age rather than dividing by a cohort that is not there', () => {
    const verdict = evaluateGates({ panelAgeDays: 0, assembly: assembleCohorts([]) })

    expect(verdict.outcome).toBe('refused')
    expect(verdict.failedGate).toBe('panel_age')
    expect(verdict.detail).toEqual({
      required_days: 61,
      actual_days: 0,
      shortfall_days: 61,
    })
  })

  it('refuses an aged but empty panel on cohort size, with a null censoring rate in hand', () => {
    // The one arrangement that reaches the censoring gate with no long-lived cohort at all.
    // `censoringRateLong` is null here — 0/0 is not 0 — and the run must refuse on the
    // absent cohort rather than on a rate that does not exist.
    const assembly = assembleCohorts([])
    expect(assembly.censoringRateLong).toBeNull()

    const verdict = evaluateGates({ panelAgeDays: HEALTHY_AGE, assembly })
    expect(verdict.failedGate).toBe('cohort_n')
  })
})
