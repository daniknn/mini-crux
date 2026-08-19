import type { Actor, MessageId, TraceId } from '@mini-crux/core'
import { appendAuditEvent, withIdempotency, type SqlExecutor } from '@mini-crux/db'
import {
  classifyProxyAd,
  classifyProxyCorpus,
  deriveVerdict,
  evaluateProxyValidationGate,
  naivePooledEstimate,
  withinAdvertiserRegression,
  type FinishedAd,
  type ProxyGateDetail,
  type ProxyGateId,
  type ProxyVerdict,
  type RawProxyAd,
  type ReachBound,
} from '@mini-crux/analysis'

import type { AdLibraryProvider, CrawlQuery } from './providers/ad-library/index.ts'
import { ProviderError } from './providers/ad-library/index.ts'
import {
  proxyValidationSnapshotPath,
  putSnapshot,
  SNAPSHOT_SCHEMA_VERSION,
  SnapshotExistsError,
  type ObjectStore,
  type ProxyValidationSnapshotEnvelope,
} from './storage.ts'

/**
 * UC-7's job: crawl Spain, land it, fold it into the quarantined corpus, and — over the whole
 * corpus, not just what this call fetched — decide whether to publish a regression.
 *
 * ONE JOB, NOT A CRAWL/PARSE SPLIT LIKE THE MX PANEL
 *
 * `crawl.ts` and `parse.ts` are two jobs because a daily tick across many watchlists needs
 * each stage to retry and interleave independently, and a slow parse must not hold a crawl's
 * same-day retry budget. Neither pressure exists here: the spec scopes this as a deliberate,
 * manually-triggered research instrument ("Out: Re-running the validation on a schedule"),
 * run once in a while over one market. Splitting it into two jobs would buy resilience this
 * UC has no use for, at the cost of a second place the corpus/run boundary has to be kept
 * consistent.
 *
 * WHY A FAILED CRAWL HERE IS JUST A RETRY, NOT A P0 LIKE `runCrawl`'s
 *
 * `runCrawl` retries same-day with backoff because a missed MX day is gone forever — the
 * panel cannot be backfilled. The spec states the opposite for this corpus: "in the EU,
 * longitudinal data *can* be backfilled." A failed attempt here can simply wait for the
 * worker's own retry/backoff (`apps/worker/src/worker.ts`) across job attempts; there is no
 * reason to burn a synchronous retry loop inside one call.
 *
 * WHAT IS IDEMPOTENT BY CONSTRUCTION, AND WHAT NEEDS THE LEDGER
 *
 * Landing the raw payload and upserting the corpus are both naturally safe to repeat: the
 * snapshot path is keyed by this job's `message_id` (write-once, `SnapshotExistsError` on a
 * redelivery is swallowed exactly as `runCrawl` swallows it), and the corpus upsert is keyed
 * on `(workspace_id, ad_archive_id)` — a second run of the same crawl corrects the same rows
 * rather than adding new ones (spec acceptance: "A second run of the same crawl does not
 * double the corpus"). Neither step is wrapped in `withIdempotency`, for the same reason
 * `runCrawl` is not: it calls the network, and holding a transaction open across that call
 * would pin a connection for the length of an Apify run.
 *
 * `proxy_validation_runs`, by contrast, is append-only — a second call would insert a second
 * stored analysis of the same corpus, which is a duplicate finding, not a correction. That
 * segment has no network call in it, so it is exactly the shape `withIdempotency` is for
 * (mirrors the `analysis` handler in `apps/worker/src/handlers.ts`, for the same reason).
 */

/** The `jobs.type` this handler answers to. */
export const PROXY_VALIDATION_JOB_TYPE = 'proxy_validation'

/** Reach is reported as a range (spec rule 7); the run records which bound fed the regression. */
export const DEFAULT_REACH_BOUND: ReachBound = 'min'

export interface ProxyValidationDeps {
  /** MUST be a BYPASSRLS worker connection: the run writes across the whole tenant set. */
  db: SqlExecutor
  store: ObjectStore
  provider: AdLibraryProvider
  /** Injectable for tests. */
  now?: () => Date
}

export interface RunProxyValidationInput {
  workspaceId: string
  traceId: TraceId
  actor: Actor
  /** The job's own message id — doubles as the ledger key and the snapshot's path component. */
  messageId: MessageId
  /** Omit for a synchronous operator run with no `jobs` row (see `proxy-validation:once`). */
  jobId?: string
  /** `country` MUST be `'ES'` — the only market the quarantined corpus accepts (migration 0011). */
  query: CrawlQuery
  reachBoundUsed?: ReachBound
}

