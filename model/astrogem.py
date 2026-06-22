"""astrogem.py - Python mirror of the DETERMINISTIC layer of model/astrogem.js.

Kept in lockstep with the JS core via the captured-reference battery (refs.json):
verify.py recomputes every reference entry with these functions and asserts
equality to the JS-produced values (abs tol 1e-6 for floats, exact for tiers/
dists). This module mirrors scoring, willpowerCost, classifyTier, fusionOutputDist,
outputLevelSumDist, goldValue, tierExpectedValue, and outcomeProbabilities. It does
NOT mirror the Monte Carlo simulation in nested.js.

Stdlib only. Compatible with Python 3.6+ (no match statement, no PEP 604 unions).

SCORING IS REAL % DAMAGE (log-space): each line is D = 100*ln(multiplier) (additive,
~percent for small values). Per-level D values are derived from real-game stat
baselines (see SCORING below). This SUPERSEDES the old abstract-weight model
(WP +/-2.4 / ATK 1.0 / AddDmg 1.85 / Boss 2.55 / Order 5.14 and the removed
SCORE_PER_PERCENT_DAMAGE = 30.96 score->gold conversion). Mirrors astrogem.js exactly.
"""

import math

# ---- Scoring in REAL % DAMAGE (log-space) ----
# Damage is MULTIPLICATIVE, so each line is scored D = 100*ln(multiplier) (additive
# in log space, ~ % gain). Per-level D is computed from the gem grid's contribution
# against the OTHER (non-grid) sources of that stat:
#   per_level_D = 100 * ln((1 + other + grid_add) / (1 + other)) / levels
# Baselines (editable, documented):
#   attackPower      other 12.1%, +1.1% over 30 grid levels
#   additionalDamage other 33.6%, +2.42% over 30 levels
#   bossDamage       other 0%,    +2.5% over 30 levels
#   order            flat x1.0016 per point (orderScore = orderLevel * D, NOT vs lvl 4)
#   willpower        2.4 * attack-per-level (old willpower:attack ratio), per cost-level
# Numeric values (~): atk 0.032549, addDmg 0.059839, boss 0.082309, order 0.159872,
# willpower 0.078119 per cost-level from 4.

STAT_BASELINES = {
    "attackPower":      {"other": 0.121,  "gridAdd": 0.011,  "levels": 30},
    "additionalDamage": {"other": 0.336,  "gridAdd": 0.0242, "levels": 30},
    "bossDamage":       {"other": 0.0,    "gridAdd": 0.025,  "levels": 30},
    "order":            {"perPoint": 0.0016},
}


def _per_level_d(b):
    return 100 * math.log((1 + b["other"] + b["gridAdd"]) / (1 + b["other"])) / b["levels"]


D_ATTACK_PER_LEVEL = _per_level_d(STAT_BASELINES["attackPower"])       # ~ 0.032549
D_ADDDMG_PER_LEVEL = _per_level_d(STAT_BASELINES["additionalDamage"])  # ~ 0.059839
D_BOSS_PER_LEVEL = _per_level_d(STAT_BASELINES["bossDamage"])          # ~ 0.082309
D_ORDER_PER_POINT = 100 * math.log(1 + STAT_BASELINES["order"]["perPoint"])  # ~ 0.159872
WILLPOWER_OVER_ATTACK_RATIO = 2.4
D_WILLPOWER_PER_COSTLEVEL = WILLPOWER_OVER_ATTACK_RATIO * D_ATTACK_PER_LEVEL  # ~ 0.078119

SCORING = {
    # All values are D = 100*ln(multiplier) ~ % damage (ADDITIVE in log space).
    "willpowerPerLevel": D_WILLPOWER_PER_COSTLEVEL,
    "attackPower": D_ATTACK_PER_LEVEL,
    "additionalDamage": D_ADDDMG_PER_LEVEL,
    "bossDamage": D_BOSS_PER_LEVEL,
    "orderPerPoint": D_ORDER_PER_POINT,  # orderLevel * D (flat per point, NOT vs level 4)
    "brandPower": 0,
    "allyDamageEnh": 0,
    "allyAttackEnh": 0,
    "baselines": STAT_BASELINES,
}

COSTS = {
    "processBase": 900,
    "finalReroll": 3800,
    "fusion": 500,
}

