import type { ProxyGateId, ProxyVerdict, ReachBound } from '@mini-crux/analysis'
import { describe, expect, it } from 'vitest'

import {
  betaLabel,
  betaMinusOneLabel,
  ENDED_ADS_ONLY_CAVEAT,
  proxyRefusalCopy,
  reachBoundLabel,
  SPAIN_NOT_MEXICO_CAVEAT,
  verdictBadgeLabel,
  verdictBadgeVariant,
  verdictSentence,
} from './proxy-validation-copy.ts'

/**
 * The detail each gate stores, keyed so the compiler can see a gate is missing — same pattern
 * as `analysis-copy.test.ts`'s `GATE_DETAIL`. The numbers are the ones `evaluateProxyValidationGate`
 * writes; the refusal copy is rendered from `gate_detail` and nothing else.
 */
const GATE_DETAIL: Record<ProxyGateId, Record<string, number>> = {
  corpus_size: { required_n: 30, actual_n: 12, shortfall_n: 18 },
  advertisers: { required_advertisers: 5, actual_advertisers: 3, shortfall_advertisers: 2 },
}

const GATES = Object.keys(GATE_DETAIL) as ProxyGateId[]
const VERDICTS: ProxyVerdict[] = ['reflects_effort', 'inertia', 'throttled']
const BOUNDS: ReachBound[] = ['min', 'max']

/** Every string this module can produce, for the checks that must hold across all of them. */
const everyString = (): string[] => [
  ...BOUNDS.map(reachBoundLabel),
  ...VERDICTS.flatMap((v) => [verdictBadgeLabel(v), verdictSentence(v)]),
  ...GATES.flatMap((gate) => {
    const copy = proxyRefusalCopy(gate, GATE_DETAIL[gate])
    return [copy.title, copy.body]
  }),
  SPAIN_NOT_MEXICO_CAVEAT.title,
  SPAIN_NOT_MEXICO_CAVEAT.body,
  ENDED_ADS_ONLY_CAVEAT.title,
  ENDED_ADS_ONLY_CAVEAT.body,
]

