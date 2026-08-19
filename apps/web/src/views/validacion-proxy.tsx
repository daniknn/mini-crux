import type { LatestProxyValidation } from '@mini-crux/db/dashboard'

import { EmptyState } from '../components/empty-state.tsx'
import { Badge } from '../components/ui/badge.tsx'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui/card.tsx'
import { probabilityLabel } from '../lib/analysis-copy.ts'
import { dateLabel, sampleLabel } from '../lib/format.ts'
import {
  betaLabel,
  betaMinusOneLabel,
  type Caveat,
  ENDED_ADS_ONLY_CAVEAT,
  proxyRefusalCopy,
  reachBoundLabel,
  SPAIN_NOT_MEXICO_CAVEAT,
  verdictBadgeLabel,
  verdictBadgeVariant,
  verdictSentence,
} from '../lib/proxy-validation-copy.ts'

/**
 * What UC-7's validation run said: whether the survival proxy this product is built on tracks
 * anything real, tested against the one market where Meta publishes delivery — Spain.
 *
 * Three states, same discipline as `analisis.tsx` and for the same reason (spec rule 6,
 * `CLAUDE.md` rule 3 one layer up): no run at all is a blank slate; a refused run is a result —
 * "the corpus has 12 ended ads, we need 30" — and collapsing it into the blank slate would
 * throw away the only one of the two that tells an operator what to do; a published run is one
 * coefficient, its confidence interval, the naive estimate beside it, and — at the same weight
 * as the number — the two caveats without which β − 1 is a misreading waiting to happen
 * (Spain-is-not-Mexico, ended-ads-only).
 *
 * Nothing here is computed beyond `betaMinusOne`, which is `beta - 1` — arithmetic, not a
 * second pass over the corpus. Every other figure was decided by the job, against the corpus it
 * read, and stored. Presentation only (UC-10): the read lives in the page beside it.
 */

export function ProxyValidationView({
  run,
}: {
  run: LatestProxyValidation | null
}): React.ReactElement {
  if (run === null) {
    return (
      <Page>
        <EmptyState title="Todavía no hemos corrido la validación">
          Este contraste no corre solo — se dispara a propósito con{' '}
          <code className="font-mono text-xs">proxy-validation:once</code>, porque en España el
          historial de un anuncio ya está completo apenas se rastrea una vez. En cuanto haya una
          corrida — publicada o rechazada — aparece aquí.
        </EmptyState>
      </Page>
    )
  }

  return (
    <Page>
      <Provenance run={run} />
      {run.outcome === 'refused' ? <Refusal run={run} /> : <Verdict run={run} />}
      <Composition run={run} />
    </Page>
  )
}

function Page({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl">Validación de la señal</h1>
        <p className="text-sm text-muted-foreground">
          Si mantener un creativo más tiempo al aire refleja algo real del anunciante, probado
          contra alcance publicado en España — no una medida de México.
        </p>
      </header>
      {children}
    </div>
  )
}

function Provenance({ run }: { run: LatestProxyValidation }): React.ReactElement {
  return (
    <section
      aria-label="Origen de la corrida"
      className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-border bg-muted/40 px-5 py-3 text-sm"
    >
      <span className="text-muted-foreground">
        Corrida del{' '}
        <strong className="font-medium text-foreground">{dateLabel(run.runDate)}</strong>
      </span>
      <span className="font-mono text-xs text-muted-foreground">
        alcance: {reachBoundLabel(run.reachBoundUsed)}
      </span>
    </section>
  )
}

/** A refusal, with the number the gate knew was missing. */
function Refusal({ run }: { run: LatestProxyValidation }): React.ReactElement {
  if (run.failedGate === null) {
    // Unreachable: proxy_validation_runs_gate_matches_outcome makes `failed_gate is null`
    // equivalent to `outcome = 'published'`. Handled rather than asserted, same reasoning as
    // analisis/page.tsx's Refusal — a blank card is a better failure than a crash.
    return (
      <EmptyState title="La corrida se rechazó sin registrar la razón">
        Es un error nuestro, no del corpus. Revisa la corrida {run.runId}.
      </EmptyState>
    )
  }

  const copy = proxyRefusalCopy(run.failedGate, run.gateDetail)

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
          No publicamos un coeficiente que nadie debería leer. Un β calculado sobre un corpus
          así de chico se vería igual de terminado que uno bueno, y esa es exactamente la razón
          para no mostrarlo.
        </p>
      </CardContent>
    </Card>
  )
}

/**
 * The published verdict: β − 1 with its CI, n, A, the categorical read, the naive estimate
 * beside it, and both mandatory caveats at reading weight in the same card.
 */
