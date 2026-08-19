import {
  ANALYSIS_FEATURES,
  HOOK_TYPES,
  TONES,
  type AnalysisFeature,
  type DescriptiveTag,
  type GateId,
} from '@mini-crux/analysis'
import { describe, expect, it } from 'vitest'

import {
  CONFOUNDER_CAVEAT,
  DESCRIPTIVE_TAG_NOTE,
  effectLabel,
  featureLabel,
  isSignal,
  probabilityLabel,
  PROXY_CAVEAT,
  refusalCopy,
  SIGNAL_Q,
  signalLabel,
  superiorityLabel,
  tagLabel,
  tagValueLabel,
  UNTESTED_NOTE,
} from './analysis-copy.ts'

/**
 * UC-8's two descriptive tags. Not exported from `@mini-crux/analysis` as an array — only the
 * union type is — so it is restated here the same way `GATES` restates `GateId`'s members: a
 * third tag added to the type without a matching entry in this array is a type error where it
 * is written, not a silent gap in `everyString()`.
 */
const TAGS: DescriptiveTag[] = ['hook_type', 'tone']

/**
 * The detail each gate stores, keyed so the compiler can see a gate is missing.
 *
 * A plain array of gate ids would let a fifth gate ship with no copy test; `Record<GateId, …>`
 * makes that a type error in this file. The numbers are the ones `evaluateGates` writes — the
 * refusal copy is rendered from `gate_detail` and nothing else, so a fixture that invented its
 * own keys would prove the sentence renders and not that it renders the run's shortfall.
 */
const GATE_DETAIL: Record<GateId, Record<string, number>> = {
  panel_age: { required_days: 61, actual_days: 12, shortfall_days: 49 },
  cohort_n: { required_n: 20, n_long: 30, n_short: 3, shortfall_n: 17 },
  strata: { required_strata: 3, strata_used: 2, strata_dropped: 2, shortfall_strata: 1 },
  censoring: { max_rate: 0.8, actual_rate: 18 / 21, resolved_long: 3, n_long: 21 },
}

const GATES = Object.keys(GATE_DETAIL) as GateId[]

/** Every string this module can produce, for the checks that must hold across all of them. */
const everyString = (): string[] => [
  ...ANALYSIS_FEATURES.map(featureLabel),
  ...ANALYSIS_FEATURES.flatMap((f) => [0, 0.37, 0.5, 0.63, 1].map((ps) => superiorityLabel(f, ps))),
  ...GATES.flatMap((gate) => {
    const copy = refusalCopy(gate, GATE_DETAIL[gate])
    return [copy.title, copy.body]
  }),
  ...[PROXY_CAVEAT, CONFOUNDER_CAVEAT].flatMap((c) => [c.title, c.body]),
  UNTESTED_NOTE,
  signalLabel(0.01),
  signalLabel(0.5),
  // UC-8's descriptive breakdown. Deliberately included here rather than swept only in its own
  // describe block below: the banned-vocabulary check is the one test that must hold across
  // the *whole* surface, and a taxonomy added to `tag-distribution.ts` without its Spanish copy
  // being pulled into this list would ship unswept — exactly the gap `TAG_COPY`'s own comment
  // in analysis-copy.ts defers to this task.
  ...TAGS.map(tagLabel),
  ...HOOK_TYPES.map((value) => tagValueLabel('hook_type', value)),
  ...TONES.map((value) => tagValueLabel('tone', value)),
  tagValueLabel('hook_type', 'untagged'),
  tagValueLabel('tone', 'untagged'),
  DESCRIPTIVE_TAG_NOTE,
]

describe('the words the product is not entitled to use', () => {
  it('never implies performance, anywhere', () => {
    // Rule 7, enforced over the whole surface rather than string by string. We have no
    // performance data: every one of these words turns a survival finding into a claim about
    // results, and the edit that introduces one is a single word inside an otherwise correct
    // sentence. The check is cheap and it is the only thing standing between a correct
    // analysis and a wrong claim.
    const banned = [
      'rendimiento',
      'rinde',
      'performance',
      'ctr',
      'roas',
      'conversión',
      'conversiones',
      'clic',
      'efectivo',
      'efectividad',
      'funciona mejor',
      'gana',
      'ganador',
      'exitoso',
      'mejor resultado',
    ]

    for (const text of everyString()) {
      for (const word of banned) {
        expect(text.toLowerCase()).not.toContain(word)
      }
    }
  })
})

