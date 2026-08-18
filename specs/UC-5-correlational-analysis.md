# UC-5 — Cohort contrast analysis (Layer 2)

**Status:** `done` · **Depends on:** UC-3, UC-4

## Goal

Answer *"which structural attributes are associated with creatives the advertiser keeps
running?"* — with honest uncertainty attached to every number.

## The thing this UC is mostly about

Every other UC ships a capability. This one ships a **refusal**.

The outline said `blocked` and warned: *"do not build this early — running it on a thin panel
produces confident nonsense, which is worse than producing nothing."* That warning is correct
and it is not a reason to defer the code. It is the specification. A Mann-Whitney U over nine
creatives returns a p-value with the same serene confidence as one over nine hundred, and
nothing in the arithmetic notices. The protection has to be built, and it can only be built
here.

So UC-5 builds the engine **and the gate that stops it**, and the gate is what gets the tests.
On today's empty panel the correct output is *"faltan N días"*, and that is a shipped feature,
not a placeholder.

**What is deliberately deferred:** tuning the thresholds against the real distribution. The
values below are defensible defaults with their reasoning recorded; they are single-source
constants precisely so they can be re-set once there is a panel to set them against.

## The unpaid debt, stated up front

The survival proxy is **unvalidated** (`ARCHITECTURE.md` §10.1). We have no ground truth that
"days active" tracks anything an advertiser cares about. The cheap validation — crawl Spain,
where `eu_total_reach` is public under the EU DSA, and test whether days-active tracks reach —
is not being paid before this UC.

UC-5 is the first UC whose output depends on the proxy meaning something. So the debt is not a
footnote in a doc: it is **rendered next to every result**, in the same card, in the same
visual weight as the number. A user who reads a UC-5 finding without reading that it rests on
an unvalidated proxy has been misled by our layout.

## Method

### Cohorts

Fixed by `ARCHITECTURE.md` §5 and not re-litigated here:

| Cohort | Definition |
|---|---|
| `short_lived` | stopped (`is_censored = false`) **and** `days_active < 14` |
| `long_lived` | `days_active > 60`, censored or not — surviving 60 days already qualifies |
| excluded | the ambiguous middle, reported as a count |

A **censored** creative with `days_active < 14` is *not* `short_lived`. It is still running and
its duration is a lower bound; calling it short-lived would be the right-censoring bug in its
purest form (`CLAUDE.md` rule 6). It falls in the excluded middle.

`has_gaps` creatives are excluded outright — their span crosses a crawl we cannot recover.
Creatives with `days_active = null` (Meta gave no `ad_delivery_start_time`) are excluded: no
start, no duration, no cohort.

### Per-feature test: van Elteren

Mann-Whitney U **stratified by advertiser**, which is the van Elteren test. Plain pooled
Mann-Whitney is not acceptable here: one advertiser with 200 creatives and a house style —
every ad fast-cut, every ad long-running — reproduces that house style as a finding about
cuts. Stratifying asks the question *within* each advertiser and then combines, so the result
survives one large spender (`ARCHITECTURE.md` §5, "MUST be stratifiable by advertiser").

Weights are `w_i = 1 / (N_i + 1)` — the design-free van Elteren weighting, which is the
standard choice when strata are advertisers rather than a designed blocking factor.

Strata contributing to only one cohort carry no information about the contrast and are
dropped, with their count reported. This is not a detail: on a thin panel it is common for
most advertisers to land entirely in one cohort, and an implementation that silently kept them
would report a confident result computed from very few advertisers.

### Effect size, always

A bare p-value is not shippable (`CLAUDE.md` rule 8). Every feature reports:

- **Probability of superiority** — `P(long > short) + ½·P(equal)`, weighted with **the same
  `1/(N_i + 1)` the test uses**. Reads in plain language: *"dentro de un mismo anunciante, de
  cada 100 pares, en 63 el creativo longevo tiene más cortes."*

  The tempting alternative is to weight by pair count, which drops the qualifier and reads
  better. It also hands the headline number straight back to the advertiser with 200
  creatives — the exact failure stratification exists to prevent — so the published effect
  size would contradict its own p-value. The clumsier sentence is the correct one.
- **Rank-biserial correlation** `r = 2·PS − 1`, in [−1, 1], as the comparable number.
- **n per cohort**, per feature — not per analysis. A feature in `skipped_features` for some
  creatives has a smaller n than its neighbours in the same table, and presenting one n for
  the whole run would overstate exactly the features we measured least well.

### Multiple comparisons — added, not in the outline