RARITY = {
    "uncommon": {"maxTurns": 5, "maxRerolls": 1},
    "rare": {"maxTurns": 7, "maxRerolls": 2},
    "epic": {"maxTurns": 9, "maxRerolls": 3},
}

EFFECT_POOLS = {
    8: ["Additional Damage", "Attack Power", "Brand Power", "Ally Damage Enh."],
    9: ["Boss Damage", "Attack Power", "Ally Damage Enh.", "Ally Attack Enh."],
    10: ["Boss Damage", "Additional Damage", "Brand Power", "Ally Attack Enh."],
}

TIER_BOUNDS = {
    "legendary": {"min": 4, "max": 15},
    "relic": {"min": 16, "max": 18},
    "ancient": {"min": 19, "max": 20},
}

# Base per-outcome probabilities (percent) + exclusion condition.
# Each entry: (type, change, base, exclude_fn(state_dict) -> bool).
# state_dict keys: willpower, order, effect1, effect2, costMult, turnsRemaining.
OUTCOME_RATES = [
    ("willpower", 1, 11.65, lambda s: s["willpower"] >= 5),
    ("willpower", 2, 4.40, lambda s: s["willpower"] >= 4),
    ("willpower", 3, 1.75, lambda s: s["willpower"] >= 3),
    ("willpower", 4, 0.45, lambda s: s["willpower"] >= 2),
    ("willpower", -1, 3.00, lambda s: s["willpower"] <= 1),
    ("order", 1, 11.65, lambda s: s["order"] >= 5),
    ("order", 2, 4.40, lambda s: s["order"] >= 4),
    ("order", 3, 1.75, lambda s: s["order"] >= 3),
    ("order", 4, 0.45, lambda s: s["order"] >= 2),
    ("order", -1, 3.00, lambda s: s["order"] <= 1),
    ("effect1", 1, 11.65, lambda s: s["effect1"] >= 5),
    ("effect1", 2, 4.40, lambda s: s["effect1"] >= 4),
    ("effect1", 3, 1.75, lambda s: s["effect1"] >= 3),
    ("effect1", 4, 0.45, lambda s: s["effect1"] >= 2),
    ("effect1", -1, 3.00, lambda s: s["effect1"] <= 1),
    ("effect2", 1, 11.65, lambda s: s["effect2"] >= 5),
    ("effect2", 2, 4.40, lambda s: s["effect2"] >= 4),
    ("effect2", 3, 1.75, lambda s: s["effect2"] >= 3),
    ("effect2", 4, 0.45, lambda s: s["effect2"] >= 2),
    ("effect2", -1, 3.00, lambda s: s["effect2"] <= 1),
    ("change_effect1", 0, 3.25, lambda s: False),
    ("change_effect2", 0, 3.25, lambda s: False),
    ("cost", 100, 1.75, lambda s: s["costMult"] >= 100 or s["turnsRemaining"] <= 1),
    ("cost", -100, 1.75, lambda s: s["costMult"] <= -100 or s["turnsRemaining"] <= 1),
    ("do_nothing", 0, 1.75, lambda s: False),
    ("reroll", 1, 2.50, lambda s: s["turnsRemaining"] <= 1),
    ("reroll", 2, 0.75, lambda s: s["turnsRemaining"] <= 1),
]


# -------------------- scoring --------------------

def willpower_cost(base_cost, wp_level):
    return base_cost - wp_level


def willpower_score(wp_cost):
    if wp_cost < 4:
        return (4 - wp_cost) * SCORING["willpowerPerLevel"]
    if wp_cost > 4:
        return (wp_cost - 4) * (-SCORING["willpowerPerLevel"])
    return 0.0


def effect_score(effect_type, level):
    if effect_type == "Attack Power":
        return level * SCORING["attackPower"]
    if effect_type == "Additional Damage":
        return level * SCORING["additionalDamage"]
    if effect_type == "Boss Damage":
        return level * SCORING["bossDamage"]
    return 0.0


def order_score(order_level):
    # Flat per point (NOT relative to level 4).
    return order_level * SCORING["orderPerPoint"]


def score(config):
    wpc = willpower_cost(config["baseCost"], config["willpowerLevel"])
    return (
        willpower_score(wpc)
        + effect_score(config["effect1"], config["effect1Level"])
        + effect_score(config["effect2"], config["effect2Level"])
        + order_score(config["orderLevel"])
    )


