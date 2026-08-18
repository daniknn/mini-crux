# UC-7 — Validating the survival proxy against real delivery

**Status:** `in-progress` · **Depends on:** UC-1, UC-3, UC-5, UC-6 · **Blocks:** nothing

## Goal

Find out whether the number this product is built on means anything.

`ARCHITECTURE.md` §10 lists it first among the known risks, and calls it the highest-value
follow-up:

> **The survival proxy is unvalidated.** We have no ground truth that "days active" tracks
> real performance.

Everything shipped through UC-6 rests on one sentence from §3: *"Performance advertisers kill
losing creatives fast and keep paying for winners."* It is a premise, not a finding. If it is
false, UC-5's cohort contrast is a rigorously-computed, multiple-comparison-corrected
statement about nothing.

This UC tests the premise against observed delivery, and writes down the answer.

## Why it is possible now, and cheaply

Meta publishes **no** delivery metrics for Mexican commercial ads (§3). It publishes
`eu_total_reach` for ads delivered in the EU, because the DSA compels it.

The part that makes this a week rather than a quarter: **the EU Ad Library retains inactive
ads**, and retains them with both `ad_delivery_stop_time` and `eu_total_reach`. A finished ad
therefore carries its own complete history — start, stop, and total delivery — in a single
record. We do not need to watch Spain daily for eight weeks to learn how long its ads ran. We
need one scrape.

This is the opposite of the MX panel's central constraint, and it is worth stating plainly
because it inverts the rule the whole repo is organized around: **in the EU, longitudinal data
*can* be backfilled.** That is the only reason this UC can run before the MX panel matures.

Spain, because it is the largest Spanish-language EU market: the ad copy is in the same
language, the creative conventions are the closest available analogue, and the advertiser mix
skews the same way toward direct-response e-commerce.

## The trap, stated before the design

`eu_total_reach` is **cumulative over the ad's life**. An ad that ran 60 days has more total
reach than one that ran 6 days for the mechanical reason that it ran ten times longer, whether
or not either was any good.

So the obvious analysis — correlate `days_active` with `eu_total_reach` — is **guaranteed** to
return a large, highly significant positive correlation, on data with no signal in it at all.
It would read as a triumphant validation. It is the same error as the naive Pearson on
duration that `CLAUDE.md` rule 6 already bans, wearing a different hat.

> **A test that cannot fail is not evidence.** If a result is mechanically certain before the
> data arrives, computing it tells you nothing.

Every design decision below exists to avoid this.

## Design

### The model, and the null that makes it a real test

If reach accumulates at a constant daily rate, `reach = rate × days`. In logs:

```
log(reach) = log(rate) + log(days)
```

Regress `log(reach)` on `log(days)` and read the slope **β**:

| β | Reading |
|---|---|
| **β = 1** | Reach is proportional to duration. Long-running ads simply ran longer at the same daily rate. **The proxy measures inertia, not performance.** |
| **β > 1** | Longer-running ads accumulate reach *faster than linearly* — advertisers push more budget through what they keep running. **The proxy measures something real.** |
| **β < 1** | Longer-running ads are being throttled down. The proxy is anti-correlated with delivery. |

**The null hypothesis is β = 1, not β = 0.** This is the whole methodological content of the
UC. Testing against 0 is the naive correlation again — it would reject at overwhelming
significance on pure mechanics and prove nothing.

β is an elasticity, so **β − 1** with its confidence interval is the effect size, and its sign
is the verdict. Reporting it that way keeps the reader from mistaking significance for size.

### Advertiser fixed effects, for the same reason UC-5 stratifies

A large advertiser both runs ads longer *and* buys more reach, from budget we cannot see. That
confound alone could manufacture β > 1.

So the regression is run **within advertiser** — `log(reach)` and `log(days)` are demeaned by
advertiser before the slope is estimated. The question becomes: *for the same advertiser, does
their longer-running ad get disproportionately more reach than their shorter one?* Between-
advertiser budget differences cancel out of that comparison entirely.

This mirrors UC-5's van Elteren stratification by advertiser exactly, and for the same reason.
Two consequences follow, both of which must be reported:

- An advertiser with **one** finished ad contributes nothing after demeaning — both its
  residuals are exactly zero. Such advertisers are dropped and counted, the same way UC-5
  drops single-cohort strata.
- Degrees of freedom are `n − A − 1`, not `n − 2`, where `A` is the number of contributing
  advertisers. Using `n − 2` would overstate precision by exactly the number of advertisers.

### The naive estimate is computed too, and shown

The pooled β (no fixed effects) and the raw Pearson correlation of `days` against `reach` are
computed alongside, stored, and displayed **next to** the real estimate.

Not as a hedge — as the exhibit. The gap between "r = 0.8, p < 0.001" and the within-advertiser
elasticity is the single most instructive number this UC produces, and someone will eventually
propose the naive version in good faith. Having it on the page with its own caveat is cheaper
than having the argument twice.

### Right-censoring: exclude, and admit what that costs

An ad still running has no stop time and an incomplete reach. It is excluded.

This is the one place in this repo where excluding censored observations is correct rather
than biased, because we are not estimating a survival curve — we are estimating a rate
relationship among ads whose totals are final.

But it costs something real and it must be on the page: **the sample is the population of
ads that have ended.** The long-lived-and-still-running creative — precisely the cell the
product cares most about — is structurally invisible to this validation. The finding therefore
covers the range of durations that have completed, and says nothing about the tail beyond it.

### Spain is not Mexico

