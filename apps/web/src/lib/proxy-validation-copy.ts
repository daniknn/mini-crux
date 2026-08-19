import type { ProxyGateId, ProxyVerdict, ReachBound } from '@mini-crux/analysis'

/**
 * The words UC-7 puts around its numbers.
 *
 * Same discipline as `analysis-copy.ts`, one layer up in a different market: the arithmetic is
 * pinned against scipy, and the sentence rendered next to it is pinned here. Two things it must
 * never do, both spelled out in the spec:
 *
 * - **Let the verdict travel to Mexico.** This validates a *mechanism* in the closest available
 *   market, not a Mexican number. Every place the verdict appears, the Spain-is-not-Mexico
 *   caveat appears with it (spec rule 6, "The verdict MUST ship with ... the Spain-is-not-Mexico
 *   caveat").
 * - **Present β = 0 as the test.** The null this UC reports against is β = 1 — proportional
 *   accumulation, not zero effect — and copy that says "reach correlates with duration" without
 *   the elasticity framing reintroduces the exact trap the spec exists to avoid.
 */

const advertisers = (n: number): string => (n === 1 ? '1 anunciante' : `${n} anunciantes`)
const ads = (n: number): string => (n === 1 ? '1 anuncio' : `${n} anuncios`)
const agree = (n: number, singular: string, plural: string): string => (n === 1 ? singular : plural)

export function reachBoundLabel(bound: ReachBound): string {
  return bound === 'min' ? 'mínimo del rango' : 'máximo del rango'
}

interface VerdictCopy {
  /** Rendered on the badge — short, so it fits beside n and the CI. */
  badge: string
  variant: 'primary' | 'neutral' | 'danger'
  /** The one-sentence reading, elasticity-framed per spec rule 1: never "reach correlates". */
  sentence: string
}

const VERDICT_COPY: Readonly<Record<ProxyVerdict, VerdictCopy>> = {
  reflects_effort: {
    badge: 'El alcance escala con la duración',
    variant: 'primary',
    sentence:
      'β es mayor a 1: los anuncios que el anunciante mantuvo más tiempo acumularon alcance ' +
      'más rápido que proporcionalmente a su duración. Es lo que esperaríamos si sostener un ' +
      'anuncio más tiempo refleja meterle más presupuesto, no solo dejarlo correr.',
  },
  inertia: {
    badge: 'No se distingue de acumulación pareja',
    variant: 'neutral',
    sentence:
      'No podemos distinguir β de 1: los datos son compatibles con que el alcance simplemente ' +
      'se acumula a un ritmo parejo mientras el anuncio sigue activo. Esto no confirma ni ' +
      'descarta que durar más refleje un anunciante empujando más presupuesto — dice que esta ' +
      'muestra no alcanza para verlo.',
  },
  throttled: {
    badge: 'El alcance no acompaña la duración',
    variant: 'danger',
    sentence:
      'β es menor a 1: los anuncios que duraron más acumularon alcance más lento que ' +
      'proporcionalmente a su duración. Es la lectura opuesta a la que este producto necesita ' +
      'para que "días activo" funcione como señal de esfuerzo del anunciante.',
  },
}

export function verdictBadgeLabel(verdict: ProxyVerdict): string {
  return VERDICT_COPY[verdict].badge
}

export function verdictBadgeVariant(verdict: ProxyVerdict): 'primary' | 'neutral' | 'danger' {
  return VERDICT_COPY[verdict].variant
}

export function verdictSentence(verdict: ProxyVerdict): string {
  return VERDICT_COPY[verdict].sentence
}

/** A coefficient to three decimals — the precision the CI is quoted at, matching it exactly. */
export function betaLabel(value: number): string {
  return value.toFixed(3)
}

/** β − 1 signed, because rule 1 asks for the elasticity, not the raw slope. */
export function betaMinusOneLabel(value: number): string {
  const rounded = betaLabel(value)
  return rounded.startsWith('-') ? rounded : `+${rounded}`
}

