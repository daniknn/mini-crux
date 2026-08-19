import { HOOK_TYPES, TONES, type AnalysisFeature, type DescriptiveTag, type GateId } from '@mini-crux/analysis'

/**
 * The words UC-5 puts around its numbers.
 *
 * Split out and tested because this is where a correct analysis becomes a wrong claim. The
 * arithmetic is pinned against scipy; the sentence rendered next to it is pinned here, and
 * it is the sentence a reader acts on. Three things it must never do:
 *
 * - **Imply performance.** We have no performance data. Copy says *supervivencia* and
 *   *comportamiento del anunciante*, never *rendimiento*, *CTR* or *ROAS* (rule 7). "Los
 *   creativos que funcionan mejor cortan más rápido" is a sentence this product is not
 *   entitled to write, and it is one small edit away from every string below.
 * - **Drop the stratum qualifier.** The probability of superiority is weighted within
 *   advertiser, so it means "de cada 100 pares *del mismo anunciante*". Without that clause
 *   the number reads as a fact about the market and contradicts the test that produced it —
 *   the spec calls the clumsier sentence the correct one, and this is that sentence.
 * - **Turn a refusal into an apology.** A refused run knows exactly what is missing. "Faltan
 *   49 días" is actionable; "no hay datos suficientes" is not.
 */

/** Below this adjusted q we call a contrast a signal. Above it, explicitly, we do not. */
export const SIGNAL_Q = 0.05

interface FeatureCopy {
  label: string
  /**
   * Completes "el creativo longevo ___". Comparative and directionless about *good*: the
   * product reports what the advertiser kept running, not what worked.
   */
  more: string
}

const FEATURE_COPY: Readonly<Record<AnalysisFeature, FeatureCopy>> = {
  duration_s: { label: 'Duración', more: 'dura más' },
  first_cut_time_s: { label: 'Primer corte', more: 'tarda más en hacer el primer corte' },
  cuts_per_second: { label: 'Cortes por segundo', more: 'corta más seguido' },
  text_in_first_2s: { label: 'Texto en los primeros 2 s', more: 'abre con texto en pantalla' },
  text_density: { label: 'Densidad de texto', more: 'tiene más texto en pantalla' },
  audio_energy_variance: { label: 'Variación de audio', more: 'varía más su audio' },
  has_people_on_screen: { label: 'Personas en pantalla', more: 'muestra personas en pantalla' },
}

export function featureLabel(feature: AnalysisFeature): string {
  return FEATURE_COPY[feature].label
}

/**
 * UC-8's other two tags. Deliberately a different shape from {@link FEATURE_COPY}: `hook_type`
 * and `tone` have no `more` clause, because there is no comparative sentence to complete — the
 * whole point of a descriptive breakdown is that "5 of 8 opened with a testimonial" needs no
 * "el creativo longevo ___" wrapped around it (spec §6). The banned-vocabulary sweep in
 * `analysis-copy.test.ts` folds every string these two taxonomies can render into the same
 * `everyString()` the tested features go through — one check across the whole surface.
 */
const TAG_COPY: Readonly<Record<DescriptiveTag, string>> = {
  hook_type: 'Tipo de gancho',
  tone: 'Tono',
}

const HOOK_TYPE_VALUE_COPY: Readonly<Record<(typeof HOOK_TYPES)[number], string>> = {
  testimonial: 'Testimonio',
  demo: 'Demostración',
  problem_solution: 'Problema y solución',
  ugc: 'Contenido de usuario',
  offer: 'Oferta',
  other: 'Otro',
}

const TONE_VALUE_COPY: Readonly<Record<(typeof TONES)[number], string>> = {
  humoristico: 'Humorístico',
  emocional: 'Emocional',
  informativo: 'Informativo',
  urgente: 'Urgente',
  aspiracional: 'Aspiracional',
  other: 'Otro',
}

export function tagLabel(tag: DescriptiveTag): string {
  return TAG_COPY[tag]
}

/** A taxonomy value in Spanish, or the untagged caption — never the raw column value. */
export function tagValueLabel(tag: DescriptiveTag, value: string): string {
  if (value === 'untagged') return 'Sin etiquetar'
  const copy: Readonly<Record<string, string>> =
    tag === 'hook_type' ? HOOK_TYPE_VALUE_COPY : TONE_VALUE_COPY
  return copy[value] ?? value
}

/**
 * Sits under every tag breakdown, at the same weight as the caveats on a tested feature (spec
 * acceptance criterion "no p-value and no q-value attached", made visible rather than merely
 * true by omission — a reader who has just read six cards with a q on every one should not
 * have to notice its absence here to know none was computed).
 */