export type RunProxyValidationOutcome =
  | {
      status: 'published'
      runId: string
      corpusSize: number
      nIncluded: number
      advertisersUsed: number
      beta: number
      verdict: ProxyVerdict
    }
  | { status: 'refused'; runId: string; failedGate: ProxyGateId; detail: ProxyGateDetail }
  /** This job's message id was already applied — a redelivery after the run row was written. */
  | { status: 'already-processed' }

export async function runProxyValidation(
  deps: ProxyValidationDeps,
  input: RunProxyValidationInput,
): Promise<RunProxyValidationOutcome> {
  // Same assertion `runCrawl` makes, at the same single place a provider is ever invoked
  // (ARCHITECTURE.md §9): renting a provider does not transfer the logged-off obligation.
  if (deps.provider.collectionMode !== 'logged-off') {
    throw new Error(
      `Provider "${deps.provider.name}" does not declare logged-off collection. ` +
        'Scraping with an authenticated session is prohibited (ARCHITECTURE.md §9).',
    )
  }
  // The database enforces this too (`proxy_validation_ads_market_es`), but failing here
  // means a misconfigured caller never reaches the provider at all.
  if (input.query.country !== 'ES') {
    throw new Error(
      `proxy_validation crawl received country "${input.query.country}"; the quarantined ` +
        "corpus (migration 0011) only accepts 'ES'.",
    )
  }

  const now = deps.now ?? (() => new Date())
  const reachBoundUsed = input.reachBoundUsed ?? DEFAULT_REACH_BOUND

  let result
  try {
    result = await deps.provider.crawl(input.query)
  } catch (error) {
    throw error instanceof ProviderError
      ? new Error(`Apify crawl failed for ES ${input.query.kind}:${input.query.query}: ${error.message}`, {
          cause: error,
        })
      : error
  }

  const path = proxyValidationSnapshotPath({ workspaceId: input.workspaceId, runId: input.messageId })
  try {
    await putSnapshot<ProxyValidationSnapshotEnvelope>(deps.store, path, {
      schema_version: SNAPSHOT_SCHEMA_VERSION,
      trace_id: input.traceId,
      actor: input.actor,
      workspace_id: input.workspaceId,
      run_id: input.messageId,
      provider: deps.provider.name,
      provider_run_id: result.providerRunId,
      captured_at: now().toISOString(),
      payload: result.raw,
    })
  } catch (error) {
    // A redelivery lands on a path a previous attempt already wrote. Immutability holds;
    // the corpus upsert below is what makes the redelivery a correction, not a duplicate.
    if (!(error instanceof SnapshotExistsError)) throw error
  }

  for (const ad of result.ads) {
    await upsertProxyValidationAd(deps.db, {
      workspaceId: input.workspaceId,
      ad,
      sourceQuery: input.query.query,
      rawStoragePath: path,
      reachBoundUsed,
    })
  }

  await appendAuditEvent(deps.db, {
    workspaceId: input.workspaceId,
    traceId: input.traceId,
    actor: input.actor,
    type: 'proxy_validation.crawled',
    subjectType: 'proxy_validation_ads',
    subjectId: input.workspaceId,
    payload: {
      provider: deps.provider.name,
      provider_run_id: result.providerRunId,
      snapshot_path: path,
      result_count: result.ads.length,
    },
  })

  const idempotent = await withIdempotency(
    deps.db,
    {
      messageId: input.messageId,
      workspaceId: input.workspaceId,
      traceId: input.traceId,
      // Conditional spread, not a direct assignment: `processed_messages.job_id` has an FK
      // to `jobs(id)` (nullable), and `runParse` uses the same pattern for the same reason —
      // an operator run with no `jobs` row must leave the ledger's job_id null, not point it
      // at a job that does not exist.
      ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
    },
    (tx) => computeAndStoreRun(tx, input, reachBoundUsed),
  )

  if (!idempotent.applied) return { status: 'already-processed' }
  return idempotent.result as RunProxyValidationOutcome
}

/**
 * The read-classify-gate-regress-store segment, over the *whole* workspace corpus — not just
 * the ads this call's crawl touched. The corpus accumulates across many crawls (possibly
 * several ES queries over time); the validation is a statement about all of it.
 */
