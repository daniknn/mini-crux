import { ANALYSIS_FEATURES, type AnalysisFeature, type TagBreakdown } from '@mini-crux/analysis'
import type { AnalysisFeatureResult, LatestAnalysis } from '@mini-crux/db/dashboard'

import { EmptyState } from '../components/empty-state.tsx'
import { Badge } from '../components/ui/badge.tsx'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui/card.tsx'
import {
  CONFOUNDER_CAVEAT,
  DESCRIPTIVE_TAG_NOTE,
  effectLabel,
  featureLabel,
  isSignal,
  probabilityLabel,
  PROXY_CAVEAT,
  refusalCopy,
  signalLabel,
  superiorityLabel,
  tagLabel,
  tagValueLabel,
  UNTESTED_NOTE,
  type Caveat,
} from '../lib/analysis-copy.ts'
import { dateLabel, sampleLabel } from '../lib/format.ts'

/**
 * What the last analysis said.
 *
 * Three states, and they are three different things. No run at all is a blank slate. A
 * *refused* run is a result — "we looked, and the panel is 12 days short" — and rendering it
 * as the blank slate would throw away the only one of the two that tells an operator what to
 * do (spec rule 6). A published run is six contrasts, each carrying its own n, its effect
 * size, its adjusted q, and — in the same card, at the same weight as the number — the two
 * caveats without which the number is a misreading waiting to happen (spec rules 4 and 5).
 *
 * Nothing on this page is computed. Every figure was decided by the job, against the panel it
 * read, under the feature definitions in force that day, and stored. A page that recomputed
 * any of it would show a number that no stored run ever claimed — and the q-value could not
 * be recomputed here at all, since it depends on the whole set of p-values in its run.
 *
 * Presentation only (UC-10). `@mini-crux/analysis` comes along, and is meant to: it is pure
 * arithmetic and vocabulary with no I/O of any kind, and `ANALYSIS_FEATURES` is what tells
 * this page which contrasts a run *should* have carried.
 */

export function AnalysisView({
  analysis,
}: {
  analysis: LatestAnalysis | null
}): React.ReactElement {
  if (analysis === null) {
    return (
      <Page>
        <EmptyState title="Todavía no hemos corrido el análisis">
          El contraste corre como job sobre el panel del día. En cuanto haya una corrida —
          publicada o rechazada — aparece aquí con la fecha del panel que leyó.
        </EmptyState>
      </Page>
    )
  }

  return (
    <Page>
      <Provenance run={analysis} />
      {analysis.outcome === 'refused' ? (
        <Refusal run={analysis} />
      ) : (
        <>
          <Findings run={analysis} />
          <TagDistributions run={analysis} />
        </>
      )}
      <Composition run={analysis} />
    </Page>
  )
}

function Page({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl">Análisis</h1>
        <p className="text-sm text-muted-foreground">
          Qué distingue a los creativos que el anunciante mantuvo al aire de los que retiró
          pronto. Es comportamiento del anunciante, no desempeño del creativo.
        </p>
      </header>
      {children}
    </div>
  )
}

/**
 * The run's own identity, rendered before anything it concluded.
 *
 * The panel date is not today's date. A run from last Tuesday is a claim about last Tuesday's
 * panel, and an operator who reads it as current will act on a stale finding — so the date of
 * the panel it read leads, and the versions it was pinned to are visible without a click. Two
 * runs disagreeing is normal and interesting; two runs disagreeing under different
 * `feature_schema_version`s is not a disagreement at all.
 */
function Provenance({ run }: { run: LatestAnalysis }): React.ReactElement {
  return (
    <section
      aria-label="Origen de la corrida"
      className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-border bg-muted/40 px-5 py-3 text-sm"
    >
      <span className="text-muted-foreground">
        Panel al{' '}
        <strong className="font-medium text-foreground">{dateLabel(run.panelDate)}</strong> ·{' '}
        {run.panelAgeDays} días de observación
      </span>
      <span className="text-muted-foreground">Corrida del {dateLabel(run.runDate)}</span>
      <span className="font-mono text-xs text-muted-foreground">
        análisis {run.analysisVersion}
        {run.featureSchemaVersion !== null && <> · medidas v{run.featureSchemaVersion}</>}
        {run.extractorVersions.length > 0 && <> · extractor {run.extractorVersions.join(', ')}</>}
      </span>
    </section>
  )
}

/**
 * A refusal, with its number.
 *
 * The gate knew exactly what was missing and the run stored it, so the headline is "faltan 49
 * días" and not "no hay datos suficientes". The first is a countdown an operator can plan
 * around; the second is an apology.
 */
