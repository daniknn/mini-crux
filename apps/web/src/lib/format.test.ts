import { describe, expect, it } from 'vitest'

import {
  dateLabel,
  durationLabel,
  durationVerb,
  gapsLabel,
  metricLabel,
  panelStrength,
  percentLabel,
  sampleLabel,
} from './format.ts'

describe('durationLabel', () => {
  it('marks a still-running creative as a lower bound', () => {
    // The single most important string in the product. Without the `+` this reads as
    // "it ran for 34 days and stopped", which is the opposite of what we know.
    expect(durationLabel(34, true)).toBe('34+ días')
  })

  it('renders a finished creative as a plain measurement', () => {
    expect(durationLabel(34, false)).toBe('34 días')
  })

  it('never renders the same string for a censored and an uncensored run', () => {
    // Guards against any future "more than a year" bucket, which would collapse the two
    // branches exactly where censoring is most common.
    for (const days of [1, 2, 34, 200, 365, 366, 1000, 5000]) {
      expect(durationLabel(days, true)).not.toBe(durationLabel(days, false))
      expect(durationLabel(days, true)).toContain('+')
      expect(durationLabel(days, false)).not.toContain('+')
    }
  })

  it('agrees in number for a one-day run', () => {
    expect(durationLabel(1, false)).toBe('1 día')
    expect(durationLabel(1, true)).toBe('1+ día')
    expect(durationLabel(2, false)).toBe('2 días')
  })

  it('says it did not measure rather than showing a zero', () => {
    // A null duration is "we have no span for this creative". A 0 would put it in the
    // shortest-lived cohort, which is a fabricated observation.
    expect(durationLabel(null, false)).toBe('sin medir')
    expect(durationLabel(null, true)).toBe('sin medir')
  })

  it('distinguishes a genuine zero-day run from an unmeasured one', () => {
    expect(durationLabel(0, false)).toBe('0 días')
    expect(durationLabel(0, false)).not.toBe(durationLabel(null, false))
  })
})

describe('durationVerb', () => {
  it('reads as ongoing for a censored run and as finished otherwise', () => {
    expect(`${durationVerb(true)} ${durationLabel(34, true)}`).toBe('lleva 34+ días')
    expect(`${durationVerb(false)} ${durationLabel(34, false)}`).toBe('duró 34 días')
  })
})

describe('percentLabel', () => {
  it('renders a share as a percentage', () => {
    expect(percentLabel(0.8)).toBe('80 %')
    expect(percentLabel(0)).toBe('0 %')
    expect(percentLabel(1)).toBe('100 %')
  })

  it('says there is no data rather than a confident zero', () => {
    // An empty panel divides by nothing. "0 %" over no data is a claim we cannot make.
    expect(percentLabel(null)).toBe('sin datos')
    expect(percentLabel(null)).not.toBe(percentLabel(0))
  })
})

describe('sampleLabel', () => {
  it('always shows n, including when it is zero', () => {
    expect(sampleLabel(0)).toBe('n = 0 creativos')
    expect(sampleLabel(1)).toBe('n = 1 creativo')
    expect(sampleLabel(12)).toBe('n = 12 creativos')
  })
})

describe('metricLabel', () => {
  it('distinguishes a measured zero from an unmeasurable metric', () => {
    // Three kinds of null: a single-shot video genuinely has 0 cuts and belongs in the n;
    // a metric we could not extract does not. Collapsing them moves creatives between
    // cohorts without anything failing.
    expect(metricLabel(0)).toBe('0')
    expect(metricLabel(null)).toBe('sin medir')
    expect(metricLabel(0)).not.toBe(metricLabel(null))
  })

  it('rounds to two decimals and carries its unit', () => {
    expect(metricLabel(1.23456, 's')).toBe('1.23 s')
    expect(metricLabel(22.5, 's')).toBe('22.5 s')
  })
})

describe('panelStrength', () => {
  it('weakens a gapped creative rather than dropping it', () => {
    expect(panelStrength(false)).toBe('strong')
    expect(panelStrength(true)).toBe('weak')
  })
})

describe('gapsLabel', () => {
  it('carries how many days the duration actually rests on', () => {
    expect(gapsLabel(8)).toBe('Con huecos · 8 días observados')
    expect(gapsLabel(1)).toBe('Con huecos · 1 día observado')
  })
})

describe('dateLabel', () => {
  it('reorders the SQL date without re-parsing it', () => {
    expect(dateLabel('2026-03-10')).toBe('10/03/2026')
  })

  it('is the same string in every timezone', () => {
    // The regression this guards: `new Date('2026-03-01')` is UTC midnight, which is
    // 2026-02-28 in Pacific/Kiritimati and 2026-02-28 18:00 in Mexico City. Reformatting
    // through a Date object would shift the panel a day for some readers and not others —
    // the exact bug the SQL layer's `to_char` eliminated one level down.
    const original = process.env['TZ']
    try {
      const seen = new Set<string>()
      for (const tz of ['UTC', 'America/Mexico_City', 'Pacific/Kiritimati', 'Pacific/Niue']) {
        process.env['TZ'] = tz
        seen.add(dateLabel('2026-03-01'))
      }
      expect(seen).toEqual(new Set(['01/03/2026']))
    } finally {
      if (original === undefined) delete process.env['TZ']
      else process.env['TZ'] = original
    }
  })

  it('renders an absent date as a dash, not as today', () => {
    expect(dateLabel(null)).toBe('—')
  })
})
