import { asDate, instantAsDate, LATEST_FEATURES } from './internal.ts'
import type { SqlExecutor } from '../types.ts'

/**
 * The gallery and the single-creative view.
 *
 * `daysActive` and `isCensored` always travel together (UC-3 rule 1). There is no shape in
 * this module that carries one without the other, so a renderer cannot print a duration
 * without being handed the fact that it may be a lower bound.
 *
 * `hasGaps` creatives are returned, not filtered. UC-3 rule 2 excludes them from *analysis
 * cohorts*, which is UC-5's job; excluding them here would quietly delete the long-lived
 * creatives — a creative alive 60 days has sixty chances to span a bad crawl day, one alive
 * three days has three — and leave a page that looks like a complete answer. They come back
 * flagged, with `observationDays` as the measure of how much the number rests on.
 */

export interface CreativeSummary {
  creativeId: string
  creativeHash: string
  advertiserId: string
  advertiserName: string
  mediaType: string
  adCopy: string | null
  publisherPlatforms: string[]
  /** How many `ad_archive_id`s share this creative — the same asset run as several ads. */
  variantCount: number
  startedDate: string | null
  firstSeenDate: string
  stoppedDate: string | null
  daysActive: number | null
  isCensored: boolean
  observationDays: number
  hasGaps: boolean
  posterStoragePath: string | null
  firstLineTranscript: string | null
  durationS: number | null
}

export interface CreativeDetail extends CreativeSummary {
  adArchiveIds: string[]
  fullTranscript: string | null
  firstCutTimeS: number | null
  cutsPerSecond: number | null
  textDensity: number | null
  textInFirst2s: boolean | null
  /** Non-null when the media outran the sampling cap: every rate above is over this span. */
  analysisCapS: number | null
  truncated: boolean
  /** Features that could not be measured. Empty is meaningful; see the three-nulls rule. */
  skippedFeatures: string[]
  /** Null when the creative was never handed to the extractor — distinct from a skip. */
  featureSchemaVersion: number | null
  observations: CreativeObservation[]
}

export interface CreativeObservation {
  runDate: string
  isPresent: boolean
  crawlStatus: string
}

export type GallerySort = 'longest' | 'newest' | 'recently-stopped'

export interface GalleryFilter {
  advertiserId?: string
  /** `running` is UC-3's `is_censored`; `stopped` has an explicit death. */
  status?: 'running' | 'stopped' | 'all'
  sort?: GallerySort
  limit?: number
  offset?: number
}

interface SummaryRow {
  creative_id: string
  creative_hash: string
  advertiser_id: string
  advertiser_name: string
  media_type: string
  ad_copy: string | null
  publisher_platforms: string[]
  variant_count: number
  started_date: string | null
  first_seen_date: string
  stopped_date: string | null
  days_active: number | null
  is_censored: boolean
  observation_days: number
  has_gaps: boolean
  poster_storage_path: string | null
  first_line_transcript: string | null
  duration_s: number | null
}

const SUMMARY_COLUMNS = `
  s.creative_id,
  s.creative_hash,
  s.advertiser_id,
  a.name                             as advertiser_name,
  s.media_type::text                 as media_type,
  c.ad_copy,
  c.publisher_platforms,
  coalesce(cardinality(c.ad_archive_ids), 0)::int as variant_count,
  ${instantAsDate('s.started_at')}   as started_date,
  ${asDate('s.first_seen_date')}     as first_seen_date,
  ${asDate('s.stopped_date')}        as stopped_date,
  s.days_active::int                 as days_active,
  s.is_censored,
  s.observation_days::int            as observation_days,
  s.has_gaps,
  f.poster_storage_path,
  f.first_line_transcript,
  f.duration_s`

const SUMMARY_FROM = `
  from public.creative_survival s
  join public.creatives c   on c.id = s.creative_id
  join public.advertisers a on a.id = s.advertiser_id
  ${LATEST_FEATURES}`

/**
 * `nulls last` on every ordering: a creative with no `started_at` from Meta has a null
 * `days_active` (UC-3 refuses to guess one), and Postgres sorts nulls first on `desc` by
 * default — which would open the gallery with the creatives we know least about.
 */
const SORTS: Record<GallerySort, string> = {
  longest: 'order by s.days_active desc nulls last, s.first_seen_date asc',
  newest: 'order by s.first_seen_date desc, s.days_active desc nulls last',
  'recently-stopped': 'order by s.stopped_date desc nulls last, s.days_active desc nulls last',
}

