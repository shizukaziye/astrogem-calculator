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
    # marginal D of ONE more level on top of a full lvl-30 grid (the standalone yardstick):
    # (1 + other + gridAdd + gridAdd/levels) / (1 + other + gridAdd).
    base = 1 + b["other"] + b["gridAdd"]
    return 100 * math.log((base + b["gridAdd"] / b["levels"]) / base)


D_ATTACK_PER_LEVEL = _per_level_d(STAT_BASELINES["attackPower"])       # ~ 0.03239
D_ADDDMG_PER_LEVEL = _per_level_d(STAT_BASELINES["additionalDamage"])  # ~ 0.05929
D_BOSS_PER_LEVEL = _per_level_d(STAT_BASELINES["bossDamage"])          # ~ 0.08127
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


# ---- Willpower as a MULTIPLIER on damage (the grading model) ----
# Mirrors astrogem.js: M(cost) calibrated so the 3 perfect gems (wp5, order5, top-2
# effects @5) tie exactly; cost 6+ linear at the cost4->5 slope.
def _perfect_damage(base_cost):
    pool = EFFECT_POOLS[base_cost]
    v = sorted((effect_score(e, 5) for e in pool), reverse=True)
    return v[0] + v[1] + order_score(5)


def _build_wp_mult():
    m = {3: _perfect_damage(10) / _perfect_damage(8),
         4: _perfect_damage(10) / _perfect_damage(9),
         5: 1.0}
    slope = m[4] - m[5]
    for c in range(6, 10):
        m[c] = 1 - slope * (c - 5)
    return m


_WP_MULT = _build_wp_mult()


def willpower_multiplier(cost):
    if cost <= 3:
        return _WP_MULT[3]
    if cost >= 9:
        return _WP_MULT[9]
    if cost in _WP_MULT:
        return _WP_MULT[cost]
    lo = int(math.floor(cost))
    return _WP_MULT[lo] + (_WP_MULT[lo + 1] - _WP_MULT[lo]) * (cost - lo)


def gem_damage(config):
    # Damage only (effects + order), NO willpower.
    return (effect_score(config["effect1"], config["effect1Level"])
            + effect_score(config["effect2"], config["effect2Level"])
            + order_score(config["orderLevel"]))


def gem_value(config):
    # Grading value = damage x willpower multiplier.
    return gem_damage(config) * willpower_multiplier(
        willpower_cost(config["baseCost"], config["willpowerLevel"]))


def score(config):
    wpc = willpower_cost(config["baseCost"], config["willpowerLevel"])
    return (
        willpower_score(wpc)
        + effect_score(config["effect1"], config["effect1Level"])
        + effect_score(config["effect2"], config["effect2Level"])
        + order_score(config["orderLevel"])
    )


def damage_percent(config):
    """Actual % damage (no willpower): (e^(gem_damage/100) - 1) * 100."""
    return (math.exp(gem_damage(config) / 100.0) - 1) * 100


# -------------------- 0-100 grade + letter rank --------------------
# grade: 0 = worst gem of its TYPE, 100 = the perfect gem of its type (so a perfect
# cost-3/4/5 each read 100). Per-baseCost min-max, cached; "all" kept for legacy global.
_GRADE_BOUNDS = None


def grade_bounds():
    global _GRADE_BOUNDS
    if _GRADE_BOUNDS is not None:
        return _GRADE_BOUNDS
    per = {}
    all_lo, all_hi = float("inf"), float("-inf")
    for cost in (8, 9, 10):
        pool = EFFECT_POOLS[cost]
        lo, hi = float("inf"), float("-inf")
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
        per[cost] = {"min": lo, "max": hi}
        if lo < all_lo:
            all_lo = lo
        if hi > all_hi:
            all_hi = hi
    per["all"] = {"min": all_lo, "max": all_hi}
    _GRADE_BOUNDS = per
    return _GRADE_BOUNDS


_VALUE_BOUNDS = None


def value_bounds():
    global _VALUE_BOUNDS
    if _VALUE_BOUNDS is not None:
        return _VALUE_BOUNDS
    lo, hi = float("inf"), float("-inf")
    for cost in (8, 9, 10):
        pool = EFFECT_POOLS[cost]
        for i in range(len(pool)):
            for j in range(i + 1, len(pool)):
                for wp in range(1, 6):
                    for o in range(1, 6):
                        for a in range(1, 6):
                            for b in range(1, 6):
                                v = gem_value({
                                    "baseCost": cost, "willpowerLevel": wp, "orderLevel": o,
                                    "effect1": pool[i], "effect1Level": a,
                                    "effect2": pool[j], "effect2Level": b,
                                })
                                if v < lo:
                                    lo = v
                                if v > hi:
                                    hi = v
    _VALUE_BOUNDS = {"min": lo, "max": hi}
    return _VALUE_BOUNDS


