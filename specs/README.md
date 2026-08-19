# Specs — Mini Crux

No feature starts without its spec (DashOne §4). One file per use case.

## Sequencing rationale

The order is driven by one fact from `ARCHITECTURE.md` §3: **longitudinal data cannot be
backfilled.** Every day without a crawl is data permanently lost. So UC-1 (daily ingestion)
ships as early as physically possible, and UC-0 is deliberately the thinnest scaffold that can
legally and safely hold it. Analysis and UI come after, because they *can* be built later
against data already collected.

The panel needs roughly 8 weeks of depth before UC-5 says anything meaningful. That clock
starts the day UC-1 lands, and it runs in the background while UC-2 through UC-4 are built.

## Status

| UC | Title | Status | Depends on |
|---|---|---|---|
| [UC-0](UC-0-scaffold-and-contracts.md) | Scaffold and cross-cutting contracts | `done` | — |
| [UC-1](UC-1-daily-ingestion.md) | Daily Ad Library ingestion → survival panel | `done` | UC-0 |
| [UC-2](UC-2-feature-extraction.md) | Structural feature extraction from video | `done` | UC-1 |
| [UC-3](UC-3-survival-panel.md) | Survival derivation with censoring | `done` | UC-1 |
| [UC-4](UC-4-descriptive-dashboard.md) | Descriptive competitive dashboard (Layer 1) | `done` | UC-2, UC-3 |
| [UC-5](UC-5-correlational-analysis.md) | Cohort contrast analysis (Layer 2) | `done` | UC-3, UC-4 |
| [UC-6](UC-6-go-live.md) | Go live: closing the loop between the tick and the panel | `done` | UC-1, UC-2, UC-5 |
| [UC-7](UC-7-proxy-validation.md) | Validating the survival proxy against real delivery | `done` | UC-1, UC-3, UC-5, UC-6 |
| [UC-8](UC-8-semantic-tagging.md) | Semantic tagging via VLM (hook type, people on screen, tone) | `done` | UC-2, UC-5 |
| [UC-9](UC-9-workspace-provisioning.md) | Workspace provisioning from Clerk | `done` | UC-0 |
| [UC-10](UC-10-ux-preview.md) | Reviewable UI without a database | `done` | UC-4, UC-5, UC-7, UC-8 |

UC-6 is the one that makes the sequencing rationale above true rather than aspirational. The
daily tick has been enqueueing `crawl` jobs that no process consumes, so the clock that was
supposed to start with UC-1 has not started. Until UC-6 lands, the 8-week count is not going
down.

UC-7 tests the premise the whole panel rests on — that survival tracks advertiser behavior —
against real delivery data, using the EU Ad Library's retained `eu_total_reach` for finished
Spanish ads. It runs alongside the MX panel rather than gating it: see
`specs/UC-7-proxy-validation.md` for why a null result changes what the product says, not what
it computes.

UC-5 is the exception to "the panel needs 8 weeks first". What it ships now is the **gate**: the
analysis refuses on a thin panel and states how much longer it needs. The engine is built and
tested against reference fixtures; only the threshold *values* wait for a real distribution.

UC-8 is the semantic-tagging pass `ARCHITECTURE.md` §10.2 named and deferred when UC-2 shipped
structural features only. It adds one boolean feature (`has_people_on_screen`) to UC-5's
existing contrast engine and two categorical tags (`hook_type`, `tone`) shown descriptively —
see `specs/UC-8-semantic-tagging.md` for why the categorical tags are not run through a
hypothesis test in v1.

UC-9 breaks the numbering's own logic, and deliberately: it depends only on UC-0 and should
have shipped with it. Migration `0001` has said since day one that the tenant is
"synced by the Clerk webhook" — and no such webhook was ever written, so nothing creates the
`workspaces` row every RLS policy in the product resolves against. It surfaced while working
out what a first deploy actually needs, which is the only reason it is numbered last rather
than first. Nothing else in the list can be *used* until it lands.

UC-10 inverts the order the rest of this list assumes. Seven surfaces have shipped and none has
been seen in a browser: every dashboard page opens with `withWorkspace`, so rendering one needs
a Clerk session, a migrated Postgres, and the `workspaces` row UC-9 provisions — five accounts
that do not exist yet. And a fresh environment would show seven empty states anyway, since the
states worth reviewing (a refused analysis, a censored duration, a suspect crawl) are the ones
only a mature panel produces. So the design review runs first, against typed fixtures, and the
external tools get connected after.

## Closing ritual

Per DashOne §4, every UC closes with: end-user test plan → run the verifiable checks and show
output → self-score 1–10 → ask *"¿Vas a probar esto, o continúo con UC{N+1}? (confianza: N/10)"*.
