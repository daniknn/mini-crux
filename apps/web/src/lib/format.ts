/**
 * Rendering rules for numbers that are not what they look like.
 *
 * Every function here exists because the honest rendering and the obvious one differ. A
 * duration we are still watching is a lower bound, not a measurement; a share computed over
 * nothing is not zero; a creative we could not observe every day has a weaker claim than one
 * we could. Formatting is where those distinctions are usually lost, so they are pinned here
 * and tested rather than repeated inline in five components.
 *
 * Copy is Mexican Spanish (rule 12). Never the word *rendimiento* — we have no performance
 * data and must not imply it (rule 7).
 */

/**
 * How long a creative has been running, as a claim we can defend.
 *
 * A censored creative — one still running at the last crawl — has been alive *at least*
 * `days`. Rendering that as `34 días` states that it stopped, which is exactly backwards:
 * censoring is most common among the long-lived creatives the product exists to find, so the
 * plain number is wrong most often on the rows that matter most. The `+` is the whole
 * difference between "duró 34 días" and "lleva 34 días" (DashOne rule 8).
 *
 * There is deliberately no "more than a year" bucket. Any such threshold collapses the two
 * branches into one string above it, which drops the censoring mark on the longest-running
 * creatives in the panel — the precise rows where it carries the most information.
 */
export function durationLabel(days: number | null, isCensored: boolean): string {
  if (days === null) return 'sin medir'

  const unit = days === 1 ? 'día' : 'días'
  return isCensored ? `${days}+ ${unit}` : `${days} ${unit}`
}

/**
 * The verb that goes with the duration. Kept beside {@link durationLabel} because the two
 * must agree: "lleva 34+ días" and "duró 34 días" are both fine, the crossings are not.
 */
export function durationVerb(isCensored: boolean): string {
  return isCensored ? 'lleva' : 'duró'
}

/** A share in 0–1 as a percentage, or the honest answer when there was nothing to divide. */
export function percentLabel(share: number | null): string {
  if (share === null) return 'sin datos'
  return `${Math.round(share * 100)} %`
}

/**
 * A sample size, always rendered, never hidden when small (rule 8: every number ships with
 * its n). `n = 0` is a real and useful statement — it says the metric was attempted and
 * nothing could be measured.
 */
export function sampleLabel(n: number): string {
  return n === 1 ? 'n = 1 creativo' : `n = ${n} creativos`
}

/** A metric value we could not measure, distinguished from a measured zero. */
export function metricLabel(value: number | null, unit = ''): string {
  if (value === null) return 'sin medir'
  const rounded = Math.round(value * 100) / 100
  return unit === '' ? String(rounded) : `${rounded} ${unit}`
}

export type PanelStrength = 'strong' | 'weak'

/**
 * How much a creative's duration rests on.
 *
 * `observationDays` is the number of days we actually looked, and a gap makes the duration a
 * weaker claim rather than a wrong one — which is why gapped creatives are shown with a badge
 * rather than excluded. Excluding them would silently drop the long-lived rows: a creative
 * alive for 60 days spans sixty chances to hit a bad crawl, one alive for three days spans
 * three. Filtering on gaps would therefore filter on lifetime, biasing the panel against
 * exactly the creatives the product exists to find.
 */
export function panelStrength(hasGaps: boolean): PanelStrength {
  return hasGaps ? 'weak' : 'strong'
}

/** Badge copy for a creative whose observation window has holes in it. */
export function gapsLabel(observationDays: number): string {
  return observationDays === 1
    ? 'Con huecos · 1 día observado'
    : `Con huecos · ${observationDays} días observados`
}

/** A date already shaped `YYYY-MM-DD` by SQL, rendered for a Mexican reader. */
export function dateLabel(isoDate: string | null): string {
  if (isoDate === null) return '—'
  // Deliberately not `new Date(isoDate)`: parsing then reformatting would re-introduce the
  // timezone shift the SQL layer went to some trouble to eliminate. The string is already
  // the market's calendar day; only reorder it.
  const [year, month, day] = isoDate.split('-')
  if (year === undefined || month === undefined || day === undefined) return '—'
  return `${day}/${month}/${year}`
}
