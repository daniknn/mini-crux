# UC-4 — Descriptive competitive dashboard (Layer 1)

**Status:** `todo` (outline — refine before build) · **Depends on:** UC-2, UC-3

> Deliberately specified at lower resolution than UC-0–UC-3. This UC is built against a panel
> that does not exist yet; over-specifying it now would be guessing. Refine once UC-1 has run
> for a few weeks and the real shape of the data is visible.

## Goal

Make the product useful **before** the correlational layer has enough data. This is what
carries Mini Crux through the ~8-week cold start, and it needs no outcome variable at all.

## The question it answers

*"What is this competitor doing right now?"* — answerable from a single crawl.

## Candidate views

- **Advertiser overview** — active creative count, launch cadence over time, format mix
  (vertical/square, duration buckets), platform mix.
- **Creative gallery** — thumbnails with age, variant count, and status (running / stopped),
  sortable by age. Age alone is a legible signal to a marketer without any statistics.
- **Message view** — first-line transcripts and ad copy, grouped. With semantic tagging out of
  scope, this is the message-level surface, and it is text the user reads and interprets
  themselves rather than a model's classification.
- **Structural profile** — distribution of cut pace, text density, hook-text presence across an
  advertiser's active set, vs. the watchlist baseline.
- **Change feed** — what launched and what died since last week. Likely the highest-value view
  and the cheapest to build.

## Rules

1. **Daily Brew** (`ARCHITECTURE.md` §8). Dark-first, Luminous Blue `#1a5cff`, never purple.
   Reuse `Button`/`Card`/`Badge`/`Input` — no bespoke components.
2. **UI copy in Mexican Spanish.** Never the word *rendimiento*, *CTR* or *ROAS*
   (`CLAUDE.md` rule 7). Say *supervivencia* / *comportamiento del anunciante*.
3. **Show the censoring rate and panel age** on any view that implies duration.
4. **WCAG AA**, keyboard navigable, visible focus ring, `alt` on every creative thumbnail.

## Open questions to resolve before build

- Is the change feed enough on its own for a first usable release?
- Does the gallery need video playback, or do thumbnail + transcript suffice?
- How is a watchlist created and managed in the UI (deferred from UC-1)?
