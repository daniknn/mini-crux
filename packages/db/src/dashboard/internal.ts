/**
 * Shared SQL fragments for the dashboard reads.
 *
 * None of these queries filter by workspace. That is not an oversight — every table and the
 * `creative_survival` view are guarded by RLS policies resolving `app.current_workspace_id()`,
 * and the caller is already inside {@link withTenant}. Adding a redundant `where workspace_id
 * = $n` would look like defence in depth and act as camouflage: the day the policy breaks,
 * the app-level filter keeps the pages looking correct while every other client is exposed.
 * Tenancy is proved in one place, against the policies, in `dashboard.test.ts`.
 *
 * On shaping: every date leaves as `to_char(...)` text, every count as `::int`, every
 * `numeric` as `::float8`. See the driver-decoding table in CLAUDE.md — handing a bare
 * `date` to node-postgres yields a JS Date at *local* midnight, which reads back a day
 * early outside UTC, and no test can catch it because PGlite decodes the same value
 * correctly.
 */

/**
 * The market's calendar. Every instant→date conversion in the product resolves here, so
 * both sides of any date subtraction are struck on the same clock regardless of who asks.
 * A second market makes this a join to `watchlists.country`, not a second literal.
 */
export const MARKET_TZ = 'America/Mexico_City'

/** ISO date, as text. The only safe way to move a Postgres `date` into JavaScript. */
export const asDate = (expr: string): string => `to_char(${expr}, 'YYYY-MM-DD')`

/** An instant resolved onto the market's calendar, as ISO date text. */
export const instantAsDate = (expr: string): string =>
  asDate(`(${expr} at time zone '${MARKET_TZ}')::date`)

/**
 * The current feature row for a creative, or nothing.
 *
 * `creative_features` is unique on `(creative_id, schema_version)`, so a creative
 * re-extracted under a newer definition set has more than one row and the older ones are
 * marked `is_stale`. Ordering by `schema_version desc` rather than trusting the flag alone
 * means a half-finished re-extraction — new row written, old row not yet flagged — shows
 * the new measurements instead of letting the planner choose between them.
 */
export const LATEST_FEATURES = `
  left join lateral (
    select f.poster_storage_path,
           f.first_line_transcript,
           f.full_transcript,
           f.skipped_features,
           f.truncated,
           f.schema_version,
           f.duration_s::float8            as duration_s,
           f.first_cut_time_s::float8      as first_cut_time_s,
           f.cuts_per_second::float8       as cuts_per_second,
           f.text_density::float8          as text_density,
           f.text_in_first_2s,
           f.analysis_cap_s::float8        as analysis_cap_s
    from public.creative_features f
    where f.creative_id = s.creative_id
      and not f.is_stale
    order by f.schema_version desc
    limit 1
  ) f on true`
