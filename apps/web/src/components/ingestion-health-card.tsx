import type { IngestionHealthSummary, IngestionOffenceReason } from '@mini-crux/db'

import { Badge } from './ui/badge.tsx'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card.tsx'

/**
 * Today's crawl, on the screen the operator already opens.
 *
 * The endpoint next door is the pager. This is the same verdict rendered for a human,
 * because an operator who opens the app should not have to *trust* that an alert would have
 * fired — the two read the same view through the same summarizer, so they cannot disagree.
 *
 * WHY EACH REASON GETS ITS OWN SENTENCE
 *
 * The four states below need four different actions, and collapsing them into "algo falló"
 * is how an operator ends up retrying something that was never started, or waiting on
 * something that already gave up. The copy for each one says what to do, not what happened.
 *
 * WHY THE HEALTHY CASE IS STILL A CARD
 *
 * An alarm that renders nothing when everything is fine is indistinguishable from an alarm
 * that is broken. Showing "3 de 3 al día" is what makes the silence trustworthy.
 */

const REASON_LABEL: Record<IngestionOffenceReason, string> = {
  'never-started': 'No arrancó',
  failed: 'Falló',
  stalled: 'Se quedó colgado',
  suspect: 'Datos incompletos',
}

const REASON_HELP: Record<IngestionOffenceReason, string> = {
  // The dangerous one, and the reason this card exists. Nothing is broken downstream:
  // something upstream never asked, so there is nothing to retry until it is scheduled.
  'never-started':
    'No se registró ningún intento hoy. Revisa que la lista siga activa y que el reloj diario ' +
    'esté corriendo — esto no se arregla reintentando, porque no hay nada que reintentar.',
  // Recoverable, and only today. Said plainly because the deadline is real.
  failed:
    'El intento corrió y no lo logró. Se puede reintentar hoy mismo y el día se salva; ' +
    'mañana ya no, porque la Ad Library solo muestra lo que está activo en este momento.',
  stalled:
    'Lleva demasiado tiempo corriendo. Lo más probable es que el proceso que lo tomó ya no ' +
    'exista; el reaper lo devuelve a la cola y vuelve a intentarse solo.',
  suspect:
    'Bajaron mucho los resultados frente a los días anteriores, así que el análisis de hoy se ' +
    'deja pendiente a propósito. Vale la pena revisar el rastreo antes de darlo por bueno.',
}

const REASON_VARIANT: Record<IngestionOffenceReason, 'danger' | 'warning'> = {
  'never-started': 'danger',
  failed: 'danger',
  stalled: 'warning',
  suspect: 'warning',
}

export function IngestionHealthCard({
  summary,
}: {
  summary: IngestionHealthSummary
}): React.ReactElement | null {
  // Nothing to crawl is not a missed crawl. The page already tells an operator with no
  // watchlists what to do, and repeating it as an alarm would teach them to dismiss one.
  if (summary.counts.watchlists === 0) return null

  const healthy = summary.status === 'ok'

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span>Rastreo de hoy</span>
          {healthy ? (
            <Badge variant="success">Al día</Badge>
          ) : (
            <Badge variant="danger">
              {summary.counts.offenders} de {summary.counts.watchlists} sin rastreo
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          {/* The market's day, spelled out, because it is the thing most likely to be
              misread by someone comparing this against their own clock. */}
          Día de mercado {summary.marketDate} (hora de la Ciudad de México).{' '}
          {summary.counts.succeeded} de {summary.counts.watchlists} listas activas ya
          rastrearon
          {summary.counts.inFlight > 0
            ? `, ${summary.counts.inFlight} sigue${summary.counts.inFlight === 1 ? '' : 'n'} en curso`
            : ''}
          .
        </CardDescription>
      </CardHeader>

      {summary.offenders.length > 0 && (
        <CardContent>
          <ul className="flex flex-col gap-4">
            {summary.offenders.map((offender) => (
              <li key={offender.watchlistId} className="flex flex-col gap-1.5">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge variant={REASON_VARIANT[offender.reason]}>
                    {REASON_LABEL[offender.reason]}
                  </Badge>
                  <span className="text-sm text-foreground">{offender.label}</span>
                </span>
                <p className="text-xs text-muted-foreground">{REASON_HELP[offender.reason]}</p>
                {offender.error !== null && (
                  // Verbatim and monospaced: this is the string that gets pasted into an
                  // issue, and paraphrasing it costs the only detail that identifies the
                  // failure.
                  <p className="font-mono text-xs text-muted-foreground">{offender.error}</p>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      )}
    </Card>
  )
}