The outline omits this and it is the most likely way this UC ships something wrong. We test
~6 features at once; at α = 0.05 the chance of at least one false positive across six
independent tests is about 26%. Reporting the winner of six tests as *the* finding is how a
product manufactures a structural insight out of noise.

So: **Benjamini-Hochberg FDR** across the features in a run, and the UI reports the adjusted
q-value. BH rather than Bonferroni because the features are correlated and mildly so — a
Bonferroni correction over correlated tests is conservative to the point of never finding
anything, which trades one failure mode for another.

### The three nulls, again

`skipped_features` from UC-2 is load-bearing here. A creative whose `text_density` was never
measurable is **excluded from that feature's test** and stays in the others. It is not imputed
and not zeroed — zeroing would move it into a cohort it does not belong in, which is the exact
corruption `CLAUDE.md` warns about. Measured-absent (`null`, no skip entry) is a real value and
stays in.

## Gating: when the analysis refuses

The analysis **must refuse to render**, stating what is missing and how much longer the panel
needs. Every threshold is a named constant in one module.

| Gate | Default | Why |
|---|---|---|
| `MIN_COHORT_N` | 20 per cohort | Below this the test has almost no power; a null result would be indistinguishable from no data. |
| `MIN_STRATA` | 3 advertisers contributing to both cohorts | Two advertisers is a comparison of two house styles wearing statistics. |
| `MIN_PANEL_AGE_DAYS` | 61 | A `long_lived` cohort cannot exist in a panel younger than its own threshold. Non-negotiable arithmetic, not a tuning knob. |
| `MAX_CENSORING_RATE` | 0.80 in `long_lived` | If nearly every long-lived creative is still running, the cohort is "things we have not seen end", and its contrast with an all-resolved cohort is partly an artefact of when we started looking. |

Refusal is **per analysis**, not per feature: a run that fails any gate publishes no feature
results at all. Publishing the features that happened to clear a per-feature n, while
suppressing the rest, is a garden of forking paths with extra steps.

The refusal is a stored result, not an absence — a run that refused records *which* gate
failed and what the panel would need. "We ran and refused" and "we never ran" must stay
distinguishable, for the same reason a failed crawl and an absent creative must.

## Where it runs

A **job** (`CLAUDE.md` rule 9), writing a versioned row. Not computed per page load.

The reason is reproducibility, not cost — the arithmetic is milliseconds. A number that
changes between two page loads with no record of why is not a finding an operator can act on
or argue with. A stored run answers *"which analysis produced this, over which panel, under
which feature definitions"*, and that question gets asked the first time a result looks wrong.

Each run pins:

- `feature_schema_version` — **one version per run, never mixed** (rule 3). This is what
  UC-2's `FEATURE_SCHEMA_VERSION` and its digest test exist to protect. A run that finds rows
  at two versions fails rather than pooling them.
- `panel_date` — the logical day of the panel it read, from `crawl_runs.run_date`, never a
  timestamp cast.
- `extractor_version`, `analysis_version`, `trace_id`, `actor`.

## Data model

Two tables, both `workspace_id` + RLS (DashOne §3).

- **`analysis_runs`** — one row per execution: the pinned versions, the panel date, the gate
  outcome (`published` | `refused`), the failed gate and its shortfall, cohort ns, excluded
  counts, censoring rate, strata counts.
- **`analysis_feature_results`** — one row per feature per published run: n per cohort, the
  van Elteren z, raw p, BH-adjusted q, probability of superiority, rank-biserial r, strata
  used and strata dropped.

Append-only. A re-run writes a new `analysis_runs` row; nothing is updated in place. The
history of what the analysis said on each day is itself the audit trail.

## Rules

1. Every figure ships with n, effect size, and the caveat (`CLAUDE.md` rule 8).
2. Framing is **revealed advertiser behavior**, never performance (rule 7). Copy says
   *supervivencia* / *comportamiento del anunciante*; never *rendimiento*, *CTR*, *ROAS*.
3. Feature definitions pinned to one `feature_schema_version` per run; never mixed.
4. Confounders (`ARCHITECTURE.md` §5 — fixed-flight brand campaigns, seasonality, budget,
   calendar refresh policies) are disclosed **next to** the result, not buried.
5. The unvalidated-proxy caveat renders in the same card as every finding.
6. A refused run is a stored result, not a blank screen.
7. No feature result is published from a run that failed any gate.

## Acceptance criteria

**Statistics**

- [x] Van Elteren z, p, PS and rank-biserial match reference values computed independently
      (scipy) on the same fixtures, to 6 decimal places
- [x] Tie correction is exercised: a fixture with many tied values gives a different variance
      than the same fixture without, and matches the reference
