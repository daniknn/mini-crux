/**
 * The gate: when the analysis refuses to publish, and what it says instead.
 *
 * WHY THIS MODULE IS THE POINT OF UC-5
 *
 * Every other use case ships a capability. This one ships a refusal.
 *
 * A van Elteren test over nine creatives returns a p-value with exactly the same serene
 * confidence as one over nine hundred, and nothing in the arithmetic notices. There is no
 * point at which the statistics volunteer that they are meaningless — `vanElteren` returns a
 * `z`, `benjaminiHochberg` adjusts it, the card renders, and an operator reallocates budget
 * against noise. The protection cannot live in the test. It has to be a separate decision
 * taken before the test is allowed to publish, which is this module.
 *
 * WHY REFUSAL IS PER ANALYSIS AND NOT PER FEATURE
 *
 * A run that fails any gate publishes **zero** feature results, not the subset that happened
 * to clear a per-feature n. Publishing the survivors is a garden of forking paths with extra
 * steps: the features that clear an n threshold on a thin panel are the ones whose extractor
 * skipped least, which correlates with media type, which correlates with advertiser. The
 * database enforces this too, in `app.assert_run_published`, because this is the rule a
 * well-meaning bug fix reintroduces.
 *
 * WHY THE ORDER OF THE GATES IS PART OF THE SPECIFICATION
 *
 * Exactly one gate is reported, so which one is reported matters — it is the sentence the
 * operator reads and the thing they will try to fix. The checks run most-fundamental first,
 * so the reported gate is always a *cause* and never a symptom:
 *
 * 1. {@link MIN_PANEL_AGE_DAYS} — on a panel younger than the `long_lived` threshold, every
 *    other shortfall is downstream of this one. Nothing but time fixes it.
 * 2. {@link MIN_COHORT_N} — with four creatives in a cohort, the strata count and the
 *    censoring rate are both noise. Reporting either would send an operator to fix the
 *    crawler when what they need is more creatives.
 * 3. {@link MIN_STRATA} — strata are bounded above by n, so this is only meaningful once n
 *    clears.
 * 4. {@link MAX_CENSORING_RATE} — last because it is the only one that can be true of a
 *    genuinely well-powered panel.
 *
 * WHY THE THRESHOLDS ARE CONSTANTS HERE AND NOT LITERALS AT THE CALL SITE
 *
 * They are defensible defaults, not measurements, and the spec defers tuning them until
 * there is a real distribution to tune against. Single-sourcing them is what makes that
 * later change one edit rather than an audit.
 */

import type { CohortAssembly } from './cohorts.ts'
import { LONG_LIVED_ABOVE_DAYS } from './cohorts.ts'

/**
 * Creatives required in *each* cohort.
 *
 * Below this the test has almost no power, which is the failure mode that matters: a null
 * result on 8 creatives is indistinguishable from a null result on no data, but it renders
 * identically to a real one. Twenty is the conventional floor for a rank test to detect a
 * large effect; it is not a claim that 20 is enough to detect a small one.
 */
export const MIN_COHORT_N = 20

/**
 * Advertisers that must contribute to *both* cohorts.
 *
 * Two advertisers is a comparison of two house styles wearing statistics: with one stratum
 * on each side, "long-lived creatives cut faster" and "the advertiser whose creatives run
 * long happens to cut fast" are the same sentence. Three is the smallest number at which
 * the stratification is doing anything a pooled test would not.
 */
export const MIN_STRATA = 3

/**
 * Days the panel must have been observed for.
 *
 * `LONG_LIVED_ABOVE_DAYS + 1` by construction, and derived rather than typed so the two
 * cannot drift: the threshold is strict, so the shortest qualifying creative has run 61
 * days. This is the observation *window* — how long we have been looking — not the age of
 * any creative. Meta's `ad_delivery_start_time` means a creative can already be 99 days old
 * on our tenth day of crawling, so a young panel does not lack long-lived creatives. What it
 * lacks is any creative we have watched *stop*: `short_lived` requires an observed death,
 * and until the window is wide enough to hold one, the contrast is between a cohort selected
 * on age and a cohort selected on having died quickly enough for us to notice.
 */
export const MIN_PANEL_AGE_DAYS = LONG_LIVED_ABOVE_DAYS + 1

