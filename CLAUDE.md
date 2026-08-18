# Mini Crux — Claude Code Instructions

> Domain-specific rules for **Mini Crux**. The shared DashOne standard (engineering, Daily Brew
> design, cross-cutting contracts, git flow, stack) is imported below — do not duplicate it here.
>
> Read `ARCHITECTURE.md` before writing code. It is the source of truth for product behavior,
> the data model, and integration choices.

@.dashone/CLAUDE.md

---

## Project overview

- **What it is:** competitive creative-intelligence for performance marketing in Mexico —
  crawls competitor ads on the public Meta Ad Library, extracts structural video features, and
  correlates them against creative *survival* (how long an advertiser keeps paying to run it).
- **Surface type:** operator/analytics → **Daily Brew**.
- **Backend lane:** hybrid. TS/Supabase for the product surface; a Python worker on Fly.io for
  video feature extraction (OpenCV / EasyOCR / faster-whisper / librosa have no TS equivalent).
- **Runs on Brigade?** No.

## Stack

- Frontend: Next.js 15 (App Router) on Vercel · Tailwind + shadcn/ui
- Auth: Clerk (Organizations are the tenant; active org from the session JWT, never the URL)
- DB: Supabase Postgres + RLS + Storage
- Orchestration: Supabase `jobs` table + `pg_cron` tick → Python worker on Fly.io
- Ingestion: Apify actor (Meta Ad Library), behind an adapter
- Notable libs: `opencv-python`, `easyocr`, `faster-whisper`, `librosa`, `scipy`

## Domain rules (project-specific; these win for domain logic)

1. **The crawl clock is sacred.** Longitudinal data cannot be backfilled. A change that risks
   missing a daily crawl is a P0. Ship crawling before analysis, before UI, before polish.
2. **Land raw, parse later.** Write the Apify payload to Storage verbatim *before* parsing.
   Raw snapshots are immutable — never edit, never delete. Parsing bugs cost a reprocess.
3. **`creative_observations` is append-only.** Never `update`, never `delete`. Absence is
   recorded as `is_present = false`, never as a missing row — "we didn't see it" and "we didn't
   look" must stay distinguishable.
4. **The creative is the unit, not the ad.** One creative spans many `ad_archive_id`s. Always
   join through `creatives.creative_hash`.
5. **Never use `first_seen_at` as a start date.** Use Meta's `ad_delivery_start_time` — it
   solves left-censoring for free.
6. **Right-censoring must be handled explicitly.** Any analysis over `days_active` MUST account
   for still-running creatives. Naive Pearson on duration is banned: it underestimates exactly
   the winners. Use the cohort contrast in `ARCHITECTURE.md` §5.
7. **Never call it performance.** UI copy says *comportamiento del anunciante* / *supervivencia*,
   never *rendimiento*, *CTR* or *ROAS*. We do not have performance data and must not imply it.
8. **Every number ships with its n and its caveat.** A correlation without sample size and a
   confidence caveat is a bug, not a formatting nit.
9. **Every async op is a job.** No `setTimeout`, no fire-and-forget `fetch`. Enqueue a `jobs` row
   with a ULID `message_id`.
10. **Scrape logged-off only.** Never with an authenticated Meta session — this is the basis of
    our legal posture (`ARCHITECTURE.md` §9).
11. **Provider calls go through the adapter** (`providers/ad-library`). Apify must be swappable
    for an owned scraper without touching parse or analysis code.
12. **Spanish UI, English code.** User-facing strings in Mexican Spanish; identifiers, comments,
    commits and docs in US English.

## Postgres guardrails (learned from real failures — do not relearn these)

- **A `language sql` function body is validated at CREATE time.** Postgres parses it under
  `check_function_bodies`, so a helper that reads a table **MUST** be defined *after* that
  table. Keep table-independent helpers (`app.jwt_claim`) in the helper block at the top of the
  migration and define table-reading helpers (`app.current_workspace_id`, `app.current_user_id`)
  directly below the table they read. Symptom if you get it wrong: `relation "public.x" does not
  exist` when the migration runs — never at review time.