def grade(config):
    # GLOBAL value-normalization: every perfect gem ties at 100.
    b = value_bounds()
    g = 100 * (gem_value(config) - b["min"]) / (b["max"] - b["min"])
    return round(max(0.0, min(100.0, g)) * 10) / 10


def grade_to_score(g, base_cost=None):
    # Inverts the global value-grade -> the gemValue threshold (base_cost kept for sig).
    b = value_bounds()
    return b["min"] + (max(0.0, min(100.0, g)) / 100) * (b["max"] - b["min"])


# user-set rank cutoffs on the 0-100 grade; +/ /- thirds within each band.
RANK_CUTS = [("S", 85), ("A", 70), ("B", 55), ("C", 40), ("D", 20), ("F", 0)]


def rank_from_grade(g):
    for i, (letter, lo) in enumerate(RANK_CUTS):
        if g >= lo:
            hi = 100 if i == 0 else RANK_CUTS[i - 1][1]
            t = (g - lo) / (hi - lo) if hi > lo else 0
            return letter + ("+" if t >= 2 / 3 else ("-" if t < 1 / 3 else ""))
    return "F-"


def gem_rank(config):
    return rank_from_grade(grade(config))


# ==================== SUPPORT SCORING AXIS ====================
# Parallel score for SUPPORT gems, mirroring astrogem.js's SUPPORT axis exactly.
# The DPS scoring above is UNCHANGED; these are purely additive. PER-DPS party-buff
# scale: the earlier x3 (3 DPS in the party) double-counts under the multiplicative
# model, so every damage coefficient is its base party-buff value / 3. Willpower is a
# per-DPS efficiency ratio (not a party buff), so it is NOT divided.
#   Effect per-level: Ally Attack Enh. 0.0596/3, Brand Power 0.0434/3, Ally Damage
#     Enh. 0.0195/3; DPS effects (Attack Power / Additional Damage / Boss Damage) -> 0.
#   Order: 0.0747/3 = 0.0249 per orderLevel point.
#   Willpower: exactly (2/3) x the DPS willpower contribution (same willpower_score
#     mechanic, same willpowerCost = baseCost - wpLevel, same 4.25 neutral; not / 3).
SUPPORT_SCORING = {
    "orderPerPoint": 0.0747 / 3,
    "willpowerFactor": 2 / 3,
    "allyAttackEnh": 0.0596 / 3,
    "brandPower": 0.0434 / 3,
    "allyDamageEnh": 0.0195 / 3,
    "attackPower": 0,
    "additionalDamage": 0,
    "bossDamage": 0,
}

# A support gem buffs the whole party (3 DPS). Coefficients are PER-DPS (×3 removed so
# grades/leaderboard are correct); the party benefit is re-applied as an explicit ×3 on
# gold-per-damage at the VALUE step only, so pipeline gold sits on the original scale.
# i.e. a "1.5M gold / 1% damage" tier is computed as 4.5M for support gems.
SUPPORT_GPD_MULTIPLIER = 3


def support_willpower_score(wp_cost):
    # (2/3) x the DPS willpower_score (same willpowerCost, same 4.25 neutral).
    return SUPPORT_SCORING["willpowerFactor"] * willpower_score(wp_cost)


def support_effect_score(effect_type, level):
    if effect_type == "Ally Attack Enh.":
        return level * SUPPORT_SCORING["allyAttackEnh"]
    if effect_type == "Brand Power":
        return level * SUPPORT_SCORING["brandPower"]
    if effect_type == "Ally Damage Enh.":
        return level * SUPPORT_SCORING["allyDamageEnh"]
    return 0.0


def support_order_score(order_level):
    # Flat per point (parallel to order_score).
    return order_level * SUPPORT_SCORING["orderPerPoint"]


def support_score(config):
    wpc = willpower_cost(config["baseCost"], config["willpowerLevel"])
    return (
        support_willpower_score(wpc)
        + support_effect_score(config["effect1"], config["effect1Level"])
        + support_effect_score(config["effect2"], config["effect2Level"])
        + support_order_score(config["orderLevel"])
    )


def support_baseline(base_cost):
    # Neutral gem: willpower cost 4.25, order 4.25, dead/DPS effects. One fixed
    # neutral for every base cost (mirrors cp_baseline / cpBaseline).
    return support_willpower_score(4.25) + support_order_score(4.25)


