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
| [UC-0](UC-0-scaffold-and-contracts.md) | Scaffold and cross-cutting contracts | `todo` | — |
| [UC-1](UC-1-daily-ingestion.md) | Daily Ad Library ingestion → survival panel | `todo` | UC-0 |
| [UC-2](UC-2-feature-extraction.md) | Structural feature extraction from video | `todo` | UC-1 |
| [UC-3](UC-3-survival-panel.md) | Survival derivation with censoring | `todo` | UC-1 |
| [UC-4](UC-4-descriptive-dashboard.md) | Descriptive competitive dashboard (Layer 1) | `todo` | UC-2, UC-3 |
| [UC-5](UC-5-correlational-analysis.md) | Cohort contrast analysis (Layer 2) | `todo` | UC-3, UC-4 |

## Closing ritual

Per DashOne §4, every UC closes with: end-user test plan → run the verifiable checks and show
output → self-score 1–10 → ask *"¿Vas a probar esto, o continúo con UC{N+1}? (confianza: N/10)"*.