def damage_percent(config):
    """Exact multiplicative % damage of the gem: (e^(D/100) - 1) * 100, D = score."""
    return (math.exp(score(config) / 100.0) - 1) * 100


# -------------------- 0-100 grade + letter rank --------------------
# grade: 0 = worst possible gem (incl. willpower penalty), 100 = best (perfect
# 10-cost). Min-max over every gem (enumerated once + cached).
_GRADE_BOUNDS = None


def grade_bounds():
    global _GRADE_BOUNDS
    if _GRADE_BOUNDS is not None:
        return _GRADE_BOUNDS
    lo, hi = float("inf"), float("-inf")
    for cost in (8, 9, 10):
        pool = EFFECT_POOLS[cost]
        for i in range(len(pool)):
            for j in range(i + 1, len(pool)):
                for wp in range(1, 6):
                    for o in range(1, 6):
                        for a in range(1, 6):
                            for b in range(1, 6):
                                s = score({
                                    "baseCost": cost, "willpowerLevel": wp, "orderLevel": o,
                                    "effect1": pool[i], "effect1Level": a,
                                    "effect2": pool[j], "effect2Level": b,
                                })
                                if s < lo:
                                    lo = s
                                if s > hi:
                                    hi = s
    _GRADE_BOUNDS = {"min": lo, "max": hi}
    return _GRADE_BOUNDS


def grade(config):
    b = grade_bounds()
    g = 100 * (score(config) - b["min"]) / (b["max"] - b["min"])
    return round(max(0.0, min(100.0, g)) * 10) / 10


def grade_to_score(g):
    b = grade_bounds()
    return b["min"] + (max(0.0, min(100.0, g)) / 100) * (b["max"] - b["min"])


# user-set rank cutoffs on the 0-100 grade; +/ /- thirds within each band.
RANK_CUTS = [("S", 85), ("A", 75), ("B", 65), ("C", 50), ("D", 25), ("F", 0)]


def rank_from_grade(g):
    for i, (letter, lo) in enumerate(RANK_CUTS):
        if g >= lo:
            hi = 100 if i == 0 else RANK_CUTS[i - 1][1]
            t = (g - lo) / (hi - lo) if hi > lo else 0
            return letter + ("+" if t >= 2 / 3 else ("-" if t < 1 / 3 else ""))
    return "F-"


def gem_rank(config):
    return rank_from_grade(grade(config))


def score_breakdown(config):
    wpc = willpower_cost(config["baseCost"], config["willpowerLevel"])
    wp_s = willpower_score(wpc)
    e1_s = effect_score(config["effect1"], config["effect1Level"])
    e2_s = effect_score(config["effect2"], config["effect2Level"])
    ord_s = order_score(config["orderLevel"])
    return {
        "willpowerCost": wpc,
        "willpowerScore": wp_s,
        "effect1Score": e1_s,
        "effect2Score": e2_s,
        "orderScore": ord_s,
        "totalScore": wp_s + e1_s + e2_s + ord_s,
    }


def available_effects(base_cost):
    return list(EFFECT_POOLS.get(base_cost, []))


def validate_config(config):
    pool = EFFECT_POOLS.get(config["baseCost"])
    if pool is None:
        return {"valid": False, "error": "Unknown base cost: %s" % config["baseCost"]}
    e1 = config["effect1"]
    e2 = config["effect2"]
    e1ok = e1 in pool or e1 == "Random"
    e2ok = e2 in pool or e2 == "Random"
    if not e1ok:
        return {"valid": False,
                "error": 'Effect 1 "%s" is not available for %s cost gems' % (e1, config["baseCost"])}
    if not e2ok:
        return {"valid": False,
                "error": 'Effect 2 "%s" is not available for %s cost gems' % (e2, config["baseCost"])}
    if e1 != "Random" and e2 != "Random" and e1 == e2:
        return {"valid": False, "error": "Effect 1 and Effect 2 must be different"}
    for lvl in (config.get("willpowerLevel"), config.get("orderLevel"),
                config.get("effect1Level"), config.get("effect2Level")):
        if lvl is not None and (lvl < 1 or lvl > 5):
            return {"valid": False, "error": "Levels must be between 1 and 5"}
    return {"valid": True}


# -------------------- tiers / level sums --------------------

def classify_tier(level_sum_value):
    if level_sum_value <= TIER_BOUNDS["legendary"]["max"]:
        return "legendary"
    if level_sum_value <= TIER_BOUNDS["relic"]["max"]:
        return "relic"
    return "ancient"


