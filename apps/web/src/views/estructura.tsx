import type {
  MetricDistribution,
  PanelHealth,
  StructuralComparison,
  StructuralProfile,
} from '@mini-crux/db/dashboard'
import Link from 'next/link'

import { EmptyState } from '../components/empty-state.tsx'
import { PanelCaveat } from '../components/panel-caveat.tsx'
import { Badge } from '../components/ui/badge.tsx'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui/card.tsx'
import { metricLabel, percentLabel, sampleLabel } from '../lib/format.ts'
import { cn } from '../lib/utils.ts'
import type { GalleryAdvertiser } from './creativos.tsx'

/**
 * How one advertiser's creatives are built, against everyone else's.
 *
 * This is a descriptive surface and stops there. It says "este anunciante corta más rápido
 * que la mediana del panel" — it does not say that cutting faster works, because we have no
 * outcome data to support that and UC-5 is where any such claim will have to earn its
 * caveats. Every distribution carries its own n, because a metric the extractor could not
 * measure shrinks that metric's sample without shrinking the others (rule 8).
 *
 * Presentation only (UC-10). `comparison` is null exactly when `selectedId` is undefined —
 * the page cannot fetch a profile for an advertiser that does not exist — and that pairing is
 * the "panel with no advertisers yet" state rather than an error.
 */

const METRICS = [
  { key: 'durationS', label: 'Duración', unit: 's' },
  { key: 'firstCutTimeS', label: 'Primer corte', unit: 's' },
  { key: 'cutsPerSecond', label: 'Cortes por segundo', unit: '' },
  { key: 'textDensity', label: 'Densidad de texto', unit: '' },
] as const

export function StructureView({
  health,
  advertisers,
  selectedId,
  activeOnly,
  comparison,
  basePath = '',
}: {
  health: PanelHealth
  advertisers: GalleryAdvertiser[]
  selectedId: string | undefined
  activeOnly: boolean
  comparison: StructuralComparison | null
  /** Prefix for every internal link. `/ux` in the preview, empty in the product (UC-10). */
  basePath?: string
}): React.ReactElement {
  if (selectedId === undefined || comparison === null) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="font-display text-2xl">Estructura</h1>
        <EmptyState title="Todavía no hay anunciantes en el panel">
          Los anunciantes aparecen cuando una lista activa produce su primer rastreo sano.
        </EmptyState>
      </div>
    )
  }

  const selected = advertisers.find((a) => a.id === selectedId)

  const href = (next: { anunciante?: string; incluir?: string }): string => {
    const search = new URLSearchParams()
    search.set('anunciante', next.anunciante ?? selectedId)
    const incluir = next.incluir ?? (activeOnly ? 'activos' : 'todos')
    if (incluir === 'todos') search.set('incluir', 'todos')
    return `${basePath}/estructura?${search.toString()}`
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl">Estructura</h1>
        <p className="text-sm text-muted-foreground">
          Cómo están armados los creativos de un anunciante, frente a la mediana del panel.
          Es una descripción, no una recomendación: no tenemos datos de desempeño.
        </p>
      </header>

      <PanelCaveat health={health} />

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-24 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
            Anunciante
          </span>
          {advertisers.map((a) => (
            <Chip key={a.id} href={href({ anunciante: a.id })} active={a.id === selectedId}>
              {a.name}
            </Chip>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="w-24 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
            Incluir
          </span>
          <Chip href={href({ incluir: 'activos' })} active={activeOnly}>
            Solo activos
          </Chip>
          <Chip href={href({ incluir: 'todos' })} active={!activeOnly}>
            Activos y retirados
          </Chip>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{selected?.name ?? 'Anunciante'}</CardTitle>
          <CardDescription className="flex flex-wrap items-center gap-2">
            <span>
              {sampleLabel(comparison.advertiser.creatives)} en alcance ·{' '}
              {comparison.advertiser.extracted} con medidas
            </span>
            {comparison.advertiser.truncated > 0 && (
              <Badge variant="warning">
                {comparison.advertiser.truncated} medidos sobre un tramo recortado
              </Badge>
            )}
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-5">
          {comparison.advertiser.extracted === 0 ? (
            <p className="text-sm text-muted-foreground">
              Ninguno de sus creativos tiene medidas todavía. No es que midan cero: aún no
              pasan por el extractor.
            </p>
          ) : (
            METRICS.map((m) => (
              <MetricRow
                key={m.key}
                label={m.label}
                unit={m.unit}
                advertiser={comparison.advertiser[m.key]}
                baseline={comparison.baseline[m.key]}
              />
            ))
          )}

          <HookRow advertiser={comparison.advertiser} baseline={comparison.baseline} />
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * One metric, as a median with its quartiles and its own n beside the panel's.
 *
 * The median rather than the mean: a single 3-minute brand film drags a mean of five
 * 15-second performance ads somewhere no creative actually sits, and this panel is small
 * enough for that to happen regularly.
 */
function MetricRow({
  label,
  unit,
  advertiser,
  baseline,
}: {
  label: string
  unit: string
  advertiser: MetricDistribution
  baseline: MetricDistribution
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1 border-b border-border pb-4 last:border-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="text-xs text-muted-foreground">
          {sampleLabel(advertiser.n)} · panel {sampleLabel(baseline.n)}
        </span>
      </div>

      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 font-mono text-sm">
        <span className="text-foreground">
          Mediana {metricLabel(advertiser.p50, unit)}
        </span>
        <span className="text-muted-foreground">
          p25 {metricLabel(advertiser.p25, unit)} · p75 {metricLabel(advertiser.p75, unit)}
        </span>
        <span className="text-muted-foreground">
          Panel {metricLabel(baseline.p50, unit)}
        </span>
      </div>

      {/* Deliberately no "X % faster than the panel" claim. With an n this small a ratio
          reads as a finding when it is noise; the two medians side by side let a reader
          judge the gap against the sample it rests on. */}
      {advertiser.n < 5 && advertiser.n > 0 && (
        <p className="text-xs text-amber-300">
          Muestra pequeña: con {advertiser.n} creativos medidos, la mediana se mueve mucho con
          uno solo.
        </p>
      )}
    </div>
  )
}

function HookRow({
  advertiser,
  baseline,
}: {
  advertiser: StructuralProfile
  baseline: StructuralProfile
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-foreground">
          Texto en los primeros 2 segundos
        </span>
        <span className="text-xs text-muted-foreground">
          {sampleLabel(advertiser.hookText.n)} · panel {sampleLabel(baseline.hookText.n)}
        </span>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-6 font-mono text-sm">
        <span className="text-foreground">{percentLabel(advertiser.hookText.share)}</span>
        <span className="text-muted-foreground">
          Panel {percentLabel(baseline.hookText.share)}
        </span>
      </div>
    </div>
  )
}

function Chip({
  href,
  active,
  children,
}: {
  href: string
  active: boolean
  children: React.ReactNode
}): React.ReactElement {
  return (
    <Link
      href={href}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'flex h-11 items-center rounded-pill px-4 text-xs transition-colors duration-fast ease-brew',
        active
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </Link>
  )
}
