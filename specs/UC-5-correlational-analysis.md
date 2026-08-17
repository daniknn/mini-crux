# UC-5 — Cohort contrast analysis (Layer 2)

**Status:** `blocked` (needs ~8 weeks of panel depth) · **Depends on:** UC-3, UC-4

> Outline only. The method is fixed (below); the parameters are not, and must be set against
> the real distribution once the panel has depth. Do not build this early — running it on a
> thin panel produces confident nonsense, which is worse than producing nothing.

## Goal

Answer *"which structural attributes are associated with creatives the advertiser keeps
running?"* — with honest uncertainty attached to every number.

## Method (fixed)

Cohort contrast, per `ARCHITECTURE.md` §5:

- `short_lived` — stopped, `days_active` < 14
- `long_lived` — `days_active` > 60, censored or not
- ambiguous middle excluded; the excluded count is reported
- **Mann-Whitney U** per feature across cohorts — non-parametric, no normality assumption
- report **effect size and n per cohort**; a bare p-value is not shippable
- exclude `has_gaps` creatives
- stratify by advertiser so one large spender cannot dominate the result

Naive Pearson over `days_active` is banned (`CLAUDE.md` rule 6) — it underestimates exactly the
still-running winners.

## Gating

The analysis MUST refuse to render, rather than degrade quietly, when:

- either cohort has fewer than a configured minimum n
- the censoring rate is so high that `long_lived` is mostly unresolved
- the panel is younger than the `long_lived` threshold — a 60-day cohort cannot exist in a
  40-day panel

In those cases the UI states what is missing and how much longer the panel needs. Refusing to
answer is a feature here, not a gap.

## Rules

1. Every figure ships with n, effect size, and the caveat (`CLAUDE.md` rule 8).
2. Framing is **revealed advertiser behavior**, never performance (`CLAUDE.md` rule 7). We do
   not have performance data.
3. Feature definitions are pinned to a `feature_schema_version`; never mix versions in one
   analysis.
4. Confounders from `ARCHITECTURE.md` §5 are disclosed in the UI next to the result, not buried.

## Upgrade path

Kaplan-Meier survival curves and Cox proportional hazards once n supports them — they use the
censored observations properly instead of bucketing around them.

## The validation debt

The survival proxy remains unvalidated (`ARCHITECTURE.md` §10.1). The cheap test — crawl Spain,
where `eu_total_reach` is public under the EU DSA, and check whether days-active tracks reach —
was scoped out of v1. **Strongly consider paying this debt before UC-5 ships**, since UC-5 is
the first UC that makes a claim resting on the proxy actually meaning something.