def support_rel_value(config):
    # Support value above the neutral baseline (parallel to relDamage).
    return support_score(config) - support_baseline(config["baseCost"])


# ---- SUPPORT multiplicative grading (parallel to the DPS gem_value model) ----
SUPPORT_ORDER_PER_CORE = {
    10001: 0.0694 / 3,  # Order Sun   (Ally Attack)
    10002: 0.0640 / 3,  # Order Moon  (Ally Damage)
    10003: 0.0486 / 3,  # Order Star  (serenade)
    10004: 0.0753 / 3,  # Chaos Sun   (Ally Damage)
    10005: 0.1044 / 3,  # Chaos Moon  (Brand - strongest)
    10006: 0.0869 / 3,  # Chaos Star  (Weapon Power)
}


def support_order_value_for_core(core_base):
    v = SUPPORT_ORDER_PER_CORE.get(core_base)
    return SUPPORT_SCORING["orderPerPoint"] if v is None else v


def support_damage(config, order_val=None):
    ov = SUPPORT_SCORING["orderPerPoint"] if order_val is None else order_val
    return (support_effect_score(config["effect1"], config["effect1Level"])
            + support_effect_score(config["effect2"], config["effect2Level"])
            + config["orderLevel"] * ov)


def _sup_perfect_damage(base_cost):
    pool = EFFECT_POOLS[base_cost]
    v = sorted((support_effect_score(e, 5) for e in pool), reverse=True)
    return v[0] + v[1] + 5 * SUPPORT_SCORING["orderPerPoint"]


def _build_sup_wp_mult():
    m = {3: _sup_perfect_damage(10) / _sup_perfect_damage(8),
         4: _sup_perfect_damage(10) / _sup_perfect_damage(9),
         5: 1.0}
    slope = m[4] - m[5]
    for c in range(6, 10):
        m[c] = 1 - slope * (c - 5)
    return m


_SUP_WP_MULT = _build_sup_wp_mult()


def support_willpower_multiplier(cost):
    if cost <= 3:
        return _SUP_WP_MULT[3]
    if cost >= 9:
        return _SUP_WP_MULT[9]
    if cost in _SUP_WP_MULT:
        return _SUP_WP_MULT[cost]
    lo = int(math.floor(cost))
    return _SUP_WP_MULT[lo] + (_SUP_WP_MULT[lo + 1] - _SUP_WP_MULT[lo]) * (cost - lo)


def support_value(config):
    return support_damage(config) * support_willpower_multiplier(
        willpower_cost(config["baseCost"], config["willpowerLevel"]))


_SUPPORT_VALUE_BOUNDS = None


def support_value_bounds():
    global _SUPPORT_VALUE_BOUNDS
    if _SUPPORT_VALUE_BOUNDS is not None:
        return _SUPPORT_VALUE_BOUNDS
    lo, hi = float("inf"), float("-inf")
    for cost in (8, 9, 10):
        pool = EFFECT_POOLS[cost]
        for i in range(len(pool)):
            for j in range(i + 1, len(pool)):
                for wp in range(1, 6):
                    for o in range(1, 6):
                        for a in range(1, 6):
                            for b in range(1, 6):
                                v = support_value({
                                    "baseCost": cost, "willpowerLevel": wp, "orderLevel": o,
                                    "effect1": pool[i], "effect1Level": a,
                                    "effect2": pool[j], "effect2Level": b,
                                })
                                if v < lo:
                                    lo = v
                                if v > hi:
                                    hi = v
    _SUPPORT_VALUE_BOUNDS = {"min": lo, "max": hi}
    return _SUPPORT_VALUE_BOUNDS


_SUPPORT_GRADE_BOUNDS = None


def support_grade_bounds():
    # Min-max over SUPPORT gems only. max = perfect support gem (10-cost Ally Attack
    # Enh Lv5 + Brand Power Lv5, order 5, willpower 5 ~ 0.836). Mirrors grade_bounds.
    global _SUPPORT_GRADE_BOUNDS
    if _SUPPORT_GRADE_BOUNDS is not None:
        return _SUPPORT_GRADE_BOUNDS
    lo, hi = float("inf"), float("-inf")
    for cost in (8, 9, 10):
        pool = EFFECT_POOLS[cost]
        for i in range(len(pool)):
            for j in range(i + 1, len(pool)):
                for wp in range(1, 6):
                    for o in range(1, 6):
                        for a in range(1, 6):
                            for b in range(1, 6):
                                s = support_score({
                                    "baseCost": cost, "willpowerLevel": wp, "orderLevel": o,
                                    "effect1": pool[i], "effect1Level": a,
                                    "effect2": pool[j], "effect2Level": b,
                                })
                                if s < lo:
                                    lo = s
                                if s > hi:
                                    hi = s
    _SUPPORT_GRADE_BOUNDS = {"min": lo, "max": hi}
    return _SUPPORT_GRADE_BOUNDS