describe('featureLabel', () => {
  it('names every declared feature', () => {
    // The label map is indexed by `AnalysisFeature`, so a new feature is a type error here —
    // but a *renamed* one would fall back to `undefined` at runtime under a looser lookup.
    for (const feature of ANALYSIS_FEATURES) {
      const label = featureLabel(feature)
      expect(label).toBeTruthy()
      expect(label).not.toContain('undefined')
    }
  })

  it('gives each feature its own label', () => {
    expect(new Set(ANALYSIS_FEATURES.map(featureLabel)).size).toBe(ANALYSIS_FEATURES.length)
  })
})

describe('tagLabel', () => {
  it('names both declared tags', () => {
    for (const tag of TAGS) {
      const label = tagLabel(tag)
      expect(label).toBeTruthy()
      expect(label).not.toContain('undefined')
    }
  })

  it('gives each tag its own label', () => {
    expect(new Set(TAGS.map(tagLabel)).size).toBe(TAGS.length)
  })
})

describe('tagValueLabel', () => {
  it('names every declared value of both taxonomies', () => {
    // Mirrors `featureLabel`'s own test: indexed by the literal union, so a renamed taxonomy
    // value would fall back to `undefined` at runtime under a looser lookup even though the
    // compiler saw nothing wrong.
    for (const value of HOOK_TYPES) {
      const label = tagValueLabel('hook_type', value)
      expect(label).toBeTruthy()
      expect(label).not.toContain('undefined')
    }
    for (const value of TONES) {
      const label = tagValueLabel('tone', value)
      expect(label).toBeTruthy()
      expect(label).not.toContain('undefined')
    }
  })

  it('gives each value its own label within a taxonomy', () => {
    // Within, not across: hook_type and tone are free to reuse a Spanish word (both have an
    // 'other' → 'Otro'), and testing the two taxonomies' values as one combined set would fail
    // on that legitimate overlap instead of catching a real collision.
    expect(new Set(HOOK_TYPES.map((v) => tagValueLabel('hook_type', v))).size).toBe(HOOK_TYPES.length)
    expect(new Set(TONES.map((v) => tagValueLabel('tone', v))).size).toBe(TONES.length)
  })

  it('renders untagged as its own caption, never the raw column value', () => {
    // The db layer stores the literal string 'untagged' as a real taxonomy row (see
    // analysis-schema.test.ts's "treats untagged as one taxonomy row, not a null the unique
    // constraint would miss twice") precisely so this has something to translate rather than a
    // null to special-case — and the caption must say so in Spanish, not echo the column value.
    expect(tagValueLabel('hook_type', 'untagged')).toBe('Sin etiquetar')
    expect(tagValueLabel('tone', 'untagged')).toBe('Sin etiquetar')
  })

  it('falls back to the raw value for anything outside the taxonomy, rather than "undefined"', () => {
    // Defensive: the taxonomy is a Postgres check constraint pinned to HOOK_TYPES/TONES, so this
    // should never fire against real data, but a lookup that returns `undefined` on a miss would
    // print the literal word "undefined" into an operator-facing card — worse than the raw code.
    expect(tagValueLabel('hook_type', 'made_up_value')).toBe('made_up_value')
  })
})

describe('DESCRIPTIVE_TAG_NOTE', () => {
  it('says out loud that this count carries no p or q', () => {
    // Acceptance criterion is "no p-value and no q-value attached", made visible rather than
    // merely true by omission — a reader who has just read six cards with a q on every one
    // should not have to notice its absence here to know none was computed.
    expect(DESCRIPTIVE_TAG_NOTE).toContain('no lleva p ni q')
  })
})

