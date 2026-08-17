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