function Refusal({ run }: { run: LatestAnalysis }): React.ReactElement {
  if (run.failedGate === null) {
    // Unreachable: the table's `analysis_runs_gate_matches_outcome` constraint makes
    // `failed_gate is null` equivalent to `outcome = 'published'`. Handled rather than
    // asserted, because a blank card is a better failure than a crash.
    return (
      <EmptyState title="La corrida se rechazó sin registrar la razón">
        Es un error nuestro, no del panel. Revisa la corrida {run.runId}.
      </EmptyState>
    )
  }

  const copy = refusalCopy(run.failedGate, run.gateDetail)

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle>{copy.title}</CardTitle>
          <Badge variant="warning">Sin publicar</Badge>
        </div>
        <CardDescription>{copy.body}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          No publicamos un contraste que no se sostiene. Un resultado calculado sobre este
          panel se vería igual de terminado que uno bueno, y esa es exactamente la razón para
          no mostrarlo.
        </p>
      </CardContent>
    </Card>
  )
}

/** The six contrasts, in declared order, each with its caveats in its own card. */
function Findings({ run }: { run: LatestAnalysis }): React.ReactElement {
  const tested = new Set(run.features.map((f) => f.feature))
  const untested = ANALYSIS_FEATURES.filter((f) => !tested.has(f))

  return (
    <div className="flex flex-col gap-4">
      {run.features.map((feature) => (
        <FindingCard key={feature.feature} result={feature} />
      ))}

      {untested.map((feature) => (
        <UntestedCard key={feature} feature={feature} />
      ))}
    </div>
  )
}

/**
 * One contrast.
 *
 * The order inside the card is deliberate: the sentence first, the numbers under it, the
 * caveats under those but inside the same border. A layout that put the caveats in a footer
 * shared by all six — or worse, behind a disclosure — would let a reader take the sentence
 * and leave the conditions behind, which is the failure mode the spec calls out by name.
 */
function FindingCard({ result }: { result: AnalysisFeatureResult }): React.ReactElement {
  const signal = isSignal(result.qValue)

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle>{featureLabel(result.feature)}</CardTitle>
          <Badge variant={signal ? 'primary' : 'neutral'}>{signalLabel(result.qValue)}</Badge>
        </div>
        <CardDescription className="text-base text-card-foreground">
          {superiorityLabel(result.feature, result.probabilitySuperiority)}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <dl className="flex flex-wrap gap-x-8 gap-y-3">
          <Figure term="Longevos" value={sampleLabel(result.nLong)} />
          <Figure term="De vida corta" value={sampleLabel(result.nShort)} />
          <Figure term="Tamaño del efecto (r)" value={effectLabel(result.rankBiserial)} />
          {/* q before p, and p labelled as raw. The q is the one to read: it is adjusted
              across the six contrasts in this run, and the raw p on its own invites picking
              the smallest of six. */}
          <Figure term="q ajustada" value={probabilityLabel(result.qValue)} />
          <Figure term="p sin ajustar" value={probabilityLabel(result.p)} muted />
          <Figure
            term="Anunciantes comparados"
            value={
              result.strataDropped > 0
                ? `${result.strataUsed} · ${result.strataDropped} fuera`
                : String(result.strataUsed)
            }
          />
        </dl>

        {!signal && (
          <p className="text-sm text-muted-foreground">
            Con este panel no distinguimos las dos cohortes en esta medida. Es un resultado:
            significa que no encontramos diferencia, no que no la hayamos buscado.
          </p>
        )}

        <CaveatBlock caveats={[PROXY_CAVEAT, CONFOUNDER_CAVEAT]} />
      </CardContent>
    </Card>
  )
}

function UntestedCard({ feature }: { feature: AnalysisFeature }): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle>{featureLabel(feature)}</CardTitle>
          <Badge variant="neutral">Sin medir</Badge>
        </div>
        <CardDescription>{UNTESTED_NOTE}</CardDescription>
      </CardHeader>
    </Card>
  )
}

/**
 * `hook_type` and `tone`, each a caption rather than a claim (spec §6).
 *
 * Deliberately not `FindingCard` reused with different data: that card's whole shape —
 * signal/no-signal badge, q before p, effect size — exists to present a statistic, and there
 * is no statistic here to badge. Reusing it would either fabricate a badge for a number that
 * was never tested or require a "hide the badge" branch that leaves the temptation to un-hide
 * it sitting in the same component. Two cards that render two different kinds of finding stay
 * two components.
 */
function TagDistributions({ run }: { run: LatestAnalysis }): React.ReactElement | null {
  if (run.tagBreakdowns.length === 0) return null

  return (
    <div className="flex flex-col gap-4">
      {run.tagBreakdowns.map((breakdown) => (
        <TagDistributionCard key={breakdown.tag} breakdown={breakdown} />
      ))}
    </div>
  )
}

