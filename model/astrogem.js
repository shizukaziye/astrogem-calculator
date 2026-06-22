/**
 * astrogem.js — PURE deterministic core for the Lost Ark astrogem-cutting model.
 *
 * No DOM, no I/O, no dependencies. Works both as a browser <script> (attaches its
 * exports to globalThis) and as a Node `require()` (CommonJS module.exports).
 *
 * ============================ PUBLIC API ============================
 *
 * SCORING IS REAL % DAMAGE (log-space). Each gem line is scored as
 *   D = 100 · ln(multiplier)        (≈ % damage gain, and ADDITIVE in log space)
 * so score(config) returns the gem's approximate % damage and the per-line
 * contributions sum. The per-level D constants are derived from real-game stat
 * baselines (see SCORING below). This SUPERSEDES the old abstract-weight model
 * (WP ±2.4 / ATK 1.0 / AddDmg 1.85 / Boss 2.55 / Order 5.14, with the long-gone
 * SCORE_PER_PERCENT_DAMAGE = 30.96 score→gold conversion).
 *
 * Constants:
 *   SCORING                 — per-level/per-point D (% damage) values + baselines.
 *   COSTS                   — gold costs: { processBase, finalReroll, fusion }.
 *   RARITY                  — { uncommon, rare, epic } -> { maxTurns, maxRerolls }.
 *   EFFECT_POOLS            — available side effects keyed by base cost (8/9/10).
 *   TIER_BOUNDS             — level-sum bounds for legendary/relic/ancient.
 *   OUTCOME_RATES           — base per-outcome probabilities (the official table).
 *
 * Functions:
 *   willpowerCost(baseCost, wpLevel)            -> number  (baseCost - wpLevel)
 *   willpowerScore(willpowerCost)               -> number  D (±0.078119 / cost-lvl from 4)
 *   effectScore(effectType, level)              -> number  D (% damage)
 *   orderScore(orderLevel)                      -> number  D (flat 0.159872 / point)
 *   score(config)                               -> number  D ≈ % damage (sum of lines)
 *   damagePercent(config)                       -> number  exact mult % = (e^(D/100)-1)*100
 *   scoreBreakdown(config)                      -> {...}   (component breakdown, in D)
 *   availableEffects(baseCost)                  -> string[]
 *   validateConfig(config)                      -> { valid, error? }
 *   classifyTier(levelSum)                      -> 'legendary'|'relic'|'ancient'
 *   levelSum(config)                            -> number
 *   levelSumWays(s)                             -> number  (# of 4-stat 1..5 partitions)
 *   outputLevelSumDist(tier)                    -> { sum: prob, ... }  (sums to 1)
 *   fusionOutputDist(inputTiers)                -> { legendary, relic, ancient }
 *   outcomeProbabilities(state)                 -> { possibilities:[...], byType:{...} }
 *   goldValue(scoreD, baseline, goldPerDamage)  -> number  direct sale value
 *                                                  = max(0,(scoreD−baseline)·goldPerDamage)
 *                                                  goldPerDamage = gold per 1% damage,
 *                                                  baseline = a %-damage threshold.
 *   tierExpectedValue(baseCost, baseline, goldPerDamage)
 *                                               -> { legendary, relic, ancient }
 *   scoreDistributionForTier(baseCost, tier)    -> Map<scoreD, prob>  (closed form)
 *   fusionValueForTier(inputTier, baseCost, baseline, goldPerDamage) -> number
 *
 * `config` shape:
 *   { baseCost, gemType, willpowerLevel, orderLevel,
 *     effect1, effect1Level, effect2, effect2Level }
 *
 * `state` shape (for outcomeProbabilities — only the fields below are read):
 *   { config, currentTurn, maxTurns, rerollsRemaining, processCostMultiplier }
 *   (turnsRemaining is derived as maxTurns - currentTurn + 1 if not supplied)
 * ===================================================================
 */