/**
 * Share of `long_lived` still running, above which the cohort is not a cohort.
 *
 * At 0.95 the long-lived group is "things we have not seen end" and the short-lived group is
 * by definition all-resolved, so part of the contrast between them measures when we started
 * looking rather than anything structural. Not 1.0: censoring in the long-lived cohort is
 * normal and expected — the good ads are still running, that is the whole premise — so this
 * gate fires only when the cohort has become almost entirely unresolved.
 */
export const MAX_CENSORING_RATE = 0.8

/** Which gate refused. Stored verbatim in `analysis_runs.failed_gate`. */
export type GateId = 'panel_age' | 'cohort_n' | 'strata' | 'censoring'

/**
 * What the gate saw and what it needed, stored in `analysis_runs.gate_detail`.
 *
 * Snake-cased because it lands in a `jsonb` column that SQL and the UI both read, and a
 * casing boundary inside a stored document is a bug waiting for whoever adds the next
 * consumer.
 */
export type GateDetail = Readonly<Record<string, number>>

export interface GateRefusal {
  readonly outcome: 'refused'
  readonly failedGate: GateId
  readonly detail: GateDetail
}

export interface GatePass {
  readonly outcome: 'published'
  readonly failedGate: null
  readonly detail: GateDetail
}

export type GateVerdict = GateRefusal | GatePass

export interface GateInput {
  /**
   * Days this workspace has been observed on: a count of distinct healthy crawl days, not
   * the calendar span between the first and the last. See `getPanelWindow` for why the
   * conservative reading is the one the gate gets.
   */
  readonly panelAgeDays: number
  readonly assembly: CohortAssembly
}

/**
 * Decide whether this panel may publish, and if not, say precisely what it is missing.
 *
 * Returns a verdict rather than throwing. A refusal is an ordinary, expected, *storable*
 * outcome — the panel is young, which is a fact about the panel and not an error — and
 * throwing would push it into the same channel as a genuine failure, where the caller would
 * have to reconstruct from an exception the row it needs to write.
 */
export function evaluateGates(input: GateInput): GateVerdict {
  const { panelAgeDays, assembly } = input
  const nLong = assembly.counts.long_lived
  const nShort = assembly.counts.short_lived

  if (panelAgeDays < MIN_PANEL_AGE_DAYS) {
    return refuse('panel_age', {
      required_days: MIN_PANEL_AGE_DAYS,
      actual_days: panelAgeDays,
      // What the UI renders as "faltan N días". Computed here rather than in the component
      // so the number an operator reads is the number the run recorded, forever, rather
      // than a subtraction re-done later against constants that have since been tuned.
      shortfall_days: MIN_PANEL_AGE_DAYS - panelAgeDays,
    })
  }

  // The smaller cohort is the binding one: a contrast with 400 long-lived and 3 short-lived
  // creatives has the power of the 3. Reporting `min` rather than whichever cohort happens
  // to be checked first also makes the shortfall an honest "how many more do we need".
  const smallest = Math.min(nLong, nShort)
  if (smallest < MIN_COHORT_N) {
    return refuse('cohort_n', {
      required_n: MIN_COHORT_N,
      n_long: nLong,
      n_short: nShort,
      shortfall_n: MIN_COHORT_N - smallest,
    })
  }

  if (assembly.strataUsed < MIN_STRATA) {
    return refuse('strata', {
      required_strata: MIN_STRATA,
      strata_used: assembly.strataUsed,
      strata_dropped: assembly.strataDropped,
      shortfall_strata: MIN_STRATA - assembly.strataUsed,
    })
  }

  // Null means the long-lived cohort is empty, which cannot reach this line — `cohort_n`
  // refused above at `nLong = 0`. It is written as "null does not fail this gate" rather
  // than as an assertion because that is also the correct reading on its own terms: with no
  // long-lived creatives there is no censoring rate to be alarmed by, only an absent cohort,
  // and the gate that owns absent cohorts has already spoken.
  const censoring = assembly.censoringRateLong
  if (censoring !== null && censoring > MAX_CENSORING_RATE) {
    return refuse('censoring', {
      max_rate: MAX_CENSORING_RATE,
      actual_rate: censoring,
      // Long-lived creatives we have actually watched stop. The share is the gate; this is
      // the number that makes it concrete in the refusal copy.
      resolved_long: Math.round(nLong * (1 - censoring)),
      n_long: nLong,
    })
  }

  return { outcome: 'published', failedGate: null, detail: {} }
}

function refuse(failedGate: GateId, detail: GateDetail): GateRefusal {
  return { outcome: 'refused', failedGate, detail }
}
