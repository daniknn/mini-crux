# UC-3 — Survival derivation with censoring

**Status:** `done` · **Depends on:** UC-1 · **Blocks:** UC-4, UC-5

## Goal

Turn the raw observation panel into a defensible duration measure per creative — the outcome
variable the whole product rests on. This UC is small in code and large in consequence: getting
censoring wrong produces confidently wrong conclusions downstream.

## Definitions

For each `creative_hash` within a workspace:

| Field | Definition |
|---|---|
| `started_at` | Meta's `ad_delivery_start_time` — **never** our `first_seen_at` |
| `first_seen_at` | earliest observation with `is_present = true` |
| `last_seen_at` | latest observation with `is_present = true` |
| `stopped_at` | `observed_at` of the first `is_present = false` after `last_seen_at`, else null |
| `days_active` | `coalesce(stopped_at, latest_crawl_at) - started_at`, in days |
| `is_censored` | true when `stopped_at` is null — the creative was still running at last look |
| `observation_days` | count of crawls in which this creative could have been seen |
| `has_gaps` | true if any day in the span had a failed/suspect crawl for its watchlist |

Exposed as a `creative_survival` view (or materialized view refreshed after each crawl).

## Why this is the risky UC

**Left-censoring is solved for free** — Meta gives the true start date, so an ad already running
before we started watching is still measured correctly.

**Right-censoring is not.** A creative still running has an unknown end; `days_active` is a
lower bound. Because the *best* creatives are exactly the ones still running, treating that
lower bound as a true duration systematically underestimates winners. Any analysis that ignores
`is_censored` will conclude the opposite of the truth for the strongest ads.

Hence `CLAUDE.md` rule 6: naive correlation over `days_active` is banned.

## Rules

1. `is_censored` MUST be carried into every downstream consumer. No API, view, export or chart
   may expose `days_active` without it.
2. Creatives whose span includes a failed or suspect crawl are flagged `has_gaps` and are
   excluded from analysis cohorts by default.
3. Death requires evidence: `stopped_at` is only set from an explicit `is_present = false` on a
   healthy crawl — never inferred from a missing row.
4. Recomputation is pure. The view is derived solely from `creative_observations` + `creatives`,
   so it can always be rebuilt from the append-only panel.

## Acceptance criteria

- [x] A creative present days 1–5, absent day 6 → `stopped_at` = day 6, `is_censored` = false
- [x] A creative present days 1–5 with no later crawl → `is_censored` = true
- [x] `days_active` measures from `ad_delivery_start_time`, verified against a fixture whose
      start predates the first crawl
- [x] A creative spanning a failed crawl day is flagged `has_gaps`
- [x] A creative absent only on a *suspect* crawl day is **not** marked stopped
- [x] Dropping and rebuilding the view reproduces identical rows

## What shipped

`supabase/migrations/0005_survival.sql` — `public.creative_survival`, a plain view (not
materialized) so rule 4's "recomputation is pure" is structural rather than a discipline: there
is no refresh to forget and no staleness window. Covered by `packages/db/test/survival.test.ts`
(17 tests).

Two decisions worth recording, because neither is visible from the spec:

**Every date derives from `run_date`, never from a timestamp.** `observed_at::date` applies the
reader's session timezone, so it describes who is asking rather than when the crawl happened. A
crawl at 20:00 Mexico City is 02:00 UTC the next day, and the same panel returned `days_active`
30 in `America/Mexico_City` and 31 in UTC, `observation_days` 3 versus 2. The Supabase API runs
in UTC and an operator's `psql` runs local, so the two would have disagreed about the outcome
variable with nothing looking wrong. `crawl_runs.run_date` is the market's logical day, already
resolved at write time. The one unavoidable cast — Meta's `ad_delivery_start_time` — is pinned
to the market's zone so both sides of the subtraction share a calendar.

**`has_gaps` is per-day, not per-run.** A day is a gap when a covering watchlist failed *and* no
other covering watchlist crawled healthily that day. Flagging on any failure would discard
creatives whose history we actually hold, when a second watchlist covered the same day. For the
single-watchlist case — nearly all of them — the definitions coincide.

`security_invoker = true` on the view is load-bearing: without it the view runs as its owner,
which bypasses RLS, and returns every workspace's panel to any authenticated caller while the
base tables still report their policies as enabled.

## What the tests caught

Ten mutants applied to the view; eight died on the first pass. The two survivors:

| # | Mutation | Result |
|---|---|---|
| M1 | `suspect` runs treated as healthy evidence | killed |
| M2 | absence before last sighting counts as death | killed |
| M3 | span always ends at last crawl, ignoring death date | **survived** |
| M4 | `is_censored` hardcoded false | killed |
| M5 | start date cast in the session timezone | killed |
| M6 | observation window derived from `observed_at` again | killed |
| M7 | any failure flags a gap, ignoring other coverage | killed |
| M8 | left-censoring bug: measure from `first_seen_at` | killed |
| M9 | `observation_days` counts runs instead of days | killed |
| M10 | view runs as owner (RLS bypass) | **survived**¹ |

**M3 was a real gap.** The clean-death fixture stopped crawling *on* the death day, so
`stopped_date` and `last_crawl_date` were equal and `coalesce(stopped_date, last_crawl_date)`
could be replaced by the latter with the suite still green. In production the watchlist keeps
crawling long after an ad dies — that mutation grows every dead creative's measured lifetime by
one more day for every day the crawler keeps running, inflating exactly the durations UC-5
correlates on. Fixed by *"freezes a dead creative span at its death, not at the latest crawl"*,
whose fixture crawls four days past the death.

¹ **M10 was a harness bug, not a coverage gap.** Deleting the whole `with (...) as` clause
produces a syntax error, the migration rolls back, and Vitest reports "no tests" — which the
campaign script read as a pass. Re-run as a semantically valid mutant (drop only the storage
parameter, keep the `as`) it dies on both tenancy tests. The lesson is about mutation harnesses:
a mutant that fails to compile is not evidence, and "zero tests ran" must count as a kill.

## What is not covered

- **Days with no crawl at all** are not flagged by `has_gaps`; the spec scopes that field to
  failed/suspect runs. `observation_days` is what tells a consumer the panel is thin — a
  `days_active` of 30 built from 3 looks is a much weaker measurement than one built from 30.
- **Performance.** The view is unoptimized by design; the upgrade path is a materialized view
  refreshed at the end of each crawl, but it should be made slow first with a panel big enough
  to prove it rather than pre-optimized into a staleness bug.
- **The censoring rate is computed but not yet surfaced** — that lands in UC-4.

## Test plan

| What to test | Steps | Expected |
|---|---|---|
| Clean death | fixture present→absent | `stopped_at` set, not censored |
| Censored | fixture present through last crawl | `is_censored` true |
| Pre-existing ad | `ad_delivery_start_time` 30d before first crawl | `days_active` ≥ 30 |
| Gap handling | inject a failed crawl mid-span | `has_gaps` true, excluded from cohorts |
| Suspect guard | inject a suspect crawl where creative is absent | not marked stopped |
| Rebuild | drop + recreate view | identical output |

**Quick CLI check:**
```bash
psql -c "select is_censored, count(*), round(avg(days_active),1) as avg_days
         from creative_survival where not has_gaps group by 1;"
```

## Notes

Report the **censoring rate** prominently in UC-4 and UC-5. If most creatives are still running,
the panel is simply too young to conclude anything, and the product must say so rather than
render a chart that implies otherwise.
