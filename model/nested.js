/**
 * nested.js — nested Monte Carlo evaluator for astrogem cutting decisions.
 *
 * Depends on model/astrogem.js (the pure deterministic core). Works as a browser
 * <script> (reads the Astrogem globals, attaches its own exports to globalThis)
 * and as a Node require() (CommonJS).
 *
 * This is a faithful port of the OLD solver-nested.js "accurate" path:
 *   - generateOutcomes(config)      — draws the 4 unique on-screen outcomes for a
 *                                     turn from the official rate table (the
 *                                     exclude-if-condition + renormalize + "4
 *                                     unique, 25% each on process" rules).
 *   - applyOutcome(config, outcome) — applies a chosen outcome to the gem config.
 *   - evaluateActions(state, baseline, goldPerDamage, numRuns, onProgress, options)
 *                                     — ranks Process / Reroll / Complete by net
 *                                     expected gold value via nested MC. Returns
 *                                     { allActions:[{name,value,aboveBaselineOdds,
 *                                       expectedScore,expectedCost,...}], ... }.
 *
 * The genetic-algorithm training apparatus from the old project is DROPPED. The
 * inner reroll decision used inside rollouts is a simple, dependency-free
 * heuristic (chooseInnerReroll) rather than a trained GA policy. The load-bearing
 * accuracy comes from nestedMonteCarloEvaluate comparing process-EV vs reroll-EV
 * directly at each continuation step.
 *
 * `state` shape:
 *   { config, currentTurn, maxTurns, rerollsRemaining, processCost,
 *     processCostMultiplier, totalGoldSpent, rosterBound, outcomes:[4], history:[] }
 */