def support_grade(config):
    # GLOBAL value-normalization over support_value (perfect support gems read 100).
    b = support_value_bounds()
    g = 100 * (support_value(config) - b["min"]) / (b["max"] - b["min"])
    return round(max(0.0, min(100.0, g)) * 10) / 10


def support_rank(config):
    # Reuses the SAME RANK_CUTS as DPS.
    return rank_from_grade(support_grade(config))


def support_grade_to_score(g):
    # Value-based inverse, parallel to grade_to_score (support_value distribution).
    b = support_value_bounds()
    return b["min"] + (max(0.0, min(100.0, g)) / 100) * (b["max"] - b["min"])


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


def score_distribution_for_tier(base_cost, tier, axis="dps"):
    # axis="support" builds the distribution with the SUPPORT scoring functions
    # (mirrors astrogem.js scoreDistributionForTier). Cache key includes the axis.
    support = (axis == "support")
    ck = (base_cost, tier, "support" if support else "dps")
    if ck in _SCORE_DIST_CACHE:
        return _SCORE_DIST_CACHE[ck]

    es_fn = support_effect_score if support else effect_score
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
            # NEW multiplicative model: value = (order damage + effects) x M(cost).
            cost = willpower_cost(base_cost, wp)
            ord_d = support_order_score(ordv) if support else order_score(ordv)
            mw = support_willpower_multiplier(cost) if support else willpower_multiplier(cost)
            for (e_a, e_b) in pairs:
                sc1 = (ord_d + es_fn(e_a, lv_a) + es_fn(e_b, lv_b)) * mw
                sc2 = (ord_d + es_fn(e_a, lv_b) + es_fn(e_b, lv_a)) * mw
                w = p_sum * part_w * pair_w * 0.5
                k1 = _round_key(sc1)
                k2 = _round_key(sc2)
                dist[k1] = dist.get(k1, 0.0) + w
                dist[k2] = dist.get(k2, 0.0) + w

    _SCORE_DIST_CACHE[ck] = dist
    return dist


# -------------------- tier expected value (JOINT fixed point across costs) --------------------
# Mirrors astrogem.js _solveJointEV / tier_expected_value / fusion_value_for_tier
# EXACTLY: same cost order, same operation order, same 1e-9 convergence test, so the
# iteration converges bit-identically (IEEE-754 doubles + identical ops).
#
# The three base costs are COUPLED: a below-baseline gem is fodder, and the
# relic/ancient fusions keep two FREE surplus legendaries that can be steered to
# whichever cost has the most valuable output (max over c). So we solve one JOINT
# 9-variable system (3 grades x 3 costs) by iteration. See astrogem.js for the
# full derivation of the fodder formulas.

JOINT_COSTS = [8, 9, 10]
_JOINT_EV_CACHE = {}