def level_sum(config):
    return (
        (config.get("willpowerLevel") or 1)
        + (config.get("orderLevel") or 1)
        + (config.get("effect1Level") or 1)
        + (config.get("effect2Level") or 1)
    )


_LEVEL_SUM_WAYS = None


def _build_level_sum_ways():
    global _LEVEL_SUM_WAYS
    if _LEVEL_SUM_WAYS is not None:
        return _LEVEL_SUM_WAYS
    c = {}
    for s in range(4, 21):
        c[s] = 0
    for a in range(1, 6):
        for b in range(1, 6):
            for d in range(1, 6):
                for e in range(1, 6):
                    c[a + b + d + e] += 1
    _LEVEL_SUM_WAYS = c
    return c


def level_sum_ways(s):
    return _build_level_sum_ways().get(s, 0)


def output_level_sum_dist(tier):
    bounds = TIER_BOUNDS.get(tier)
    if bounds is None:
        return {}
    ways = _build_level_sum_ways()
    total = 0
    for s in range(bounds["min"], bounds["max"] + 1):
        total += ways[s]
    out = {}
    for s in range(bounds["min"], bounds["max"] + 1):
        out[s] = ways[s] / total
    return out


def _partitions_of_sum(s):
    res = []
    for wp in range(1, 6):
        for ordv in range(1, 6):
            for e1 in range(1, 6):
                e2 = s - wp - ordv - e1
                if 1 <= e2 <= 5:
                    res.append((wp, ordv, e1, e2))
    return res


# -------------------- fusion output tier distribution --------------------

def fusion_output_dist(input_tiers):
    n_l = n_r = n_a = 0
    for t in input_tiers:
        if t == "legendary":
            n_l += 1
        elif t == "relic":
            n_r += 1
        elif t == "ancient":
            n_a += 1
    if n_l == len(input_tiers) and n_r == 0 and n_a == 0:
        return {"legendary": 0.99, "relic": 0.01, "ancient": 0}
    raw_r = n_r * 25 + n_a * 40
    raw_a = n_r * 2 + n_a * 25
    a = min(100, raw_a)
    r = min(raw_r, 100 - a)
    lg = max(0, 100 - a - r)
    return {"legendary": lg / 100, "relic": r / 100, "ancient": a / 100}


# -------------------- per-turn outcome probabilities --------------------

def outcome_probabilities(state):
    cfg = state["config"]
    if state.get("turnsRemaining") is not None:
        turns_remaining = state["turnsRemaining"]
    else:
        turns_remaining = (state.get("maxTurns") or 0) - (state.get("currentTurn") or 1) + 1
    s = {
        "willpower": cfg["willpowerLevel"],
        "order": cfg["orderLevel"],
        "effect1": cfg["effect1Level"],
        "effect2": cfg["effect2Level"],
        "costMult": state.get("processCostMultiplier") or 0,
        "turnsRemaining": turns_remaining,
    }
    possibilities = []
    sum_base = 0.0
    for (typ, change, base, exclude_fn) in OUTCOME_RATES:
        if exclude_fn(s):
            continue
        possibilities.append({"type": typ, "change": change, "base": base})
        sum_base += base
    by_type = {}
    for p in possibilities:
        p["prob"] = (p["base"] / sum_base) if sum_base > 0 else 0
        by_type["%s_%s" % (p["type"], p["change"])] = p["prob"]
    return {
        "possibilities": possibilities,
        "byType": by_type,
        "totalBase": sum_base,
        "turnsRemaining": turns_remaining,
    }


# -------------------- gold value --------------------

def gold_value(score_val, baseline, gold_per_damage):
    # score IS % damage: gold_per_damage = gold per 1% damage, baseline = %-damage
    # threshold. No score->damage conversion.
    return max(0.0, (score_val - baseline) * gold_per_damage)


# -------------------- closed-form tier score distribution --------------------

_SCORE_DIST_CACHE = {}


def _round_key(x):
    return round(x * 1e6) / 1e6