export const DESCRIPTIVE_TAG_NOTE =
  'Conteo descriptivo. A diferencia de las medidas de arriba, esto no pasa por una prueba ' +
  'estadística: no lleva p ni q, solo cuántos creativos de cada cohorte llevan cada etiqueta.'

/**
 * The effect size in plain language, with the qualifier that makes it true.
 *
 * Rounds to whole pairs out of 100 because a probability of superiority quoted to three
 * decimals invites a precision the sample does not have. The direction is never flipped to
 * keep the number above 50: "en 37 de cada 100" says the long-lived creative cuts *less*,
 * and rewriting it as "en 63 el de vida corta corta más seguido" would silently swap which
 * cohort the sentence is about between one row and the next.
 */
export function superiorityLabel(feature: AnalysisFeature, ps: number): string {
  const pairs = Math.round(ps * 100)
  return (
    `Dentro de un mismo anunciante, de cada 100 pares, en ${pairs} ` +
    `el creativo longevo ${FEATURE_COPY[feature].more}.`
  )
}

/** A p or q value, floored at the precision it is worth quoting. */
export function probabilityLabel(value: number): string {
  if (value < 0.001) return '< 0.001'
  return value.toFixed(3)
}

/** Rank-biserial r, signed, because the sign is the whole direction of the finding. */
export function effectLabel(r: number): string {
  const rounded = r.toFixed(2)
  // Sign the *rounded* value, not the raw one. An r of ±0.001 rounds to zero at the precision
  // shown, and both "+0.00" and "-0.00" then read as a direction we did not measure — the
  // former just as wrongly as the latter, which is why the check cannot be a string test for
  // "-0.00" alone. Below the displayed precision there is no direction to report.
  if (rounded === '0.00' || rounded === '-0.00') return '0.00'
  return rounded.startsWith('-') ? rounded : `+${rounded}`
}

export function isSignal(qValue: number): boolean {
  return qValue < SIGNAL_Q
}

/**
 * Says "no" out loud.
 *
 * A row above the threshold has to be labelled, not merely left unbadged. Six contrasts on a
 * page where only the significant ones carry a mark is a page a reader scans for marks, and
 * the five unmarked rows become "nothing here" rather than "we tested this and found nothing"
 * — which is a result, and on a small panel usually the honest one.
 */
export function signalLabel(qValue: number): string {
  return isSignal(qValue) ? 'Señal' : 'Sin señal'
}

/** A caveat that sits inside a finding's card, at the same weight as the number. */
export interface Caveat {
  title: string
  body: string
}

/**
 * The unvalidated proxy, rendered beside every finding rather than once at the top.
 *
 * The spec is explicit that this is not a footnote: UC-5 is the first surface whose output
 * depends on *días activos* meaning something to an advertiser, and we have never tested that
 * it does. The validation is cheap and specific — crawl Spain, where `eu_total_reach` is
 * public under the EU DSA, and check whether days-active tracks reach — and naming it keeps
 * the caveat a debt with a price rather than a disclaimer.
 */
export const PROXY_CAVEAT: Caveat = {
  title: 'Qué mide esto, y qué no',
  body:
    'Medimos cuántos días el anunciante mantuvo el creativo al aire. Es una señal de lo que ' +
    'el anunciante decidió, no de lo que el creativo logró: no tenemos datos de resultados y ' +
    'nunca hemos comprobado que durar más equivalga a servir mejor. Esa comprobación está ' +
    'pendiente — se hace rastreando España, donde el alcance es público — y hasta hacerla ' +
    'este número describe una conducta, no un logro.',
}

/**
 * The confounders, also in-card.
 *
 * Every one of these produces a long-lived creative for a reason that has nothing to do with
 * how it is built. They are listed rather than summarized because "puede haber sesgos" is a
 * sentence a reader skips; a brand campaign booked for a quarter is one they recognize.
 */
export const CONFOUNDER_CAVEAT: Caveat = {
  title: 'Qué más puede explicarlo',
  body:
    'Un creativo puede durar por razones ajenas a cómo está armado: campañas de marca con ' +
    'vuelo fijo comprado por trimestre, temporada, presupuesto disponible, o la política de ' +
    'refresco del anunciante. La comparación se hace dentro de cada anunciante, lo que ' +
    'neutraliza el estilo de casa, pero no el calendario.',
}