(function (root) {
  "use strict";

  // ---- Scoring in REAL % DAMAGE (log-space) ----
  //
  // Damage in Lost Ark is MULTIPLICATIVE: each line multiplies your total. So we
  // score every line as  D = 100 · ln(multiplier)  — additive in log space and
  // ≈ the % damage gain for small values (the same convention as the accessory
  // calculator, ~/lost-ark-accessory METHODOLOGY §2).
  //
  // Each per-level D below is computed from the gem grid's contribution against
  // the OTHER (non-grid) sources of that stat you already have, using
  //   per-level D = 100 · ln((1 + bucket_with) / (1 + bucket_without)) / levels
  // with these (editable, documented) baselines:
  //
  //   * Attack Power      — other sources 12.1% (adrenaline relic book lv7 9% +
  //                         accessories 3.1%); +30 grid levels add 1.1%.
  //   * Additional Damage — other sources 33.6% (100-quality weapon 30% + high
  //                         necklace 2.6% + pet 1%); +30 levels add 2.42%.
  //   * Boss Damage       — no other sources; +30 levels add 2.5%.
  //   * Order             — flat 100·ln(1.0016) per point (NOT relative to level 4):
  //                         orderScore = orderLevel · D_ORDER_PER_POINT.
  //   * Willpower         — efficiency, scored vs cost 4 (cost = baseCost − wpLevel).
  //                         Converted from the old abstract ±2.4 by the old
  //                         willpower-to-attack ratio (2.4 / 1.0 = 2.4): one
  //                         cost-level of willpower is worth 2.4 attack-levels, so
  //                         D_WP = 2.4 · D_ATTACK_PER_LEVEL ≈ ±0.078119 per cost-level.
  //   * Brand Power / Ally Damage Enh. / Ally Attack Enh. — 0 (support, no DPS).
  //
  // The numeric values these baselines yield (≈): atk 0.032549, addDmg 0.059839,
  // boss 0.082309, order 0.159872, willpower 0.078119 (per cost-level from 4).

  // Bucket baselines (edit these to retune the assumptions).
  var STAT_BASELINES = {
    attackPower:      { other: 0.121, gridAdd: 0.011, levels: 30 },  // 12.1% other, +1.1% over 30
    additionalDamage: { other: 0.336, gridAdd: 0.0242, levels: 30 }, // 33.6% other, +2.42% over 30
    bossDamage:       { other: 0.0,   gridAdd: 0.025, levels: 30 },  // 0% other, +2.5% over 30
    order:            { perPoint: 0.0016 }                            // flat ×1.0016 per point
  };

  // Per-line D (% damage) derived from the baselines above. Computed in code so
  // the assumptions stay visible/editable; these equal the numbers in the comment.
  function _perLevelD(b) {
    return 100 * Math.log((1 + b.other + b.gridAdd) / (1 + b.other)) / b.levels;
  }
  var D_ATTACK_PER_LEVEL  = _perLevelD(STAT_BASELINES.attackPower);      // ≈ 0.032549
  var D_ADDDMG_PER_LEVEL  = _perLevelD(STAT_BASELINES.additionalDamage); // ≈ 0.059839
  var D_BOSS_PER_LEVEL    = _perLevelD(STAT_BASELINES.bossDamage);       // ≈ 0.082309
  var D_ORDER_PER_POINT   = 100 * Math.log(1 + STAT_BASELINES.order.perPoint); // ≈ 0.159872
  // Willpower keeps the old willpower:attack weight ratio (2.4 : 1.0) in D units.
  var WILLPOWER_OVER_ATTACK_RATIO = 2.4;
  var D_WILLPOWER_PER_COSTLEVEL = WILLPOWER_OVER_ATTACK_RATIO * D_ATTACK_PER_LEVEL; // ≈ 0.078119

  var SCORING = {
    // All values are D = 100·ln(multiplier) ≈ % damage (ADDITIVE in log space).
    willpowerPerLevel: D_WILLPOWER_PER_COSTLEVEL, // cost<4 => (4-cost)*D ; cost>4 => (cost-4)*(-D)
    attackPower: D_ATTACK_PER_LEVEL,
    additionalDamage: D_ADDDMG_PER_LEVEL,
    bossDamage: D_BOSS_PER_LEVEL,
    orderPerPoint: D_ORDER_PER_POINT,             // orderLevel * D (flat per point, NOT vs level 4)
    // Support / non-DPS effects contribute nothing to the damage score:
    brandPower: 0,
    allyDamageEnh: 0,
    allyAttackEnh: 0,
    // The bucket baselines that produced the per-level D values (for documentation).
    baselines: STAT_BASELINES
  };

  var COSTS = {
    processBase: 900,         // actual = 900 * (1 + mult/100), mult in [-100, +100]
    finalReroll: 3800,        // cost of the LAST reroll
    fusion: 500               // gold to fuse 3 gems
  };

  var RARITY = {
    uncommon: { maxTurns: 5, maxRerolls: 1 },
    rare:     { maxTurns: 7, maxRerolls: 2 },
    epic:     { maxTurns: 9, maxRerolls: 3 }
  };

  // Side-effect pools by base cost.
  var EFFECT_POOLS = {
    8:  ["Additional Damage", "Attack Power", "Brand Power", "Ally Damage Enh."],
    9:  ["Boss Damage", "Attack Power", "Ally Damage Enh.", "Ally Attack Enh."],
    10: ["Boss Damage", "Additional Damage", "Brand Power", "Ally Attack Enh."]
  };

  // Tier boundaries on the level-sum (willpower+order+effect1+effect2, each 1..5).
  var TIER_BOUNDS = {
    legendary: { min: 4, max: 15 },
    relic:     { min: 16, max: 18 },
    ancient:   { min: 19, max: 20 }
  };

  // Base per-outcome probabilities (percent) + the condition under which the
  // outcome is EXCLUDED from the pool. `excludeIf` returns true when the outcome
  // cannot appear. Matches PROBABILITIES.md.
  // turnsRemaining = maxTurns - currentTurn + 1.
  var OUTCOME_RATES = [
    // Willpower
    { type: "willpower", change: 1, base: 11.65, excludeIf: function (s) { return s.willpower >= 5; } },
    { type: "willpower", change: 2, base: 4.40,  excludeIf: function (s) { return s.willpower >= 4; } },
    { type: "willpower", change: 3, base: 1.75,  excludeIf: function (s) { return s.willpower >= 3; } },
    { type: "willpower", change: 4, base: 0.45,  excludeIf: function (s) { return s.willpower >= 2; } },
    { type: "willpower", change: -1, base: 3.00, excludeIf: function (s) { return s.willpower <= 1; } },
    // Order
    { type: "order", change: 1, base: 11.65, excludeIf: function (s) { return s.order >= 5; } },
    { type: "order", change: 2, base: 4.40,  excludeIf: function (s) { return s.order >= 4; } },
    { type: "order", change: 3, base: 1.75,  excludeIf: function (s) { return s.order >= 3; } },
    { type: "order", change: 4, base: 0.45,  excludeIf: function (s) { return s.order >= 2; } },
    { type: "order", change: -1, base: 3.00, excludeIf: function (s) { return s.order <= 1; } },
    // Effect 1
    { type: "effect1", change: 1, base: 11.65, excludeIf: function (s) { return s.effect1 >= 5; } },
    { type: "effect1", change: 2, base: 4.40,  excludeIf: function (s) { return s.effect1 >= 4; } },
    { type: "effect1", change: 3, base: 1.75,  excludeIf: function (s) { return s.effect1 >= 3; } },
    { type: "effect1", change: 4, base: 0.45,  excludeIf: function (s) { return s.effect1 >= 2; } },
    { type: "effect1", change: -1, base: 3.00, excludeIf: function (s) { return s.effect1 <= 1; } },
    // Effect 2
    { type: "effect2", change: 1, base: 11.65, excludeIf: function (s) { return s.effect2 >= 5; } },
    { type: "effect2", change: 2, base: 4.40,  excludeIf: function (s) { return s.effect2 >= 4; } },
    { type: "effect2", change: 3, base: 1.75,  excludeIf: function (s) { return s.effect2 >= 3; } },
    { type: "effect2", change: 4, base: 0.45,  excludeIf: function (s) { return s.effect2 >= 2; } },
    { type: "effect2", change: -1, base: 3.00, excludeIf: function (s) { return s.effect2 <= 1; } },
    // Effect changes (always available)
    { type: "change_effect1", change: 0, base: 3.25, excludeIf: function () { return false; } },
    { type: "change_effect2", change: 0, base: 3.25, excludeIf: function () { return false; } },
    // Process-cost changes
    { type: "cost", change: 100,  base: 1.75, excludeIf: function (s) { return s.costMult >= 100 || s.turnsRemaining <= 1; } },
    { type: "cost", change: -100, base: 1.75, excludeIf: function (s) { return s.costMult <= -100 || s.turnsRemaining <= 1; } },
    // Other
    { type: "do_nothing", change: 0, base: 1.75, excludeIf: function () { return false; } },
    { type: "reroll", change: 1, base: 2.50, excludeIf: function (s) { return s.turnsRemaining <= 1; } },
    { type: "reroll", change: 2, base: 0.75, excludeIf: function (s) { return s.turnsRemaining <= 1; } }
  ];

  // -------------------- scoring --------------------

  function willpowerCost(baseCost, wpLevel) {
    return baseCost - wpLevel;
  }

  function willpowerScore(wpCost) {
    if (wpCost < 4) return (4 - wpCost) * SCORING.willpowerPerLevel;
    if (wpCost > 4) return (wpCost - 4) * (-SCORING.willpowerPerLevel);
    return 0;
  }

  function effectScore(effectType, level) {
    switch (effectType) {
      case "Attack Power": return level * SCORING.attackPower;
      case "Additional Damage": return level * SCORING.additionalDamage;
      case "Boss Damage": return level * SCORING.bossDamage;
      // Brand Power / Ally Damage Enh. / Ally Attack Enh. (and anything else) -> 0
      default: return 0;
    }
  }

  // Order is FLAT per point (each order level contributes D_ORDER_PER_POINT),
  // NOT relative to level 4.
  function orderScore(orderLevel) {
    return orderLevel * SCORING.orderPerPoint;
  }

  // Total score = approximate % damage of the gem (sum of per-line D, additive
  // in log space).
  function score(config) {
    var wpc = willpowerCost(config.baseCost, config.willpowerLevel);
    return willpowerScore(wpc)
      + effectScore(config.effect1, config.effect1Level)
      + effectScore(config.effect2, config.effect2Level)
      + orderScore(config.orderLevel);
  }

  // Exact multiplicative % damage of the gem: the per-line D are 100·ln(mult),
  // so the combined multiplier is e^(D/100); damagePercent = (mult − 1)·100.
  // For small D this ≈ score(config); for large gems it is slightly below the sum.
  function damagePercent(config) {
    return (Math.exp(score(config) / 100) - 1) * 100;
  }

  // -------------------- 0-100 grade (min-max over all gems) --------------------
  // 0 = the worst possible gem (incl. the willpower-cost penalty, ~ no damage),
  // 100 = the best possible gem (perfect 10-cost: Boss5 + AddDmg5, order5, wp5).
  // Min-max normalization → invariant to a constant scoring offset (so the
  // willpower/order pivot choice, 4 vs 4.25, does not change the grade). Bounds
  // are enumerated once over every (cost, effect-pair, levels) gem and cached.
  var _gradeBounds = null;
  function gradeBounds() {
    if (_gradeBounds) return _gradeBounds;
    var min = Infinity, max = -Infinity, costs = [8, 9, 10];
    for (var ci = 0; ci < costs.length; ci++) {
      var cost = costs[ci], pool = EFFECT_POOLS[cost];
      for (var i = 0; i < pool.length; i++)
        for (var j = i + 1; j < pool.length; j++)
          for (var wp = 1; wp <= 5; wp++)
            for (var o = 1; o <= 5; o++)
              for (var a = 1; a <= 5; a++)
                for (var b = 1; b <= 5; b++) {
                  var s = score({ baseCost: cost, willpowerLevel: wp, orderLevel: o,
                    effect1: pool[i], effect1Level: a, effect2: pool[j], effect2Level: b });
                  if (s < min) min = s;
                  if (s > max) max = s;
                }
    }
    _gradeBounds = { min: min, max: max };
    return _gradeBounds;
  }

  // 0-100 grade for a gem (rounded to 1 decimal).
  function grade(config) {
    var bnds = gradeBounds();
    var g = 100 * (score(config) - bnds.min) / (bnds.max - bnds.min);
    return Math.round(Math.max(0, Math.min(100, g)) * 10) / 10;
  }

  function scoreBreakdown(config) {
    var wpc = willpowerCost(config.baseCost, config.willpowerLevel);
    var wpS = willpowerScore(wpc);
    var e1S = effectScore(config.effect1, config.effect1Level);
    var e2S = effectScore(config.effect2, config.effect2Level);
    var ordS = orderScore(config.orderLevel);
    return {
      willpowerCost: wpc,
      willpowerScore: wpS,
      effect1Score: e1S,
      effect2Score: e2S,
      orderScore: ordS,
      totalScore: wpS + e1S + e2S + ordS,
      breakdown: {
        willpower: { cost: wpc, score: wpS },
        effect1: { type: config.effect1, level: config.effect1Level, score: e1S },
        effect2: { type: config.effect2, level: config.effect2Level, score: e2S },
        order: { level: config.orderLevel, score: ordS }
      }
    };
  }

  function availableEffects(baseCost) {
    return EFFECT_POOLS[baseCost] ? EFFECT_POOLS[baseCost].slice() : [];
  }

  function validateConfig(config) {
    var pool = EFFECT_POOLS[config.baseCost];
    if (!pool) return { valid: false, error: "Unknown base cost: " + config.baseCost };
    var e1 = config.effect1, e2 = config.effect2;
    var e1ok = pool.indexOf(e1) !== -1 || e1 === "Random";
    var e2ok = pool.indexOf(e2) !== -1 || e2 === "Random";
    if (!e1ok) return { valid: false, error: 'Effect 1 "' + e1 + '" is not available for ' + config.baseCost + ' cost gems' };
    if (!e2ok) return { valid: false, error: 'Effect 2 "' + e2 + '" is not available for ' + config.baseCost + ' cost gems' };
    if (e1 !== "Random" && e2 !== "Random" && e1 === e2) {
      return { valid: false, error: "Effect 1 and Effect 2 must be different" };
    }
    var levels = [config.willpowerLevel, config.orderLevel, config.effect1Level, config.effect2Level];
    for (var i = 0; i < levels.length; i++) {
      if (levels[i] != null && (levels[i] < 1 || levels[i] > 5)) {
        return { valid: false, error: "Levels must be between 1 and 5" };
      }
    }
    return { valid: true };
  }

  // -------------------- tiers / level sums --------------------

  function classifyTier(levelSumValue) {
    if (levelSumValue <= TIER_BOUNDS.legendary.max) return "legendary";
    if (levelSumValue <= TIER_BOUNDS.relic.max) return "relic";
    return "ancient";
  }

  function levelSum(config) {
    return (config.willpowerLevel || 1) + (config.orderLevel || 1)
      + (config.effect1Level || 1) + (config.effect2Level || 1);
  }

  // Number of ways to get level-sum s with four independent stats each in 1..5.
  var _levelSumWays = null;
  function _buildLevelSumWays() {
    if (_levelSumWays) return _levelSumWays;
    var c = {};
    for (var s = 4; s <= 20; s++) c[s] = 0;
    for (var a = 1; a <= 5; a++)
      for (var b = 1; b <= 5; b++)
        for (var d = 1; d <= 5; d++)
          for (var e = 1; e <= 5; e++)
            c[a + b + d + e]++;
    _levelSumWays = c;
    return c;
  }
  function levelSumWays(s) {
    return _buildLevelSumWays()[s] || 0;
  }

  // P(level sum) WITHIN a tier, proportional to the number of integer partitions
  // (four stats 1..5) achieving that sum. Returns { sum: prob } summing to 1.
  function outputLevelSumDist(tier) {
    var bounds = TIER_BOUNDS[tier];
    if (!bounds) return {};
    var ways = _buildLevelSumWays();
    var total = 0, s;
    for (s = bounds.min; s <= bounds.max; s++) total += ways[s];
    var out = {};
    for (s = bounds.min; s <= bounds.max; s++) out[s] = ways[s] / total;
    return out;
  }

  // All (wp, order, e1, e2) partitions of a given sum with each stat 1..5.
  function _partitionsOfSum(s) {
    var res = [];
    for (var wp = 1; wp <= 5; wp++)
      for (var ord = 1; ord <= 5; ord++)
        for (var e1 = 1; e1 <= 5; e1++) {
          var e2 = s - wp - ord - e1;
          if (e2 >= 1 && e2 <= 5) res.push([wp, ord, e1, e2]);
        }
    return res;
  }

  // -------------------- fusion output tier distribution --------------------

  // Additive per-input contributions, then normalize to 100%:
  //   1 Legendary -> +0% R, +0% A
  //   1 Relic     -> +25% R, +2% A
  //   1 Ancient   -> +40% R, +25% A
  // Ancient share is taken first (clamped <=100), relic fills the remainder, and
  // legendary absorbs whatever is left (clamped >=0). Special case: exactly three
  // legendaries -> { L:0.99, R:0.01, A:0 }.
  //
  // inputTiers: array of tier strings (length 3 in normal use, but any length works).
  function fusionOutputDist(inputTiers) {
    var nL = 0, nR = 0, nA = 0, i;
    for (i = 0; i < inputTiers.length; i++) {
      if (inputTiers[i] === "legendary") nL++;
      else if (inputTiers[i] === "relic") nR++;
      else if (inputTiers[i] === "ancient") nA++;
    }
    // 3-legendaries special case.
    if (nL === inputTiers.length && nR === 0 && nA === 0) {
      return { legendary: 0.99, relic: 0.01, ancient: 0 };
    }
    var rawR = nR * 25 + nA * 40;
    var rawA = nR * 2 + nA * 25;
    var A = Math.min(100, rawA);
    var R = Math.min(rawR, 100 - A);
    var L = Math.max(0, 100 - A - R);
    return { legendary: L / 100, relic: R / 100, ancient: A / 100 };
  }

  // -------------------- per-turn outcome probabilities --------------------

  // Returns the normalized probability of each VALID possibility for the given
  // state (the "exclude-if-condition + renormalize" rule). This is the analytic
  // per-possibility distribution; on a process the engine then draws 4 unique
  // outcomes and picks one at 25% each (that 25%/unique step is a sampling
  // concern handled in nested.js, not part of this deterministic table).
  //
  // `prob` fields are fractions in [0,1] that sum to 1 across `possibilities`.
  function outcomeProbabilities(state) {
    var cfg = state.config;
    var turnsRemaining = state.turnsRemaining != null
      ? state.turnsRemaining
      : ((state.maxTurns || 0) - (state.currentTurn || 1) + 1);
    var s = {
      willpower: cfg.willpowerLevel,
      order: cfg.orderLevel,
      effect1: cfg.effect1Level,
      effect2: cfg.effect2Level,
      costMult: state.processCostMultiplier || 0,
      turnsRemaining: turnsRemaining
    };
    var possibilities = [];
    var sumBase = 0, i, r;
    for (i = 0; i < OUTCOME_RATES.length; i++) {
      r = OUTCOME_RATES[i];
      if (r.excludeIf(s)) continue;
      possibilities.push({ type: r.type, change: r.change, base: r.base });
      sumBase += r.base;
    }
    var byType = {};
    for (i = 0; i < possibilities.length; i++) {
      possibilities[i].prob = sumBase > 0 ? possibilities[i].base / sumBase : 0;
      var key = possibilities[i].type + "_" + possibilities[i].change;
      byType[key] = possibilities[i].prob;
    }
    return { possibilities: possibilities, byType: byType, totalBase: sumBase, turnsRemaining: turnsRemaining };
  }

  // -------------------- gold value --------------------

  // Direct sale value of a single gem. score IS now % damage, so no score→damage
  // conversion: goldPerDamage is gold per 1% damage and baseline is a %-damage
  // threshold. value = max(0, (scoreD − baseline) · goldPerDamage).
  function goldValue(scoreVal, baseline, goldPerDamage) {
    return Math.max(0, (scoreVal - baseline) * goldPerDamage);
  }

  // -------------------- closed-form tier score distribution --------------------

  // Exact distribution of total DPS score for a UNIFORM random gem within a tier
  // at a given base cost. Enumerates every level-sum in the tier (weighted by its
  // partition count), every (wp, order, e1, e2) partition of that sum (uniform
  // among partitions of the sum), and every unordered effect pair (uniform among
  // the C(4,2)=6 pairs) with the two levels assigned to the two effects.
  //
  // Returns a Map from score (number) to probability (fractions summing to 1).
  //
  // Effect-pair handling: the two side effects are an unordered pair drawn
  // uniformly from the pool; (effect1Level, effect2Level) are the partition's
  // 3rd/4th entries. Since score is symmetric we average effectScore over both
  // assignments of (levelA, levelB) to the unordered pair, which is equivalent to
  // enumerating ordered pairs uniformly.
  var _scoreDistCache = {};
  function scoreDistributionForTier(baseCost, tier) {
    var ck = baseCost + "_" + tier;
    if (_scoreDistCache[ck]) return _scoreDistCache[ck];

    var pool = EFFECT_POOLS[baseCost];
    var bounds = TIER_BOUNDS[tier];
    var sumDist = outputLevelSumDist(tier); // P(sum) within tier
    var dist = new Map();

    // Precompute unordered effect pairs (i<j) -> uniform weight 1/Cnt.
    var pairs = [];
    for (var a = 0; a < pool.length; a++)
      for (var b = a + 1; b < pool.length; b++)
        pairs.push([pool[a], pool[b]]);
    var pairW = 1 / pairs.length;

    var sums = Object.keys(sumDist);
    for (var si = 0; si < sums.length; si++) {
      var s = parseInt(sums[si], 10);
      var pSum = sumDist[s];
      var parts = _partitionsOfSum(s);
      var partW = 1 / parts.length; // uniform among partitions of this sum
      for (var pi = 0; pi < parts.length; pi++) {
        var part = parts[pi];
        var wp = part[0], ord = part[1], lvA = part[2], lvB = part[3];
        var baseScore = willpowerScore(willpowerCost(baseCost, wp)) + orderScore(ord);
        for (var ci = 0; ci < pairs.length; ci++) {
          var eA = pairs[ci][0], eB = pairs[ci][1];
          // Average over the two assignments of (lvA, lvB) to the unordered pair.
          var sc1 = baseScore + effectScore(eA, lvA) + effectScore(eB, lvB);
          var sc2 = baseScore + effectScore(eA, lvB) + effectScore(eB, lvA);
          var w = pSum * partW * pairW * 0.5;
          _addToDist(dist, sc1, w);
          _addToDist(dist, sc2, w);
        }
      }
    }
    _scoreDistCache[ck] = dist;
    return dist;
  }

  function _addToDist(map, key, w) {
    // Round score key to avoid float dust splitting identical scores.
    var k = Math.round(key * 1e6) / 1e6;
    map.set(k, (map.get(k) || 0) + w);
  }

  // -------------------- tier expected value (joint fixed point) --------------------

  // E[value of a random gem in tier T] at (baseCost, baseline, goldPerDamage).
  //
  // For each tier we split the exact score distribution into:
  //   directExp[T] = sum over scores>=baseline of P(score) * directGold(score)
  //   pBelow[T]    = P(score < baseline)
  // A below-baseline gem is fodder: its value is the fusion value of 3 copies of
  // that tier, which itself depends on E[L], E[R], E[A] (the output can be a
  // higher/lower tier). That circularity is resolved as a 3x3 linear fixed point:
  //
  //   E[T] = directExp[T] + pBelow[T] * ( (mix(T) . E) - fusionCost ) / 3
  //
  // where mix(T) is the fusion output distribution over {L,R,A} for 3 copies of T:
  //   mix(L) = 3-legendary special-case (0.99 L, 0.01 R, 0 A)
  //   mix(R) = fusionOutputDist([R,R,R])  (0.19, 0.75, 0.06)
  //   mix(A) = fusionOutputDist([A,A,A])  (0,    0.25, 0.75)
  //
  // Rearranged to A_mat . E = rhs and solved by Gaussian elimination, then each
  // component clamped to >=0 (matches the reference solver).
  var _tierEVCache = {};
  function tierExpectedValue(baseCost, baseline, goldPerDamage) {
    var key = baseCost + "_" + baseline + "_" + goldPerDamage;
    if (_tierEVCache[key]) return _tierEVCache[key];

    var tiers = ["legendary", "relic", "ancient"];
    var directExp = {}, pBelow = {};
    for (var t = 0; t < tiers.length; t++) {
      var tier = tiers[t];
      var dist = scoreDistributionForTier(baseCost, tier);
      var dExp = 0, below = 0;
      dist.forEach(function (p, sc) {
        if (sc >= baseline) dExp += p * goldValue(sc, baseline, goldPerDamage);
        else below += p;
      });
      directExp[tier] = dExp;
      pBelow[tier] = below;
    }

    // Fusion output mixes for 3 copies of each tier (order: [L, R, A]).
    var mixL = fusionOutputDist(["legendary", "legendary", "legendary"]);
    var mixR = fusionOutputDist(["relic", "relic", "relic"]);
    var mixA = fusionOutputDist(["ancient", "ancient", "ancient"]);
    var mix = {
      legendary: [mixL.legendary, mixL.relic, mixL.ancient],
      relic:     [mixR.legendary, mixR.relic, mixR.ancient],
      ancient:   [mixA.legendary, mixA.relic, mixA.ancient]
    };
    var fc = COSTS.fusion / 3;

    // Build A_mat . E = rhs.
    //   E[i] - pBelow[i]/3 * (mix[i] . E) = directExp[i] - pBelow[i]*fc
    var A_mat = [], rhs = [];
    for (var i = 0; i < 3; i++) {
      var tierI = tiers[i];
      var row = [0, 0, 0];
      var k = pBelow[tierI] / 3;
      for (var j = 0; j < 3; j++) {
        row[j] = (i === j ? 1 : 0) - k * mix[tierI][j];
      }
      A_mat.push(row);
      rhs.push(directExp[tierI] - pBelow[tierI] * fc);
    }

    var E = _solve3x3(A_mat, rhs);
    var result = {
      legendary: Math.max(0, E[0]),
      relic: Math.max(0, E[1]),
      ancient: Math.max(0, E[2])
    };
    _tierEVCache[key] = result;
    return result;
  }

  // Value (per input gem) of fusing 3 copies of `inputTier` at this (baseCost,
  // baseline, goldPerDamage): (E[output] - fusionCost) / 3, clamped >= 0.
  function fusionValueForTier(inputTier, baseCost, baseline, goldPerDamage) {
    var E = tierExpectedValue(baseCost, baseline, goldPerDamage);
    var Earr = [E.legendary, E.relic, E.ancient];
    var mix = fusionOutputDist([inputTier, inputTier, inputTier]);
    var outVal = mix.legendary * Earr[0] + mix.relic * Earr[1] + mix.ancient * Earr[2];
    return Math.max(0, (outVal - COSTS.fusion) / 3);
  }

  // Gaussian elimination with partial pivoting for a 3x3 system. Returns [0,0,0]
  // if singular (degenerate; shouldn't happen for these well-conditioned systems).
  function _solve3x3(A, b) {
    var m = [
      [A[0][0], A[0][1], A[0][2], b[0]],
      [A[1][0], A[1][1], A[1][2], b[1]],
      [A[2][0], A[2][1], A[2][2], b[2]]
    ];
    for (var col = 0; col < 3; col++) {
      var pivot = col;
      for (var row = col + 1; row < 3; row++) {
        if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
      }
      var tmp = m[col]; m[col] = m[pivot]; m[pivot] = tmp;
      var d = m[col][col];
      if (Math.abs(d) < 1e-12) return [0, 0, 0];
      for (var j = 0; j <= 3; j++) m[col][j] /= d;
      for (var r2 = 0; r2 < 3; r2++) {
        if (r2 === col) continue;
        var f = m[r2][col];
        for (var j2 = 0; j2 <= 3; j2++) m[r2][j2] -= f * m[col][j2];
      }
    }
    return [m[0][3], m[1][3], m[2][3]];
  }

  // -------------------- exports (dual: browser global + CommonJS) --------------------

  var API = {
    SCORING: SCORING,
    COSTS: COSTS,
    RARITY: RARITY,
    EFFECT_POOLS: EFFECT_POOLS,
    TIER_BOUNDS: TIER_BOUNDS,
    OUTCOME_RATES: OUTCOME_RATES,

    willpowerCost: willpowerCost,
    willpowerScore: willpowerScore,
    effectScore: effectScore,
    orderScore: orderScore,
    score: score,
    damagePercent: damagePercent,
    grade: grade,
    gradeBounds: gradeBounds,
    scoreBreakdown: scoreBreakdown,
    availableEffects: availableEffects,
    validateConfig: validateConfig,
    classifyTier: classifyTier,
    levelSum: levelSum,
    levelSumWays: levelSumWays,
    outputLevelSumDist: outputLevelSumDist,
    fusionOutputDist: fusionOutputDist,
    outcomeProbabilities: outcomeProbabilities,
    goldValue: goldValue,
    scoreDistributionForTier: scoreDistributionForTier,
    tierExpectedValue: tierExpectedValue,
    fusionValueForTier: fusionValueForTier
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = API;
  } else {
    // Browser: attach each export to the global scope so <script> users can call
    // them directly (window.score, window.tierExpectedValue, ...), and also expose
    // a namespaced handle.
    root.Astrogem = API;
    for (var name in API) {
      if (Object.prototype.hasOwnProperty.call(API, name)) root[name] = API[name];
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
