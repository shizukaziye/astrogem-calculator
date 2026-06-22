#!/usr/bin/env python3
"""verify.py - recompute every entry in refs.json using model/astrogem.py and
assert equality to the JS-produced values. Floats compared with abs tolerance
1e-6; tiers/dists exact. Prints PASS/FAIL and exits 1 on any mismatch.

This is the JS<->Python lockstep guard: refs.json is generated FROM the JS core,
so a green run here means astrogem.py matches astrogem.js. Stdlib only.

Run: python3 verify.py
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "model"))
import astrogem as A  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "refs.json"), "r") as f:
    refs = json.load(f)

TOL = refs["meta"].get("floatTolerance", 1e-6)

_pass = 0
_fail = 0
_failures = []


def is_inf(x):
    return isinstance(x, float) and math.isinf(x)


def approx(a, b):
    if a == b:
        return True
    if not isinstance(a, (int, float)) or not isinstance(b, (int, float)):
        return False
    if is_inf(a) or is_inf(b):
        return a == b
    return abs(a - b) <= TOL


def r6(x):
    if isinstance(x, float) and math.isinf(x):
        return x
    return round(x * 1e6) / 1e6


def check(label, got, want, exact=False):
    global _pass, _fail
    ok = (got == want) if exact else approx(got, want)
    if ok:
        _pass += 1
    else:
        _fail += 1
        _failures.append("%s  got=%s  want=%s" % (label, got, want))


# ---- score ----
for i, cse in enumerate(refs["score"]):
    c = cse["config"]
    check("score[%d].score" % i, r6(A.score(c)), cse["score"])
    bd = A.score_breakdown(c)
    check("score[%d].wpCost" % i, bd["willpowerCost"], cse["breakdown"]["willpowerCost"], exact=True)
    check("score[%d].wpScore" % i, r6(bd["willpowerScore"]), cse["breakdown"]["willpowerScore"])
    check("score[%d].e1Score" % i, r6(bd["effect1Score"]), cse["breakdown"]["effect1Score"])
    check("score[%d].e2Score" % i, r6(bd["effect2Score"]), cse["breakdown"]["effect2Score"])
    check("score[%d].orderScore" % i, r6(bd["orderScore"]), cse["breakdown"]["orderScore"])
    check("score[%d].total" % i, r6(bd["totalScore"]), cse["breakdown"]["totalScore"])

# ---- willpowerCost ----
for i, cse in enumerate(refs["willpowerCost"]):
    check("willpowerCost[%d].cost" % i, A.willpower_cost(cse["baseCost"], cse["wpLevel"]), cse["cost"], exact=True)
    check("willpowerCost[%d].score" % i,
          r6(A.willpower_score(A.willpower_cost(cse["baseCost"], cse["wpLevel"]))), cse["score"])

# ---- classifyTier ----
for i, cse in enumerate(refs["classifyTier"]):
    check("classifyTier[%d].tier" % i, A.classify_tier(cse["levelSum"]), cse["tier"], exact=True)
    check("classifyTier[%d].ways" % i, A.level_sum_ways(cse["levelSum"]), cse["ways"], exact=True)

# ---- outputLevelSumDist ----
for t in ("legendary", "relic", "ancient"):
    got = A.output_level_sum_dist(t)
    want = refs["outputLevelSumDist"][t]
    for k, wv in want.items():
        check("outputLevelSumDist.%s[%s]" % (t, k), r6(got[int(k)]), wv)

# ---- fusionOutputDist ----
for i, cse in enumerate(refs["fusionOutputDist"]):
    d = A.fusion_output_dist(cse["inputs"])
    check("fusionOutputDist[%d].L" % i, r6(d["legendary"]), cse["dist"]["legendary"])
    check("fusionOutputDist[%d].R" % i, r6(d["relic"]), cse["dist"]["relic"])
    check("fusionOutputDist[%d].A" % i, r6(d["ancient"]), cse["dist"]["ancient"])

# ---- outcomeProbabilities ----
for i, cse in enumerate(refs["outcomeProbabilities"]):
    op = A.outcome_probabilities(cse["state"])
    check("outcomeProb[%d].nPoss" % i, len(op["possibilities"]), cse["nPossibilities"], exact=True)
    check("outcomeProb[%d].totalBase" % i, r6(op["totalBase"]), cse["totalBase"])
    check("outcomeProb[%d].turnsRemaining" % i, op["turnsRemaining"], cse["turnsRemaining"], exact=True)
    for k, wv in cse["byType"].items():
        check("outcomeProb[%d].byType.%s" % (i, k), r6(op["byType"][k]), wv)
    check("outcomeProb[%d].byTypeKeyCount" % i, len(op["byType"]), len(cse["byType"]), exact=True)

# ---- goldValue ----
for i, cse in enumerate(refs["goldValue"]):
    check("goldValue[%d]" % i, r6(A.gold_value(cse["score"], cse["baseline"], cse["goldPerDamage"])), cse["value"])

# ---- tierExpectedValue ----
for i, cse in enumerate(refs["tierExpectedValue"]):
    ev = A.tier_expected_value(cse["baseCost"], cse["baseline"], cse["goldPerDamage"])
    check("tierEV[%d].L" % i, r6(ev["legendary"]), cse["ev"]["legendary"])
    check("tierEV[%d].R" % i, r6(ev["relic"]), cse["ev"]["relic"])
    check("tierEV[%d].A" % i, r6(ev["ancient"]), cse["ev"]["ancient"])

# ---- summary ----
print("=== verify.py (JS<->Python parity) ===")
print("PASS: %d   FAIL: %d" % (_pass, _fail))
if _fail > 0:
    print("\nFailures:")
    for fl in _failures[:40]:
        print("  " + fl)
    if len(_failures) > 40:
        print("  ... and %d more" % (len(_failures) - 40))
    sys.exit(1)
print("ALL CHECKS PASSED")