The headline caveat, stated wherever the verdict is stated. What transfers between markets is
the *mechanism* — whether performance advertisers behave the way §3 assumes — which is more
plausibly universal than any magnitude. The coefficient itself does not transfer, and no MX
number may be derived from it.

### The corpus is quarantined

ES ads land in their own tables and **never** join to `creatives`, `creative_observations` or
`creative_survival`. A Spanish ad reaching the MX panel would corrupt the outcome variable of
the actual product to answer a question about it.

This is a hard boundary, not a convention: the validation tables carry no `creative_hash` and
there is no foreign key in either direction.

### It reports; it does not rewire

The verdict changes what the product *says*, not what it computes. No gate reads it, no copy
is switched automatically, no threshold moves. A human reads the report and decides.

Automatic propagation would mean a Spanish sample silently retuning a Mexican product, and
would make the eventual "we validated it" claim depend on a code path nobody inspected.

## Rules

1. The null MUST be β = 1. A test of β = 0 MUST NOT be presented as validation of the proxy.
2. The primary estimate MUST include advertiser fixed effects, with `df = n − A − 1`.
3. The naive pooled estimate and the raw correlation MUST be computed and displayed alongside,
   each labelled with why it is misleading.
4. Ads without a `stop_time` MUST be excluded and counted. Ads with `reach = 0` or
   `days_active < 1` MUST be excluded and counted separately — logs are undefined there, and
   silently dropping them would bias the low end.
5. Validation tables MUST NOT reference, or be referenced by, any MX panel table.
6. The verdict MUST ship with `n`, `A`, the confidence interval, and the Spain-is-not-Mexico
   caveat. A coefficient alone is a bug (CLAUDE.md rule 8).
7. Reach reported as a range MUST record both bounds and which was used; it MUST NOT be
   silently collapsed to a midpoint with the range discarded.
8. The regression MUST be verified against `scipy` reference fixtures, as UC-5's statistics
   were. A hand-rolled OLS with no external check is not a result.
9. The ES crawl MUST go through the same provider adapter and the same logged-off assertion as
   the MX crawl (CLAUDE.md rules 10, 11).

## Scope

**In:** an ES validation crawl behind the existing adapter; quarantined storage for the
corpus; the within-advertiser log-log regression with its scipy-checked implementation; a
`proxy_validation` job; a report surface in Spanish; the runbook entry.

**Out:** changing any UC-5 threshold, gate or copy on the basis of the result. Re-running the
validation on a schedule — this is a research instrument, run deliberately, not a daily tick.

**Explicitly out:** other EU markets, a spend model, any attempt to estimate MX reach. The
temptation to turn a validated elasticity into a predicted reach figure for Mexican ads is
exactly the "never call it performance" line (CLAUDE.md rule 7) with a regression in front
of it.

## Acceptance criteria

### Corpus

- [ ] An ES validation crawl lands raw before parsing, like every other crawl
- [ ] Finished ads are stored with start, stop, reach bounds, and advertiser
- [ ] Still-running ads are stored and marked, not silently dropped
- [ ] Reach reported as a range keeps both bounds and records which was used
- [ ] No validation table references an MX panel table, in either direction
- [ ] A second run of the same crawl does not double the corpus

### Statistics

- [ ] Within-advertiser β matches a `scipy` reference fixture to 1e-9
- [ ] `df = n − A − 1`, verified against a fixture where it differs from `n − 2`
- [ ] Advertisers with one finished ad are dropped and counted
- [ ] The t-test is against β = 1; a fixture with β exactly 1 does not reject
- [ ] A fixture with pure mechanical accumulation returns β ≈ 1 and a null verdict —
      the test that would have caught the naive design
- [ ] The naive pooled β and Pearson r are computed and differ from the primary estimate on
      a fixture built so they must
- [ ] Excluded ads are counted by reason: still running, zero reach, sub-day duration

### Report

- [ ] States β − 1, its CI, `n`, `A`, and the verdict in Mexican Spanish
- [ ] Shows the naive estimate beside the primary one, each labelled
- [ ] Carries the Spain-is-not-Mexico caveat and the ended-ads-only caveat
- [ ] Refuses with a stated reason when the corpus is too thin, rather than reporting a
      coefficient nobody should read

## Test plan

| What | How |
|---|---|
| Regression correctness | scipy reference fixtures, as UC-5 |
| The null is β = 1 | fixture with exact proportional accumulation → no rejection |
| Fixed effects matter | fixture where pooled and within-advertiser β have opposite signs |
| Degrees of freedom | fixture where `n − A − 1` and `n − 2` give different p-values |
| Exclusions | fixture with a still-running ad, a zero-reach ad, a same-day ad |
| Quarantine | catalog assertion: no FK between validation and panel tables |
| Corpus idempotency | run the same crawl twice, count rows |

The second row is the one this UC exists for. It is the only test that fails if the analysis
is rebuilt naively.

## What this UC cannot prove

It cannot prove the proxy works in Mexico. It tests a mechanism in the closest available
market and reports an elasticity with a confidence interval, on ads that have finished.

A null result is a real outcome and must be reported as one. If β is indistinguishable from 1,
the honest conclusion is that survival tracks inertia rather than performance in this sample —
and the product's framing as *revealed advertiser behavior*, never performance, stops being a
careful hedge and starts being the literal and only defensible reading.

## Notes

The naive analysis here would have produced a confident, significant, entirely spurious
validation, and it is the analysis anyone would write first. The general form is worth keeping
beside the fixture rule already in `CLAUDE.md`:

**When the outcome variable accumulates over the exposure you are testing, the correlation is
arithmetic before it is empirical.** Ask what the coefficient would be if nothing in the
hypothesis were true, and make *that* the null.