describe('the words the product is not entitled to use', () => {
  it('never implies performance, anywhere', () => {
    // Rule 7, same check as analysis-copy.test.ts, over UC-7's strings. A validation result is
    // still not performance data — it is an elasticity about delivery, and the same edit that
    // corrupts UC-5's copy corrupts this one.
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

  it('never states the null as beta = 0', () => {
    // Spec rule 1: "A test of β = 0 MUST NOT be presented as validation of the proxy." The
    // verdict sentences are the one place a well-meaning edit would reach for "correlaciona
    // con", which is exactly that trap in different words.
    for (const verdict of VERDICTS) {
      expect(verdictSentence(verdict).toLowerCase()).not.toContain('correlaciona')
    }
  })
})

describe('reachBoundLabel', () => {
  it('names which bound of the range fed the regression', () => {
    expect(reachBoundLabel('min')).toBe('mínimo del rango')
    expect(reachBoundLabel('max')).toBe('máximo del rango')
  })
})

describe('verdict copy', () => {
  it('gives each verdict its own badge, variant and sentence', () => {
    const badges = VERDICTS.map(verdictBadgeLabel)
    expect(new Set(badges).size).toBe(VERDICTS.length)
  })

  it('maps reflects_effort to the affirmative variant', () => {
    expect(verdictBadgeVariant('reflects_effort')).toBe('primary')
  })

  it('maps inertia to the neutral variant, not a warning', () => {
    // Inertia is a genuine, reportable outcome (spec: "A null result is a real outcome and
    // must be reported as one") — not a degraded or suspicious state, so it does not get the
    // amber/red treatment `Badge` reserves for those.
    expect(verdictBadgeVariant('inertia')).toBe('neutral')
  })

  it('maps throttled to the negative variant', () => {
    expect(verdictBadgeVariant('throttled')).toBe('danger')
  })

  it('frames reflects_effort as beta greater than one, an elasticity not a correlation', () => {
    expect(verdictSentence('reflects_effort')).toContain('mayor a 1')
  })

  it('frames throttled as beta less than one', () => {
    expect(verdictSentence('throttled')).toContain('menor a 1')
  })

  it('states inertia as inability to distinguish beta from one, not as a failed test', () => {
    // A null result must not read as "nothing was found" — it reads as "this sample cannot
    // tell reflects_effort from throttled apart from pure inertia".
    expect(verdictSentence('inertia').toLowerCase()).toContain('no podemos distinguir')
  })
})

describe('betaLabel and betaMinusOneLabel', () => {
  it('renders three decimals', () => {
    expect(betaLabel(1.184219)).toBe('1.184')
    expect(betaLabel(1)).toBe('1.000')
  })

  it('signs beta minus one, because rule 1 asks for the elasticity not the raw slope', () => {
    expect(betaMinusOneLabel(0.184)).toBe('+0.184')
    expect(betaMinusOneLabel(-0.184)).toBe('-0.184')
    expect(betaMinusOneLabel(0)).toBe('+0.000')
  })
})

describe('the mandatory caveats', () => {
  it('names Spain as the market and forbids deriving an MX number from it', () => {
    // Spec rule 6 and the spec's own "Spain is not Mexico" section: the mechanism may
    // transfer, the coefficient never does.
    expect(SPAIN_NOT_MEXICO_CAVEAT.body).toContain('España')
    expect(SPAIN_NOT_MEXICO_CAVEAT.body).toContain('no sobre México')
    expect(SPAIN_NOT_MEXICO_CAVEAT.body).toContain('Ningún número de México se deriva')
  })

  it('names the mechanism as what may transfer, never the coefficient', () => {
    expect(SPAIN_NOT_MEXICO_CAVEAT.body).toContain('el mecanismo')
    expect(SPAIN_NOT_MEXICO_CAVEAT.body).toContain('nunca el coeficiente')
  })

  it('admits the still-running cell is invisible to this validation', () => {
    // The spec's own admission: "The long-lived-and-still-running creative — precisely the
    // cell the product cares most about — is structurally invisible to this validation."
    expect(ENDED_ADS_ONLY_CAVEAT.body).toContain('sigue corriendo')
    expect(ENDED_ADS_ONLY_CAVEAT.body).toContain('invisible')
  })

  it('says why excluding censored ads is correct here, unlike everywhere else in the product', () => {
    expect(ENDED_ADS_ONLY_CAVEAT.body).toContain('aquí es lo correcto')
  })
})

describe('proxyRefusalCopy', () => {
  it('names a number in every branch, from the stored detail', () => {
    for (const gate of GATES) {
      const copy = proxyRefusalCopy(gate, GATE_DETAIL[gate])

      expect(copy.title).toMatch(/\d/)
      expect(copy.body).toMatch(/\d/)
      expect(copy.title).not.toContain('undefined')
      expect(copy.body).not.toContain('undefined')
      expect(copy.body).not.toContain('NaN')
    }
  })

  it('renders the corpus_size shortfall against finished ads, not the raw corpus', () => {
    const copy = proxyRefusalCopy('corpus_size', GATE_DETAIL.corpus_size)

    expect(copy.title).toBe('Faltan 18 anuncios terminados')
    expect(copy.body).toContain('30 anuncios')
    expect(copy.body).toContain('12 anuncios')
  })

  it('renders the advertisers shortfall as the count that can compare within itself', () => {
    const copy = proxyRefusalCopy('advertisers', GATE_DETAIL.advertisers)

    expect(copy.title).toBe('Faltan 2 anunciantes que aporten contraste')
    expect(copy.body).toContain('3 anunciantes')
    expect(copy.body).toContain('5 anunciantes')
  })

  it('agrees in number when a shortfall is exactly one', () => {
    expect(
      proxyRefusalCopy('corpus_size', { ...GATE_DETAIL.corpus_size, shortfall_n: 1 }).title,
    ).toBe('Falta 1 anuncio terminado')
    expect(
      proxyRefusalCopy('advertisers', {
        ...GATE_DETAIL.advertisers,
        shortfall_advertisers: 1,
        actual_advertisers: 1,
      }).title,
    ).toBe('Falta 1 anunciante que aporte contraste')
    expect(
      proxyRefusalCopy('advertisers', { ...GATE_DETAIL.advertisers, actual_advertisers: 1 }).body,
    ).toContain('1 anunciante tiene')
  })

  it('renders a zero rather than dropping a key it did not find', () => {
    // `gate_detail` comes back as untyped json, same as analysis-copy.ts's refusalCopy.
    for (const gate of GATES) {
      const copy = proxyRefusalCopy(gate, {})
      expect(copy.title).not.toContain('undefined')
      expect(copy.body).not.toContain('undefined')
      expect(copy.body).not.toContain('NaN')
    }
  })
})