describe('superiorityLabel', () => {
  const anyFeature: AnalysisFeature = 'cuts_per_second'

  it('keeps the within-advertiser qualifier that makes the number true', () => {
    // The test is stratified: the probability of superiority is weighted within advertiser, so
    // it is a statement about pairs drawn from the same advertiser. Without the clause the
    // same number reads as a fact about the market, which is a claim the design of the test
    // specifically refuses to make.
    expect(superiorityLabel(anyFeature, 0.63)).toContain('Dentro de un mismo anunciante')
  })

  it('rounds to whole pairs out of 100', () => {
    expect(superiorityLabel(anyFeature, 0.634)).toContain('en 63 ')
    expect(superiorityLabel(anyFeature, 0.635)).toContain('en 64 ')
    expect(superiorityLabel(anyFeature, 0.63)).not.toMatch(/\d\.\d/)
  })

  it('reports the direction it measured instead of flipping to stay above 50', () => {
    // A PS below ½ says the long-lived creative does the thing *less*. Rewriting that as "en
    // 63 el de vida corta corta más seguido" keeps every row above 50 and silently swaps which
    // cohort the sentence is about from one row to the next. Both of these name the same
    // cohort and the same verb; only the count moves.
    const below = superiorityLabel(anyFeature, 0.37)
    const above = superiorityLabel(anyFeature, 0.63)

    expect(below).toContain('en 37 ')
    expect(above).toContain('en 63 ')
    expect(below).toContain('el creativo longevo corta más seguido')
    expect(above).toContain('el creativo longevo corta más seguido')
  })

  it('never mentions the short-lived cohort as the subject', () => {
    for (const feature of ANALYSIS_FEATURES) {
      for (const ps of [0.05, 0.37, 0.5, 0.63, 0.95]) {
        expect(superiorityLabel(feature, ps)).toContain('el creativo longevo')
      }
    }
  })

  it('describes what the advertiser kept running, not what worked', () => {
    // Each phrase completes "el creativo longevo ___" and must stay comparative and
    // directionless about *good*. Pinned in full because this is the one string a well-meaning
    // edit would "improve" into a performance claim.
    expect(superiorityLabel('duration_s', 0.6)).toBe(
      'Dentro de un mismo anunciante, de cada 100 pares, en 60 el creativo longevo dura más.',
    )
    expect(superiorityLabel('text_in_first_2s', 0.6)).toBe(
      'Dentro de un mismo anunciante, de cada 100 pares, en 60 el creativo longevo abre con ' +
        'texto en pantalla.',
    )
  })
})

describe('probabilityLabel', () => {
  it('floors at the precision worth quoting', () => {
    // A p of 3e-9 quoted as "0.000" reads as zero, and quoted in full invites a reader to
    // compare exponents across six tests that were adjusted together.
    expect(probabilityLabel(0.0000000031)).toBe('< 0.001')
    expect(probabilityLabel(0)).toBe('< 0.001')
  })

  it('renders three decimals above the floor', () => {
    expect(probabilityLabel(0.001)).toBe('0.001')
    expect(probabilityLabel(0.0499)).toBe('0.050')
    expect(probabilityLabel(0.5)).toBe('0.500')
    expect(probabilityLabel(1)).toBe('1.000')
  })

  it('puts the boundary on the correct side', () => {
    // `<` and `<=` differ by exactly this value, and 0.001 is a number a reader will see.
    expect(probabilityLabel(0.001)).not.toBe('< 0.001')
    expect(probabilityLabel(0.0009)).toBe('< 0.001')
  })
})

describe('effectLabel', () => {
  it('keeps the sign, because the sign is the finding', () => {
    expect(effectLabel(0.42)).toBe('+0.42')
    expect(effectLabel(-0.42)).toBe('-0.42')
  })

  it('does not render a direction it did not measure', () => {
    // `(-0.001).toFixed(2)` is the string "-0.00", which reads as "shorter-lived, slightly" —
    // a direction, from a number that is zero to the precision shown.
    expect(effectLabel(-0.001)).toBe('0.00')
    expect(effectLabel(0)).toBe('0.00')
    expect(effectLabel(0.001)).toBe('0.00')
  })

  it('rounds to two decimals', () => {
    expect(effectLabel(0.4567)).toBe('+0.46')
    expect(effectLabel(-0.4567)).toBe('-0.46')
  })
})

