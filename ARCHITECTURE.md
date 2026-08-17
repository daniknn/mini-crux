# Mini Crux — Architecture

> Source of truth for product behavior, data model, and integration choices.
> `CLAUDE.md` tells you *how* to build inside the repo. Read this first.

## 1. What this is

A **competitive creative-intelligence** tool for performance marketing in Mexico. It watches
a set of competitor advertisers on the public Meta Ad Library, extracts structural features
from their video creatives, and answers two questions:

1. **Descriptive (day one):** what is this competitor running right now, in what formats, with
   what message, at what cadence?
2. **Correlational (week ~8+):** which creative attributes are associated with ads that
   *survive* — i.e. that the advertiser keeps paying to run?

## 2. What this is NOT

- **Not a creative generator.** No storyboards, no video synthesis. Analysis only. The
  generation layer is deliberately out of scope until the analysis layer earns its keep.
- **Not connected to anyone's ad account.** No Meta Marketing API, no OAuth, no app review.
  We never see real spend, CTR, ROAS or CAC. See §3.
- **Not a statistically validated model.** See §5 and §10. Every number this product shows
  MUST carry its sample size and its caveat.

## 3. The central problem: there is no outcome variable

This is the constraint the whole design bends around.

Meta's Ad Library exposes **no performance metrics for commercial ads outside the EU/UK**.
Confirmed against Meta's own field docs: `impressions` and `spend` are annotated
*"Available only for POLITICAL_AND_ISSUE_ADS"*; `eu_total_reach` is EU-delivery only. The
official `ads_archive` API returns only political/issue ads for non-EU countries, so
`country=MX` commercial data is reachable only through the web UI.

**Verified in the browser (2026-08-17):** a live `country=MX` keyword search renders no
impression figure on any ad card. Note that the UI accepts `sort_data[mode]=total_impressions`
in the URL — the parameter is accepted but exposes no usable number for MX commercial ads, so
it must not be mistaken for available data.

For a Mexican commercial ad we get:

| Available | Not available |
|---|---|
| Creative media (video/image) | Impressions |
| Ad copy | Reach |
| `ad_delivery_start_time` | Spend |
| Publisher platforms | CTR / ROAS / CPA |
| Library ID, page name/ID | Demographics |
| Variant count ("N ads use this creative") | — |

### The substitute: survival

We manufacture an outcome variable from **time**, not from a single scrape. By crawling the
same watchlist **daily**, we observe when each creative *stops* running. The premise:

> Performance advertisers kill losing creatives fast and keep paying for winners.

A creative still running after 90 days is a revealed-preference signal. A creative that
disappeared after 6 days is the opposite. Neither is spend data, but both are real behavior.

**The operational consequence dominates everything else in this document: longitudinal data
cannot be backfilled.** A crawl not run today is data permanently lost. UC-1 therefore ships
before any analysis, any UI, and any polish.

### Secondary signal: conviction

Ad Library reports how many ad instances share one creative. An advertiser running 40 copies
of one concept across placements is scaling it. Tracked as `variant_count` per observation,
so its *trajectory* is visible, not just its current value.

## 4. Data flow

```
Apify actor (Meta Ad Library, country=MX)
   │  daily, per watchlist
   ▼
raw snapshot  ──►  Supabase Storage (immutable JSON)      ◄── land raw, parse later
   │
   ▼  parse job
creatives  +  creative_observations (append-only panel)
   │
   ▼  extract job (Python worker, Fly.io)
creative_features  (OpenCV cuts · EasyOCR text · faster-whisper transcript · librosa energy)
   │
   ▼  derive
creative_survival (view)  ──►  cohort analysis  ──►  Next.js dashboard
```

**Land raw, parse later** is a hard rule. The Apify payload is written to Storage verbatim and
never mutated, *before* any parsing. Schema mistakes then cost a reprocess, not a data loss —
which matters enormously when the data is time-series and irreplaceable.

## 5. Survival semantics (the part that is easy to get wrong)

**Left-censoring is solved for free.** An ad already running when we start crawling would
normally have an unknown start. Meta gives us `ad_delivery_start_time`, so true start is
always known. Use it — never use our own `first_seen_at` as the start.

**Right-censoring is real and must be handled.** A creative still running at the latest crawl
has an unknown *end*. Its observed duration is a lower bound. Naively correlating features
against `days_active` systematically **underestimates the best ads**, because the winners are
exactly the ones still running. This is the single most likely way to produce confidently
wrong output.

**v1 analysis method: cohort contrast, not Pearson.**

- `short_lived` — stopped, total duration < 14 days
- `long_lived` — duration > 60 days (censored or not; surviving 60 days already qualifies)
- ambiguous middle is excluded, and the excluded count is reported
- compare feature distributions across cohorts with **Mann-Whitney U** (non-parametric — no
  normality assumption on a small, skewed sample)
- report **effect size and n per cohort**, never a bare p-value

Kaplan-Meier / Cox proportional hazards is the correct upgrade once n supports it. Not v1.