async function computeAndStoreRun(
  db: SqlExecutor,
  input: RunProxyValidationInput,
  reachBoundUsed: ReachBound,
): Promise<RunProxyValidationOutcome> {
  const corpus = await loadCorpus(db, input.workspaceId)
  const classification = classifyProxyCorpus(corpus, reachBoundUsed)
  const gate = evaluateProxyValidationGate({ finishedAds: classification.finishedAds })
  const counts = advertiserCounts(classification.finishedAds)

  const corpusSize =
    classification.finishedAds.length +
    classification.nExcludedStillRunning +
    classification.nExcludedZeroReach +
    classification.nExcludedSubDay

  if (gate.outcome === 'refused') {
    const runId = await insertProxyValidationRun(db, {
      input,
      reachBoundUsed,
      corpusSize,
      classification,
      counts,
      gate,
      regression: null,
      naive: null,
      verdict: null,
    })
    await appendAuditEvent(db, {
      workspaceId: input.workspaceId,
      traceId: input.traceId,
      actor: input.actor,
      type: 'proxy_validation.refused',
      subjectType: 'proxy_validation_run',
      subjectId: runId,
      payload: { corpus_size: corpusSize, failed_gate: gate.failedGate, detail: gate.detail },
    })
    return { status: 'refused', runId, failedGate: gate.failedGate, detail: gate.detail }
  }

  const regression = withinAdvertiserRegression(classification.finishedAds)
  if (regression === null) {
    // The gate requires >= 30 finished ads across >= 5 advertisers with a repeat — that is
    // exactly what makes `advertisersUsed > 0` and `df > 0` true. Reaching here means the
    // gate and the regression have drifted apart; that is a bug worth failing loudly for
    // (the job retries) rather than silently storing a refusal the gate did not report.
    throw new Error(
      `proxy_validation gate published for workspace ${input.workspaceId} but the regression ` +
        'returned null — gate and regression thresholds have diverged.',
    )
  }
  const naive = naivePooledEstimate(classification.finishedAds)
  const verdict = deriveVerdict(regression)

  const runId = await insertProxyValidationRun(db, {
    input,
    reachBoundUsed,
    corpusSize,
    classification,
    counts,
    gate,
    regression,
    naive,
    verdict,
  })

  await appendAuditEvent(db, {
    workspaceId: input.workspaceId,
    traceId: input.traceId,
    actor: input.actor,
    type: 'proxy_validation.published',
    subjectType: 'proxy_validation_run',
    subjectId: runId,
    payload: {
      corpus_size: corpusSize,
      n_included: classification.finishedAds.length,
      advertisers_used: regression.advertisersUsed,
      beta: regression.beta,
      p_value: regression.pValue,
      verdict,
    },
  })

  return {
    status: 'published',
    runId,
    corpusSize,
    nIncluded: classification.finishedAds.length,
    advertisersUsed: regression.advertisersUsed,
    beta: regression.beta,
    verdict,
  }
}

/**
 * Total / contributing / dropped advertisers over the finished ads, by the same >= 2 ads
 * rule `withinAdvertiserRegression` uses internally. Computed independently so the run row's
 * "corpus composition" columns are populated even on a `corpus_size` refusal, where the
 * regression itself is never called.
 */
function advertiserCounts(ads: readonly FinishedAd[]): {
  total: number
  used: number
  dropped: number
} {
  const perAdvertiser = new Map<string, number>()
  for (const ad of ads) {
    perAdvertiser.set(ad.advertiser, (perAdvertiser.get(ad.advertiser) ?? 0) + 1)
  }
  const total = perAdvertiser.size
  const dropped = [...perAdvertiser.values()].filter((count) => count < 2).length
  return { total, used: total - dropped, dropped }
}

interface UpsertAdInput {
  workspaceId: string
  ad: {
    adArchiveId: string
    pageId: string
    pageName: string
    adDeliveryStartTime: string | null
    adDeliveryStopTime?: string | null
    euTotalReachMin?: number | null
    euTotalReachMax?: number | null
  }
  sourceQuery: string
  rawStoragePath: string
  reachBoundUsed: ReachBound
}

/**
 * One row of the corpus, upserted. `exclusion_reason` is set here — at write time, from the
 * row's own fields as this crawl currently sees them — not recomputed on read (migration
 * 0011's column comment), so it stays explicable even after a later run reclassifies the
 * whole corpus for a fresh regression.
 */
async function upsertProxyValidationAd(db: SqlExecutor, input: UpsertAdInput): Promise<void> {
  const raw: RawProxyAd = {
    advertiserPageId: input.ad.pageId,
    adDeliveryStartTime: input.ad.adDeliveryStartTime,
    adDeliveryStopTime: input.ad.adDeliveryStopTime ?? null,
    euTotalReachMin: input.ad.euTotalReachMin ?? null,
    euTotalReachMax: input.ad.euTotalReachMax ?? null,
  }
  const exclusionReason = classifyProxyAd(raw, input.reachBoundUsed).exclusionReason

  await db.query(
    `insert into public.proxy_validation_ads
       (workspace_id, ad_archive_id, advertiser_page_id, advertiser_name,
        ad_delivery_start_time, ad_delivery_stop_time,
        eu_total_reach_min, eu_total_reach_max,
        source_query, source_country, raw_storage_path, exclusion_reason)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ES', $10, $11)
     on conflict (workspace_id, ad_archive_id) do update set
       advertiser_page_id = excluded.advertiser_page_id,
       advertiser_name = excluded.advertiser_name,
       ad_delivery_start_time = excluded.ad_delivery_start_time,
       ad_delivery_stop_time = excluded.ad_delivery_stop_time,
       eu_total_reach_min = excluded.eu_total_reach_min,
       eu_total_reach_max = excluded.eu_total_reach_max,
       source_query = excluded.source_query,
       raw_storage_path = excluded.raw_storage_path,
       exclusion_reason = excluded.exclusion_reason`,
    [
      input.workspaceId,
      input.ad.adArchiveId,
      raw.advertiserPageId,
      input.ad.pageName,
      raw.adDeliveryStartTime,
      raw.adDeliveryStopTime,
      raw.euTotalReachMin,
      raw.euTotalReachMax,
      input.sourceQuery,
      input.rawStoragePath,
      exclusionReason,
    ],
  )
}

