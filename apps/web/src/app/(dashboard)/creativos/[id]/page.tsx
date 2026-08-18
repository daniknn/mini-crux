import { getCreativeDetail, type CreativeDetail } from '@mini-crux/db/dashboard'
import { notFound } from 'next/navigation'

import { Duration } from '../../../../components/duration.tsx'
import { Badge } from '../../../../components/ui/badge.tsx'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../../components/ui/card.tsx'
import { dateLabel, metricLabel } from '../../../../lib/format.ts'
import { withWorkspace } from '../../../../server/db.ts'

/**
 * One creative: its measurements, its message, and the day-by-day record behind its duration.
 *
 * The observation history is the point. Every other surface shows a derived number; this is
 * the only place an operator can see what that number was derived from, including the days
 * we did not look. "No lo vimos" and "no miramos" are different facts (rule 3), and a
 * duration that spans a hole in the record is weaker than one that does not.
 */
export default async function CreativeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<React.ReactElement> {
  const { id } = await params

  // A malformed id would make Postgres reject the `::uuid` cast, which is a 500 for what is
  // really a 404. Checked here so a typo'd URL reads as "not found".
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound()

  const creative = await withWorkspace((db) => getCreativeDetail(db, id))
  // Null covers both "no such creative" and "belongs to another workspace" — RLS returns the
  // same empty result for each, and rendering the same 404 is what keeps them
  // indistinguishable to a caller probing for ids.
  if (creative === null) notFound()

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">{creative.advertiserName}</p>
        <h1 className="font-display text-2xl">
          {creative.firstLineTranscript ?? creative.adCopy ?? 'Creativo sin copia registrada'}
        </h1>
        <Duration
          daysActive={creative.daysActive}
          isCensored={creative.isCensored}
          hasGaps={creative.hasGaps}
          observationDays={creative.observationDays}
          withVerb
        />
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Estructura</CardTitle>
            <CardDescription>
              Medidas del video, no de su resultado. No tenemos datos de desempeño.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Metric label="Duración" value={metricLabel(creative.durationS, 's')} />
            <Metric label="Primer corte" value={metricLabel(creative.firstCutTimeS, 's')} />
            <Metric label="Cortes por segundo" value={metricLabel(creative.cutsPerSecond)} />
            <Metric label="Densidad de texto" value={metricLabel(creative.textDensity)} />
            <Metric
              label="Texto en los primeros 2 s"
              value={
                creative.textInFirst2s === null
                  ? 'sin medir'
                  : creative.textInFirst2s
                    ? 'sí'
                    : 'no'
              }
            />
            <Metric label="Variantes del anuncio" value={String(creative.variantCount)} />

            {/* A rate over a capped sample is a different quantity from one over the whole
                ad, and the analysis has to be able to tell which it is holding. */}
            {creative.truncated && creative.analysisCapS !== null && (
              <p className="sm:col-span-2 rounded-sm bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                El video superó el límite de muestreo: las tasas de arriba se midieron sobre
                los primeros {creative.analysisCapS} s, no sobre el video completo.
              </p>
            )}

            <SkippedFeatures creative={creative} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Fechas</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            {/* Meta's own start date, which is what makes a duration a real lifetime rather
                than "how long we happened to be watching" (rule 5). */}
            <Row label="Inicio según Meta" value={dateLabel(creative.startedDate)} />
            <Row label="Primera vez que lo vimos" value={dateLabel(creative.firstSeenDate)} />
            <Row
              label="Retirado"
              value={
                creative.stoppedDate === null
                  ? 'Sigue activo'
                  : dateLabel(creative.stoppedDate)
              }
            />
            <Row label="Días observados" value={String(creative.observationDays)} />
            <Row label="Plataformas" value={creative.publisherPlatforms.join(', ') || '—'} />
          </CardContent>
        </Card>
      </div>

      {creative.fullTranscript !== null && (
        <Card>
          <CardHeader>
            <CardTitle>Mensaje</CardTitle>
            <CardDescription>Transcripción automática del audio.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">
              {creative.fullTranscript}
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Historial de observación</CardTitle>
          <CardDescription>
            Un renglón por día de rastreo. Los días marcados como no observados no cuentan
            como desaparición: un rastreo fallido no es una muerte.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="flex flex-wrap gap-1.5">
            {creative.observations.map((o) => (
              <li key={o.runDate}>
                <span
                  title={`${dateLabel(o.runDate)} · rastreo ${o.crawlStatus} · ${
                    o.isPresent ? 'presente' : 'ausente'
                  }`}
                  className={dotClass(o.isPresent, o.crawlStatus)}
                >
                  {/* Text, not just colour: the state has to survive a colour-blind reader
                      and a screen reader. */}
                  <span className="sr-only">
                    {dateLabel(o.runDate)}: {o.isPresent ? 'presente' : 'ausente'} (rastreo{' '}
                    {o.crawlStatus})
                  </span>
                  <span aria-hidden>{o.isPresent ? '●' : '○'}</span>
                </span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  )
}

function dotClass(isPresent: boolean, crawlStatus: string): string {
  if (crawlStatus !== 'succeeded') return 'text-amber-400'
  return isPresent ? 'text-primary' : 'text-muted-foreground'
}

/**
 * The three kinds of null, made visible.
 *
 * A metric that reads "sin medir" with the feature listed here is one we could not measure.
 * A metric that reads "sin medir" with nothing listed, and no schema version at all, was
 * never handed to the extractor. And a metric showing 0 was measured as zero — a single-shot
 * video genuinely has no cuts. Collapsing any two of these moves creatives between cohorts
 * without anything failing.
 */
function SkippedFeatures({ creative }: { creative: CreativeDetail }): React.ReactElement | null {
  if (creative.featureSchemaVersion === null) {
    return (
      <p className="sm:col-span-2 text-xs text-muted-foreground">
        Este creativo todavía no pasó por el extractor. No es que no se pudiera medir: no se
        intentó.
      </p>
    )
  }

  if (creative.skippedFeatures.length === 0) return null

  return (
    <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">No se pudieron medir:</span>
      {creative.skippedFeatures.map((f) => (
        <Badge key={f} variant="warning">
          {f}
        </Badge>
      ))}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-sm tabular-nums text-foreground">{value}</span>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right text-foreground">{value}</span>
    </div>
  )
}