describe('isSignal', () => {
  it('pins the threshold', () => {
    // A constant is untested until something pins it. This is the line between "we found
    // something" and "we did not", drawn on the BH-adjusted q.
    expect(SIGNAL_Q).toBe(0.05)
  })

  it('excludes the threshold itself', () => {
    // `<` and `<=`. A q of exactly 0.05 is the boundary case an adjusted p-value lands on
    // often enough to matter, and calling it a signal is the more generous of the two errors.
    expect(isSignal(0.049)).toBe(true)
    expect(isSignal(0.05)).toBe(false)
    expect(isSignal(0.051)).toBe(false)
  })
})

describe('signalLabel', () => {
  it('labels the absence of a signal instead of leaving the row blank', () => {
    // Five unbadged rows next to one badged row read as "nothing here". They are results.
    expect(signalLabel(0.01)).toBe('Señal')
    expect(signalLabel(0.5)).toBe('Sin señal')
    expect(signalLabel(SIGNAL_Q)).toBe('Sin señal')
  })
})

describe('the in-card caveats', () => {
  it('names the proxy as unvalidated and says what would validate it', () => {
    // Spec rule 5: this renders in the same card as every finding. A caveat that only said
    // "los datos son limitados" is a disclaimer; naming the missing evidence and the specific
    // experiment that would supply it keeps it a debt with a price.
    //
    // The exact claim, not a keyword. Measured: replacing "nunca hemos comprobado que durar
    // más equivalga a servir mejor" with "los datos son limitados" left every other phrase in
    // this string intact, so a test that only looked for 'España' and 'no tenemos datos'
    // stayed green while the one sentence carrying the admission was gone.
    expect(PROXY_CAVEAT.body).toContain('nunca hemos comprobado que durar más equivalga a')
    expect(PROXY_CAVEAT.body).toContain('no tenemos datos de resultados')
    expect(PROXY_CAVEAT.body).toContain('España')
  })

  it('says survival, not achievement', () => {
    expect(PROXY_CAVEAT.body).toContain('el anunciante decidió')
    expect(PROXY_CAVEAT.body).toContain('describe una conducta')
  })

  it('lists the confounders by name rather than gesturing at bias', () => {
    // "Puede haber sesgos" is a sentence a reader skips. A quarter-long brand booking is one
    // they recognize in their own account.
    for (const phrase of ['vuelo fijo', 'temporada', 'presupuesto', 'refresco']) {
      expect(CONFOUNDER_CAVEAT.body).toContain(phrase)
    }
  })

  it('admits what stratifying does not fix', () => {
    // Within-advertiser comparison neutralizes house style and nothing else. Claiming it
    // handles the confounders above would make the caveat worse than absent.
    expect(CONFOUNDER_CAVEAT.body).toContain('no el calendario')
  })

  it('distinguishes an untested feature from a null result', () => {
    // Absent is not zero and not "no significativo". The contrast never ran.
    expect(UNTESTED_NOTE).toContain('No es un cero ni un empate')
  })
})