def score_distribution_for_tier(base_cost, tier):
    ck = (base_cost, tier)
    if ck in _SCORE_DIST_CACHE:
        return _SCORE_DIST_CACHE[ck]

    pool = EFFECT_POOLS[base_cost]
    sum_dist = output_level_sum_dist(tier)
    dist = {}

    pairs = []
    for a in range(len(pool)):
        for b in range(a + 1, len(pool)):
            pairs.append((pool[a], pool[b]))
    pair_w = 1.0 / len(pairs)

    for s, p_sum in sum_dist.items():
        parts = _partitions_of_sum(s)
        part_w = 1.0 / len(parts)
        for (wp, ordv, lv_a, lv_b) in parts:
            base_score = willpower_score(willpower_cost(base_cost, wp)) + order_score(ordv)
            for (e_a, e_b) in pairs:
                sc1 = base_score + effect_score(e_a, lv_a) + effect_score(e_b, lv_b)
                sc2 = base_score + effect_score(e_a, lv_b) + effect_score(e_b, lv_a)
                w = p_sum * part_w * pair_w * 0.5
                k1 = _round_key(sc1)
                k2 = _round_key(sc2)
                dist[k1] = dist.get(k1, 0.0) + w
                dist[k2] = dist.get(k2, 0.0) + w

    _SCORE_DIST_CACHE[ck] = dist
    return dist


# -------------------- tier expected value (joint fixed point) --------------------

_TIER_EV_CACHE = {}


def tier_expected_value(base_cost, baseline, gold_per_damage):
    key = (base_cost, baseline, gold_per_damage)
    if key in _TIER_EV_CACHE:
        return _TIER_EV_CACHE[key]

    tiers = ["legendary", "relic", "ancient"]
    direct_exp = {}
    p_below = {}
    for tier in tiers:
        dist = score_distribution_for_tier(base_cost, tier)
        d_exp = 0.0
        below = 0.0
        for sc, p in dist.items():
            if sc >= baseline:
                d_exp += p * gold_value(sc, baseline, gold_per_damage)
            else:
                below += p
        direct_exp[tier] = d_exp
        p_below[tier] = below

    mix_l = fusion_output_dist(["legendary", "legendary", "legendary"])
    mix_r = fusion_output_dist(["relic", "relic", "relic"])
    mix_a = fusion_output_dist(["ancient", "ancient", "ancient"])
    mix = {
        "legendary": [mix_l["legendary"], mix_l["relic"], mix_l["ancient"]],
        "relic": [mix_r["legendary"], mix_r["relic"], mix_r["ancient"]],
        "ancient": [mix_a["legendary"], mix_a["relic"], mix_a["ancient"]],
    }
    fc = COSTS["fusion"] / 3.0

    a_mat = []
    rhs = []
    for i in range(3):
        tier_i = tiers[i]
        k = p_below[tier_i] / 3.0
        row = []
        for j in range(3):
            row.append((1 if i == j else 0) - k * mix[tier_i][j])
        a_mat.append(row)
        rhs.append(direct_exp[tier_i] - p_below[tier_i] * fc)

    e = _solve3x3(a_mat, rhs)
    result = {
        "legendary": max(0.0, e[0]),
        "relic": max(0.0, e[1]),
        "ancient": max(0.0, e[2]),
    }
    _TIER_EV_CACHE[key] = result
    return result


def fusion_value_for_tier(input_tier, base_cost, baseline, gold_per_damage):
    e = tier_expected_value(base_cost, baseline, gold_per_damage)
    e_arr = [e["legendary"], e["relic"], e["ancient"]]
    mix = fusion_output_dist([input_tier, input_tier, input_tier])
    out_val = mix["legendary"] * e_arr[0] + mix["relic"] * e_arr[1] + mix["ancient"] * e_arr[2]
    return max(0.0, (out_val - COSTS["fusion"]) / 3.0)


def _solve3x3(a, b):
    m = [
        [a[0][0], a[0][1], a[0][2], b[0]],
        [a[1][0], a[1][1], a[1][2], b[1]],
        [a[2][0], a[2][1], a[2][2], b[2]],
    ]
    for col in range(3):
        pivot = col
        for row in range(col + 1, 3):
            if abs(m[row][col]) > abs(m[pivot][col]):
                pivot = row
        m[col], m[pivot] = m[pivot], m[col]
        d = m[col][col]
        if abs(d) < 1e-12:
            return [0.0, 0.0, 0.0]
        for j in range(4):
            m[col][j] /= d
        for r2 in range(3):
            if r2 == col:
                continue
            f = m[r2][col]
            for j2 in range(4):
                m[r2][j2] -= f * m[col][j2]
    return [m[0][3], m[1][3], m[2][3]]