- [x] A stratum present in only one cohort is dropped and counted, not silently weighted
- [x] One advertiser with an overwhelming creative count does not determine the pooled result
      — the same fixture pooled unstratified gives a materially different answer
- [x] BH adjustment matches reference q-values, including the monotonicity step-up

**Cohorts**

- [x] A censored creative with `days_active < 14` lands in the excluded middle, never in
      `short_lived`
- [x] A censored creative with `days_active > 60` lands in `long_lived`
- [x] `has_gaps` and null-`days_active` creatives are excluded and counted
- [x] A creative whose feature is in `skipped_features` is dropped from that feature's test
      only, and its absence changes that feature's n and no other

**Gating**

- [x] Each gate refuses on its own, with the shortfall reported
- [x] A refused run writes an `analysis_runs` row and zero feature results
- [x] A run finding two `feature_schema_version`s fails rather than pooling them
- [x] A panel younger than 61 days cannot publish, whatever the ns say

**Surface**

- [x] The three states are distinct on screen: never run, refused with its shortfall, published
- [x] A refused run renders the failing gate's number, taken from the stored `gate_detail` and
      not recomputed against today's panel
- [x] The unvalidated-proxy and confounder caveats render inside every finding's card, at
      reading weight — not in a shared footer, not behind a disclosure (rules 4 and 5)
- [x] No string the copy layer can produce implies performance (rule 7), checked over every
      feature, every effect direction and every gate at once
- [x] The within-advertiser qualifier cannot be dropped from the probability of superiority,
      and the direction is never flipped to keep the number above 50
- [x] A feature with no result row reads as untested, never as a zero or a null result
- [x] A contrast above the q threshold is labelled "sin señal" rather than left unmarked

**Tenancy**

- [x] Both tables carry RLS and are proved isolated through `asAuthenticated`
- [x] A run reads only its own workspace's panel

## Test plan

| What | Fixture | Expected |
|---|---|---|
| Known-answer stats | hand-built vectors, scipy reference | exact match to 6 dp |
| Stratification bites | one advertiser at 10× the others | pooled ≠ stratified |
| Censoring trap | short + censored creative | excluded, not `short_lived` |
| Every gate | one fixture per gate, each failing alone | specific refusal, no results |
| Mixed versions | rows at v2 and v3 | run fails |
| Isolation | two workspaces, one panel each | no cross-read |
| Stale published run | refusal newer than a published run | the refusal renders |
| Banned vocabulary | every string the copy layer can emit | no performance word |

## What shipped

| Layer | Where | Tests |
|---|---|---|
| Statistics | `packages/analysis/src/{van-elteren,fdr,normal}.ts` | `van-elteren.test.ts`, `fdr.test.ts`, `normal.test.ts` |
| Cohorts & contrast | `packages/analysis/src/{cohorts,contrast}.ts` | `cohorts.test.ts`, `contrast.test.ts` |
| Gating | `packages/analysis/src/gating.ts` | `gating.test.ts` |
| Storage | `supabase/migrations/0007_analysis.sql`, `0008` | `analysis-schema.test.ts` |
| The job | `packages/db/src/analysis/` | `analysis-run.test.ts`, `analysis-panel.test.ts` |
| The read | `packages/db/src/dashboard/analysis.ts` | `dashboard-analysis.test.ts` |
| The copy | `apps/web/src/lib/analysis-copy.ts` | `analysis-copy.test.ts` |
| The page | `apps/web/src/app/(dashboard)/analisis/page.tsx` | — (composition only) |

## Notes

- **Mutation testing is mandatory here**, as everywhere, and this is the UC where a green
  suite is least trustworthy: statistical code returns plausible numbers under almost any
  bug. `> 0` and `is not None` are decoration (`CLAUDE.md`). Reference values or nothing.
- The stats live in **TypeScript**, not the Python worker. `CLAUDE.md`'s documented deviation
  scopes Python to `apps/extractor` only; van Elteren and BH are a few dozen lines and do not
  justify moving product logic across the boundary. scipy is used to *generate reference
  values for the tests*, not at runtime.

## Upgrade path

Kaplan-Meier and Cox proportional hazards once n supports them — they use the censored
observations properly instead of bucketing around them. The cohort contrast exists because it
is honest at small n, not because it is the right answer at large n.

## Deferred past UC-5

- Paying the validation debt (Spain / `eu_total_reach`). Still the highest-value follow-up,
  and now the highest-*risk* one outstanding, because UC-5 makes claims that rest on it.
- Semantic features (hook type, people on screen, tone) — a VLM tagging pass.
- Tuning every threshold in the gating table against the real distribution.
