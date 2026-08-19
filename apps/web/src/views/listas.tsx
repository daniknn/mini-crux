import type { IngestionHealthSummary } from '@mini-crux/db'
import type { Watchlist } from '@mini-crux/db/dashboard'

import { EmptyState } from '../components/empty-state.tsx'
import { IngestionHealthCard } from '../components/ingestion-health-card.tsx'
import { Badge } from '../components/ui/badge.tsx'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui/card.tsx'
import { dateLabel } from '../lib/format.ts'
import type { WatchlistAction } from '../lib/watchlist-actions.ts'
import {
  CreateWatchlistForm,
  RenameWatchlistForm,
  StatusBadge,
  ToggleWatchlistForm,
} from './watchlist-forms.tsx'

/**
 * Watchlists — what the crawler looks at, and whether it is still looking.
 *
 * This is the ingestion health surface as much as the settings screen. The crawl clock is
 * sacred (rule 1): a watchlist whose last run failed is losing days that cannot be
 * backfilled, and the operator has to be able to see that without reading logs. So each row
 * carries its last run date, that run's status, and the succeeded/failed/suspect tally
 * behind it — three numbers rather than one, because "9 de 10 sanos" and "9 de 30 sanos"
 * are very different panels and a single success count hides which one you have.
 *
 * Presentation only (UC-10). The three writes arrive as props rather than as imports; see
 * `watchlist-forms.tsx` for why that seam is where the preview's isolation is actually won.
 */

const KIND_LABEL: Record<string, string> = {
  keyword: 'Palabra clave',
  page: 'Página',
}

/** The three watchlist writes this surface can trigger. */
export interface WatchlistActions {
  create: WatchlistAction
  rename: WatchlistAction
  setActive: WatchlistAction
}

export function WatchlistsView({
  watchlists,
  health,
  actions,
}: {
  watchlists: Watchlist[]
  health: IngestionHealthSummary
  actions: WatchlistActions
}): React.ReactElement {
  const active = watchlists.filter((w) => w.isActive)
  const paused = watchlists.filter((w) => !w.isActive)

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl">Listas</h1>
        <p className="text-sm text-muted-foreground">
          Lo que el rastreador revisa cada día. Una lista pausada deja de rastrearse, pero
          conserva todo lo que ya observó.
        </p>
      </header>

      {/* Above the create form on purpose: a missed crawl is today's problem and a new
          watchlist is tomorrow's. */}
      <IngestionHealthCard summary={health} />

      <Card>
        <CardHeader>
          <CardTitle>Nueva lista</CardTitle>
          <CardDescription>
            Empieza a rastrear en el siguiente ciclo diario. Lo que pasó antes de crearla no se
            puede recuperar: el historial solo corre hacia adelante.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreateWatchlistForm action={actions.create} />
        </CardContent>
      </Card>

      {watchlists.length === 0 ? (
        <EmptyState title="Todavía no tienes listas">
          Crea la primera arriba. Hasta entonces el panel está vacío porque no hay nada que
          rastrear.
        </EmptyState>
      ) : (
        <>
          <Section title="Activas" watchlists={active} actions={actions} />
          <Section title="Pausadas" watchlists={paused} actions={actions} />
        </>
      )}
    </div>
  )
}

function Section({
  title,
  watchlists,
  actions,
}: {
  title: string
  watchlists: Watchlist[]
  actions: WatchlistActions
}): React.ReactElement | null {
  if (watchlists.length === 0) return null

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm uppercase tracking-wide text-muted-foreground">{title}</h2>
      <ul className="flex flex-col gap-4">
        {watchlists.map((w) => (
          <li key={w.id}>
            <WatchlistCard watchlist={w} actions={actions} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function WatchlistCard({
  watchlist: w,
  actions,
}: {
  watchlist: Watchlist
  actions: WatchlistActions
}): React.ReactElement {
  const totalRuns = w.succeededRuns + w.failedRuns + w.suspectRuns

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span>{w.label}</span>
          <Badge variant="neutral">{KIND_LABEL[w.kind] ?? w.kind}</Badge>
          <Badge variant="neutral">{w.country}</Badge>
          {!w.isActive && <Badge variant="warning">Pausada</Badge>}
        </CardTitle>
        <CardDescription className="flex flex-col gap-2">
          <span className="font-mono text-xs">{w.query}</span>
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={w.lastRunStatus} />
            <span className="text-xs">Último rastreo: {dateLabel(w.lastRunDate)}</span>
          </span>
          {/* Failed and suspect are counted apart on purpose. A failed run wrote nothing; a
              suspect one wrote the creatives it saw and withheld every absence. Both weaken
              the panel, and they weaken it in different ways. */}
          <span className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <span>{totalRuns} rastreos</span>
            <span>{w.succeededRuns} sanos</span>
            {w.suspectRuns > 0 && (
              <span className="text-amber-300">{w.suspectRuns} dudosos (sin registrar bajas)</span>
            )}
            {w.failedRuns > 0 && (
              <span className="text-red-300">{w.failedRuns} fallidos (días sin mirar)</span>
            )}
          </span>
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4 border-t border-border pt-4">
        <RenameWatchlistForm action={actions.rename} id={w.id} label={w.label} />
        <ToggleWatchlistForm action={actions.setActive} id={w.id} isActive={w.isActive} />
      </CardContent>
    </Card>
  )
}
