# UC-4 — Descriptive competitive dashboard (Layer 1)

**Status:** `todo` · **Depends on:** UC-2, UC-3 · **Blocks:** UC-5

## Goal

Make the product useful **before** the correlational layer has enough data. This is what
carries Mini Crux through the ~8-week cold start, and it needs no outcome variable at all.

## The question it answers

*"What is this competitor doing right now?"* — answerable from a single crawl.

## Scope

The outline listed five candidate views. Three ship, one is folded in, one is cut.

| Surface | Route | Ships |
|---|---|---|
| Change feed — what launched, what died | `/novedades` | yes |
| Creative gallery — poster, age, status, variants | `/creativos` | yes |
| Creative detail — transcript, ad copy, structural row | `/creativos/[id]` | yes |
| Structural profile — distribution vs. watchlist baseline | `/estructura` | yes |
| Watchlist management — full CRUD | `/listas` | yes |
| Advertiser overview | — | **cut from v1** |

**Advertiser overview is cut** because every number it would show (active count, format mix,
launch cadence) is a filter or a facet of the gallery and the change feed. Building it as a
third surface duplicates the same query with a different chrome. It returns when there is a
reason for it to exist that is not "the outline mentioned it".

**Message view is folded into creative detail** rather than shipping standalone. Grouping
first-line transcripts across an advertiser is a clustering problem, and semantic tagging is
explicitly out of scope; a list of transcripts sorted by recency is what we can honestly
build, and that list is the gallery.

## How the web app reaches the database

This is the first UC that reads tenant data from the product surface, so it decides the
access path for everything after it.

**Direct Postgres, not PostgREST.** The web app opens a `pg` connection as Supabase's
`authenticator` role and, inside a transaction, does:

```sql
begin;
select set_config('request.jwt.claims', $1, true);  -- true = transaction-local
set local role authenticated;
--  ... the query ...
commit;
```

Which is precisely what `asAuthenticated` already does in the test harness. That symmetry is
the entire argument: the tenancy assertions in `packages/db/test` then exercise **the same
helper and the same SQL** the browser hits, rather than a parallel implementation that merely
resembles it. Through PostgREST the queries would be an untestable second dialect, and the
aggregate shapes this UC needs (change feed, distribution vs. baseline) are awkward there.

**Both settings must be transaction-local.** `set role` and a session-scoped `set_config`
survive the connection's return to the pool, so under Supabase's transaction pooler the next
request — a *different tenant* — inherits them. `set local` and `set_config(..., true)` are
reverted by `commit`. There is a test for this: two sequential tenants on one pooled
connection must not see each other's rows.

Queries live in `packages/db/src/dashboard/*.ts` as parameterized SQL against `SqlExecutor`,
for the same reason worker SQL lives in `.sql` files — so a renamed column fails a test
instead of a page.

## Definitions

| Term | Definition |
|---|---|
| `panel_age_days` | days from the workspace's earliest `crawl_runs.run_date` to the latest |
| `censoring_rate` | share of creatives in the current selection with `is_censored = true` |
| *launched* | `first_seen_date` within the selected window |
| *stopped* | `stopped_at` non-null and its `run_date` within the selected window |
| `poster_storage_path` | Storage key of a keyframe JPEG extracted from the stored media |

## Poster frames

The gallery needs an image per creative and there is nothing to show one from. Meta's
`media_url` is signed and rotates between crawls (`CLAUDE.md`, panel guardrails), so it cannot
be rendered from a stored row; the extractor's saved media is the full video.

So UC-4 adds a poster step to the UC-2 extractor: decode one keyframe, write a JPEG to
Storage, record `poster_storage_path` on `creative_features`. The web app serves it through a
short-lived signed URL minted server-side.

The frame is taken at **`max(first_cut_time_s / 2, 1.0s)`**, not at t=0 — the first frame of an
ad is frequently black or a platform chrome card, and a gallery of black squares is a gallery
of nothing. A video with no cut to halve uses the same 1.0s.

The 1.0s is a **floor, not just a fallback**, and the difference matters for exactly the
creatives the rule exists to protect. Meta's re-encodes routinely open with a fraction of a
second of black; that black-to-content transition is itself detected as the first cut, so
`first_cut_time_s` is small and a literal halving puts the poster back *inside* the black. The
floor is what keeps it out. (Implemented in `_poster_target_s`; pinned by
`test_an_early_first_cut_falls_back_instead_of_landing_back_in_the_lead_in`, which uses a
ramp-brightness fixture because against flat scenes t=0, the halving and the fallback all
produce the same image and the test would prove nothing.)

The poster key carries the schema version (`….poster.v{n}.jpg`). Storage is write-once, so a
version-less key would make a re-extraction silently keep the *previous* definition's frame.

Poster extraction is **best-effort and never fails the job.** A creative with no poster
renders a text card. This follows UC-2's degradation rule: a missing poster is a missing
poster, not a missing feature row, and it records itself in `skipped_features`.

## Rules

1. **Daily Brew** (`ARCHITECTURE.md` §8). Dark-first, Luminous Blue `#1a5cff`, never purple.
   Reuse `Button`/`Card`/`Badge`/`Input` — no bespoke components.