- **Any helper called from an RLS policy on a table it reads MUST be `security definer`.**
  Policy expressions are themselves subject to RLS, so an INVOKER function recurses until
  Postgres aborts with `ERRORDATA_STACK_SIZE exceeded`. Always pair it with
  `set search_path = ''` and fully-qualified names, or `security definer` becomes a privilege
  escalation. Symptom if you get it wrong: policies quietly return zero rows *before* they blow
  the error stack — which reads like "isolation works" right up until everything fails.
- **RLS denies any command that has no permissive policy for it, regardless of grants.** A
  `grant insert` with only a `for select` policy is dead code. If a client role is granted a
  command, that command needs its own policy — see `audit_events_tenant_append` in `0001`.
- **Never run a tenancy assertion on the default PGlite connection.** It is a superuser, and
  superusers bypass RLS even with `FORCE ROW LEVEL SECURITY`. Always go through
  `asAuthenticated` (`packages/db/src/testing.ts`).
- **Install scripts are opt-in.** New dependencies that want to run code at install time are
  recorded in `allowBuilds` in `pnpm-workspace.yaml`, with a note on why. Never wave one
  through with a CLI flag.
- **A function that returns a row MUST `return setof`, never a bare composite.** Postgres
  expands `select (app.f(...)).*` into one evaluation *per output column* before it optimizes,
  so a single-looking claim actually runs a dozen times, each claiming and abandoning a
  different job. `returns setof` forces `select * from app.f(...)`, which evaluates once, and
  makes "nothing found" zero rows instead of a row of nulls that reads like a real result.
  Symptom if you get it wrong: `claim_job` returns all-nulls, and jobs vanish into `running`.
- **A `CASE` over string literals is type `unknown`.** Assigning one to an enum column is a
  parse error, not an inference — `set status = case … end` fails with `transformAssignedExpr`.
  Cast it explicitly: `(case … end)::public.job_status`. See `app.reap_stalled_jobs` in `0004`.
- **A view over tenant tables is NOT covered by their RLS policies.** A Postgres view executes
  with the privileges of its **owner** — here the migration role, which bypasses RLS — so an
  ordinary view over `creative_observations` returns every workspace's panel to any
  authenticated caller, while each base table still reports its policy as enabled and every
  tenancy test on those tables still passes. It looks like a correctly secured system from
  every angle except an actual cross-workspace query. Every view in `public` **MUST** declare
  `with (security_invoker = true)`; `scripts/check-rls-policies.mjs` fails the build without
  it, `migrations.test.ts` re-checks it against the live catalog, and the isolation itself is
  proved through the view in `survival.test.ts`.
- **Keep worker SQL in files, not in Python string literals.** `apps/extractor/src/extractor/
  statements/*.sql` is loaded by the worker *and* `PREPARE`d against a freshly-migrated PGlite
  by `packages/db/test/worker-sql.test.ts`. That is the only thing checking the Python worker's
  columns against the real schema — PGlite cannot be imported from Python, and a renamed column
  is otherwise invisible until it runs in production against data that cannot be re-crawled.

## Panel guardrails (the failure modes that corrupt the outcome variable)

These are silent. Nothing crashes, the tests stay green, and the survival estimate is wrong.

- **Never key creative identity on anything that rotates.** Ad Library media URLs are signed
  and change between crawls. Hashing one mints a fresh creative every day, capping every ad's
  observed life at 1 day and making the entire panel look like churn. Identity is
  `(advertiser, normalized copy, media type)` or the media bytes — never a URL, never
  `first_seen_at`. Covered by *"does not fork a creative when the signed media URL rotates"*.