/**
 * What a feature with no row means.
 *
 * Absent is not zero and it is not "no significativo". The contrast never ran, because within
 * the advertisers compared there was nothing to rank — every creative measured the same, or
 * the feature was skipped on too many of them.
 */
export const UNTESTED_NOTE =
  'Sin contraste este día: dentro de los anunciantes comparados no hubo variación suficiente ' +
  'para ordenar los creativos, o la medida faltaba en demasiados. No es un cero ni un empate.'

export interface RefusalCopy {
  /** What is missing, with the number. Rendered as the card's headline. */
  title: string
  /** Why that gate exists and what, if anything, an operator can do about it. */
  body: string
}

/**
 * A rate as whole percent. The censoring gate stores a share and the sentence quotes it; a
 * rate rendered to decimals ("85.7 %") suggests the panel resolves that finely, when what the
 * number is actually saying is "almost all of them are still running".
 */
const pct = (share: number): string => `${Math.round(share * 100)} %`

const days = (n: number): string => (n === 1 ? '1 día' : `${n} días`)
const creatives = (n: number): string => (n === 1 ? '1 creativo' : `${n} creativos`)
const advertisers = (n: number): string => (n === 1 ? '1 anunciante' : `${n} anunciantes`)

/**
 * Verb agreement for the shortfall titles, and for the clauses that hang off a count.
 *
 * "Faltan 1 día" is the tell that a number was pasted into a fixed sentence, and it lands on
 * exactly the operator who is one unit away from an analysis — the one most likely to read
 * the card carefully.
 */
const agree = (n: number, singular: string, plural: string): string => (n === 1 ? singular : plural)

/**
 * The refusal, rendered from the shortfall the run stored.
 *
 * Every branch names a number, and the numbers come off `gate_detail` rather than being
 * recomputed — the run refused against the panel it read, and a page that re-derived the
 * shortfall from today's panel would show a different one from the run it claims to display.
 */
export function refusalCopy(gate: GateId, detail: Record<string, number>): RefusalCopy {
  const n = (key: string): number => detail[key] ?? 0

  switch (gate) {
    case 'panel_age':
      return {
        title: `${agree(n('shortfall_days'), 'Falta', 'Faltan')} ${days(
          n('shortfall_days'),
        )} de panel`,
        body:
          `La cohorte de creativos longevos arranca a los ${n('required_days')} días de ` +
          `observación y llevamos ${days(n('actual_days'))}. No hay nada que ajustar: es ` +
          'tiempo. Lo único que puede perderse es un día de rastreo, y ese no se recupera.',
      }

    case 'cohort_n':
      return {
        title: `${agree(n('shortfall_n'), 'Falta', 'Faltan')} ${creatives(
          n('shortfall_n'),
        )} en la cohorte más chica`,
        body:
          `Necesitamos ${n('required_n')} por cohorte y tenemos ${n('n_long')} longevos y ` +
          `${n('n_short')} de vida corta. Con menos, una comparación sin diferencias no se ` +
          'distingue de no tener datos. Sumar listas que sigan a más anunciantes lo acelera.',
      }

    case 'strata':
      return {
        title:
          `${agree(n('shortfall_strata'), 'Falta', 'Faltan')} ` +
          `${advertisers(n('shortfall_strata'))} que ` +
          `${agree(n('shortfall_strata'), 'aporte', 'aporten')} a las dos cohortes`,
        body:
          `Solo ${advertisers(n('strata_used'))} ` +
          `${agree(n('strata_used'), 'aporta', 'aportan')} ` +
          'creativos longevos y de vida corta a la vez, y la comparación se hace dentro de ' +
          `cada anunciante. Con menos de ${n('required_strata')}, lo que se compara son ` +
          `estilos de casa. ${advertisers(n('strata_dropped'))} ` +
          `${agree(n('strata_dropped'), 'quedó fuera por caer entero', 'quedaron fuera por caer enteros')} ` +
          'en una sola cohorte.',
      }

    case 'censoring':
      return {
        title: `El ${pct(n('actual_rate'))} de la cohorte longeva sigue al aire`,
        body:
          `De ${creatives(n('n_long'))} longevos, solo a ${n('resolved_long')} los hemos ` +
          `visto detenerse; el máximo admitido es ${pct(n('max_rate'))}. Compararlos contra ` +
          'una cohorte que ya terminó mediría en parte cuándo empezamos a mirar, no cómo se ' +
          'comporta el anunciante. Se resuelve solo, conforme los creativos actuales salgan ' +
          'de circulación.',
      }
  }
}