def _solve_joint_ev(baseline, gold_per_damage, axis="dps"):
    """Solve the joint system once for (baseline, gold_per_damage, axis).

    axis="support" uses the SUPPORT score distribution (mirrors astrogem.js
    _solveJointEV); gold_value is unchanged (just (score-baseline)*gpd). Cache key
    includes the axis.

    Returns {"E": {8:{legendary,relic,ancient}, 9:{...}, 10:{...}},
             "maxG": ..., "maxH": ..., "iters": ...}.
    """
    key = (baseline, gold_per_damage, "support" if axis == "support" else "dps")
    if key in _JOINT_EV_CACHE:
        return _JOINT_EV_CACHE[key]
    if axis == "support":  # 3-DPS party benefit at the gold step (coefficients are per-DPS)
        gold_per_damage *= SUPPORT_GPD_MULTIPLIER

    tiers = ["legendary", "relic", "ancient"]
    fc = COSTS["fusion"]

    direct_exp = {}
    p_below = {}
    e = {}
    for c in JOINT_COSTS:
        direct_exp[c] = {}
        p_below[c] = {}
        e[c] = {}
        for tier in tiers:
            dist = score_distribution_for_tier(c, tier, axis)
            d_exp = 0.0
            below = 0.0
            for sc, p in dist.items():
                if sc >= baseline:
                    d_exp += p * gold_value(sc, baseline, gold_per_damage)
                else:
                    below += p
            direct_exp[c][tier] = d_exp
            p_below[c][tier] = below
            e[c][tier] = d_exp  # init E = directExp

    max_g = 0.0
    max_h = 0.0
    iters = 0
    MAX_ITERS = 10000
    while iters < MAX_ITERS:
        g = {}
        h = {}
        max_g = float("-inf")
        max_h = float("-inf")
        for c in JOINT_COSTS:
            g_c = 0.73 * e[c]["legendary"] + 0.25 * e[c]["relic"] + 0.02 * e[c]["ancient"]
            h_c = 0.35 * e[c]["legendary"] + 0.40 * e[c]["relic"] + 0.25 * e[c]["ancient"]
            g[c] = g_c
            h[c] = h_c
            if g_c > max_g:
                max_g = g_c
            if h_c > max_h:
                max_h = h_c
        max_delta = 0.0
        for c in JOINT_COSTS:
            fodder_l = (0.99 * e[c]["legendary"] + 0.01 * e[c]["relic"] - fc) / 3
            fodder_r = (1 / 3) * g[c] + (2 / 3) * max_g - fc
            fodder_a = (1 / 3) * h[c] + (2 / 3) * max_h - fc
            new_l = direct_exp[c]["legendary"] + p_below[c]["legendary"] * max(0, fodder_l)
            new_r = direct_exp[c]["relic"] + p_below[c]["relic"] * max(0, fodder_r)
            new_a = direct_exp[c]["ancient"] + p_below[c]["ancient"] * max(0, fodder_a)
            d_l = abs(new_l - e[c]["legendary"])
            d_r = abs(new_r - e[c]["relic"])
            d_a = abs(new_a - e[c]["ancient"])
            if d_l > max_delta:
                max_delta = d_l
            if d_r > max_delta:
                max_delta = d_r
            if d_a > max_delta:
                max_delta = d_a
            e[c]["legendary"] = new_l
            e[c]["relic"] = new_r
            e[c]["ancient"] = new_a
        iters += 1
        if max_delta < 1e-9:
            break

    # Recompute maxG / maxH from the CONVERGED E so callers see the final values.
    max_g = float("-inf")
    max_h = float("-inf")
    for c in JOINT_COSTS:
        g_f = 0.73 * e[c]["legendary"] + 0.25 * e[c]["relic"] + 0.02 * e[c]["ancient"]
        h_f = 0.35 * e[c]["legendary"] + 0.40 * e[c]["relic"] + 0.25 * e[c]["ancient"]
        if g_f > max_g:
            max_g = g_f
        if h_f > max_h:
            max_h = h_f

    result = {"E": e, "maxG": max_g, "maxH": max_h, "iters": iters}
    _JOINT_EV_CACHE[key] = result
    return result


_TIER_EV_CACHE = {}


def tier_expected_value(base_cost, baseline, gold_per_damage, axis="dps"):
    key = (base_cost, baseline, gold_per_damage, "support" if axis == "support" else "dps")
    if key in _TIER_EV_CACHE:
        return _TIER_EV_CACHE[key]
    joint = _solve_joint_ev(baseline, gold_per_damage, axis)
    e_c = joint["E"][base_cost]
    result = {
        "legendary": max(0.0, e_c["legendary"]),
        "relic": max(0.0, e_c["relic"]),
        "ancient": max(0.0, e_c["ancient"]),
    }
    _TIER_EV_CACHE[key] = result
    return result


def fusion_value_for_tier(input_tier, base_cost, baseline, gold_per_damage, axis="dps"):
    joint = _solve_joint_ev(baseline, gold_per_damage, axis)
    e_c = joint["E"][base_cost]
    fc = COSTS["fusion"]
    if input_tier == "legendary":
        v = (0.99 * e_c["legendary"] + 0.01 * e_c["relic"] - fc) / 3
    elif input_tier == "relic":
        g_c = 0.73 * e_c["legendary"] + 0.25 * e_c["relic"] + 0.02 * e_c["ancient"]
        v = (1 / 3) * g_c + (2 / 3) * joint["maxG"] - fc
    else:  # ancient
        h_c = 0.35 * e_c["legendary"] + 0.40 * e_c["relic"] + 0.25 * e_c["ancient"]
        v = (1 / 3) * h_c + (2 / 3) * joint["maxH"] - fc
    return max(0.0, v)


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