/**
 * The whole workspace corpus, timestamps shaped to full-precision ISO instants — not just a
 * date, unlike `dashboard/internal.ts`'s `asDate`/`instantAsDate`. `classifyProxyAd` excludes
 * a same-day ad, which a date-only truncation would misclassify at the boundary; the CLAUDE.md
 * guardrail ("shape every value in SQL") applies here as full-instant text, not calendar-date
 * text, because this is the case that guardrail's own siblings are not built for.
 */
async function loadCorpus(db: SqlExecutor, workspaceId: string): Promise<RawProxyAd[]> {
  const rows = await db.query<{
    advertiser_page_id: string
    ad_delivery_start_time: string | null
    ad_delivery_stop_time: string | null
    eu_total_reach_min: number | null
    eu_total_reach_max: number | null
  }>(
    `select advertiser_page_id,
            to_char(ad_delivery_start_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              as ad_delivery_start_time,
            to_char(ad_delivery_stop_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              as ad_delivery_stop_time,
            eu_total_reach_min::int as eu_total_reach_min,
            eu_total_reach_max::int as eu_total_reach_max
     from public.proxy_validation_ads
     where workspace_id = $1`,
    [workspaceId],
  )
  return rows.map((row) => ({
    advertiserPageId: row.advertiser_page_id,
    adDeliveryStartTime: row.ad_delivery_start_time,
    adDeliveryStopTime: row.ad_delivery_stop_time,
    euTotalReachMin: row.eu_total_reach_min,
    euTotalReachMax: row.eu_total_reach_max,
  }))
}

interface InsertRunArgs {
  input: RunProxyValidationInput
  reachBoundUsed: ReachBound
  corpusSize: number
  classification: {
    nExcludedStillRunning: number
    nExcludedZeroReach: number
    nExcludedSubDay: number
    finishedAds: readonly FinishedAd[]
  }
  counts: { total: number; used: number; dropped: number }
  gate: { outcome: 'published' | 'refused'; failedGate: ProxyGateId | null; detail: ProxyGateDetail }
  regression: {
    beta: number
    se: number
    ciLow: number
    ciHigh: number
    tStat: number
    pValue: number
    df: number
  } | null
  naive: { pooledBeta: number; pearsonR: number } | null
  verdict: ProxyVerdict | null
}

async function insertProxyValidationRun(db: SqlExecutor, args: InsertRunArgs): Promise<string> {
  const { input, reachBoundUsed, corpusSize, classification, counts, gate, regression, naive, verdict } =
    args

  const [row] = await db.query<{ id: string }>(
    `insert into public.proxy_validation_runs
       (workspace_id, corpus_size, n_excluded_still_running, n_excluded_zero_reach,
        n_excluded_sub_day, n_included,
        advertisers_total, advertisers_used, advertisers_dropped, reach_bound_used,
        outcome, failed_gate, gate_detail,
        beta, beta_se, beta_ci_low, beta_ci_high, t_stat, p_value, df,
        naive_pooled_beta, naive_pearson_r, verdict,
        trace_id, actor)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
             $19, $20, $21, $22, $23, $24, $25)
     returning id`,
    [
      input.workspaceId,
      corpusSize,
      classification.nExcludedStillRunning,
      classification.nExcludedZeroReach,
      classification.nExcludedSubDay,
      classification.finishedAds.length,
      counts.total,
      counts.used,
      counts.dropped,
      reachBoundUsed,
      gate.outcome,
      gate.failedGate,
      JSON.stringify(gate.detail),
      regression?.beta ?? null,
      regression?.se ?? null,
      regression?.ciLow ?? null,
      regression?.ciHigh ?? null,
      regression?.tStat ?? null,
      regression?.pValue ?? null,
      regression?.df ?? null,
      naive?.pooledBeta ?? null,
      naive?.pearsonR ?? null,
      verdict,
      input.traceId,
      JSON.stringify(input.actor),
    ],
  )
  return row!.id
}
