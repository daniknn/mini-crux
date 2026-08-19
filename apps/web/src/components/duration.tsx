import { Badge } from './ui/badge.tsx'
import { durationLabel, durationVerb, gapsLabel } from '../lib/format.ts'

/**
 * A creative's lifetime, with everything that qualifies it.
 *
 * This component exists so that no surface can render `daysActive` on its own. The number
 * alone is a claim the data does not support in the two most common cases — still running,
 * and observed with gaps — and those are exactly the cases a component author is most
 * likely to forget, because both look like ordinary integers in the row.
 */
export function Duration({
  daysActive,
  isCensored,
  hasGaps,
  observationDays,
  withVerb = false,
}: {
  daysActive: number | null
  isCensored: boolean
  hasGaps: boolean
  observationDays: number
  withVerb?: boolean
}): React.ReactElement {
  const label = durationLabel(daysActive, isCensored)

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="tabular-nums">
        {withVerb && <span className="text-muted-foreground">{durationVerb(isCensored)} </span>}
        <strong className="font-medium text-foreground">{label}</strong>
      </span>

      {/* Spelled out rather than left to the `+`: the mark is easy to miss at a glance and
          impossible to hear. */}
      {isCensored && daysActive !== null && (
        <Badge variant="primary" title="Seguía activo en el último rastreo, así que su duración es un mínimo">
          Aún activo
        </Badge>
      )}

      {/* Shown, not filtered out. Excluding gapped creatives would quietly exclude the
          long-lived ones — a creative alive 60 days spans sixty chances to hit a bad crawl,
          one alive 3 days spans three — and so would bias the panel against precisely the
          rows the product exists to find. */}
      {hasGaps && (
        <Badge variant="warning" title="Faltan días de observación dentro de su periodo de vida">
          {gapsLabel(observationDays)}
        </Badge>
      )}
    </span>
  )
}
