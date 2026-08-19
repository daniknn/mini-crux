import type { CohortMember } from './cohorts.ts'

/**
 * The descriptive half of UC-8: `hook_type` and `tone`, counted per cohort, never tested.
 *
 * Spec §6 draws the line on purpose. `has_people_on_screen` is boolean and runs through the
 * same van Elteren + Benjamini-Hochberg pipeline as every structural feature — 0/1 in, z/p/q
 * out. `hook_type` and `tone` are small, unordered, fixed-taxonomy categories: "testimonial"
 * is not more or less than "demo", so a rank test has nothing to rank them by, and forcing
 * one through would assume an ordering that does not exist. A chi-square or Fisher's exact
 * test is named explicitly as future work (upgrade path), not attempted here.
 *
 * So this module produces the other kind of thing a panel can say: a caption, not a claim.
 * "5 of 8 long-lived creatives opened with a testimonial, 2 of 8 short-lived" carries its own
 * n on its face (`CLAUDE.md` rule 8) and needs no p-value to be honest — it is a count, not
 * an inference.
 */

/** The two descriptive tags, and the field on {@link CohortMember} each one reads. */
export type DescriptiveTag = 'hook_type' | 'tone'

const TAG_FIELD = {
  hook_type: 'hookType',
  tone: 'tone',
} as const satisfies Record<DescriptiveTag, keyof CohortMember>

/**
 * The fixed taxonomies, pinned to the `check` constraints on `creative_semantic_tags` in
 * migration 0012. Duplicated the same way {@link ANALYSIS_FEATURES} is duplicated against
 * `analysis_feature_results` — two lists in two languages that have to agree, and
 * `analysis-schema.test.ts` reads the live constraint out of the catalog to prove it.
 */
export const HOOK_TYPES = [
  'testimonial',
  'demo',
  'problem_solution',
  'ugc',
  'offer',
  'other',
] as const

export const TONES = ['humoristico', 'emocional', 'informativo', 'urgente', 'aspiracional', 'other'] as const

const TAXONOMY: Readonly<Record<DescriptiveTag, readonly string[]>> = {
  hook_type: HOOK_TYPES,
  tone: TONES,
}

export interface TagValueCount {
  readonly value: string
  readonly nLong: number
  readonly nShort: number
}

export interface TagBreakdown {
  readonly tag: DescriptiveTag
  /** One entry per taxonomy value, in taxonomy order, including values nobody was tagged with. */
  readonly counts: readonly TagValueCount[]
  /** Cohort members with no value for this tag: never tagged, or the model declined the field. */
  readonly untaggedLong: number
  readonly untaggedShort: number
  /** Every member in the cohort, tagged or not — what the counts above are a share of. */
  readonly nLong: number
  readonly nShort: number
}

/**
 * Count one descriptive tag across the two cohorts.
 *
 * No p-value, no q-value, no rank test — the whole point of keeping this a separate module
 * from `stratify`/`vanElteren` (spec §6, acceptance criterion "no p-value and no q-value
 * attached"). `counts` is built from the fixed taxonomy rather than from whatever values
 * happen to appear, so a value nobody in this panel used still renders as a zero rather than
 * silently vanishing from the caption — and the sum of every `nLong`/`nShort` in `counts` plus
 * `untaggedLong`/`untaggedShort` is exactly {@link TagBreakdown.nLong}/{@link
 * TagBreakdown.nShort}, which is the "counts sum to n" acceptance criterion made structural
 * rather than merely true by luck on one fixture.
 */
export function describeTagDistribution(
  members: readonly CohortMember[],
  tag: DescriptiveTag,
): TagBreakdown {
  const field = TAG_FIELD[tag]
  const longCounts = new Map<string, number>()
  const shortCounts = new Map<string, number>()
  let untaggedLong = 0
  let untaggedShort = 0
  let nLong = 0
  let nShort = 0

  for (const member of members) {
    const value = member[field] as string | null
    const long = member.cohort === 'long_lived'
    if (long) nLong += 1
    else nShort += 1

    if (value === null) {
      if (long) untaggedLong += 1
      else untaggedShort += 1
      continue
    }

    const counts = long ? longCounts : shortCounts
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }

  const counts = TAXONOMY[tag].map((value) => ({
    value,
    nLong: longCounts.get(value) ?? 0,
    nShort: shortCounts.get(value) ?? 0,
  }))

  return { tag, counts, untaggedLong, untaggedShort, nLong, nShort }
}
