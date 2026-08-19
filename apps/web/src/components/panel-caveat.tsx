import type { PanelHealth } from '@mini-crux/db/dashboard'

import { Badge } from './ui/badge.tsx'
import { dateLabel, percentLabel } from '../lib/format.ts'

/**
 * The caveat that has to sit above every duration on every surface.
 *
 * `days_active` is meaningless without it. A panel three weeks old with 90% of its creatives
 * still running does not report a short average lifetime — it reports the length of its own
 * observation window, and a reader who cannot see the window will read the first number as
 * the second. DashOne rule 8: every number ships with its n and its caveat, and this is the
 * caveat, rendered once rather than restated per card.
 */
export function PanelCaveat({ health }: { health: PanelHealth }): React.ReactElement {
  const outageDays = health.panelAgeDays - health.healthyDays
  const censored = health.censoringRate

  return (
    <section
      aria-label="Alcance del panel"
      className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-border bg-muted/40 px-5 py-3 text-sm"
    >
      <span className="text-muted-foreground">
        Panel de <strong className="font-medium text-foreground">{health.panelAgeDays} días</strong>
        {health.firstRunDate !== null && (
          <> · desde el {dateLabel(health.firstRunDate)}</>
        )}
      </span>

      <span className="text-muted-foreground">
        {health.totalCreatives} creativos observados
      </span>

      {/* The share still running. High is not bad — it is the reason every duration below
          is a lower bound rather than a measurement. */}
      <span className="text-muted-foreground">
        {censored === null ? (
          'Sin datos de supervivencia todavía'
        ) : (
          <>
            <strong className="font-medium text-foreground">{percentLabel(censored)}</strong> sigue
            activo, así que su duración es un mínimo
          </>
        )}
      </span>

      {outageDays > 0 && (
        <Badge variant="warning">
          {outageDays === 1 ? '1 día sin rastreo sano' : `${outageDays} días sin rastreo sano`}
        </Badge>
      )}

      {health.creativesWithGaps > 0 && (
        <Badge variant="warning">
          {health.creativesWithGaps === 1
            ? '1 creativo con huecos'
            : `${health.creativesWithGaps} creativos con huecos`}
        </Badge>
      )}
    </section>
  )
}