function Verdict({ run }: { run: LatestProxyValidation }): React.ReactElement {
  // Unreachable in practice: proxy_validation_runs_published_has_beta makes `outcome =
  // 'published'` equivalent to `beta is not null`, and every other regression field is written
  // in the same transaction. Narrowed explicitly rather than asserted with `!`, so a bug in
  // that guarantee shows an empty state instead of throwing on render.
  if (
    run.beta === null ||
    run.betaMinusOne === null ||
    run.betaCiLow === null ||
    run.betaCiHigh === null ||
    run.pValue === null ||
    run.df === null ||
    run.verdict === null
  ) {
    return (
      <EmptyState title="La corrida se publicó sin registrar el coeficiente">
        Es un error nuestro. Revisa la corrida {run.runId}.
      </EmptyState>
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle>β − 1 = {betaMinusOneLabel(run.betaMinusOne)}</CardTitle>
          <Badge variant={verdictBadgeVariant(run.verdict)}>
            {verdictBadgeLabel(run.verdict)}
          </Badge>
        </div>
        <CardDescription className="text-base text-card-foreground">
          {verdictSentence(run.verdict)}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <dl className="flex flex-wrap gap-x-8 gap-y-3">
          <Figure term="β (dentro de anunciante)" value={betaLabel(run.beta)} />
          <Figure
            term="Intervalo de confianza 95 %"
            value={`[${betaLabel(run.betaCiLow)}, ${betaLabel(run.betaCiHigh)}]`}
          />
          <Figure term="p (contra β = 1)" value={probabilityLabel(run.pValue)} />
          <Figure term="Grados de libertad" value={String(run.df)} />
          <Figure term="Anuncios terminados" value={sampleLabel(run.nIncluded)} />
          <Figure term="Anunciantes que aportan" value={String(run.advertisersUsed)} />
        </dl>

        <NaiveEstimate run={run} />

        <CaveatBlock caveats={[SPAIN_NOT_MEXICO_CAVEAT, ENDED_ADS_ONLY_CAVEAT]} />
      </CardContent>
    </Card>
  )
}

/**
 * The exhibit, not a hedge (spec: "The naive estimate is computed too, and shown"). Labelled
 * as what it omits, right beside the number, so a reader who only remembers one figure from
 * this card is more likely to remember the one that accounts for the advertiser confound.
 */
function NaiveEstimate({ run }: { run: LatestProxyValidation }): React.ReactElement | null {
  if (run.naivePooledBeta === null || run.naivePearsonR === null) return null

  return (
    <div className="flex flex-col gap-2 rounded-sm border border-border bg-muted/40 p-4">
      <h4 className="text-sm font-medium text-foreground">
        Si no separáramos por anunciante
      </h4>
      <dl className="flex flex-wrap gap-x-8 gap-y-3">
        <Figure term="β agrupado" value={betaLabel(run.naivePooledBeta)} muted />
        <Figure term="r de Pearson" value={run.naivePearsonR.toFixed(3)} muted />
      </dl>
      <p className="text-sm text-muted-foreground">
        Este es el número que saldría de correlacionar duración con alcance sin descontar que
        un anunciante grande corre anuncios más tiempo *y* compra más alcance, con presupuesto
        que no vemos. Es el cálculo que produciría una validación segura y espuria — no es el
        que reportamos.
      </p>
    </div>
  )
}

/** The caveats, inside the card, at reading weight — same rule as analisis/page.tsx. */
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
 * How the corpus became this sample. Rendered for a refused run too — the exclusion counts are
 * how an operator sees *why* the corpus is thin, the same reasoning as `analisis/page.tsx`'s
 * Composition card.
 */
function Composition({ run }: { run: LatestProxyValidation }): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <CardTitle>De dónde sale la muestra</CardTitle>
        <CardDescription>
          Cada anuncio del corpus entra a la regresión o queda fuera por una razón registrada.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="flex flex-wrap gap-x-8 gap-y-3">
          <Figure term="Corpus" value={sampleLabel(run.corpusSize)} />
          <Figure term="Terminados, en la regresión" value={sampleLabel(run.nIncluded)} />
          <Figure
            term="Anunciantes"
            value={`${run.advertisersUsed} de ${run.advertisersTotal}`}
          />
        </dl>

        <dl className="flex flex-wrap gap-x-8 gap-y-3">
          <Figure term="Fuera · sigue activo" value={String(run.excluded.stillRunning)} muted />
          <Figure term="Fuera · sin alcance" value={String(run.excluded.zeroReach)} muted />
          <Figure
            term="Fuera · duró menos de un día"
            value={String(run.excluded.subDay)}
            muted
          />
          <Figure
            term="Anunciantes con un solo anuncio"
            value={String(run.advertisersDropped)}
            muted
          />
        </dl>
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