**Confounders to disclose in the UI, not hide:** brand campaigns run fixed flights regardless
of performance; seasonality; advertiser budget and size; creative-refresh policies on a
calendar. Analysis MUST be stratifiable by advertiser so one big spender cannot dominate.

## 6. Data model (Supabase Postgres)

Every business table carries `workspace_id` and ships with an RLS policy (DashOne §3).

| Table | Purpose |
|---|---|
| `workspaces` | tenant (projection of the Clerk org) |
| `advertisers` | tracked competitors (`meta_page_id`, name) |
| `watchlists` | what to crawl daily: keyword or page, + country |
| `crawl_runs` | one per watchlist per day; `trace_id`, `actor`, `apify_run_id`, `raw_storage_path`, status |
| `creatives` | dedup unit; `ad_archive_id`s, `creative_hash`, media, copy, `ad_delivery_start_time` |
| `creative_observations` | **append-only panel**: (creative_id, crawl_run_id, observed_at, is_present, variant_count) |
| `creative_features` | extracted structural features + `schema_version`, `skipped_features[]` |
| `jobs` | work queue (parse, download, extract) |
| `processed_messages` | idempotency by `message_id` |
| `audit_events` | append-only, queryable by `actor` / `trace_id` / type / date |

**Creative dedup.** One creative is reused across many `ad_archive_id`s, so the ad is not the
unit — the creative is. v1 hashes the downloaded media bytes (SHA-256) with a fallback tuple
of `(advertiser_id, normalized_copy, duration_s)`. Perceptual hashing (pHash over sampled
frames) is the documented upgrade for when re-encoding breaks byte equality.

**`creative_observations` is append-only and is the product's real asset.** Never update or
delete a row. Absence from a crawl is recorded explicitly as `is_present = false`, not as a
missing row — "we did not see it" and "we did not look" must stay distinguishable.

## 7. Orchestration

Per DashOne §3, a request never blocks on background work.

- **Scheduler** — Supabase `pg_cron` fires a daily tick per active watchlist, enqueuing a
  `crawl` job.
- **Queue** — the `jobs` table. Every async operation is a job row; no fire-and-forget.
- **Workers** — a Python service on Fly.io polls `jobs`. Python is non-negotiable here:
  OpenCV, EasyOCR, faster-whisper and librosa have no credible TS equivalents.
- **Idempotency** — every job carries a ULID `message_id`, recorded in `processed_messages` in
  the same transaction as its side effect. A re-delivered crawl must not double-write the panel.
- **`trace_id`** — a ULID `trc_…` minted at the cron tick and propagated through crawl → parse →
  download → extract, so one day's pipeline is a single joinable trace.

## 8. Stack

| Layer | Choice |
|---|---|
| Frontend | Next.js 15 (App Router) on Vercel, Tailwind + shadcn/ui, Daily Brew tokens |
| Auth | Clerk (Organizations as the tenant) |
| DB | Supabase Postgres + RLS + Storage |
| Queue | Supabase `jobs` table + `pg_cron` tick |
| Worker | Python 3.12 on Fly.io (video feature extraction) |
| Ingestion | Apify actor for Meta Ad Library (v1) |
| Secrets | Doppler (only source of truth) |
| Observability | OpenTelemetry, joined on `trace_id` |

**Surface type: operator/analytics → Daily Brew design system applies.** Dark-first, Luminous
Blue `#1a5cff`, never purple.

## 9. Ingestion: rent now, own later

v1 rents an Apify actor rather than running Playwright. The Ad Library is React-rendered with
active bot detection, and a self-maintained scraper is a recurring tax paid before the thesis
is validated. The adapter boundary (`providers/ad-library`) exists specifically so the Apify
implementation can be swapped for an owned scraper without touching parse or analysis code.

**Legal posture:** scraping happens **logged-off only**, never with an authenticated session.
In *Meta v. Bright Data* (N.D. Cal., 2024) the court held Meta's ToS do not bind logged-off
collection of public data, and Meta dropped the suit. Renting Apify does not transfer this
obligation away from us. Not legal advice; revisit before commercial launch.

## 10. Known risks and accepted debts

Documented deliberately, per DashOne's honest-reporting rule. These are chosen, not overlooked.

1. **The survival proxy is unvalidated.** We have no ground truth that "days active" tracks
   real performance. The cheap validation — crawling Spain, where `eu_total_reach` is public
   under the EU DSA, and testing whether days-active correlates with reach — was scoped out of
   v1. It remains the highest-value follow-up. Until then, all output is explicitly framed as
   *revealed advertiser behavior*, never as performance.
2. **Structural features only.** No semantic tagging (hook type, people on screen, tone). v1
   derives message-level insight from the whisper transcript and the Ad Library ad copy. A VLM
   tagging pass is the planned depth upgrade.
3. **~8-week cold start.** The correlational layer produces nothing until the panel has depth.
   The descriptive layer must carry the product until then.
4. **Survivorship in reverse.** We only see *active* ads by default. Ads that ran and stopped
   before our first crawl are invisible. The panel only knows what it has watched.
5. **Single market, single platform.** MX + Meta only. No TikTok Creative Center (real CTR, but
   top-ads-only and therefore survivorship-biased), no Google.