function TagDistributionCard({ breakdown }: { breakdown: TagBreakdown }): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle>{tagLabel(breakdown.tag)}</CardTitle>
          <Badge variant="neutral">Descriptivo</Badge>
        </div>
        <CardDescription>{DESCRIPTIVE_TAG_NOTE}</CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <dl className="flex flex-wrap gap-x-8 gap-y-3">
          {breakdown.counts.map((count) => (
            <Figure
              key={count.value}
              term={tagValueLabel(breakdown.tag, count.value)}
              value={`${sampleLabel(count.nLong)} · ${sampleLabel(count.nShort)}`}
            />
          ))}
          <Figure
            term={tagValueLabel(breakdown.tag, 'untagged')}
            value={`${sampleLabel(breakdown.untaggedLong)} · ${sampleLabel(breakdown.untaggedShort)}`}
            muted
          />
        </dl>
        <p className="text-xs text-muted-foreground">
          Longevos · de vida corta, en ese orden, dentro de {sampleLabel(breakdown.nLong)}{' '}
          longevos y {sampleLabel(breakdown.nShort)} de vida corta en total.
        </p>
      </CardContent>
    </Card>
  )
}

/**
 * The caveats, inside the card, at reading weight.
 *
 * Not `text-xs`, not muted to the point of decoration, not collapsed. The spec asks for the
 * same visual weight as the number, and the honest test of that is whether a reader who
 * skims the card can come away with the finding but not the conditions.
 */
function CaveatBlock({ caveats }: { caveats: Caveat[] }): React.ReactElement {
  return (
    <div className="flex flex-col gap-3 rounded-sm border border-border bg-muted/40 p-4">
      {caveats.map((caveat) => (
        <div key={caveat.title} className="flex flex-col gap-1">
          <h4 className="text-sm font-medium text-foreground">{caveat.title}</h4>
          <p className="text-sm text-muted-foreground">{caveat.body}</p>
        </div>
      ))}
    </div>
  )
}

/**
 * How the panel became these two cohorts.
 *
 * Rendered for a refused run too. The exclusion counts are how an operator sees *why* a
 * cohort is thin — 40 creatives dropped for having no start date is a different problem from
 * 40 sitting in the ambiguous middle, and only one of them is fixed by waiting.
 */
function Composition({ run }: { run: LatestAnalysis }): React.ReactElement {
  const excluded =
    run.excluded.middle + run.excluded.gaps + run.excluded.noStart + run.excluded.notExtracted

  return (
    <Card>
      <CardHeader>
        <CardTitle>De dónde salen las cohortes</CardTitle>
        <CardDescription>
          Cada creativo del panel cae en una cohorte o queda fuera por una razón registrada.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="flex flex-wrap gap-x-8 gap-y-3">
          <Figure term="Longevos" value={sampleLabel(run.nLong)} />
          <Figure term="De vida corta" value={sampleLabel(run.nShort)} />
          <Figure
            term="Anunciantes con las dos cohortes"
            value={`${run.strataUsed} de ${run.strataTotal}`}
          />
          <Figure
            term="Longevos aún al aire"
            value={
              run.censoringRateLong === null
                ? 'sin cohorte'
                : `${Math.round(run.censoringRateLong * 100)} %`
            }
          />
        </dl>

        <dl className="flex flex-wrap gap-x-8 gap-y-3">
          <Figure term="Fuera · duración ambigua" value={String(run.excluded.middle)} muted />
          <Figure term="Fuera · con huecos" value={String(run.excluded.gaps)} muted />
          <Figure term="Fuera · sin fecha de inicio" value={String(run.excluded.noStart)} muted />
          <Figure term="Fuera · sin medidas" value={String(run.excluded.notExtracted)} muted />
        </dl>

        <p className="text-sm text-muted-foreground">
          {excluded === 0
            ? 'Ningún creativo quedó fuera del contraste.'
            : `${excluded} creativos quedaron fuera del contraste. Un creativo censurado que ` +
              'lleva poco tiempo al aire no es de vida corta: su duración es un mínimo, y ' +
              'contarlo como corto sería inventarle una muerte.'}
        </p>
      </CardContent>
    </Card>
  )
}

function Figure({
  term,
  value,
  muted = false,
}: {
  term: string
  value: string
  muted?: boolean
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{term}</dt>
      <dd className={muted ? 'font-mono text-sm text-muted-foreground' : 'font-mono text-sm text-foreground'}>
        {value}
      </dd>
    </div>
  )
}
