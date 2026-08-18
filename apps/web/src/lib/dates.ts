/**
 * Calendar arithmetic on the dates SQL already shaped as `YYYY-MM-DD`.
 *
 * Every date reaching the UI is the market's logical crawl day, resolved once at write time
 * from `crawl_runs.run_date`. The only safe thing to do with it here is move it by whole days
 * without ever letting a local timezone touch it — which is why everything below goes through
 * `Date.UTC` and `toISOString`, never `new Date(string)` plus `getDate()`.
 */

/** Shift an ISO date by whole days. Timezone-independent by construction. */
export function shiftDays(isoDate: string, delta: number): string {
  const [year, month, day] = isoDate.split('-').map(Number)
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Not an ISO date: ${isoDate}`)
  }
  // UTC midnight plus whole days. A local-time Date would land on 23:00 the previous day in
  // any negative-offset zone, and `toISOString` would then read back the wrong calendar day.
  const shifted = Date.UTC(year, month - 1, day) + delta * 86_400_000
  return new Date(shifted).toISOString().slice(0, 10)
}

/**
 * The inclusive window ending on `lastRunDate` and `days` long.
 *
 * Anchored on the panel's last crawl, never on `Date.now()`. A clock-anchored window slides
 * past the last crawl during an outage, so a week with no ingestion renders as a week with
 * no market activity — the outage disappears into a calm-looking feed.
 */
export function windowEndingAt(lastRunDate: string, days: number): {
  since: string
  until: string
} {
  return { since: shiftDays(lastRunDate, -(days - 1)), until: lastRunDate }
}