- **A truncated crawl must never write absences.** A payload at 10% of yesterday's volume is
  indistinguishable from a real die-off, so we refuse to guess: the run is marked `suspect`,
  present creatives are recorded, and every absence is withheld. Writing them would fabricate
  deaths in the one variable the product exists to measure.
- **A failed crawl writes no observations at all**, not even absences. "We did not look" and
  "we looked and it was gone" are different facts; collapsing them turns every outage into a
  mass extinction event in the data.
- **Prove a test can fail before trusting it.** Panel tests pass vacuously with alarming ease
  — a suite that only asserts "rows exist" is satisfied by almost any bug. Each of the three
  rules above was verified by mutating the source and confirming the specific test went red.
- **`> 0` and `is not None` are not assertions, they are decoration.** A feature measured over
  the wrong window is still positive, still non-null, still a complete-looking row. UC-2's
  `cuts_per_second` was divided by the full duration instead of the analyzed span and the
  truncation test passed anyway, biasing every long creative's cut rate downward by exactly its
  truncation ratio. Assert the **exact expected value** for anything UC-5 will correlate on.
- **A rate computed over a capped sample uses the analyzed span as its denominator**, never the
  full duration, and the cap goes on the row. A `text_density` over the first 60s of a 3-minute
  ad is a different quantity from one over the whole ad, and the analysis has to be able to
  tell which one it is holding.
- **Three kinds of null, and collapsing them corrupts the outcome variable.** Measured-absent
  is `null` with *no* `skipped_features` entry (a single-shot video genuinely has 0 cuts — it
  belongs in the n). Not-measurable is `null` *with* an entry. Not-attempted is no row at all.
  A feature that zeroes what it could not measure silently moves creatives between cohorts.
- **Never derive a date by casting a timestamp.** `observed_at::date` applies the *reader's*
  session timezone, so it is a fact about who is asking, not about the crawl. A crawl at 20:00
  in Mexico City is 02:00 UTC the next day: the Supabase API (UTC) and an operator's local
  `psql` then disagree about which day it happened on, and `days_active` differs by one. On the
  UC-3 fixture the same panel returned 30 days in `America/Mexico_City` and 31 in UTC, with
  `observation_days` differing too — no error, no warning, just an outcome variable that
  depends on the connection. `crawl_runs.run_date` is the crawl's logical day in the market,
  resolved once at write time; **every** date in an analysis derives from it. The single
  unavoidable cast (Meta's `ad_delivery_start_time`) is pinned to the market's zone so both
  sides of the subtraction are struck on the same calendar.
- **A fixture where two candidate expressions coincide tests neither.** UC-3's clean-death
  panel ended crawling *on* the death day, so `stopped_date` and `last_crawl_date` were equal
  and `coalesce(stopped_date, last_crawl_date)` could be replaced by the latter with the suite
  still green. In production the crawler keeps running after an ad dies, and that mutation
  grows every dead creative's measured lifetime by a day for every day the crawler runs. When a
  test pins a value that two different implementations both produce, extend the fixture until
  they diverge.
- **A constant is untested until something pins it.** `DEFAULT_HEARTBEAT_INTERVAL_S` only means
  something relative to `app.reap_stalled_jobs`' stall window — a number in another language in
  another directory. Tests that pass an explicit override prove the mechanism and leave the
  shipped value free to drift into reaping every healthy job. When two constants across a
  language boundary have a required relationship, assert it and **read one of them from source**
  rather than copying it.

## Specs

Spec dir: `specs/`. No feature starts without its spec. Index and status: `specs/README.md`.

## Local dev

```bash
# secrets via Doppler — never a committed .env
doppler run -- pnpm dev

# tests
pnpm test          # web + packages (Vitest)
pytest             # python worker
```

## Deviations from the standard (must be explicit)

- **Python worker alongside the TS product lane.** DashOne §5 lists both as approved; this
  project runs both at once. Justification: video feature extraction has no credible TS path.
  Boundary: Python owns *only* `apps/extractor`. All product logic stays in TS.