export interface Caveat {
  title: string
  body: string
}

/**
 * The headline caveat, rendered wherever the verdict is (spec rule 6, and the spec's own
 * "Spain is not Mexico" section). What may transfer between markets is the *mechanism* —
 * whether performance advertisers behave the way the survival proxy assumes — never the
 * coefficient itself, and no MX number may be derived from it.
 */
export const SPAIN_NOT_MEXICO_CAVEAT: Caveat = {
  title: 'España no es México',
  body:
    'Esta validación corre sobre España, no sobre México: es el mercado hispanohablante más ' +
    'grande donde Meta publica alcance por ley (DSA), y no tenemos ese dato para anuncios ' +
    'mexicanos. Lo que puede viajar de un mercado a otro es el mecanismo — si los ' +
    'anunciantes de resultados se comportan como asume el producto — nunca el coeficiente. ' +
    'Ningún número de México se deriva de esta corrida.',
}

/**
 * The right-censoring caveat (spec: "Right-censoring: exclude, and admit what that costs").
 * Excluding still-running ads is correct here — unlike everywhere else in this repo — but it
 * costs something that has to be on the page: the longest-running, still-active creatives are
 * structurally invisible to this validation.
 */
export const ENDED_ADS_ONLY_CAVEAT: Caveat = {
  title: 'Solo anuncios que ya terminaron',
  body:
    'Un anuncio que sigue activo no tiene fecha de fin ni alcance final, así que lo excluimos ' +
    'del cálculo — aquí es lo correcto, porque no estamos midiendo cuánto dura un creativo ' +
    'sino cómo se relaciona su alcance con su duración una vez que termina. El costo es que la ' +
    'muestra es la población de anuncios que ya terminaron: el creativo que el anunciante ' +
    'sostuvo más tiempo y sigue corriendo — la celda que más le importa a este producto — es ' +
    'invisible para esta validación.',
}

export interface RefusalCopy {
  title: string
  body: string
}

/**
 * The refusal, rendered from the shortfall the run stored — same discipline as
 * `analysis-copy.ts`'s `refusalCopy`: every branch names a number, and the numbers come off
 * `gate_detail` rather than being recomputed against today's corpus.
 */
export function proxyRefusalCopy(gate: ProxyGateId, detail: Record<string, number>): RefusalCopy {
  const n = (key: string): number => detail[key] ?? 0

  switch (gate) {
    case 'corpus_size':
      return {
        title:
          `${agree(n('shortfall_n'), 'Falta', 'Faltan')} ${ads(n('shortfall_n'))} ` +
          `${agree(n('shortfall_n'), 'terminado', 'terminados')}`,
        body:
          `Necesitamos ${ads(n('required_n'))} que ya hayan terminado para que el error ` +
          `estándar de β sea confiable, y el corpus tiene ${ads(n('actual_n'))}. Con menos, ` +
          'un intervalo de confianza calculado se vería igual de terminado que uno bueno, y ' +
          'esa es la razón para no publicarlo. Se resuelve corriendo el rastreo de nuevo más ' +
          'adelante, cuando más anuncios de la corrida actual hayan terminado.',
      }

    case 'advertisers':
      return {
        title:
          `${agree(n('shortfall_advertisers'), 'Falta', 'Faltan')} ` +
          `${advertisers(n('shortfall_advertisers'))} que ` +
          `${agree(n('shortfall_advertisers'), 'aporte', 'aporten')} contraste`,
        body:
          `La regresión compara dentro de cada anunciante, y solo ` +
          `${advertisers(n('actual_advertisers'))} ` +
          `${agree(n('actual_advertisers'), 'tiene', 'tienen')} dos o más anuncios terminados ` +
          `para comparar entre sí. Necesitamos ${advertisers(n('required_advertisers'))}. Con ` +
          'menos, lo que se mediría serían las diferencias entre unos pocos anunciantes ' +
          'específicos, no un patrón general.',
      }
  }
}
