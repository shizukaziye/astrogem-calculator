/**
 * tools/collect-stats-worker.js — worker thread for the Pipeline DP bake.
 *
 * One worker computes the exact Bellman DP value `W` (and the optimal-policy
 * diagnostics) for a stripe of (rarity, cost, bucket, baseline, gpd) tasks, then
 * posts each result back to the parent (tools/collect-stats.js). Each worker
 * handles task indices where (index % numWorkers === workerId).
 *
 * The whole computation is the DEPENDENCY-FREE core in model/dp.js (which itself
 * pulls model/nested.js + model/astrogem.js). No Monte Carlo, no RNG: the value is
 * the deterministic without-replacement 4-draw expectation, so it is reproducible.
 *
 * What each task produces (see collect-stats.js for the schema):
 *   cutValue   W(freshGem, maxTurns[rarity], maxRerolls[rarity], cm=0)        (gold)
 *   pAbove     P(final cut clears baseline) along the optimal policy           (0..1)
 *   expSpend   E[future gold spent] along the optimal policy                   (gold)
 *   expScore   E[final % damage] along the optimal policy                      (% dmg)
 *   bestAction the turn-1 optimal action: 'process' | 'reroll' | 'complete'
 *   fodder     P(below-baseline cut lands in {legendary, relic, ancient}) — the
 *              fusion-fodder tier split, summing to (1 - pAbove). Computed by
 *              walking the SAME optimal policy the value uses and accumulating the
 *              terminal gem's level-sum tier whenever it ends below baseline.
 */
"use strict";

const { parentPort, workerData } = require("worker_threads");
const path = require("path");
const DP = require(path.join(__dirname, "..", "model", "dp.js"));
const A = require(path.join(__dirname, "..", "model", "astrogem.js"));

const { tasks, workerId, numWorkers, axis } = workerData;

// ---------------------------------------------------------------------------
// Fresh (level-1) gem config for a bucket — mirrors collect-statistics-v2.js
// buildState: a fresh gem has willpower/order/effect1/effect2 all at level 1.
// ---------------------------------------------------------------------------
function freshConfig(cost, effect1, effect2) {
  return {
    baseCost: cost,
    gemType: "order",
    effect1: effect1,
    effect1Level: 1,
    effect2: effect2,
    effect2Level: 1,
    willpowerLevel: 1,
    orderLevel: 1
  };
}

// ---------------------------------------------------------------------------
// Fusion-fodder tier split.
//
// We want, for a gem cut under the OPTIMAL policy, the probability mass that
// ends BELOW baseline (= fodder) split by the terminal gem's tier (by level-sum:
// legendary 4-15, relic 16-18, ancient 19-20). We obtain it exactly by walking
// the optimal policy the DP already computed: at every node we ask the Solver for
// the optimal action (solver._node(...).act) and propagate the reach-probability
// to its children, exactly mirroring the value recursion:
//   - complete: terminal. Add reachProb to fodder[tier(config)] iff score<baseline.
//   - reroll:   single deterministic child (same config, one fewer reroll).
//   - process:  the 4-draw — a uniformly-random one of 4 i.i.d. draws is applied,
//               so each drawable possibility i gets weight probs[i] (the per-
//               possibility draw probability, already normalized in the core).
//
// This reuses the Solver's memoized policy, so it is the SAME decisions the value
// uses; it is a second pass, not a re-solve. Reach probabilities are tiny by the
// time we hit deep leaves, so the recursion terminates at t<=0 / complete / reroll
// chains quickly. Memoized per (configKey,t,r,cm) within one call to stay linear
// in the reachable policy-tree size.
// ---------------------------------------------------------------------------
function fodderTierSplit(solver, rootConfig, t0, r0) {
  const acc = { legendary: 0, relic: 0, ancient: 0 };
  const baseline = solver.baseline;

  function keyOf(c, t, r, cm) {
    return c.willpowerLevel + "|" + c.orderLevel + "|" + c.effect1 + ":" + c.effect1Level
      + "|" + c.effect2 + ":" + c.effect2Level + "|" + t + "|" + r + "|" + cm;
  }
  function pushFrame(map, config, t, r, cm, prob) {
    const k = keyOf(config, t, r, cm);
    const e = map.get(k);
    if (e) e.prob += prob;
    else map.set(k, { config: config, t: t, r: r, cm: cm, prob: prob });
  }
  function addFodder(c, prob) {
    // Use the Solver's axis score (DPS or support) so the below-baseline test matches
    // the value pass's baseline semantics on the active axis.
    if (solver._score(c) < baseline) acc[A.classifyTier(A.levelSum(c))] += prob;
  }

  // Breadth-first over the reachable policy tree, FOLDING identical
  // (config,t,r,cm) frames each layer so the work stays bounded by the small
  // reachable state space (4 stats x levels 1..5 x turns x rerolls x cm), not the
  // exponential path count. Each layer drops t by 1 (process) or r by 1 (reroll),
  // so the loop is O(maxTurns + maxRerolls) iterations.
  let frontier = new Map();
  pushFrame(frontier, rootConfig, t0, r0, 0, 1);

  while (frontier.size > 0) {
    const next = new Map();
    frontier.forEach(function (f) {
      const c = f.config, t = f.t, r = f.r, cm = f.cm, prob = f.prob;
      if (prob <= 0) return;
      if (t <= 0) { addFodder(c, prob); return; }
      const act = solver._node(c, t, r, cm).act;
      if (act === "complete") { addFodder(c, prob); return; }
      if (act === "reroll") { pushFrame(next, c, t, r - 1, cm, prob); return; }
      // process: a uniformly-random one of 4 i.i.d. draws is applied; each drawable
      // possibility i carries the core's per-possibility draw probability.
      const kids = childConfigs(c, t, r, cm);
      for (let i = 0; i < kids.length; i++) {
        const k = kids[i];
        pushFrame(next, k.config, t - 1, k.r, k.cm, prob * k.prob);
      }
    });
    frontier = next;
  }
  return acc;
}

