# UC-3 — Survival derivation with censoring

**Status:** `todo` · **Depends on:** UC-1 · **Blocks:** UC-4, UC-5

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

- [ ] A creative present days 1–5, absent day 6 → `stopped_at` = day 6, `is_censored` = false
- [ ] A creative present days 1–5 with no later crawl → `is_censored` = true
- [ ] `days_active` measures from `ad_delivery_start_time`, verified against a fixture whose
      start predates the first crawl
- [ ] A creative spanning a failed crawl day is flagged `has_gaps`
- [ ] A creative absent only on a *suspect* crawl day is **not** marked stopped
- [ ] Dropping and rebuilding the view reproduces identical rows

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