describe('refusalCopy', () => {
  it('names a number in every branch, from the stored detail', () => {
    // A refusal that says "no hay datos suficientes" is an apology. Every gate knows exactly
    // what is missing and the run stored it; the title is where an operator reads it.
    for (const gate of GATES) {
      const copy = refusalCopy(gate, GATE_DETAIL[gate])

      expect(copy.title).toMatch(/\d/)
      expect(copy.body).toMatch(/\d/)
      expect(copy.title).not.toContain('undefined')
      expect(copy.body).not.toContain('undefined')
      expect(copy.body).not.toContain('NaN')
    }
  })

  it('renders the panel-age shortfall as days that can only be waited out', () => {
    const copy = refusalCopy('panel_age', GATE_DETAIL.panel_age)

    expect(copy.title).toBe('Faltan 49 días de panel')
    expect(copy.body).toContain('61 días')
    expect(copy.body).toContain('12 días')
  })

  it('reads the threshold off the run rather than restating the shipped constant', () => {
    // The spec defers tuning `MIN_PANEL_AGE_DAYS` against the real distribution, so the copy
    // has to survive it moving — and a stored run keeps whatever threshold it refused under,
    // which is the whole point of storing `gate_detail` instead of recomputing.
    //
    // Measured: with the fixture above alone, replacing the interpolated value with a literal
    // 61 left the suite green, because the shipped threshold and the fixture's threshold were
    // the same number. Two candidate expressions that coincide test neither.
    const copy = refusalCopy('panel_age', {
      required_days: 45,
      actual_days: 30,
      shortfall_days: 15,
    })

    expect(copy.title).toBe('Faltan 15 días de panel')
    expect(copy.body).toContain('45 días')
    expect(copy.body).not.toContain('61')
  })

  it('reports the cohort shortfall against the smaller cohort, with both counts', () => {
    // 30 long and 3 short: the shortfall is 17 and it is about the 3. A body that quoted only
    // the binding cohort would leave an operator unable to see which side is thin.
    const copy = refusalCopy('cohort_n', GATE_DETAIL.cohort_n)

    expect(copy.title).toBe('Faltan 17 creativos en la cohorte más chica')
    expect(copy.body).toContain('20 por cohorte')
    expect(copy.body).toContain('30 longevos')
    expect(copy.body).toContain('3 de vida corta')
  })

  it('explains the strata refusal as a comparison of house styles', () => {
    const copy = refusalCopy('strata', GATE_DETAIL.strata)

    expect(copy.title).toBe('Falta 1 anunciante que aporte a las dos cohortes')
    expect(copy.body).toContain('2 anunciantes aportan')
    expect(copy.body).toContain('2 anunciantes quedaron fuera')
  })

  it('quotes the censoring rate as whole percent of a named cohort', () => {
    // 18/21 = 0.857…, which is "86 %" and not "85.71 %": the panel does not resolve that
    // finely, and the sentence is saying "almost all of them are still running".
    const copy = refusalCopy('censoring', GATE_DETAIL.censoring)

    expect(copy.title).toBe('El 86 % de la cohorte longeva sigue al aire')
    expect(copy.body).toContain('21 creativos longevos')
    expect(copy.body).toContain('solo a 3')
    expect(copy.body).toContain('80 %')
  })

  it('agrees in number when a shortfall is one', () => {
    // Spanish agreement is not cosmetic here: "Faltan 1 días" is the tell that the number was
    // pasted into a fixed sentence, and it lands on the operator who is one unit away.
    expect(refusalCopy('panel_age', { ...GATE_DETAIL.panel_age, shortfall_days: 1 }).title).toBe(
      'Falta 1 día de panel',
    )
    expect(refusalCopy('cohort_n', { ...GATE_DETAIL.cohort_n, shortfall_n: 1 }).title).toBe(
      'Falta 1 creativo en la cohorte más chica',
    )
    expect(
      refusalCopy('strata', { ...GATE_DETAIL.strata, shortfall_strata: 2, strata_used: 1 }).title,
    ).toBe('Faltan 2 anunciantes que aporten a las dos cohortes')
    expect(
      refusalCopy('strata', { ...GATE_DETAIL.strata, strata_used: 1 }).body,
    ).toContain('Solo 1 anunciante aporta')
  })

  it('renders a zero rather than dropping a key it did not find', () => {
    // `gate_detail` comes back as untyped json. A missing key must not print "undefined" into
    // a sentence an operator is meant to act on.
    for (const gate of GATES) {
      const copy = refusalCopy(gate, {})
      expect(copy.title).not.toContain('undefined')
      expect(copy.body).not.toContain('undefined')
      expect(copy.body).not.toContain('NaN')
    }
  })
})
