import { asDate, instantAsDate, LATEST_FEATURES, MARKET_TZ } from './internal.ts'
import type { SqlExecutor } from '../types.ts'

/**
 * What changed in the market between two crawl days.
 *
 * WHY THERE ARE THREE SECTIONS AND NOT TWO
 *
 * The obvious change feed is "new" and "gone", where "new" means the first day we saw it.
 * That conflates two different facts. An ad Meta started yesterday is a **launch** — a
 * competitor decision, this week's news. An ad that has been running for eight months and
 * merely entered our panel yesterday because someone added a watchlist is a **discovery** —
 * news about us, not about them. Both arrive as a row that is new to the database.
 *
 * Reporting a discovery as a launch is the same error as `first_seen_at`-as-start-date
 * (CLAUDE.md rule 5) wearing different clothes, and it fails in the same direction: the
 * ads most likely to predate our watching are the long-lived ones, so a change feed that
 * cannot tell them apart announces a competitor's *best* evergreen ad as a fresh launch,
 * every time a watchlist is created.
 *
 * So `launched` is keyed on Meta's `started_at`, `discovered` on our `first_seen_date`
 * excluding anything already counted as a launch, and `stopped` on an explicit death.
 * The three are disjoint by construction.
 */

export type ChangeKind = 'launched' | 'discovered' | 'stopped'

export interface ChangeFeedEntry {
  kind: ChangeKind
  creativeId: string
  creativeHash: string
  advertiserId: string
  advertiserName: string
  mediaType: string
  /** The day this entry is about: the launch, the discovery, or the death. */
  eventDate: string
  startedDate: string | null
  firstSeenDate: string
  stoppedDate: string | null
  daysActive: number | null
  isCensored: boolean
  observationDays: number
  hasGaps: boolean
  adCopy: string | null
  firstLineTranscript: string | null
  posterStoragePath: string | null
}

export interface ChangeFeedWindow {
  /** Inclusive ISO dates. Both are crawl days, never derived from a clock. */
  since: string
  until: string
}

export interface ChangeFeed extends ChangeFeedWindow {
  launched: ChangeFeedEntry[]
  discovered: ChangeFeedEntry[]
  stopped: ChangeFeedEntry[]
}

interface ChangeFeedRow {
  kind: ChangeKind
  creative_id: string
  creative_hash: string
  advertiser_id: string
  advertiser_name: string
  media_type: string
  event_date: string
  started_date: string | null
  first_seen_date: string
  stopped_date: string | null
  days_active: number | null
  is_censored: boolean
  observation_days: number
  has_gaps: boolean
  ad_copy: string | null
  first_line_transcript: string | null
  poster_storage_path: string | null
}

/**
 * Columns every section shares. `started_date` resolves Meta's instant onto the market's
 * calendar — the one place an instant becomes a date here, pinned exactly as
 * `creative_survival` pins it so both sides of every comparison use one clock.
 */
const ENTRY_COLUMNS = `
  s.creative_id,
  s.creative_hash,
  s.advertiser_id,
  a.name                            as advertiser_name,
  s.media_type::text                as media_type,
  ${instantAsDate('s.started_at')}  as started_date,
  ${asDate('s.first_seen_date')}    as first_seen_date,
  ${asDate('s.stopped_date')}       as stopped_date,
  s.days_active::int                as days_active,
  s.is_censored,
  s.observation_days::int           as observation_days,
  s.has_gaps,
  c.ad_copy,
  f.first_line_transcript,
  f.poster_storage_path`

const FROM_CLAUSE = `
  from public.creative_survival s
  join public.creatives c   on c.id = s.creative_id
  join public.advertisers a on a.id = s.advertiser_id
  ${LATEST_FEATURES}`

export async function getChangeFeed(
  db: SqlExecutor,
  window: ChangeFeedWindow,
): Promise<ChangeFeed> {
  const rows = await db.query<ChangeFeedRow>(
    `select 'launched'::text as kind,
            ${instantAsDate('s.started_at')} as event_date,
            ${ENTRY_COLUMNS}
     ${FROM_CLAUSE}
     where (s.started_at at time zone '${MARKET_TZ}')::date between $1 and $2

     union all

     -- First seen inside the window but *not* a launch: either Meta gave no start date, or
     -- the ad was already running before the window opened. Disjoint from the section above
     -- by construction, so nothing is double-counted and nothing falls between them.
     select 'discovered'::text,
            ${asDate('s.first_seen_date')},
            ${ENTRY_COLUMNS}
     ${FROM_CLAUSE}
     where s.first_seen_date between $1 and $2
       and (s.started_at is null
            or (s.started_at at time zone '${MARKET_TZ}')::date not between $1 and $2)

     union all

     -- Deaths only. Reading this off end_date would be catastrophic: end_date falls back
     -- to the last crawl day for living creatives, so every running ad in the workspace
     -- would be announced as stopped on the day of the most recent crawl.
     select 'stopped'::text,
            ${asDate('s.stopped_date')},
            ${ENTRY_COLUMNS}
     ${FROM_CLAUSE}
     where s.stopped_date between $1 and $2

     order by event_date desc, advertiser_name asc, creative_hash asc`,
    [window.since, window.until],
  )

  const entries = rows.map(toEntry)
  return {
    since: window.since,
    until: window.until,
    launched: entries.filter((e) => e.kind === 'launched'),
    discovered: entries.filter((e) => e.kind === 'discovered'),
    stopped: entries.filter((e) => e.kind === 'stopped'),
  }
}

function toEntry(row: ChangeFeedRow): ChangeFeedEntry {
  return {
    kind: row.kind,
    creativeId: row.creative_id,
    creativeHash: row.creative_hash,
    advertiserId: row.advertiser_id,
    advertiserName: row.advertiser_name,
    mediaType: row.media_type,
    eventDate: row.event_date,
    startedDate: row.started_date,
    firstSeenDate: row.first_seen_date,
    stoppedDate: row.stopped_date,
    daysActive: row.days_active,
    isCensored: row.is_censored,
    observationDays: row.observation_days,
    hasGaps: row.has_gaps,
    adCopy: row.ad_copy,
    firstLineTranscript: row.first_line_transcript,
    posterStoragePath: row.poster_storage_path,
  }
}
