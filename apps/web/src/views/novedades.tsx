import type { ChangeFeed, ChangeFeedEntry, PanelHealth } from '@mini-crux/db/dashboard'
import Link from 'next/link'

import { Duration } from '../components/duration.tsx'
import { EmptyState } from '../components/empty-state.tsx'
import { PanelCaveat } from '../components/panel-caveat.tsx'
import { Badge } from '../components/ui/badge.tsx'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.tsx'
import { dateLabel } from '../lib/format.ts'

/**
 * "¿Qué cambió?" — the question an operator opens the product with.
 *
 * WHY LAUNCHES AND DISCOVERIES ARE SEPARATE SECTIONS
 *
 * A new row in our panel is not a new ad. An ad Meta started yesterday is news about the
 * competitor; an eight-month evergreen that only just entered our panel is news about *us* —
 * it says our coverage grew, not that anything happened in the market. Merging them puts a
 * creative that has been running since last year under "nuevo", which is the same error as
 * using `first_seen_at` for a start date (rule 5), and it misfires hardest on exactly the
 * long-lived creatives this product exists to surface.
 *
 * Presentation only: the fetch lives in `app/(dashboard)/novedades/page.tsx`, and the same
 * component renders under `/ux` from fixtures (UC-10). `feed` is nullable here rather than
 * being resolved by the caller because "no crawls yet" is one of the states this surface is
 * responsible for saying out loud.
 */

// The panel's own last day is the anchor, never `new Date()`. A clock-derived window would
// silently slide past the last crawl during an outage and report an empty week as calm.
export const WINDOW_DAYS = 7

export function ChangeFeedView({
  health,
  feed,
  basePath = '',
}: {
  health: PanelHealth
  feed: ChangeFeed | null
  /** Prefix for every internal link. `/ux` in the preview, empty in the product (UC-10). */
  basePath?: string
}): React.ReactElement {
  if (feed === null) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="font-display text-2xl">Novedades</h1>
        <EmptyState title="Todavía no hay rastreos">
          El panel empieza a llenarse con el primer rastreo diario. La supervivencia de un
          creativo no se puede reconstruir hacia atrás, así que los primeros resultados útiles
          llegan después de unas ocho semanas de observación continua.
        </EmptyState>
      </div>
    )
  }

  const total = feed.launched.length + feed.discovered.length + feed.stopped.length

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl">Novedades</h1>
        <p className="text-sm text-muted-foreground">
          Del {dateLabel(feed.since)} al {dateLabel(feed.until)}, según los días de rastreo —
          no según el reloj.
        </p>
      </header>

      <PanelCaveat health={health} />

      {total === 0 ? (
        <EmptyState title="Sin movimientos en la ventana">
          Ningún anunciante vigilado lanzó ni retiró creativos en estos {WINDOW_DAYS} días.
          Revisa que el rastreo siga sano: una racha de días fallidos también se ve así.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-8">
          <Section
            title="Lanzados"
            hint="Meta registra su inicio dentro de la ventana. Esto sí es novedad del anunciante."
            entries={feed.launched}
            basePath={basePath}
          />
          <Section
            title="Descubiertos"
            hint="Los vimos por primera vez ahora, pero llevaban tiempo corriendo. Es novedad de nuestra cobertura, no del mercado."
            entries={feed.discovered}
            basePath={basePath}
          />
          <Section
            title="Retirados"
            hint="Dejaron de aparecer en un rastreo sano. Solo bajas explícitas: un rastreo fallido nunca cuenta como muerte."
            entries={feed.stopped}
            basePath={basePath}
          />
        </div>
      )}
    </div>
  )
}

function Section({
  title,
  hint,
  entries,
  basePath,
}: {
  title: string
  hint: string
  entries: ChangeFeedEntry[]
  basePath: string
}): React.ReactElement {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="font-display text-lg">
          {title}{' '}
          <span className="font-sans text-sm font-normal text-muted-foreground">
            ({entries.length})
          </span>
        </h2>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>

      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nada en esta ventana.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {entries.map((entry) => (
            <li key={`${entry.kind}-${entry.creativeId}`}>
              <Card>
                <CardHeader className="flex-row items-start justify-between gap-4">
                  <div className="flex flex-col gap-1">
                    <CardTitle className="text-base">
                      <Link
                        href={`${basePath}/creativos/${entry.creativeId}`}
                        className="hover:text-primary"
                      >
                        {entry.advertiserName}
                      </Link>
                    </CardTitle>
                    <CardDescription className="line-clamp-2">
                      {entry.firstLineTranscript ?? entry.adCopy ?? 'Sin copia registrada'}
                    </CardDescription>
                  </div>
                  <Badge variant="neutral">{dateLabel(entry.eventDate)}</Badge>
                </CardHeader>
                <CardContent className="flex flex-wrap items-center gap-3 text-sm">
                  <Duration
                    daysActive={entry.daysActive}
                    isCensored={entry.isCensored}
                    hasGaps={entry.hasGaps}
                    observationDays={entry.observationDays}
                    withVerb
                  />
                  {/* Meta's own start date, when it gave us one. Its absence is why
                      "descubierto" and "lanzado" have to stay separate sections. */}
                  <span className="text-muted-foreground">
                    {entry.startedDate === null
                      ? 'Meta no reporta fecha de inicio'
                      : `Inicio según Meta: ${dateLabel(entry.startedDate)}`}
                  </span>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
