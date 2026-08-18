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
from scipy.stats import false_discovery_control, mannwhitneyu, norm, rankdata

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

OUT.write_text(
    json.dumps(
        {"vanElteren": CASES, "benjaminiHochberg": BH, "normalTail": NORMAL_TAIL}, indent=2
    )
    + "\n",
    encoding="utf-8",
)
print(f"wrote {OUT}")
for c in CASES:
    e = c["expected"]
    print(f"  {c['name']:32s} z={e['z']:+.6f} p={e['p']:.6f} ps={e['probabilitySuperiority']:.6f}")
