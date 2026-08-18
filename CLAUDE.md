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
