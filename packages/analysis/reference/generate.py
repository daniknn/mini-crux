"""Generate the reference values the TypeScript statistics tests assert against.

WHY THIS EXISTS

`specs/UC-5` is blunt about the risk: statistical code returns plausible numbers under
almost any bug. A van Elteren implementation with the wrong tie correction still produces a
z in a believable range, a p-value between 0 and 1, and a probability of superiority near
0.5. Nothing crashes and nothing looks wrong. So the tests cannot assert shapes — they have
to assert *values*, and the values have to come from somewhere other than the code being
tested.

They come from here. This script is run by hand, writes `fixtures.json`, and that file is
checked in. It is never imported at runtime, and scipy is deliberately not a dependency of
any package: it is invoked ephemerally.

    uv run --with scipy --with numpy python packages/analysis/reference/generate.py

HOW INDEPENDENT IS "INDEPENDENT"?

Honestly: partly. Three of the four layers are genuinely externally checked, and one is not.

1. **Ranking and tie correction** — checked against `scipy.stats.mannwhitneyu` with the
   asymptotic method. For a single stratum the van Elteren weight cancels out of the
   z-score entirely, so our Z must equal scipy's normal approximation exactly. That is the
   layer where tie bugs live, and it is checked against code we did not write.
2. **Probability of superiority** — computed twice, once from the U statistic and once by
   brute-force counting every (long, short) pair. Those two routes share no arithmetic.
3. **Benjamini-Hochberg** — checked against `scipy.stats.false_discovery_control`.
4. **The stratum combination itself** (`T = Σ wᵢSᵢ`, `Var = Σ wᵢ²Varᵢ`) — *not*
   independently checked. scipy has no van Elteren. This is the same formula written twice
   in two languages, and a misread of the reference would be reproduced faithfully. The
   mitigation is that the formula is four lines and the layer underneath it is externally
   pinned; the residual risk is stated here rather than papered over.

SIGN CONVENTION

The rank sum is taken over the **long_lived** group throughout, so a positive z and a
probability of superiority above 0.5 both mean "long-lived creatives score higher on this
feature". Getting this backwards inverts every finding in the product while leaving all the
magnitudes correct, which is the most expensive kind of wrong.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from scipy.stats import false_discovery_control, linregress, mannwhitneyu, norm, rankdata
from scipy.stats import t as student_t

OUT = Path(__file__).resolve().parent.parent / "test" / "fixtures.json"

#: van Elteren's design-free weighting. Standard when strata are advertisers we happened to
#: observe rather than blocks we designed.
def weight(n_total: int) -> float:
    return 1.0 / (n_total + 1)


def stratum_stats(long: list[float], short: list[float]) -> dict:
    """Wilcoxon rank sum over the long group, with the tie-corrected variance."""
    n_long, n_short = len(long), len(short)
    n = n_long + n_short
    ranks = rankdata(np.array(long + short, dtype=float))  # midranks for ties
    s = float(ranks[:n_long].sum())

    expected = n_long * (n + 1) / 2
    # Tie-corrected variance, written in the form that reduces to n1·n2·(N+1)/12 when no
    # value is repeated. Keeping the general form means the untied case is not a separate
    # code path that could disagree with the tied one.
    variance = (n_long * n_short / (n * (n - 1))) * float(
        (ranks**2).sum() - n * (n + 1) ** 2 / 4
    )

    u = s - n_long * (n_long + 1) / 2
    ps_from_u = u / (n_long * n_short)

    # Second, unrelated route to the same number: count the pairs.
    wins = sum(1 for a in long for b in short if a > b)
    draws = sum(1 for a in long for b in short if a == b)
    ps_brute = (wins + 0.5 * draws) / (n_long * n_short)
    assert abs(ps_from_u - ps_brute) < 1e-12, (ps_from_u, ps_brute)

    return {
        "n_long": n_long,
        "n_short": n_short,
        "n": n,
        "s": s,
        "expected": expected,
        "variance": variance,
        "ps": ps_from_u,
        "weight": weight(n),
    }


def van_elteren(strata: list[dict]) -> dict:
    """Combine per-advertiser rank sums. Single-cohort strata are dropped, not weighted."""
    used, dropped = [], 0
    for st in strata:
        if not st["long"] or not st["short"]:
            # Carries no information about the contrast: with one cohort empty there is no
            # pair to rank against. Weighting it anyway would add its expectation and
            # variance to both sides and shrink the z toward zero for free.
            dropped += 1
            continue
        used.append((st["stratum"], stratum_stats(st["long"], st["short"])))

    t = sum(s["weight"] * s["s"] for _, s in used)
    e_t = sum(s["weight"] * s["expected"] for _, s in used)
    var_t = sum(s["weight"] ** 2 * s["variance"] for _, s in used)
    z = (t - e_t) / np.sqrt(var_t)
    p = 2 * float(norm.sf(abs(z)))

    # The effect size uses the *same* weights as the test. Weighting by pair count instead
    # would read more naturally ("de cada 100 pares…") but would hand the answer back to
    # the one advertiser with 200 creatives — the exact failure stratification exists to
    # prevent. A headline number that disagrees with its own p-value is worse than a
    # slightly harder sentence.
    w_sum = sum(s["weight"] for _, s in used)
    ps = sum(s["weight"] * s["ps"] for _, s in used) / w_sum

    return {
        "z": float(z),
        "p": p,
        "t": float(t),
        "expectedT": float(e_t),
        "varianceT": float(var_t),
        "probabilitySuperiority": float(ps),
        "rankBiserial": float(2 * ps - 1),
        "nLong": sum(s["n_long"] for _, s in used),
        "nShort": sum(s["n_short"] for _, s in used),
        "strataUsed": len(used),
        "strataDropped": dropped,
    }


def pooled(strata: list[dict]) -> dict:
    """The same data with the advertiser thrown away — one stratum, everything in it."""
    return van_elteren(
        [
            {
                "stratum": "pooled",
                "long": [v for st in strata for v in st["long"]],
                "short": [v for st in strata for v in st["short"]],
            }
        ]
    )


def scipy_check(strata: list[dict]) -> dict | None:
    """For a single stratum the weight cancels, so scipy must reproduce our z exactly."""
    live = [st for st in strata if st["long"] and st["short"]]
    if len(live) != 1:
        return None
    st = live[0]
    result = mannwhitneyu(
        st["long"], st["short"], use_continuity=False, alternative="two-sided", method="asymptotic"
    )
    ours = van_elteren(strata)
    # scipy reports U for the first sample; ours is the same U by construction.
    n_pairs = len(st["long"]) * len(st["short"])
    assert abs(result.pvalue - ours["p"]) < 1e-12, (result.pvalue, ours["p"])
    assert abs(result.statistic / n_pairs - ours["probabilitySuperiority"]) < 1e-12
    return {"u": float(result.statistic), "p": float(result.pvalue)}


def case(name: str, why: str, strata: list[dict], *, with_pooled: bool = False) -> dict:
    out = {
        "name": name,
        "why": why,
        "strata": strata,
        "expected": van_elteren(strata),
        "scipy": scipy_check(strata),
    }
    if with_pooled:
        out["pooled"] = pooled(strata)
    return out


def st(name: str, long: list[float], short: list[float]) -> dict:
    return {"stratum": name, "long": long, "short": short}


# -- the cases -----------------------------------------------------------------------

CASES = [
    case(
        "single_stratum_no_ties",
        "One advertiser, every value distinct. The van Elteren weight cancels, so this is a "
        "plain Mann-Whitney and scipy pins it exactly.",
        [st("adv_a", [7.0, 9.0, 11.0, 13.0, 15.0, 17.0], [1.0, 2.0, 3.0, 4.0, 6.0, 8.0])],
    ),
    case(
        "single_stratum_heavy_ties",
        "The same shape and the same ns as `single_stratum_no_ties`, with values coarsened "
        "so most observations tie. The tie correction must lower the variance; a fixture "
        "without a matched untied twin could not tell a correction from its absence.",
        [st("adv_a", [2.0, 2.0, 2.0, 2.0, 3.0, 3.0], [1.0, 1.0, 2.0, 2.0, 2.0, 2.0])],
    ),
    case(
        "three_strata_balanced",
        "Three advertisers, each contributing to both cohorts. The ordinary published case.",
        [
            st("adv_a", [12.0, 15.0, 9.0, 14.0], [4.0, 7.0, 3.0, 11.0]),
            st("adv_b", [22.0, 19.0, 25.0], [18.0, 20.0, 13.0]),
            st("adv_c", [5.5, 6.5, 8.5, 4.5, 9.5], [6.0, 2.5, 7.5]),
        ],
    ),
    case(
        "dominant_advertiser",
        "One advertiser with ten times the creatives of the others and no within-advertiser "
        "contrast at all — its cohorts are drawn from the same values. The small advertisers "
        "all run *lower* on the feature when long-lived. Pooling reads the big advertiser's "
        "house style as a finding and flips the sign; stratifying does not.",
        [
            st(
                "adv_big",
                [80.0, 82.0, 84.0, 86.0, 88.0, 90.0, 92.0, 94.0, 96.0, 98.0,
                 81.0, 83.0, 85.0, 87.0, 89.0, 91.0, 93.0, 95.0, 97.0, 99.0,
                 80.5, 82.5, 84.5, 86.5, 88.5, 90.5, 92.5, 94.5, 96.5, 98.5,
                 81.5, 83.5, 85.5, 87.5, 89.5],
                [80.2, 84.2, 88.2, 92.2, 96.2],
            ),
            st("adv_s1", [1.0, 2.0, 3.0, 4.0], [10.0, 11.0, 12.0, 13.0]),
            st("adv_s2", [1.5, 2.5, 3.5, 4.5], [10.5, 11.5, 12.5, 13.5]),
            st("adv_s3", [1.2, 2.2, 3.2, 4.2], [10.2, 11.2, 12.2, 13.2]),
        ],
        with_pooled=True,
    ),
    case(
        "single_cohort_strata_dropped",
        "Two advertisers land entirely in one cohort. They must be dropped and counted, and "
        "the result must equal the same run with those advertisers absent — on a thin panel "
        "this is the common shape, and silently keeping them reports a confident number "
        "computed from one advertiser.",
        [
            st("adv_a", [12.0, 15.0, 9.0, 14.0], [4.0, 7.0, 3.0, 11.0]),
            st("adv_long_only", [30.0, 31.0, 32.0], []),
            st("adv_short_only", [], [1.0, 2.0]),
        ],
    ),
]

# The dropped-strata case must reduce exactly to its surviving stratum.
_reduced = van_elteren([CASES[4]["strata"][0]])
assert abs(_reduced["z"] - CASES[4]["expected"]["z"]) < 1e-12

BH = []
for name, why, raw in [
    (
        "monotonicity_step_up",
        "Raw q = p·m/i is non-monotone here (i=3 gives 0.078, i=5 gives 0.0504), so the "
        "step-up from the largest p downward is what produces the answer. Without it, "
        "feature 3 reports a q larger than feature 5's despite a smaller p.",
        [0.001, 0.008, 0.039, 0.041, 0.042, 0.60],
    ),
    (
        "unsorted_input",
        "The same p-values shuffled. BH sorts internally and must hand results back in the "
        "caller's order — a mismatch here attaches every q to the wrong feature name.",
        [0.042, 0.001, 0.60, 0.039, 0.008, 0.041],
    ),
    (
        "large_p_values",
        "Raw p·m/i runs past 1 here (0.4·4/1 = 1.6), and the step-up brings every value "
        "back down to the largest p. No clamp is needed and none is present: max(q) equals "
        "max(p) exactly.",
        [0.4, 0.7, 0.9, 0.95],
    ),
    ("single_test", "m = 1: BH is the identity.", [0.031]),
]:
    BH.append(
        {
            "name": name,
            "why": why,
            "p": raw,
            "q": [float(v) for v in false_discovery_control(np.array(raw), method="bh")],
        }
    )

# The two-sided normal tail, pinned on its own. Every p-value in the product goes through
# it, and a series approximation that is accurate near z = 2 can be badly wrong in the tail
# — where it matters most, because that is where a finding gets published. The large-|z|
# rows are the point of this block: they are the ones a low-order approximation fails.
NORMAL_TAIL = [
    {"z": z, "p": float(2 * norm.sf(abs(z)))}
    for z in [0.0, 0.5, -0.5, 1.959963984540054, 2.7221793990985196, -2.803937, 3.5, 5.0, -6.5, 8.0]
]

# -- UC-7: the within-advertiser regression -------------------------------------------------
#
# Same discipline as the van Elteren block above, for the same reason: a wrong sign on the
# demeaning, an off-by-one in `df`, or a dropped advertiser that should have contributed all
# return a plausible-looking beta and a p-value between 0 and 1. Nothing crashes.
#
# INDEPENDENCE OF THE CROSS-CHECK
#
# `within_advertiser_expected` computes beta by demeaning, exactly as `regression.ts` does.
# It is cross-checked against a *second*, unrelated route inside this same function: one
# dummy variable per advertiser (including the singletons the demeaning route drops), no
# separate intercept, solved by `numpy.linalg.lstsq` — ordinary dummy-variable OLS, ance
# `regression.ts`'s own header comment argues the two are algebraically identical. A
# singleton advertiser's dummy absorbs its one point exactly, contributing zero to both the
# slope and the residual degrees of freedom, which is why the dummy-OLS df over the *whole*
# corpus (`n_total − A_total − 1`) collapses to the demeaning route's `n_used − A_used − 1`
# without special-casing singletons in the dummy design. The two betas are asserted equal to
# 1e-9 below, per the spec's own acceptance criterion.
#
# Student-t values (`p`, the critical value) are scipy's, not a hand-rolled series — the
# thing being checked is `student-t.ts`'s use of the incomplete-beta identity, not scipy's
# own t-distribution.


def ad(advertiser: str, days: float, reach: float) -> dict:
    return {"advertiser": advertiser, "days": days, "reach": reach}


def within_advertiser_expected(ads: list[dict]) -> dict:
    from collections import defaultdict

    groups: dict[str, list[dict]] = defaultdict(list)
    for a in ads:
        groups[a["advertiser"]].append(a)

    demeaned_x: list[float] = []
    demeaned_y: list[float] = []
    advertisers_used = 0
    advertisers_dropped = 0
    for members in groups.values():
        if len(members) < 2:
            advertisers_dropped += 1
            continue
        advertisers_used += 1
        xs = np.log(np.array([m["days"] for m in members], dtype=float))
        ys = np.log(np.array([m["reach"] for m in members], dtype=float))
        demeaned_x.extend((xs - xs.mean()).tolist())
        demeaned_y.extend((ys - ys.mean()).tolist())

    x = np.array(demeaned_x)
    y = np.array(demeaned_y)
    n = len(x)
    df = n - advertisers_used - 1

    sxx = float((x * x).sum())
    sxy = float((x * y).sum())
    beta = sxy / sxx

    residuals = y - beta * x
    rss = float((residuals * residuals).sum())
    variance = rss / df
    se = float(np.sqrt(variance / sxx))

    t_stat = float((beta - 1.0) / se)
    p_value = float(2 * student_t.sf(abs(t_stat), df))
    t_critical = float(student_t.ppf(1 - 0.05 / 2, df))

    # Independent route: dummy-variable OLS over the entire corpus, singletons included.
    advertiser_names = sorted(groups.keys())
    x_full = np.log(np.array([a["days"] for a in ads], dtype=float))
    y_full = np.log(np.array([a["reach"] for a in ads], dtype=float))
    dummies = np.zeros((len(ads), len(advertiser_names)))
    for i, a in enumerate(ads):
        dummies[i, advertiser_names.index(a["advertiser"])] = 1.0
    design = np.hstack([dummies, x_full.reshape(-1, 1)])
    coef, _residual_sum, _rank, _sv = np.linalg.lstsq(design, y_full, rcond=None)
    beta_dummy_ols = float(coef[-1])
    assert abs(beta_dummy_ols - beta) < 1e-9, (beta_dummy_ols, beta)

    return {
        "beta": beta,
        "betaMinusOne": beta - 1.0,
        "se": se,
        "ciLow": beta - t_critical * se,
        "ciHigh": beta + t_critical * se,
        "tStat": t_stat,
        "pValue": p_value,
        "df": df,
        "n": n,
        "advertisersUsed": advertisers_used,
        "advertisersDropped": advertisers_dropped,
        "betaDummyOls": beta_dummy_ols,
    }


def naive_expected(ads: list[dict]) -> dict:
    x = np.log(np.array([a["days"] for a in ads], dtype=float))
    y = np.log(np.array([a["reach"] for a in ads], dtype=float))
    result = linregress(x, y)
    return {"pooledBeta": float(result.slope), "pearsonR": float(result.rvalue), "n": len(ads)}


def regression_case(name: str, why: str, ads: list[dict]) -> dict:
    return {
        "name": name,
        "why": why,
        "ads": ads,
        "expected": within_advertiser_expected(ads),
        "naive": naive_expected(ads),
    }


REGRESSION_CASES = [
    regression_case(
        "general_case",
        "Three advertisers, an ordinary shape, beta away from both 0 and 1. The published "
        "case — cross-checked against dummy-variable OLS to 1e-9, as the spec requires.",
        [
            ad("adv_a", 5, 400), ad("adv_a", 10, 1500), ad("adv_a", 20, 5200), ad("adv_a", 40, 22000),
            ad("adv_b", 8, 900), ad("adv_b", 16, 2600), ad("adv_b", 32, 6200),
            ad("adv_c", 6, 300), ad("adv_c", 12, 700), ad("adv_c", 24, 1900), ad("adv_c", 48, 5100),
        ],
    ),
    regression_case(
        "singleton_advertiser_dropped",
        "`general_case` plus one advertiser with a single finished ad. Its residuals are "
        "exactly zero after demeaning, so it must be dropped and counted, and beta/se/df "
        "must be byte-for-byte identical to the same corpus with that row absent — asserted "
        "below, not just claimed.",
        [
            ad("adv_a", 5, 400), ad("adv_a", 10, 1500), ad("adv_a", 20, 5200), ad("adv_a", 40, 22000),
            ad("adv_b", 8, 900), ad("adv_b", 16, 2600), ad("adv_b", 32, 6200),
            ad("adv_c", 6, 300), ad("adv_c", 12, 700), ad("adv_c", 24, 1900), ad("adv_c", 48, 5100),
            ad("adv_solo", 15, 1000),
        ],
    ),
    regression_case(
        "df_matters",
        "Eight advertisers with two ads each: A is a large share of n, so `df = n - A - 1` "
        "(7) and the naive `n - 2` (14) diverge sharply, and the p-values they produce are "
        "orders of magnitude apart even though both happen to reject here — using the wrong "
        "df would still be wrong, just not caught by a fixture that only checks the verdict.",
        [
            ad("adv_0", 6, 50 * 6**1.35 * 1.02), ad("adv_0", 18, 50 * 18**1.35 * 0.97),
            ad("adv_1", 10, 80 * 10**1.35 * 0.98), ad("adv_1", 25, 80 * 25**1.35 * 1.04),
            ad("adv_2", 4, 30 * 4**1.35 * 1.05), ad("adv_2", 14, 30 * 14**1.35 * 0.96),
            ad("adv_3", 8, 120 * 8**1.35 * 0.95), ad("adv_3", 30, 120 * 30**1.35 * 1.06),
            ad("adv_4", 12, 60 * 12**1.35 * 1.03), ad("adv_4", 20, 60 * 20**1.35 * 0.98),
            ad("adv_5", 5, 200 * 5**1.35 * 0.97), ad("adv_5", 15, 200 * 15**1.35 * 1.02),
            ad("adv_6", 9, 40 * 9**1.35 * 1.01), ad("adv_6", 27, 40 * 27**1.35 * 0.94),
            ad("adv_7", 7, 90 * 7**1.35 * 0.99), ad("adv_7", 21, 90 * 21**1.35 * 1.03),
        ],
    ),
    regression_case(
        "near_proportional_accumulation",
        "The fixture the naive design would have failed: reach tracks `rate * days` almost "
        "exactly, with only small multiplicative jitter per ad. Beta lands within noise of 1 "
        "and the t-test against beta=1 must NOT reject — this is what 'the proxy measures "
        "inertia, not performance' looks like arithmetically.",
        [
            ad("adv_0", 6, 40 * 6 * 1.01), ad("adv_0", 12, 40 * 12 * 0.99),
            ad("adv_0", 24, 40 * 24 * 1.02), ad("adv_0", 48, 40 * 48 * 0.98),
            ad("adv_1", 8, 65 * 8 * 0.98), ad("adv_1", 16, 65 * 16 * 1.02), ad("adv_1", 32, 65 * 32 * 1.00),
            ad("adv_2", 5, 25 * 5 * 1.00), ad("adv_2", 10, 25 * 10 * 1.01),
            ad("adv_2", 20, 25 * 20 * 0.99), ad("adv_2", 40, 25 * 40 * 1.00),
            ad("adv_3", 7, 90 * 7 * 0.99), ad("adv_3", 14, 90 * 14 * 1.00), ad("adv_3", 28, 90 * 28 * 1.01),
            ad("adv_4", 9, 55 * 9 * 1.02), ad("adv_4", 18, 55 * 18 * 0.98),
            ad("adv_4", 36, 55 * 36 * 1.00), ad("adv_4", 72, 55 * 72 * 1.01),
        ],
    ),
    regression_case(
        "dominant_advertiser_confound",
        "Three small advertisers whose reach barely moves with duration (flat internally) "
        "plus one advertiser that both runs far longer and buys far more reach, sitting on "
        "its own cluster far out on both axes. Pooling reads the between-advertiser budget "
        "gap as 'longer ads get disproportionately more reach' (beta well above 1, r near "
        "0.97) — a confident, spurious validation. Fixed effects see through it: the "
        "within-advertiser slope is barely above 0. This is the fixture the whole UC exists "
        "to make impossible to miss.",
        [
            ad("adv_small_a", 4, 1200), ad("adv_small_a", 6, 1250), ad("adv_small_a", 9, 1300),
            ad("adv_small_b", 5, 900), ad("adv_small_b", 8, 950), ad("adv_small_b", 12, 1000),
            ad("adv_small_c", 3, 1100), ad("adv_small_c", 7, 1150), ad("adv_small_c", 10, 1180),
            ad("adv_big", 150, 480000), ad("adv_big", 180, 490000),
            ad("adv_big", 220, 500000), ad("adv_big", 260, 510000),
        ],
    ),
]

# `singleton_advertiser_dropped` must reduce, beta/se/df exactly, to `general_case` with the
# solo advertiser's row removed — the direct test of "dropped means dropped", not just
# "counted as dropped".
_without_solo = within_advertiser_expected(
    [a for a in REGRESSION_CASES[1]["ads"] if a["advertiser"] != "adv_solo"]
)
assert abs(_without_solo["beta"] - REGRESSION_CASES[0]["expected"]["beta"]) < 1e-12
assert REGRESSION_CASES[1]["expected"]["advertisersDropped"] == 1
assert REGRESSION_CASES[1]["expected"]["n"] == REGRESSION_CASES[0]["expected"]["n"]

# The point of `near_proportional_accumulation`: fails to reject beta = 1.
assert REGRESSION_CASES[3]["expected"]["pValue"] > 0.05

# The point of `dominant_advertiser_confound`: naive and within-advertiser disagree sharply,
# and the naive estimate is the one that looks like a validation.
_dominant = REGRESSION_CASES[4]
assert _dominant["naive"]["pooledBeta"] > 1.5
assert _dominant["naive"]["pearsonR"] > 0.9
assert _dominant["expected"]["beta"] < 0.5

# -- UC-7: the Student-t tail and critical value, pinned against scipy directly -------------
#
# `student-t.ts` is a from-scratch continued-fraction evaluation of the regularized
# incomplete beta function; scipy's `t.sf`/`t.ppf` is the independent implementation it is
# checked against, at exactly the level the module's own header says is meaningful: p and
# critical-value pairs across a range of df, not the continued fraction's internals (which
# has its own direct test on `regularizedIncompleteBeta`).
STUDENT_T_TAIL = [
    {"t": t_value, "df": df, "p": float(2 * student_t.sf(abs(t_value), df))}
    for df in [1, 2, 3, 5, 10, 30, 50, 120, 1000]
    for t_value in [0.0, 0.5, 1.0, 2.0, 3.5, 6.0, 10.0]
]

STUDENT_T_CRITICAL = [
    {"alpha": alpha, "df": df, "tCritical": float(student_t.ppf(1 - alpha / 2, df))}
    for df in [1, 2, 3, 5, 10, 30, 50, 120, 1000]
    for alpha in [0.10, 0.05, 0.01]
]

OUT.write_text(
    json.dumps(
        {
            "vanElteren": CASES,
            "benjaminiHochberg": BH,
            "normalTail": NORMAL_TAIL,
            "regression": REGRESSION_CASES,
            "studentTTail": STUDENT_T_TAIL,
            "studentTCritical": STUDENT_T_CRITICAL,
        },
        indent=2,
    )
    + "\n",
    encoding="utf-8",
)
print(f"wrote {OUT}")
for c in CASES:
    e = c["expected"]
    print(f"  {c['name']:32s} z={e['z']:+.6f} p={e['p']:.6f} ps={e['probabilitySuperiority']:.6f}")
for c in REGRESSION_CASES:
    e = c["expected"]
    print(
        f"  {c['name']:32s} beta={e['beta']:+.6f} p={e['pValue']:.6g} "
        f"df={e['df']} used={e['advertisersUsed']} dropped={e['advertisersDropped']}"
    )
