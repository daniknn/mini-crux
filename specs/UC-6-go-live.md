# UC-6 — Go live: closing the loop between the tick and the panel

**Status:** `in-progress` · **Depends on:** UC-1, UC-2, UC-5 · **Blocks:** every future UC

## Goal

Make the system run without a human at the keyboard.

Everything through UC-5 is proven against PGlite and reachable from a CLI. Nothing is
deployed, and — more seriously — **the scheduler ticks into a void.** `app.enqueue_daily_crawls`
writes a `crawl` job every morning at 08:00 Mexico City and no process on earth consumes it.
The panel that the entire product rests on is not being collected.

This UC ends with the daily loop closed and running on its own, and with an alarm that fires
when it stops.

## The gap, stated precisely

`jobs.type` is an open string, and four values are in play. Today:

| type | produced by | consumed by |
|---|---|---|
| `crawl` | `app.enqueue_daily_crawls()`, cron `0 14 * * *` | **nobody** |
| `parse` | `runCrawl` on a landed snapshot | **nobody** |
| `extract` | `app.enqueue_pending_extractions()` | `ExtractWorker` (Python) — written, never deployed |
| `analysis` | **nobody** | **nobody** |

`app.reap_stalled_jobs()` is defined, tested, and **called by nothing**, so a worker that dies
mid-job leaves the row `running` forever and the creative is never measured.

Three separate breaks in one chain. Any one of them is enough to make the product collect
nothing, and none of them is visible from the test suite — every test calls the handler
directly, which is exactly why they all passed while the chain was severed.

> **The lesson, and it is the whole UC:** a handler with a green test and no caller is not a
> feature. The tests proved each link; nothing proved the chain.

## Why this is urgent rather than merely pending

`ARCHITECTURE.md` §3: *"longitudinal data cannot be backfilled. A crawl not run today is data
permanently lost."* Every other kind of engineering debt in this repo can be paid later at the
same price. This one gets more expensive every day at midnight, and it is the only debt with
that property.

UC-5's gate currently says *"faltan 61 días de panel"*. That sentence is a lie of omission
until this UC ships: the count is not going down.

## Scope

**In:** the job runner that consumes `crawl` / `parse` / `analysis`; the daily analysis tick;
the reaper tick; container and platform config for both workers and the web app; automatic
migration on deploy; a health check and an alarm for a missed day; the operator runbook.

**Out:** creating the Supabase / Fly / Vercel / Apify / Clerk accounts and filling Doppler.
Those need the owner's credentials and card. The spec ends in a runbook, and the runbook is
the deliverable for that half.

**Explicitly out:** autoscaling, blue-green, multi-region, a staging *data* environment with
its own crawl schedule. One worker process per runtime is the correct size for one market and
one watchlist set, and a second crawl schedule against the same Ad Library is a way to get
rate-limited, not a way to be safe.

## Design

### One worker per runtime, not one per job type

`crawl`, `parse` and `analysis` are TypeScript; `extract` is Python because OpenCV, EasyOCR
and faster-whisper have no credible TS equivalent (`ARCHITECTURE.md` §7). That is the only
reason the split exists, and it is where the split stops. A third process would be three
things to deploy, three to monitor, and three to wake up at night for.

The TS worker mirrors the Python one deliberately — same `app.claim_job`, same heartbeat, same
`app.reap_stalled_jobs` window, same `processed_messages` idempotency. Two queue disciplines
in one `jobs` table is how a job gets claimed twice.

### Dispatch is a table, and an unknown type is an error

```
crawl    → runCrawl,    then enqueue `parse` for the same crawl_run + trace
parse    → runParse
analysis → runAnalysis
```

A claimed job whose type has no handler MUST fail loudly with `last_error` set, not be
silently released. A silent release is an infinite claim loop that looks like an idle worker.

### Chaining `parse` off `crawl` rather than doing both inline

`crawl:once` does both in one process because an operator is watching. The worker must not:
the crawl holds an Apify run and the parse holds nothing, so a parse failure that retries
should not re-rent the actor. Separate jobs, same `trace_id`, so the day is still one trace.

### The analysis tick

A new `app.enqueue_daily_analysis()`, cron `0 16 * * *` (10:00 Mexico City) — two hours after
the crawl tick, which is generous for one watchlist and cheap to widen. It enqueues one
`analysis` job per workspace that has a **healthy crawl for today's market date** and no
`analysis_runs` row for that panel date yet. Both conditions matter: without the first it
analyzes a panel that did not update, and without the second a retry doubles the run.

### The reaper tick

`0,15,30,45 * * * *`. Four times an hour against a 5-minute stall window means a dead worker
costs at most ~20 minutes, and the statement is a single `update`.

### Health: the alarm is the feature

A crawl that fails is fine — the operator retries it the same day and the panel date is
saved. A crawl that *never ran* and told nobody is the failure that costs data forever, and
it is silent by construction.

`getIngestionHealth()` answers one question per active watchlist: **is there a `succeeded`
crawl_run for today's market date?** Exposed two ways:

- `GET /api/health/ingestion` — `200` when every active watchlist has today's crawl, `503`
  with the offending watchlists otherwise. A platform uptime check pointed at this URL is the
  cheapest possible pager, and it needs no new vendor.
- The same data rendered on the dashboard, because an operator who opens the app should not
  have to trust that an alert would have fired.

The endpoint MUST be unauthenticated-safe: it returns counts and watchlist names for the whole
instance, so it exposes no creative data, no copy, and no cross-tenant rows beyond the fact
that a watchlist exists. It is therefore gated by a shared secret header rather than by Clerk,
because an uptime checker cannot hold a session.

### Migrations run themselves

DashOne §3: *"SQL applied automatically at startup by a runner … never ask a human to run
them."* The runner exists (`runMigrations`). It runs as a **release command on the worker
app**, once per deploy, before the new process serves — not on the web app, which is many
short-lived Vercel functions that would race each other on the same tracking table.

## Rules

1. The TS worker MUST claim through `app.claim_job` and heartbeat on the same schedule as the
   Python worker. No second queue discipline in the same table.
2. An unhandled `jobs.type` MUST fail the job with `last_error`, never silently release it.
3. `crawl` MUST enqueue `parse` as a separate job carrying the same `trace_id`, not parse
   inline.
4. Both cron ticks MUST be idempotent: a second tick on the same day enqueues nothing. The
   guarantee is a database constraint or a `not exists`, never an application check.
5. Workers connect with `SUPABASE_DB_URL` (BYPASSRLS). The web app connects with
   `SUPABASE_DB_AUTHENTICATOR_URL` and never the former. A deploy that gives the web app the
   worker's URL serves every workspace's panel to everyone, with a green suite.
6. No secret in a `Dockerfile`, `fly.toml`, `vercel.json`, or any committed file. Doppler is
   the only source; the platform integrations inject.
7. Every image MUST build in CI. A Dockerfile first built during an incident is not a deploy
   artifact.
8. Migrations apply on deploy, from the worker app's release command, exactly once.
9. The health check MUST distinguish *"today's crawl failed"* from *"today's crawl never
   started"*. They have different runbook entries and only one of them is recoverable by
   retrying.

## Acceptance criteria

### Worker

- [ ] Claims a `crawl` job, runs it, and leaves `jobs.status = 'succeeded'`
- [ ] A successful `crawl` enqueues exactly one `parse` job with the **same `trace_id`**
- [ ] Claims `parse` and `analysis` and dispatches each to its handler
- [ ] A job whose type has no handler ends `failed` with `last_error` naming the type
- [ ] A handler that throws leaves the job `pending` with `attempts` incremented, until
      `max_attempts`, then `failed`
- [ ] Heartbeat continues during a handler that blocks for longer than the stall window
- [ ] A redelivered `message_id` does not run the side effect twice
- [ ] Claims nothing belonging to another runtime — a pending `extract` job is left alone

### Schedule

- [ ] `app.enqueue_daily_analysis()` enqueues one job for a workspace with a healthy crawl today
- [ ] It enqueues nothing when today's crawl failed
- [ ] It enqueues nothing when an `analysis_runs` row already exists for that panel date
- [ ] It enqueues nothing on a second call the same day
- [ ] Both new cron entries register on a database with `pg_cron`, and the migration still
      applies on PGlite without it

### Health

- [ ] `200` when every active watchlist has a `succeeded` crawl for today's market date
- [ ] `503` naming the watchlist when one is missing entirely
- [ ] `503` distinguishing `failed` from `never started`
- [ ] Inactive watchlists are ignored
- [ ] The market date is used, not UTC — a run at 23:00 UTC still reads as the same market day
- [ ] Wrong or missing shared secret → `401`, and the body reveals nothing

### Deploy

- [ ] `apps/extractor` image builds in CI
- [ ] The TS worker image builds in CI
- [ ] Migrations run once as the worker's release command against an empty database
- [ ] `RUNBOOK.md` covers: first deploy, a missed day, a stuck job, a failed migration,
      rotating a secret

## Test plan

| What | How |
|---|---|
| Dispatch, retry, idempotency, heartbeat | PGlite, mirroring `test_worker.py` |
| `enqueue_daily_analysis` idempotency | PGlite, two calls, count the rows |
| Health endpoint states | PGlite fixtures per state + a route test |
| Market-date boundary | fixture at 23:30 UTC, asserted against Mexico City's date |
| Images build | CI job, `docker build` only — no push from a PR |
| Chain end-to-end | one test that ticks the scheduler, runs the worker to exhaustion against a fake provider, and asserts a populated panel |

That last row is the one this UC exists for. It is the only test in the repo that would have
failed while the chain was severed.

## What this UC cannot prove

It cannot prove the deploy works — that needs the owner's accounts. It proves the chain is
whole and the artifacts build, and hands over a runbook. The honest self-score at the close
must reflect that split rather than average over it.

## Notes

The severed chain was not visible from the suite because every test called its handler
directly. The general form is worth keeping: **a test that constructs its own caller cannot
tell you whether a caller exists.** Integration points need a test that starts where
production starts — here, at the cron tick.