2. **UI copy in Mexican Spanish.** Never the word *rendimiento*, *CTR* or *ROAS*
   (`CLAUDE.md` rule 7). Say *supervivencia* / *comportamiento del anunciante*.
3. **Every duration ships with its censoring rate and panel age.** A view that renders
   `days_active` without both is a bug, not a formatting nit (`CLAUDE.md` rule 8).
4. **A censored duration is never rendered as a plain number.** `34 días` and `34+ días` are
   different claims; the second is the true one for a creative still running.
5. **`has_gaps` creatives are shown, badged, never silently dropped.** See below.
6. **WCAG AA**, keyboard navigable, visible focus ring, `alt` on every poster.
7. **No tenant id in any URL.** The workspace comes from the Clerk session (UC-0 middleware).

## Why `has_gaps` is shown rather than excluded

UC-3 rule 2 says creatives spanning a bad crawl day are *"excluded from analysis cohorts by
default"*. That rule holds for UC-5. It is the wrong default for UC-4, and the demo panel
showed why: 14 crawl days with one failed day left **1 of 4** creatives passing
`where not has_gaps`.

The bias is not random. A creative alive for 60 days spans sixty chances to hit a bad crawl;
one alive for three days spans three. Excluding by default therefore filters out long-lived
creatives preferentially — the exact population the operator opened the dashboard to look at —
and does it invisibly, leaving a page that looks like a complete answer.

So UC-4 shows every creative and marks the ones whose history has holes, with
`observation_days` as the legible measure of how much the number rests on: *34+ días · 8 de 34
días observados*. A weak measurement presented as weak is more useful than a strong
measurement that is absent. UC-5 still excludes, and says so.

## Acceptance criteria

**Tenancy** — these are the ones that matter; everything else is a rendering bug.

- [ ] Every dashboard query returns zero rows for a workspace the caller does not belong to
- [ ] Two tenants served in sequence on one pooled connection do not see each other's rows
      (proves `set local` / transaction-local claims)
- [ ] A query run without claims set returns zero rows rather than every row

**Correctness of the numbers**

- [ ] A censored creative renders `N+ días`, never `N días`
- [ ] Change feed *launched* on a window matches `first_seen_date` within it, and does not
      include a creative first seen before the window
- [ ] Change feed *stopped* includes only creatives with an explicit `stopped_at`
- [ ] `censoring_rate` and `panel_age_days` appear on the change feed, gallery and structural
      profile
- [ ] A `has_gaps` creative appears in the gallery, badged, with its `observation_days`
- [ ] A workspace with zero crawls renders an empty state, not a zero-filled chart

**Poster frames**

- [x] A creative whose media decodes gets a `poster_storage_path` and renders an image
      *(extractor side proven; gallery rendering still open)*
- [x] A creative whose poster extraction fails still gets its feature row and lands in
      `skipped_features` *(text card still open)*
- [x] A poster whose **upload** fails leaves `poster_storage_path` null, never a path
      pointing at an object that was never written
- [x] The poster is cut at the floored timestamp, not at t=0 and not at a bare halving
- [ ] The poster URL handed to the browser is short-lived and minted server-side
- [ ] A creative with no poster renders a text card in the gallery

**Watchlists**

- [ ] Creating a watchlist writes an audit event with the acting user
- [ ] Deactivating a watchlist stops it being crawled but destroys no observations
- [ ] A watchlist cannot be created for another workspace even with a forged body

**Design**

- [ ] No hardcoded hex outside `globals.css`; no purple anywhere
- [ ] Every interactive element reachable by keyboard with a visible focus ring
- [ ] Copy contains none of *rendimiento*, *CTR*, *ROAS*

## Test plan

| What to test | Steps | Expected |
|---|---|---|
| Cross-tenant read | sign in as workspace A, query B's creative id | not found |
| Pooled leakage | two tenant queries back to back on one connection | each sees only its own |
| Censored label | creative still running | `N+ días` with a caveat |
| Gap badge | creative spanning a failed crawl | shown, badged, `observation_days` visible |
| Empty panel | fresh workspace, no crawls | empty state with an explanation |
| Poster fallback | corrupt media fixture | text card, feature row intact |
| Watchlist CRUD | create, rename, deactivate | audit event per write, crawl stops |
| Keyboard | tab through every surface | focus visible at all times |

**Quick CLI check:**
```bash
pnpm --filter @mini-crux/db test dashboard
psql -c "select count(*) filter (where is_censored) * 100.0 / count(*) as censoring_rate_pct,
                count(*) filter (where has_gaps) as with_gaps, count(*) as n
         from creative_survival;"
```

## Notes

If `censoring_rate` is above ~80% the panel is too young for UC-5 and the dashboard must say
so in words on the page, not merely expose the number. The whole point of Layer 1 is that it
stays honest while Layer 2 is still statistically empty.

## Open questions deferred past UC-4

- Grouping messages semantically across an advertiser (needs embeddings; not in scope).
- Video playback in the gallery — poster + transcript first; revisit if operators ask.
- Per-advertiser overview page — see "Scope" above.