(function (root) {
  "use strict";

  var A = (typeof module !== "undefined" && module.exports)
    ? require("./astrogem.js")
    : (root.Astrogem || root);

  // Tunable run counts (env-overridable in Node, like the old code).
  function _innerRuns() {
    if (typeof global !== "undefined" && global.NESTED_INNER_RUNS != null) {
      return global.NESTED_INNER_RUNS;
    }
    return 60; // smaller default than the old 300; UI agents can pass options.
  }

  // ---------------- outcome generation ----------------

  // Build the list of valid possibilities for a turn (delegates the rate table +
  // normalization to the deterministic core), then draw up to 4 UNIQUE outcomes
  // (same type+change can't repeat in one turn), each drawn weighted by the
  // normalized probability without replacement. Returns an array of 4 outcome
  // objects in the shape applyOutcome expects.
  function generateOutcomes(config) {
    var turnsRemaining = config.turnsRemaining != null ? config.turnsRemaining : 9;
    var op = A.outcomeProbabilities({
      config: config,
      processCostMultiplier: config.processCostMultiplier || 0,
      turnsRemaining: turnsRemaining
    });
    // Work on a mutable copy of possibilities (each has prob in [0,1]).
    var pool = op.possibilities.map(function (p) {
      return { type: p.type, change: p.change, prob: p.prob };
    });

    var selected = [];
    while (selected.length < 4 && pool.length > 0) {
      var total = 0, i;
      for (i = 0; i < pool.length; i++) total += pool[i].prob;
      var r = Math.random() * total;
      var idx = -1, cum = 0;
      for (i = 0; i < pool.length; i++) {
        cum += pool[i].prob;
        if (r <= cum) { idx = i; break; }
      }
      if (idx < 0) idx = pool.length - 1;
      selected.push(_toOutcome(pool[idx], config));
      pool.splice(idx, 1);
    }
    while (selected.length < 4) selected.push({ type: "do_nothing", description: "—" });
    return selected;
  }

  function _toOutcome(p, config) {
    var t = p.type;
    if (t === "willpower" || t === "order" || t === "effect1" || t === "effect2") {
      var isInc = p.change > 0;
      return {
        type: isInc ? "raise_effect" : "lower_effect",
        target: t,
        amount: Math.abs(p.change),
        description: (t + (isInc ? " +" : " -") + Math.abs(p.change))
      };
    }
    if (t === "change_effect1" || t === "change_effect2") {
      return {
        type: "change_side_option",
        target: t === "change_effect1" ? "effect1" : "effect2",
        description: "Change " + (t === "change_effect1" ? config.effect1 : config.effect2)
      };
    }
    if (t === "cost") {
      return { type: "change_gold_cost", change: p.change, description: "Cost " + (p.change > 0 ? "+" : "") + p.change + "%" };
    }
    if (t === "do_nothing") {
      return { type: "do_nothing", description: "—" };
    }
    if (t === "reroll") {
      return { type: "reroll_increase", change: p.change, description: "Reroll +" + p.change };
    }
    return { type: "do_nothing", description: "—" };
  }

  // Apply an outcome to a config; returns a NEW config (config-only changes;
  // cost/reroll bookkeeping is done by the caller against the state).
  function applyOutcome(config, outcome) {
    var c = {
      baseCost: config.baseCost, gemType: config.gemType,
      willpowerLevel: config.willpowerLevel, orderLevel: config.orderLevel,
      effect1: config.effect1, effect1Level: config.effect1Level,
      effect2: config.effect2, effect2Level: config.effect2Level
    };
    var amt = outcome.amount || 1;
    if (outcome.type === "raise_effect") {
      if (outcome.target === "willpower") c.willpowerLevel = Math.min(5, c.willpowerLevel + amt);
      else if (outcome.target === "order") c.orderLevel = Math.min(5, c.orderLevel + amt);
      else if (outcome.target === "effect1") c.effect1Level = Math.min(5, c.effect1Level + amt);
      else if (outcome.target === "effect2") c.effect2Level = Math.min(5, c.effect2Level + amt);
    } else if (outcome.type === "lower_effect") {
      if (outcome.target === "willpower") c.willpowerLevel = Math.max(1, c.willpowerLevel - amt);
      else if (outcome.target === "order") c.orderLevel = Math.max(1, c.orderLevel - amt);
      else if (outcome.target === "effect1") c.effect1Level = Math.max(1, c.effect1Level - amt);
      else if (outcome.target === "effect2") c.effect2Level = Math.max(1, c.effect2Level - amt);
    } else if (outcome.type === "change_side_option") {
      var pool = A.EFFECT_POOLS[c.baseCost] || [];
      var current = [c.effect1, c.effect2];
      var candidates = pool.filter(function (e) { return current.indexOf(e) === -1; });
      if (candidates.length > 0) {
        var ne = outcome.newEffect && candidates.indexOf(outcome.newEffect) !== -1
          ? outcome.newEffect
          : candidates[Math.floor(Math.random() * candidates.length)];
        // The swapped-in effect KEEPS the level of the effect it replaced (confirmed
        // in-game) — so you can level any line and then change it into a damage line.
        if (outcome.target === "effect1") { c.effect1 = ne; }
        else if (outcome.target === "effect2") { c.effect2 = ne; }
      }
    }
    // change_gold_cost / do_nothing / reroll_increase: no config change here.
    return c;
  }

  // ---------------- gem value (direct or fusion-fodder) ----------------

  function calculateGemValue(scoreVal, baseline, goldPerDamage, config) {
    var direct = A.goldValue(scoreVal, baseline, goldPerDamage);
    if (direct > 0) return direct;
    if (!config) return 0;
    var baseCost = config.baseCost != null ? config.baseCost : 10;
    var inputTier = A.classifyTier(A.levelSum(config));
    return A.fusionValueForTier(inputTier, baseCost, baseline, goldPerDamage);
  }

  // ---------------- state helpers ----------------

  function _cloneState(s) {
    return {
      config: {
        baseCost: s.config.baseCost, gemType: s.config.gemType,
        willpowerLevel: s.config.willpowerLevel, orderLevel: s.config.orderLevel,
        effect1: s.config.effect1, effect1Level: s.config.effect1Level,
        effect2: s.config.effect2, effect2Level: s.config.effect2Level
      },
      currentTurn: s.currentTurn,
      maxTurns: s.maxTurns,
      rerollsRemaining: s.rerollsRemaining,
      processCost: s.processCost != null ? s.processCost : A.COSTS.processBase,
      processCostMultiplier: s.processCostMultiplier || 0,
      totalGoldSpent: s.totalGoldSpent || 0,
      rosterBound: s.rosterBound || false
    };
  }

  function _applyProcessStep(st, outcome) {
    st.config = applyOutcome(st.config, outcome);
    st.currentTurn++;
    st.totalGoldSpent += (st.rosterBound ? 0 : st.processCost);
    if (outcome.type === "change_gold_cost" && !st.rosterBound) {
      st.processCostMultiplier = Math.max(-100, Math.min(100, st.processCostMultiplier + outcome.change));
      st.processCost = Math.max(100, Math.round(A.COSTS.processBase * (1 + st.processCostMultiplier / 100)));
    }
    if (outcome.type === "reroll_increase") {
      st.rerollsRemaining += outcome.change || 1;
    }
  }

  // ---------------- simple inner reroll heuristic (replaces GA) ----------------

  // Decide whether to reroll the on-screen outcomes during an inner rollout.
  // Dependency-free heuristic: reroll when the BEST available outcome barely
  // improves the gem (low upside) yet we still have rerolls to spare relative to
  // remaining turns. Turn 1 can never reroll.
  function chooseInnerReroll(state, outcomes, baseline) {
    if (state.rerollsRemaining <= 0) return false;
    if (state.currentTurn === 1) return false;
    var turnsRemaining = Math.max(1, state.maxTurns - state.currentTurn + 1);
    var current = A.score(state.config);
    var best = -Infinity;
    for (var i = 0; i < outcomes.length; i++) {
      var sc = A.score(applyOutcome(state.config, outcomes[i]));
      if (sc > best) best = sc;
    }
    var upside = best - current;
    // Plenty of rerolls per remaining turn and the best outcome adds little:
    // reroll for a better board. Thresholds chosen to be conservative.
    var rerollsPerTurn = state.rerollsRemaining / turnsRemaining;
    return upside < 1.0 && rerollsPerTurn >= 0.5;
  }

  // ---------------- rollouts ----------------

  // Roll a path to completion using the simple heuristic for reroll decisions.
  function _rolloutToCompletion(state, baseline, goldPerDamage, initialGoldSpent) {
    var cur = state;
    while (cur.currentTurn <= cur.maxTurns) {
      var cfg = _cfgWithState(cur);
      var outcomes = generateOutcomes(cfg);
      if (cur.rerollsRemaining > 0 && chooseInnerReroll(cur, outcomes, baseline)) {
        var rc = cur.rerollsRemaining === 1 ? A.COSTS.finalReroll : 0;
        cur.rerollsRemaining--;
        cur.totalGoldSpent += rc;
        continue;
      }
      var pick = outcomes[Math.floor(Math.random() * outcomes.length)];
      _applyProcessStep(cur, pick);
    }
    var finalScore = A.score(cur.config);
    var finalValue = calculateGemValue(finalScore, baseline, goldPerDamage, cur.config);
    return { finalScore: finalScore, finalValue: finalValue, totalCost: cur.totalGoldSpent - initialGoldSpent, finalConfig: cur.config };
  }

  function _cfgWithState(st) {
    return {
      baseCost: st.config.baseCost, gemType: st.config.gemType,
      willpowerLevel: st.config.willpowerLevel, orderLevel: st.config.orderLevel,
      effect1: st.config.effect1, effect1Level: st.config.effect1Level,
      effect2: st.config.effect2, effect2Level: st.config.effect2Level,
      processCostMultiplier: st.processCostMultiplier || 0,
      turnsRemaining: st.maxTurns - st.currentTurn + 1
    };
  }

  // Inner nested MC: expected NET value of taking `action` now, then rolling out.
  function nestedMonteCarloEvaluate(state, outcomes, action, baseline, goldPerDamage, initialGoldSpent, numRuns) {
    var total = 0;
    for (var run = 0; run < numRuns; run++) {
      var st = _cloneState(state);
      if (action === "process" && outcomes) {
        var pick = outcomes[Math.floor(Math.random() * outcomes.length)];
        _applyProcessStep(st, pick);
      } else if (action === "reroll") {
        var rc = st.rerollsRemaining === 1 ? A.COSTS.finalReroll : 0;
        st.rerollsRemaining--;
        st.totalGoldSpent += rc;
      }
      _rolloutToCompletion(st, baseline, goldPerDamage, initialGoldSpent);
      var cost = st.totalGoldSpent - initialGoldSpent;
      total += calculateGemValue(A.score(st.config), baseline, goldPerDamage, st.config) - cost;
    }
    return total / numRuns;
  }

  // Outer rollout: take firstAction, then at each continuation step compare
  // process-EV vs reroll-EV (vs optional Complete) via the inner nested MC.
  function simulateRandomPath(state, firstAction, baseline, goldPerDamage, initialGoldSpent, currentOutcomes, allowComplete) {
    var cur = _cloneState(state);

    if (firstAction === "process") {
      if (cur.currentTurn > cur.maxTurns) {
        var sc0 = A.score(cur.config);
        return { finalScore: sc0, finalValue: calculateGemValue(sc0, baseline, goldPerDamage, cur.config), totalCost: cur.totalGoldSpent - initialGoldSpent, finalConfig: cur.config };
      }
      var outs = (currentOutcomes && currentOutcomes.length > 0) ? currentOutcomes : generateOutcomes(_cfgWithState(cur));
      var pick = outs[Math.floor(Math.random() * outs.length)];
      _applyProcessStep(cur, pick);
    } else if (firstAction === "reroll") {
      if (cur.rerollsRemaining <= 0) {
        var sc1 = A.score(cur.config);
        return { finalScore: sc1, finalValue: calculateGemValue(sc1, baseline, goldPerDamage, cur.config), totalCost: cur.totalGoldSpent - initialGoldSpent, finalConfig: cur.config };
      }
      var rc = cur.rerollsRemaining === 1 ? A.COSTS.finalReroll : 0;
      cur.rerollsRemaining--;
      cur.totalGoldSpent += rc;
    }

    var innerRuns = _innerRuns();
    while (cur.currentTurn <= cur.maxTurns) {
      var outcomes = generateOutcomes(_cfgWithState(cur));
      var rerollCost = cur.rerollsRemaining === 1 ? A.COSTS.finalReroll : 0;

      var processValue = nestedMonteCarloEvaluate(cur, outcomes, "process", baseline, goldPerDamage, initialGoldSpent, innerRuns);
      var rerollValue = cur.rerollsRemaining > 0
        ? nestedMonteCarloEvaluate(cur, null, "reroll", baseline, goldPerDamage, initialGoldSpent, innerRuns) - rerollCost
        : -Infinity;

      if (allowComplete) {
        var curScore = A.score(cur.config);
        var completeValue = calculateGemValue(curScore, baseline, goldPerDamage, cur.config);
        var completeNet = completeValue - (cur.totalGoldSpent - initialGoldSpent);
        if (completeNet >= processValue && completeNet >= rerollValue) {
          return { finalScore: curScore, finalValue: completeValue, totalCost: cur.totalGoldSpent - initialGoldSpent, finalConfig: cur.config };
        }
      }

      if (rerollValue > processValue + 50) {
        var rc2 = cur.rerollsRemaining === 1 ? A.COSTS.finalReroll : 0;
        cur.rerollsRemaining--;
        cur.totalGoldSpent += rc2;
        continue;
      }
      var sel = outcomes[Math.floor(Math.random() * outcomes.length)];
      _applyProcessStep(cur, sel);
    }

    var fScore = A.score(cur.config);
    return { finalScore: fScore, finalValue: calculateGemValue(fScore, baseline, goldPerDamage, cur.config), totalCost: cur.totalGoldSpent - initialGoldSpent, finalConfig: cur.config };
  }

  // ---------------- top-level MC + evaluateActions ----------------

  function _emptyAgg() {
    return { totalScore: 0, totalValue: 0, totalCost: 0, count: 0, aboveBaseline: 0 };
  }

  // Run the outer MC for Process / Reroll / Complete and return per-action
  // expected score, value, cost, and above-baseline odds.
  function monteCarloSimulation(state, baseline, goldPerDamage, numRuns, currentOutcomes) {
    var process = _emptyAgg(), reroll = _emptyAgg(), del = _emptyAgg();
    var baseCost = state.config.baseCost != null ? state.config.baseCost : 10;
    var initialGoldSpent = state.totalGoldSpent || 0;
    var isFirstTurn = state.currentTurn === 1;

    // Complete (Turn 1 == Dismantle: value 0; Turn 2+ keep gem).
    var curScore = A.score(state.config);
    var delValue = isFirstTurn ? 0 : calculateGemValue(curScore, baseline, goldPerDamage, state.config);
    var delAbove = curScore > baseline ? 1 : 0;
    for (var d = 0; d < numRuns; d++) {
      del.totalScore += curScore; del.totalValue += delValue; del.count++;
      if (delAbove) del.aboveBaseline++;
    }

    for (var run = 0; run < numRuns; run++) {
      var s = _cloneState(state);
      if (s.currentTurn <= s.maxTurns) {
        var outs = (currentOutcomes && currentOutcomes.length > 0)
          ? currentOutcomes
          : generateOutcomes(_cfgWithState(s));
        var ps = simulateRandomPath(s, "process", baseline, goldPerDamage, initialGoldSpent, outs, true);
        process.totalScore += ps.finalScore; process.totalValue += ps.finalValue; process.totalCost += ps.totalCost; process.count++;
        if (ps.finalScore > baseline) process.aboveBaseline++;
      }
      if (s.currentTurn > 1 && s.rerollsRemaining > 0) {
        var rs = simulateRandomPath(s, "reroll", baseline, goldPerDamage, initialGoldSpent, null, true);
        reroll.totalScore += rs.finalScore; reroll.totalValue += rs.finalValue; reroll.totalCost += rs.totalCost; reroll.count++;
        if (rs.finalScore > baseline) reroll.aboveBaseline++;
      }
    }

    return {
      process: _finalize(process),
      reroll: _finalize(reroll),
      delete: _finalize(del)
    };
  }

  function _finalize(r) {
    if (r.count === 0) {
      return { score: -Infinity, value: -Infinity, cost: 0, aboveBaselineOdds: 0 };
    }
    return {
      score: r.totalScore / r.count,
      value: r.totalValue / r.count,
      cost: r.totalCost / r.count,
      aboveBaselineOdds: r.aboveBaseline / r.count
    };
  }

  // Public: rank Process / Reroll / Complete by NET expected value.
  // options.includeSim2 (default true): when true, Complete is excluded from being
  // chosen as the best action (mirrors the old behaviour where the advisor focuses
  // on Process-vs-Reroll), but its computed value is still reported.
  function evaluateActions(state, baseline, goldPerDamage, numRuns, onProgress, options) {
    numRuns = numRuns || 200;
    options = options || {};
    var currentOutcomes = state.outcomes || null;
    var excludeComplete = options.includeSim2 !== false;

    var res = monteCarloSimulation(state, baseline, goldPerDamage, numRuns, currentOutcomes);

    var processNet = res.process.value - res.process.cost;
    var rerollNet = res.reroll.value - res.reroll.cost;
    var deleteNet = res.delete.value - res.delete.cost;

    var actions = [
      { name: "Process", value: processNet, expectedScore: res.process.score, expectedCost: res.process.cost, aboveBaselineOdds: res.process.aboveBaselineOdds, description: "Process the gem with current outcomes" },
      { name: "Reroll", value: rerollNet, expectedScore: res.reroll.score, expectedCost: res.reroll.cost, aboveBaselineOdds: res.reroll.aboveBaselineOdds, description: "Reroll to get new outcomes" },
      { name: "Complete", value: excludeComplete ? -Infinity : deleteNet, expectedScore: res.delete.score, expectedCost: res.delete.cost, aboveBaselineOdds: res.delete.aboveBaselineOdds, description: "Complete the process and keep the current gem" }
    ];
    actions.sort(function (a, b) { return b.value - a.value; });

    if (typeof onProgress === "function") onProgress(numRuns, numRuns);

    return {
      bestAction: actions[0].name.toLowerCase(),
      includeSim2: excludeComplete,
      expectedValues: { process: processNet, reroll: rerollNet, delete: deleteNet },
      expectedScores: { process: res.process.score, reroll: res.reroll.score, delete: res.delete.score },
      allActions: actions,
      currentValue: calculateGemValue(A.score(state.config), baseline, goldPerDamage, state.config)
    };
  }

  // ---------------- exports ----------------

  var API = {
    generateOutcomes: generateOutcomes,
    applyOutcome: applyOutcome,
    calculateGemValue: calculateGemValue,
    chooseInnerReroll: chooseInnerReroll,
    nestedMonteCarloEvaluate: nestedMonteCarloEvaluate,
    simulateRandomPath: simulateRandomPath,
    monteCarloSimulation: monteCarloSimulation,
    evaluateActions: evaluateActions
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = API;
  } else {
    root.AstrogemNested = API;
    for (var name in API) {
      if (Object.prototype.hasOwnProperty.call(API, name)) root[name] = API[name];
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
