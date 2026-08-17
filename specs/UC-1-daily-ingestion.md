# UC-1 — Daily Ad Library ingestion → survival panel

**Status:** `todo` · **Depends on:** UC-0 · **Blocks:** UC-2, UC-3

> **This is the highest-priority UC in the project.** Every day it does not run is a day of
> data permanently lost — the panel cannot be backfilled (`ARCHITECTURE.md` §3). Ship it
> before feature extraction, before any dashboard, before polish.

## Goal

Crawl a watchlist of Mexican competitor advertisers on the public Meta Ad Library once per day,
land the raw payload immutably, and record one observation per creative per day — including
explicit absences.

## Scope

**In:**
- `watchlists` CRUD (minimal — a seeded row is acceptable for v1; UI comes in UC-4)
- `pg_cron` daily tick → enqueues one `crawl` job per active watchlist
- Apify actor invocation behind the `providers/ad-library` adapter
- Raw snapshot → Supabase Storage, immutable, before any parsing
- Parse job → upsert `advertisers`, `creatives`; insert `creative_observations`
- Creative dedup by `creative_hash`
- Absence recording: creatives previously seen for this watchlist but missing today get
  `is_present = false`

**Out:** video download and feature extraction (UC-2), survival math (UC-3), any chart (UC-4).

## Data contract

**Raw snapshot** — `storage://raw/{workspace_id}/{watchlist_id}/{YYYY-MM-DD}/{run_id}.json`,
write-once. Envelope carries `schema_version`, `trace_id`, `actor`, `apify_run_id`, `captured_at`.

**Per creative, from Ad Library:** `ad_archive_id`, page id/name, `ad_delivery_start_time`,
media URL, media type, ad copy, publisher platforms, variant count.

**`creative_observations`** — append-only, one row per (creative, crawl_run):
`creative_id`, `crawl_run_id`, `observed_at`, `is_present`, `variant_count`.

## Rules

1. **Land raw before parsing.** If parsing fails, the snapshot still exists and the job retries
   against stored bytes — never against a second live crawl.
2. **Absence is a row, not a gap.** A creative missing from today's crawl gets an explicit
   `is_present = false`. A day we failed to crawl produces *no rows at all* for that watchlist,
   and `crawl_runs.status = 'failed'`. These two states must never be confused.
3. **`ad_delivery_start_time` is the start date.** Never `first_seen_at` (`CLAUDE.md` rule 5).
4. **Dedup by creative, not by ad.** v1: SHA-256 of media bytes, falling back to
   `(advertiser_id, normalized_copy, duration_s)` when bytes are unavailable at parse time.
   pHash is the documented upgrade.
5. **Idempotent by `message_id`.** A redelivered crawl job must not double-write the panel.
6. **Logged-off only.** The adapter must never carry an authenticated Meta session.

## Failure handling

A failed crawl is a **P0 alert**, not a silent retry — a missed day is unrecoverable.

- Apify run fails or times out → retry with backoff, up to 3 attempts within the same day
- All attempts fail → `crawl_runs.status = 'failed'`, alert fires, the day is recorded as a
  known gap rather than being silently absent
- Partial payload (actor returns fewer results than the previous day by a large margin) → land
  it, flag `crawl_runs.status = 'suspect'`, do **not** write absences from a suspect run

That last rule matters: writing `is_present = false` off a truncated crawl would fabricate
deaths and corrupt the outcome variable.

## Acceptance criteria

- [ ] Cron tick enqueues exactly one `crawl` job per active watchlist per day
- [ ] Raw snapshot lands in Storage before any row is parsed; re-running parse against the
      stored snapshot reproduces identical rows
- [ ] A creative appearing on day 1 and missing on day 2 has two observations:
      `is_present = true`, then `is_present = false`
- [ ] A failed crawl writes `status = 'failed'` and writes **no** observations
- [ ] A suspect (truncated) crawl writes observations for present creatives but **no** absences
- [ ] The same creative under two `ad_archive_id`s resolves to one `creatives` row
- [ ] Re-delivering the same `message_id` produces no duplicate observations
- [ ] `trace_id` links cron tick → crawl job → snapshot → parsed rows

## Test plan

| What to test | Steps | Expected |
|---|---|---|
| Panel builds | run crawl on a fixture 3 days running | 3 observations per creative |
| Absence | remove a creative from day-3 fixture | day-3 row with `is_present = false` |
| Suspect guard | day-3 fixture returns 10% of day-2 volume | `status = 'suspect'`, zero absences written |
| Dedup | fixture with one video under 2 ad ids | one `creatives` row, `variant_count` reflects both |
| Reprocess | delete parsed rows, re-parse snapshot | byte-identical result |
| Tenant isolation | two workspaces, same competitor | panels do not cross |

**Quick CLI check:**
```bash
doppler run -- pnpm crawl:once --watchlist <id>   # forces a run outside cron
psql -c "select observed_at, count(*) filter (where is_present) as present,
                count(*) filter (where not is_present) as absent
         from creative_observations group by 1 order by 1;"
```

## Notes

Seed watchlist for v1 is Mexican fintech — the vertical where the original Ad Library query
(`q=stori`, `country=MX`) came from. Keep the seed small; crawl reliability matters far more
than breadth on day one. Breadth can be added any time; the missed days cannot.