// Re-derive the (config, r, cm, prob) children of a PROCESS node, mirroring the
// core's outcomeTransitions + transitionBranches but exposing the resulting
// configs (drawDistribution collapses them). We reuse the public core primitives:
// A.outcomeProbabilities for the per-possibility prob, and N.applyOutcome for the
// config mutation, so this matches the DP's transitions exactly.
const N = require(path.join(__dirname, "..", "model", "nested.js"));
function childConfigs(config, t, r, cm) {
  const op = A.outcomeProbabilities({ config: config, processCostMultiplier: cm || 0, turnsRemaining: t });
  const out = [];
  for (let i = 0; i < op.possibilities.length; i++) {
    const p = op.possibilities[i];
    const branches = transitionBranches(config, p);
    for (let b = 0; b < branches.length; b++) {
      const br = branches[b];
      out.push({
        config: br.config,
        r: clampReroll(r + br.dRerolls),
        cm: clampCm(cm + br.dCm),
        prob: p.prob * (br.w != null ? br.w : 1 / branches.length)
      });
    }
  }
  return out;
}
function clampReroll(r) { return r < 0 ? 0 : r; }
function clampCm(cm) { return Math.max(-100, Math.min(100, cm)); }
function cloneConfig(c) {
  return { baseCost: c.baseCost, gemType: c.gemType, willpowerLevel: c.willpowerLevel,
    orderLevel: c.orderLevel, effect1: c.effect1, effect1Level: c.effect1Level,
    effect2: c.effect2, effect2Level: c.effect2Level };
}
function transitionBranches(config, p) {
  const t = p.type;
  if (t === "willpower" || t === "order" || t === "effect1" || t === "effect2") {
    const o = { type: p.change > 0 ? "raise_effect" : "lower_effect", target: t, amount: Math.abs(p.change) };
    return [{ config: N.applyOutcome(config, o), dCm: 0, dRerolls: 0 }];
  }
  if (t === "change_effect1" || t === "change_effect2") {
    const target = (t === "change_effect1") ? "effect1" : "effect2";
    const pool = A.EFFECT_POOLS[config.baseCost] || [];
    const current = [config.effect1, config.effect2];
    const candidates = pool.filter(function (e) { return current.indexOf(e) === -1; });
    if (candidates.length === 0) return [{ config: cloneConfig(config), dCm: 0, dRerolls: 0 }];
    const branches = [];
    for (let k = 0; k < candidates.length; k++) {
      const oc = { type: "change_side_option", target: target, newEffect: candidates[k] };
      branches.push({ config: N.applyOutcome(config, oc), dCm: 0, dRerolls: 0, w: 1 / candidates.length });
    }
    return branches;
  }
  if (t === "cost") return [{ config: cloneConfig(config), dCm: p.change, dRerolls: 0 }];
  if (t === "reroll") return [{ config: cloneConfig(config), dCm: 0, dRerolls: p.change || 1 }];
  return [{ config: cloneConfig(config), dCm: 0, dRerolls: 0 }];
}

// ---------------------------------------------------------------------------
// Main worker loop.
// ---------------------------------------------------------------------------
for (let i = workerId; i < tasks.length; i += numWorkers) {
  const task = tasks[i];
  try {
    const cfg = freshConfig(task.cost, task.effect1, task.effect2);
    const solver = new DP.Solver(task.baseline, task.gpd, task.rosterBound, { maxTurns: task.maxTurns, axis: axis });
    const t = task.maxTurns, r = task.maxRerolls;
    const rec = solver._node(cfg, t, r, 0);  // value + policy diagnostics in one pass
    const cutValue = rec.v;
    const pAbove = rec.pAbove;
    const expScore = rec.expScore;
    const expSpend = rec.expSpend;
    const bestAction = rec.act;

    // Fodder tier split — only the NRB pipeline/fodder view consumes it, and it is
    // a second policy walk roughly as costly as the value solve, so skip it for
    // roster-bound tasks (the assembler discards rb fodder anyway).
    const below = Math.max(0, 1 - pAbove);
    let fodder = { legendary: 0, relic: 0, ancient: 0 };
    if (!task.rosterBound && below > 1e-9) {
      const split = fodderTierSplit(solver, cfg, t, r);
      const tot = split.legendary + split.relic + split.ancient;
      // Normalize the walked split to exactly (1 - pAbove) to stay consistent with
      // the value pass's pAbove (tiny numerical drift between the two passes).
      if (tot > 0) {
        const k = below / tot;
        fodder = { legendary: split.legendary * k, relic: split.relic * k, ancient: split.ancient * k };
      }
    }

    parentPort.postMessage({
      type: "result",
      id: task.id,
      cutValue: cutValue,
      pAbove: pAbove,
      expScore: expScore,
      expSpend: expSpend,
      bestAction: bestAction,
      fodderLeg: fodder.legendary,
      fodderRelic: fodder.relic,
      fodderAnc: fodder.ancient,
      nodes: solver.nodes
    });
  } catch (err) {
    parentPort.postMessage({
      type: "result", id: task.id, cutValue: NaN, pAbove: null, expScore: null,
      expSpend: null, bestAction: "error", fodderLeg: null, fodderRelic: null,
      fodderAnc: null, _error: String(err && err.stack || err)
    });
  }
}
