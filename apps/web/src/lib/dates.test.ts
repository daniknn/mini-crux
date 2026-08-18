import { afterEach, describe, expect, it } from 'vitest'

import { shiftDays, windowEndingAt } from './dates.ts'

const ORIGINAL_TZ = process.env['TZ']

afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env['TZ']
  else process.env['TZ'] = ORIGINAL_TZ
})

/** Both extremes of the UTC offset range, plus the market's own zone. */
const ZONES = ['UTC', 'America/Mexico_City', 'Pacific/Kiritimati', 'Pacific/Niue', 'Asia/Kolkata']

describe('shiftDays', () => {
  it('moves whole days in both directions', () => {
    expect(shiftDays('2026-03-10', -6)).toBe('2026-03-04')
    expect(shiftDays('2026-03-10', 0)).toBe('2026-03-10')
    expect(shiftDays('2026-03-10', 1)).toBe('2026-03-11')
  })

  it('crosses month and year boundaries', () => {
    expect(shiftDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(shiftDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(shiftDays('2025-12-31', 1)).toBe('2026-01-01')
  })

  it('knows 2024 was a leap year and 2026 is not', () => {
    expect(shiftDays('2024-03-01', -1)).toBe('2024-02-29')
    expect(shiftDays('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('returns the same date in every timezone', () => {
    // The regression: `new Date('2026-03-01')` is UTC midnight, which in Mexico City is
    // 18:00 on 2026-02-28. Reading `.getDate()` off that returns 28, so the window would
    // start a day early for some readers and not others — an outcome variable that depends
    // on who is asking, which is the bug the SQL layer already fixed one level down.
    for (const offset of [-30, -7, -1, 0, 1, 7, 365]) {
      const seen = new Set<string>()
      for (const tz of ZONES) {
        process.env['TZ'] = tz
        seen.add(shiftDays('2026-03-01', offset))
      }
      expect(seen.size, `offset ${offset} differed by timezone`).toBe(1)
    }
  })

  it('survives a DST transition unchanged', () => {
    // US DST began 2026-03-08. A local-midnight Date crossing it gains or loses an hour,
    // which rounds a whole-day shift onto the wrong calendar day.
    process.env['TZ'] = 'America/New_York'
    expect(shiftDays('2026-03-07', 1)).toBe('2026-03-08')
    expect(shiftDays('2026-03-08', 1)).toBe('2026-03-09')
    expect(shiftDays('2026-03-09', -2)).toBe('2026-03-07')
  })

  it('refuses a string that is not an ISO date rather than inventing one', () => {
    expect(() => shiftDays('marzo', 1)).toThrow(/Not an ISO date/)
  })
})

describe('windowEndingAt', () => {
  it('is inclusive on both ends', () => {
    // Seven days ending on the 10th is the 4th through the 10th — seven dates, not eight.
    expect(windowEndingAt('2026-03-10', 7)).toEqual({ since: '2026-03-04', until: '2026-03-10' })
  })

  it('degenerates correctly to a single day', () => {
    expect(windowEndingAt('2026-03-10', 1)).toEqual({ since: '2026-03-10', until: '2026-03-10' })
  })

  it('anchors on the last crawl, not on the clock', () => {
    // A panel whose last healthy crawl was weeks ago must report a window that ends then.
    // Anchoring on today would return a window containing no crawl days at all, and the
    // feed would render "sin movimientos" — an outage disguised as a quiet market.
    expect(windowEndingAt('2026-01-15', 7)).toEqual({ since: '2026-01-09', until: '2026-01-15' })
  })
})