export async function listCreatives(
  db: SqlExecutor,
  filter: GalleryFilter = {},
): Promise<CreativeSummary[]> {
  const status = filter.status ?? 'all'
  const sort = SORTS[filter.sort ?? 'longest']
  const limit = Math.min(Math.max(filter.limit ?? 60, 1), 200)
  const offset = Math.max(filter.offset ?? 0, 0)

  const rows = await db.query<SummaryRow>(
    `select ${SUMMARY_COLUMNS}
     ${SUMMARY_FROM}
     where ($1::uuid is null or s.advertiser_id = $1::uuid)
       and ($2::text = 'all'
            or ($2::text = 'running' and s.is_censored)
            or ($2::text = 'stopped' and not s.is_censored))
     ${sort}, s.creative_hash asc
     limit $3 offset $4`,
    [filter.advertiserId ?? null, status, limit, offset],
  )

  return rows.map(toSummary)
}

export async function getCreativeDetail(
  db: SqlExecutor,
  creativeId: string,
): Promise<CreativeDetail | null> {
  const rows = await db.query<
    SummaryRow & {
      ad_archive_ids: string[]
      full_transcript: string | null
      first_cut_time_s: number | null
      cuts_per_second: number | null
      text_density: number | null
      text_in_first_2s: boolean | null
      analysis_cap_s: number | null
      truncated: boolean | null
      skipped_features: string[] | null
      feature_schema_version: number | null
    }
  >(
    `select ${SUMMARY_COLUMNS},
            c.ad_archive_ids,
            f.full_transcript,
            f.first_cut_time_s,
            f.cuts_per_second,
            f.text_density,
            f.text_in_first_2s,
            f.analysis_cap_s,
            f.truncated,
            f.skipped_features,
            f.schema_version::int as feature_schema_version
     ${SUMMARY_FROM}
     where s.creative_id = $1::uuid`,
    [creativeId],
  )

  const row = rows[0]
  // Zero rows is also what a cross-workspace id returns — RLS filters it before we get
  // here — so "not found" and "not yours" are indistinguishable to the caller by design.
  if (row === undefined) return null

  const observations = await db.query<{
    run_date: string
    is_present: boolean
    crawl_status: string
  }>(
    `select ${asDate('r.run_date')} as run_date,
            o.is_present,
            r.status::text as crawl_status
     from public.creative_observations o
     join public.crawl_runs r on r.id = o.crawl_run_id
     where o.creative_id = $1::uuid
     order by r.run_date asc`,
    [creativeId],
  )

  return {
    ...toSummary(row),
    adArchiveIds: row.ad_archive_ids ?? [],
    fullTranscript: row.full_transcript,
    firstCutTimeS: row.first_cut_time_s,
    cutsPerSecond: row.cuts_per_second,
    textDensity: row.text_density,
    textInFirst2s: row.text_in_first_2s,
    analysisCapS: row.analysis_cap_s,
    truncated: row.truncated ?? false,
    skippedFeatures: row.skipped_features ?? [],
    featureSchemaVersion: row.feature_schema_version,
    observations: observations.map((o) => ({
      runDate: o.run_date,
      isPresent: o.is_present,
      crawlStatus: o.crawl_status,
    })),
  }
}

/** Advertisers with a creative in the panel, for the gallery's filter control. */
export async function listAdvertisers(
  db: SqlExecutor,
): Promise<{ id: string; name: string; creativeCount: number; runningCount: number }[]> {
  const rows = await db.query<{
    id: string
    name: string
    creative_count: number
    running_count: number
  }>(
    `select a.id,
            a.name,
            count(s.creative_id)::int                          as creative_count,
            count(s.creative_id) filter (where s.is_censored)::int as running_count
     from public.advertisers a
     join public.creative_survival s on s.advertiser_id = a.id
     group by a.id, a.name
     order by count(s.creative_id) desc, a.name asc`,
  )
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    creativeCount: r.creative_count,
    runningCount: r.running_count,
  }))
}

function toSummary(row: SummaryRow): CreativeSummary {
  return {
    creativeId: row.creative_id,
    creativeHash: row.creative_hash,
    advertiserId: row.advertiser_id,
    advertiserName: row.advertiser_name,
    mediaType: row.media_type,
    adCopy: row.ad_copy,
    publisherPlatforms: row.publisher_platforms ?? [],
    variantCount: row.variant_count,
    startedDate: row.started_date,
    firstSeenDate: row.first_seen_date,
    stoppedDate: row.stopped_date,
    daysActive: row.days_active,
    isCensored: row.is_censored,
    observationDays: row.observation_days,
    hasGaps: row.has_gaps,
    posterStoragePath: row.poster_storage_path,
    firstLineTranscript: row.first_line_transcript,
    durationS: row.duration_s,
  }
}
