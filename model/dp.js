/**
 * dp.js — EXACT Bellman dynamic-program for optimal astrogem-cutting decisions.
 *
 * This is "Plan C": the deterministic source-of-truth optimal policy. It computes
 *
 *   W(config, t, r, cm) = expected optimal NET gold value of an in-progress cut,
 *
 * where t = turns remaining, r = rerolls remaining, cm = process-cost multiplier,
 * and the expectation over the fresh draw of 4 on-screen outcomes is taken INSIDE.
 * The recursion is:
 *
 *   W(config,t,r,cm) = E_{4 outcomes O}[ max(
 *       COMPLETE: gemValue(config),
 *       PROCESS (t>=1): -procCost(cm) + (1/4)·Σ_{o∈O} W(apply(config,o), t-1, r_o, cm_o),
 *       REROLL  (r>=1, t<maxTurns): -rerollCost(r) + W(config, t, r-1, cm)
 *                (the game greys the reroll out until the gem has been processed once)
 *   )]
 *
 * COMPLETE and REROLL do not depend on WHICH 4 are drawn; only PROCESS does, via
 * the mean of the 4 drawn continuation values v(o)=W(apply(config,o), t-1, r_o, cm_o).
 * So W = E_4[max(K, P4)] with K = max(complete, reroll) and
 * P4 = -procCost + mean of the 4 drawn v(o). We compute E_4[max(K,P4)]
 * deterministically (no RNG), with two selectable draw models:
 *
 *   "wor" (DEFAULT) — the 4 outcomes are drawn DISTINCT (the real game). We use the
 *     conditional-Bernoulli without-replacement model P(4-subset) ∝ Π p_i, computed
 *     EXACTLY via an inclusion-exclusion over disjoint 2-subsets (expectedMaxOfDrawWoR).
 *     This is what the Monte-Carlo gate (tools/verify-dp.js) validates: the leveraged
 *     rare/epic decisions match the independent MC to <2%; a documented short
 *     low-baseline corner is within ~6% (the conditional-Bernoulli vs true
 *     sequential-proportional gap).
 *   "iid" — the faster with-replacement approximation (exact 4-fold via a sum-of-two
 *     heap-merge, expectedMaxOfDraw). ~2x faster but its small per-node bias COMPOUNDS
 *     to ~4-7% over a 9-turn epic cut, so it FAILS the strict gate; kept as a speed
 *     fallback and for cross-checking.
 *
 * Why this matters: the i.i.d. per-node error is only ~0.1-0.9%, but it compounds
 * over the recursion; the without-replacement model removes it (verified per-node and
 * end-to-end vs MC). Both models are RNG-free and memoizable.
 *
 * Determinism / memoization: W is a pure function of (config, t, r, cm) for a fixed
 * (baseline, goldPerDamage, rosterBound, drawModel) — all Solver constants. The whole
 * DP is wrapped in a `Solver` object holding the memo. No Math.random() inside W.
 *
 * The advisor calls `topLevelAdvice(...)`: it knows the ACTUAL 4 on-screen outcomes,
 * so the top-level decision needs NO draw expectation — Process is computed directly
 * from those 4 outcomes' continuation W values. Return shape matches what advisor.js
 * already consumes from evaluateActions.
 *
 * Depends on model/astrogem.js (core) and model/nested.js (the SHARED applyOutcome,
 * calculateGemValue, and the outcome-shaping that keeps DP and MC consistent).
 * Dual export: CommonJS (Node) + browser globals.
 */
(function (root) {
  "use strict";

  var A = (typeof module !== "undefined" && module.exports)
    ? require("./astrogem.js")
    : (root.Astrogem || root);
  var N = (typeof module !== "undefined" && module.exports)
    ? require("./nested.js")
    : (root.AstrogemNested || root);

  // applyOutcome and calculateGemValue are the SHARED primitives from nested.js so
  // the DP terminal value and transitions are identical to the MC's.
  var applyOutcome = N.applyOutcome;
  var calculateGemValue = N.calculateGemValue;

  // ---------------- cost helpers (match nested.js exactly) ----------------

  // procCost(cm) = 900 * (1 + cm/100), floored at 100 and rounded (mirrors
  // nested.js _applyProcessStep, which rounds and clamps the process cost).
  function procCost(cm) {
    // cm = -100 is REAL: the game's "-100% Processing Cost" outcome shows a
    // literal "Processing Cost 0" (live 2026-07-19) — no phantom 100g floor
    return Math.max(0, Math.round(A.COSTS.processBase * (1 + (cm || 0) / 100)));
  }
  // rerollCost: free unless it is the LAST reroll (r===1 -> 3800), per nested.js.
  function rerollCost(r) {
    return r === 1 ? A.COSTS.finalReroll : 0;
  }

  // ---------------- config key (memoization) ----------------

  // Per-cost map from effect name -> a small canonical class id. Two effects with
  // the SAME per-level damage schedule are interchangeable for the DP value (the
  // outcome rate table is symmetric across the two effect slots and depends only on
  // levels, and effectScore is all that distinguishes effect identity in the
  // terminal value). All zero-score support effects collapse to one class. This +
  // the effect-slot swap symmetry below shrinks the reachable state space a lot.
  var _effClassCache = {};
  function effectClass(baseCost, effectName, axis) {
    var support = (axis === "support");
    var ck = baseCost + "_" + (support ? "support" : "dps");
    var map = _effClassCache[ck];
    if (!map) {
      map = {};
      var pool = A.EFFECT_POOLS[baseCost] || [];
      // class id = the per-level VALUE on the active axis, rounded; effects with no
      // value on this axis -> 0 (DPS: support effects=0; support: DPS effects=0).
      var esFn = support ? A.supportEffectScore : A.effectScore;
      for (var i = 0; i < pool.length; i++) {
        map[pool[i]] = Math.round(esFn(pool[i], 1) * 1e6);
      }
      _effClassCache[ck] = map;
    }
    var v = map[effectName];
    return v == null ? 0 : v;
  }

  // Canonical memo key. willpower/order levels + the TWO (effectClass, level) pairs,
  // with the two effect pairs ordered canonically (slot-swap symmetry). gemType /
  // baseCost are fixed for a whole cut so they are NOT part of the key (each query
  // builds a fresh Solver, and Solvers are never shared across base costs).
  function configKey(c, axis) {
    var bc = c.baseCost;
    var c1 = effectClass(bc, c.effect1, axis), l1 = c.effect1Level;
    var c2 = effectClass(bc, c.effect2, axis), l2 = c.effect2Level;
    // order the two (class, level) pairs so {e1,e2} and {e2,e1} share a key
    var aKey, bKey;
    if (c1 < c2 || (c1 === c2 && l1 <= l2)) { aKey = c1 + ":" + l1; bKey = c2 + ":" + l2; }
    else { aKey = c2 + ":" + l2; bKey = c1 + ":" + l1; }
    return c.willpowerLevel + "|" + c.orderLevel + "|" + aKey + "|" + bKey;
  }

  // ---------------- the deterministic per-outcome transition list ----------------

  // For a given (config, t, r, cm) build the list of possible single-outcome
  // transitions the game can draw, each as:
  //   { prob, branches:[{ config', dCm, dRerolls } ...] }
  // Most outcomes have a single deterministic branch; change_side_option fans out
  // (uniformly) over the candidate replacement effects so W stays deterministic.
  //
  // prob is the per-possibility probability from the deterministic core
  // (exclude-if + renormalize). t is passed as turnsRemaining (the exclude-if rules
  // gate `cost` and `reroll` outcomes when turnsRemaining <= 1).
  function outcomeTransitions(config, t, cm) {
    var op = A.outcomeProbabilities({
      config: config,
      processCostMultiplier: cm || 0,
      turnsRemaining: t
    });
    var out = [];
    for (var i = 0; i < op.possibilities.length; i++) {
      var p = op.possibilities[i];
      out.push({ prob: p.prob, branches: transitionBranches(config, p) });
    }
    return out;
  }

  // Map one core possibility {type,change} to its config/cm/reroll effect(s).
  // Uses the SHARED applyOutcome for the config mutation so DP == MC.
  function transitionBranches(config, p) {
    var t = p.type;
    if (t === "willpower" || t === "order" || t === "effect1" || t === "effect2") {
      var o = {
        type: p.change > 0 ? "raise_effect" : "lower_effect",
        target: t,
        amount: Math.abs(p.change)
      };
      return [{ config: applyOutcome(config, o), dCm: 0, dRerolls: 0 }];
    }
    if (t === "change_effect1" || t === "change_effect2") {
      // Fan out over all candidate replacement effects (uniform), deterministically.
      var target = (t === "change_effect1") ? "effect1" : "effect2";
      var pool = A.EFFECT_POOLS[config.baseCost] || [];
      var current = [config.effect1, config.effect2];
      var candidates = pool.filter(function (e) { return current.indexOf(e) === -1; });
      if (candidates.length === 0) {
        return [{ config: cloneConfig(config), dCm: 0, dRerolls: 0 }];
      }
      var branches = [];
      for (var k = 0; k < candidates.length; k++) {
        var oc = { type: "change_side_option", target: target, newEffect: candidates[k] };
        branches.push({
          config: applyOutcome(config, oc),
          dCm: 0,
          dRerolls: 0,
          // sub-weight: uniform across candidates
          w: 1 / candidates.length
        });
      }
      return branches;
    }
    if (t === "cost") {
      // costMult change; clamp -100..+100 (config unchanged).
      return [{ config: cloneConfig(config), dCm: p.change, dRerolls: 0 }];
    }
    if (t === "reroll") {
      // +1 or +2 rerolls (config unchanged).
      return [{ config: cloneConfig(config), dCm: 0, dRerolls: p.change || 1 }];
    }
    // do_nothing (and any unknown): no change.
    return [{ config: cloneConfig(config), dCm: 0, dRerolls: 0 }];
  }

  function cloneConfig(c) {
    return {
      baseCost: c.baseCost, gemType: c.gemType,
      willpowerLevel: c.willpowerLevel, orderLevel: c.orderLevel,
      effect1: c.effect1, effect1Level: c.effect1Level,
      effect2: c.effect2, effect2Level: c.effect2Level
    };
  }

  function clampCm(cm) { return Math.max(-100, Math.min(100, cm)); }

  // ---------------- the Solver (holds memo + caches for one query) ----------------

  // baseline, goldPerDamage, AND rosterBound are fixed for the life of a Solver, so
  // they are NOT part of the memo key. rosterBound makes processing/reroll FREE
  // (matching nested.js), which genuinely changes the optimal policy — so the costs
  // used inside W must reflect it. Each advice query builds its own Solver.
  function Solver(baseline, goldPerDamage, rosterBound, opts) {
    this.baseline = baseline;
    this.gpd = goldPerDamage;
    this.rb = !!rosterBound;
    // Scoring axis: "dps" (default) or "support". Selects the score function used for
    // the terminal value, the baseline test, and the memo-key effect canonicalization.
    this.axis = (opts && opts.axis === "support") ? "support" : "dps";
    // NEW model: terminal value + baseline test use the multiplicative gemValue (DPS) /
    // supportValue (support) — matching the grade and the pipeline EV value distribution.
    this._score = (this.axis === "support") ? A.supportValue : A.gemValue;
    // Draw model: "wor" (default) = exact without-replacement 4-distinct draw,
    // matching the game (passes the MC gate to ~2%). "iid" = the faster
    // with-replacement approximation (≈2x faster, ~3-5% high on long epic cuts).
    this.drawModel = (opts && opts.drawModel) || "wor";
    this._emax = this.drawModel === "iid" ? expectedMaxOfDraw : expectedMaxOfDrawWoR;
    // Complete (finalize + keep/fodder the gem) is only legal AFTER >=1 process — you
    // cannot finalize a 0-process gem, only Delete it (value 0). Since only Process
    // decrements t (Reroll keeps it), "0 processes done" <=> t === maxTurns. Callers
    // that know the gem's starting turn budget pass maxTurns so _node forbids Complete
    // at the fresh node. Default Infinity = no gate (generic W()/self-check back-compat).
    this.maxTurns = (opts && opts.maxTurns != null) ? opts.maxTurns : Infinity;
    this.memo = Object.create(null);     // key -> node record { v, act, expScore, pAbove, expSpend }
    this.nodes = 0;                      // diagnostic: nodes actually computed
  }

  // Cost of a process / reroll under this Solver's roster-bound setting.
  Solver.prototype.procCost = function (cm) { return this.rb ? 0 : procCost(cm); };
  Solver.prototype.rerollCost = function (r) { return this.rb ? 0 : rerollCost(r); };

  // Terminal gem value (direct or fusion-fodder) — SAME as nested.calculateGemValue.
  Solver.prototype.gemValue = function (config) {
    return calculateGemValue(this._score(config), this.baseline, this.gpd, config, this.axis);
  };

  // The continuation record for ONE drawn possibility (collapsed over any
  // change_side_option sub-branches): { v, expScore, pAbove, expSpend } = the child
  // node's value + diagnostics, averaged over the uniform candidate branches.
  Solver.prototype.outcomeChild = function (trans, t, r, cm) {
    var branches = trans.branches;
    if (branches.length === 1) {
      var b = branches[0];
      return this._node(b.config, t - 1, clampReroll(r + b.dRerolls), clampCm(cm + b.dCm));
    }
    var v = 0, es = 0, pa = 0, sp = 0, wsum = 0;
    for (var i = 0; i < branches.length; i++) {
      var br = branches[i];
      var w = br.w != null ? br.w : 1 / branches.length;
      var ch = this._node(br.config, t - 1, clampReroll(r + br.dRerolls), clampCm(cm + br.dCm));
      v += w * ch.v; es += w * ch.expScore; pa += w * ch.pAbove; sp += w * ch.expSpend; wsum += w;
    }
    if (wsum > 0) { v /= wsum; es /= wsum; pa /= wsum; sp /= wsum; }
    return { v: v, expScore: es, pAbove: pa, expSpend: sp };
  };

  // Build, for the fresh 4-draw at (config,t,r,cm), parallel arrays of per-outcome
  // continuation VALUES + draw PROBS (for the value expectation) and the child
  // RECORDS (for the process-branch diagnostics). One entry per drawable possibility.
  Solver.prototype.drawDistribution = function (config, t, r, cm) {
    var trans = outcomeTransitions(config, t, cm);
    var nP = trans.length;
    var values = new Array(nP), probs = new Array(nP), kids = new Array(nP);
    for (var i = 0; i < nP; i++) {
      var ch = this.outcomeChild(trans[i], t, r, cm);
      kids[i] = ch;
      values[i] = ch.v;
      probs[i] = trans[i].prob;
    }
    return { values: values, probs: probs, kids: kids };
  };

  // E_4[ max(K, -proc + mean of 4 i.i.d. draws of v) ] where the v-distribution is
  // {values, probs} (one atom per drawable possibility, n <= ~22).
  //
  // PROCESS applies a uniformly-random one of 4 freshly-drawn outcomes; approximating
  // the 4 distinct draws as 4 i.i.d. draws, the realized value is
  //   X = -proc + (Y1+Y2+Y3+Y4)/4,  Yk ~ {values,probs} iid,
  // and we want E[max(K, X)]. We avoid the O(n^4) 4-fold convolution: build the
  // SUM-OF-TWO distribution S2 (n^2 atoms) ONCE, sorted, then S4 = Sa+Sb with
  // Sa,Sb ~ S2 iid. With S2 sorted + suffix sums, for each atom a:
  //   max(K, -proc+(a+b)/4) = K            when b <= z*-a   (z* = 4(K+proc))
  //                         = -proc+(a+b)/4 when b >  z*-a
  //   E_b[...] = K·headMass + (-proc)·tailMass + (a·tailMass + tailSum_b)/4
  // Summed over a weighted by p2(a). This is EXACT for the i.i.d.-of-4 approximation
  // (validated to ~1e-10 vs brute force; the without-replacement gap is checked by
  // the Monte-Carlo gate in tools/verify-dp.js). No RNG, fully memoizable.
  //
  // Performance: S2 is built already-sorted via an n-way merge of the n sorted runs
  // {u[r] + u[*]} (u = sorted 1-draw values) using a tiny inlined binary heap — no
  // closure comparator (the hot path runs once per DP node). Then a per-atom binary
  // search over the sorted S2. Values are gold (>= 0); W >= 0 since COMPLETE >= 0.
  function expectedMaxOfDraw(values, probs, K, proc) {
    var n = values.length;
    if (n === 0) return K;
    if (n === 1) return Math.max(K, -proc + values[0]);

    // Cheap dominance prunes that skip the (relatively expensive) 2-sum build:
    //   meanV = Σ p·v ; vMin/vMax = extreme outcome values.
    // Since the realized X = -proc + mean of 4 draws, X ∈ [-proc+vMin, -proc+vMax].
    //   * if -proc + vMax <= K : PROCESS can never beat K -> E[max] = K.
    //   * if -proc + vMin >= K : PROCESS always beats K   -> E[max] = -proc + meanV.
    var vMin = Infinity, vMax = -Infinity, meanV = 0, pv;
    for (var z = 0; z < n; z++) {
      pv = values[z];
      if (pv < vMin) vMin = pv;
      if (pv > vMax) vMax = pv;
      meanV += probs[z] * pv;
    }
    if (-proc + vMax <= K) return K;
    if (-proc + vMin >= K) return -proc + meanV;

    // Sort the 1-draw distribution by value (n <= 22; closure sort is negligible).
    var ord = new Array(n);
    for (var t = 0; t < n; t++) ord[t] = t;
    ord.sort(function (x, y) { return values[x] - values[y]; });
    var u = new Float64Array(n), q = new Float64Array(n);
    for (var s = 0; s < n; s++) { u[s] = values[ord[s]]; q[s] = probs[ord[s]]; }

    // Build the sorted SUM-OF-TWO distribution via n-way merge of runs
    // run r = u[r] + u[ptr[r]] (each run ascending because u is sorted).
    var L = n * n;
    var oVal = new Float64Array(L), oP = new Float64Array(L);
    var ptr = new Int32Array(n);
    var heap = new Int32Array(n), hkey = new Float64Array(n), hs = 0, r, i, par, ch, l, rr, sm, tr, tk;
    for (r = 0; r < n; r++) { // push (run r, u[r]+u[0])
      i = hs++; heap[i] = r; hkey[i] = u[r] + u[0];
      while (i > 0) { par = (i - 1) >> 1; if (hkey[par] <= hkey[i]) break; tr = heap[par]; heap[par] = heap[i]; heap[i] = tr; tk = hkey[par]; hkey[par] = hkey[i]; hkey[i] = tk; i = par; }
    }
    for (var out = 0; out < L; out++) {
      var top = heap[0]; var p = ptr[top];
      oVal[out] = u[top] + u[p]; oP[out] = q[top] * q[p];
      ptr[top]++;
      // replace root with next from this run (or last heap element if run exhausted)
      if (ptr[top] < n) { hkey[0] = u[top] + u[ptr[top]]; }
      else { hs--; if (hs > 0) { heap[0] = heap[hs]; hkey[0] = hkey[hs]; } }
      // sift down
      i = 0;
      for (;;) {
        l = 2 * i + 1; rr = 2 * i + 2; sm = i;
        if (l < hs && hkey[l] < hkey[sm]) sm = l;
        if (rr < hs && hkey[rr] < hkey[sm]) sm = rr;
        if (sm === i) break;
        tr = heap[sm]; heap[sm] = heap[i]; heap[i] = tr; tk = hkey[sm]; hkey[sm] = hkey[i]; hkey[i] = tk; i = sm;
      }
    }

    // Suffix sums over the sorted S2.
    var tailP = new Float64Array(L + 1), tailSum = new Float64Array(L + 1);
    for (var k = L - 1; k >= 0; k--) {
      tailP[k] = tailP[k + 1] + oP[k];
      tailSum[k] = tailSum[k + 1] + oP[k] * oVal[k];
    }

    // Sweep a (= Sa) ascending. The tail starts at the first index where
    // oVal > zStar - av; since av increases, that threshold decreases, so the tail
    // boundary `ptrb` only moves LEFT -> a single monotone two-pointer (no per-atom
    // binary search). ptrb = first index with oVal[ptrb] > thr.
    var zStar = 4 * (K + proc); // process beats K iff Sa+Sb > zStar
    var e = 0;
    var ptrb = L; // start: no tail (av smallest -> thr largest)
    for (var ai = 0; ai < L; ai++) {
      var av = oVal[ai], ap = oP[ai];
      var thr = zStar - av;
      // move ptrb left while the element just below it still exceeds thr
      while (ptrb > 0 && oVal[ptrb - 1] > thr) ptrb--;
      var tm = tailP[ptrb], tvs = tailSum[ptrb];
      e += ap * (K * (1 - tm) + (-proc) * tm + (av * tm + tvs) / 4);
    }
    return e;
  }

  // WITHOUT-REPLACEMENT version of expectedMaxOfDraw — the game draws 4 DISTINCT
  // outcomes (not i.i.d.). The i.i.d. model above is exact-per-node to ~0.1-0.9% but
  // that small bias COMPOUNDS over the ~9-turn recursion to a 3-5% gap vs the true
  // (without-replacement) Monte-Carlo (see tools/verify-dp.js). This computes the
  // exact expectation under the "conditional-Bernoulli" without-replacement model
  // P(4-subset) ∝ Π_{i∈subset} p_i, renormalized — which matches the game's
  // sequential-proportional draw to <1% for the n>=10 nodes that dominate the value.
  //
  // We need, over distinct 4-subsets weighted by Πp:
  //   P>T  = Σ Πp·1{Σv>T} ,  ES>T = Σ Πp·(Σv)·1{Σv>T} ,   T = 4(K+proc)
  // then E[max(K, -proc+Σv/4)] = K + (ES>T − T·P>T)/4 / Z4 ,  Z4 = e_4(p).
  //
  // The 4-subset sum is split into two DISJOINT 2-subsets {A,B}; each 4-subset is 3
  // such unordered pairs, so Σ_{4-sub} = (1/3)·Σ_{disjoint unordered {A,B}}. And
  // disjoint-unordered = (1/2)(all-ordered − share-one − share-two[diagonal]). Each
  // piece is a threshold sum computed in O(n^2)/O(|D2|) via sorted suffix sums and
  // monotone two-pointers (validated exact vs brute Πp enumeration, ~1e-12).
  function expectedMaxOfDrawWoR(values, probs, K, proc) {
    var n = values.length;
    if (n === 0) return K;
    if (n < 4) {
      // Can't draw 4 distinct from <4 possibilities; the game pads (rare, late game
      // with very few valid outcomes). Fall back to the i.i.d. model, which equals
      // the with-replacement padding behaviour and is exact for n==1.
      return expectedMaxOfDraw(values, probs, K, proc);
    }
    var T = 4 * (K + proc);

    // Sort the 1-draw distribution by value ascending.
    var ord = new Array(n);
    for (var z = 0; z < n; z++) ord[z] = z;
    ord.sort(function (x, y) { return values[x] - values[y]; });
    var u = new Float64Array(n), q = new Float64Array(n);
    for (var s0 = 0; s0 < n; s0++) { u[s0] = values[ord[s0]]; q[s0] = probs[ord[s0]]; }

    // ---- ordered-pair threshold sums over ALL j != k (full set), at threshold tau:
    //   Gp = Σ_{j!=k} q_j q_k 1{u_j+u_k>tau} ; Gv = Σ_{j!=k} q_j q_k (u_j+u_k) 1{...}
    // Computed as (all ordered incl j==k) minus the diagonal, via a monotone pointer.
    function pairThresh(tau) {
      var P = 0, V = 0, idx = n, i, jj;
      for (jj = 0; jj < n; jj++) {
        var tj = tau - u[jj];
        while (idx > 0 && u[idx - 1] > tj) idx--;
        i = idx;
        var qp = QP[i];
        P += q[jj] * qp;
        V += q[jj] * (u[jj] * qp + QV[i]);
      }
      var dP = 0, dV = 0;
      for (jj = 0; jj < n; jj++) { if (2 * u[jj] > tau) { dP += q[jj] * q[jj]; dV += q[jj] * q[jj] * 2 * u[jj]; } }
      return { P: P - dP, V: V - dV };
    }

    // suffix sums of the 1-draw (for pairThresh)
    var QP = new Float64Array(n + 1), QV = new Float64Array(n + 1);
    for (var k1 = n - 1; k1 >= 0; k1--) { QP[k1] = QP[k1 + 1] + q[k1]; QV[k1] = QV[k1 + 1] + q[k1] * u[k1]; }

    // ---- D2: distribution of 2-SUBSET sums {i<j}, weight q_i q_j, sorted asc ----
    // Built already-sorted via an n-way merge of the distinct-pair runs: run i covers
    // j = i+1..n-1 with sums u[i]+u[j] (ascending since u is sorted). Tiny inlined
    // binary heap, no closure comparator (this runs once per DP node, hot path).
    var m = (n * (n - 1)) / 2;
    var sv = new Float64Array(m), sp = new Float64Array(m);
    var jp = new Int32Array(n);            // jp[i] = current j pointer for run i (starts i+1)
    for (var ri = 0; ri < n; ri++) jp[ri] = ri + 1;
    var dheap = new Int32Array(n), dkey = new Float64Array(n), dhs = 0, di, dpar, dl, drr, dsm, dtr, dtk;
    for (var r0 = 0; r0 < n - 1; r0++) { // run r0 is non-empty iff r0+1 <= n-1
      di = dhs++; dheap[di] = r0; dkey[di] = u[r0] + u[r0 + 1];
      while (di > 0) { dpar = (di - 1) >> 1; if (dkey[dpar] <= dkey[di]) break; dtr = dheap[dpar]; dheap[dpar] = dheap[di]; dheap[di] = dtr; dtk = dkey[dpar]; dkey[dpar] = dkey[di]; dkey[di] = dtk; di = dpar; }
    }
    for (var dout = 0; dout < m; dout++) {
      var dtop = dheap[0], dj = jp[dtop];
      sv[dout] = u[dtop] + u[dj]; sp[dout] = q[dtop] * q[dj];
      jp[dtop]++;
      if (jp[dtop] < n) { dkey[0] = u[dtop] + u[jp[dtop]]; }
      else { dhs--; if (dhs > 0) { dheap[0] = dheap[dhs]; dkey[0] = dkey[dhs]; } }
      di = 0;
      for (;;) {
        dl = 2 * di + 1; drr = 2 * di + 2; dsm = di;
        if (dl < dhs && dkey[dl] < dkey[dsm]) dsm = dl;
        if (drr < dhs && dkey[drr] < dkey[dsm]) dsm = drr;
        if (dsm === di) break;
        dtr = dheap[dsm]; dheap[dsm] = dheap[di]; dheap[di] = dtr; dtk = dkey[dsm]; dkey[dsm] = dkey[di]; dkey[di] = dtk; di = dsm;
      }
    }
    var TP = new Float64Array(m + 1), TV = new Float64Array(m + 1);
    for (var k2 = m - 1; k2 >= 0; k2--) { TP[k2] = TP[k2 + 1] + sp[k2]; TV[k2] = TV[k2 + 1] + sp[k2] * sv[k2]; }

    // AllOrdered: Σ_{A,B ordered 2-subsets} w_A w_B 1{s_A+s_B>T} (and *(s_A+s_B))
    var allP = 0, allV = 0, ptr = m, a2;
    for (a2 = 0; a2 < m; a2++) {
      var ta = T - sv[a2];
      while (ptr > 0 && sv[ptr - 1] > ta) ptr--;
      var tp = TP[ptr];
      allP += sp[a2] * tp;
      allV += sp[a2] * (sv[a2] * tp + TV[ptr]);
    }
    // Diagonal A==B: Σ_A w_A^2 1{2 s_A>T}
    var diagP = 0, diagV = 0;
    for (a2 = 0; a2 < m; a2++) { if (2 * sv[a2] > T) { diagP += sp[a2] * sp[a2]; diagV += sp[a2] * sp[a2] * 2 * sv[a2]; } }
    // ShareOne: Σ_i q_i^2 · Σ_{j,k != i, j!=k} q_j q_k 1{2u_i+u_j+u_k>T} (ordered j,k), *(value)
    var shP = 0, shV = 0, ii;
    for (ii = 0; ii < n; ii++) {
      var tau = T - 2 * u[ii];
      var g = pairThresh(tau);            // over ALL j!=k (full set)
      // remove ordered pairs touching i: (i,k) and (j,i)
      var remP = 0, remV = 0, kk;
      for (kk = 0; kk < n; kk++) { if (kk === ii) continue; if (u[ii] + u[kk] > tau) { remP += q[ii] * q[kk]; remV += q[ii] * q[kk] * (u[ii] + u[kk]); } }
      remP *= 2; remV *= 2;
      var gjkP = g.P - remP, gjkV = g.V - remV; // over j,k != i
      shP += q[ii] * q[ii] * gjkP;
      shV += q[ii] * q[ii] * (2 * u[ii] * gjkP + gjkV);
    }

    // DERIVATION of the /2/3: we need Σ over UNORDERED DISJOINT pairs {A,B} of
    // 2-subsets. AllOrdered counts every ordered (A,B) including A==B (diagP) and
    // pairs sharing exactly one element (shP); subtracting both leaves ordered
    // disjoint pairs → /2 makes them unordered. Each 4-subset {a,b,c,d} is then
    // counted once per way of splitting it into two disjoint 2-subsets — exactly
    // 3 splits (ab|cd, ac|bd, ad|bc) — so /3 converts pair-sums into 4-subset sums.
    var dispP = (allP - diagP - shP) / 2 / 3;     // disjoint -> 4-subset
    var dispV = (allV - diagV - shV) / 2 / 3;

    // Z4 = e_4(p) via the elementary-symmetric recurrence.
    var e1 = 0, e2 = 0, e3 = 0, e4 = 0, pi;
    for (var ei = 0; ei < n; ei++) {
      pi = probs[ei];
      e4 += e3 * pi; e3 += e2 * pi; e2 += e1 * pi; e1 += pi;
    }
    var Z4 = e4;
    if (Z4 <= 0) return expectedMaxOfDraw(values, probs, K, proc);
    var P = dispP / Z4, ES = dispV / Z4;
    return K + (ES - T * P) / 4;
  }

  function clampReroll(r) { return r < 0 ? 0 : r; }

  // The core memoized value. Returns the scalar optimal NET value W.
  // (Diagnostics are read straight off _node records — a branchStats wrapper was
  // removed 2026-07-18, nothing called it.)
  Solver.prototype.W = function (config, t, r, cm) {
    return this._node(config, t, r, cm).v;
  };

  // Memoized node record computed in a SINGLE pass:
  //   { v, act, expScore, pAbove, expSpend }
  // v   = optimal NET value W (the decision quantity)
  // act = argmax action 'complete' | 'reroll' | 'process'
  // expScore/pAbove/expSpend = expected final % damage, P(final clears baseline),
  //   and expected future gold spend, ALONG THE OPTIMAL POLICY from this node. These
  //   diagnostics are RNG-free and follow the same argmax the value uses, so no
  //   second tree-walk is needed. (baseline, goldPerDamage, rosterBound are Solver
  //   constants, so they don't expand the key.)
  Solver.prototype._node = function (config, t, r, cm) {
    cm = clampCm(cm || 0);
    r = clampReroll(r || 0);
    if (t <= 0) {
      var scT = this._score(config);
      return { v: this.gemValue(config), act: "complete", expScore: scT, pAbove: scT > this.baseline ? 1 : 0, expSpend: 0 };
    }
    var key = configKey(config, this.axis) + "#" + t + "#" + r + "#" + cm;
    var hit = this.memo[key];
    if (hit !== undefined) return hit;
    this.nodes++;

    // Cannot Complete a 0-process gem (t === maxTurns) — only Process or Delete(=0).
    var complete = (t < this.maxTurns) ? this.gemValue(config) : 0;
    var scTerminal = this._score(config);

    // REROLL does not depend on the draw. Gated on having processed at least once
    // (t < maxTurns): the game greys the reroll out on a fresh gem.
    var reroll = -Infinity, rerollRec = null;
    if (r >= 1 && t < this.maxTurns) {
      rerollRec = this._node(config, t, r - 1, cm);
      reroll = -this.rerollCost(r) + rerollRec.v;
    }
    var K = Math.max(complete, reroll);

    // PROCESS via the 4-draw expectation. drawDistribution also returns the child
    // RECORDS so we can roll diagnostics forward without recomputation.
    var dist = this.drawDistribution(config, t, r, cm);
    var pc = this.procCost(cm);       // actual gold charged per process (0 if roster-bound)
    // The value of PROCESS is -pc + mean continuation, so the cost used INSIDE the
    // max-expectation must be the actually-charged cost (0 for roster-bound gems —
    // they cut for free, which is what makes "always process" optimal for them).
    var val = this._emax(dist.values, dist.probs, K, pc);

    var rec;
    if (val > K) {
      // PROCESS optimal. Expected post-process diagnostics = draw-prob-weighted mean
      // of child stats (a uniform-random one of the 4 i.i.d. draws is applied).
      var es = 0, pa = 0, sp = 0, ptot = 0;
      for (var i = 0; i < dist.kids.length; i++) {
        var w = dist.probs[i], ch = dist.kids[i];
        es += w * ch.expScore; pa += w * ch.pAbove; sp += w * ch.expSpend; ptot += w;
      }
      if (ptot > 0) { es /= ptot; pa /= ptot; sp /= ptot; }
      rec = { v: val, act: "process", expScore: es, pAbove: pa, expSpend: pc + sp };
    } else if (reroll >= complete && r >= 1) {
      // REROLL optimal: same gem, one fewer reroll.
      rec = { v: val, act: "reroll", expScore: rerollRec.expScore, pAbove: rerollRec.pAbove, expSpend: this.rerollCost(r) + rerollRec.expSpend };
    } else {
      // COMPLETE optimal: keep the current gem.
      rec = { v: val, act: "complete", expScore: scTerminal, pAbove: scTerminal > this.baseline ? 1 : 0, expSpend: 0 };
    }
    this.memo[key] = rec;
    return rec;
  };

  // ---------------- top-level advice (advisor-facing) ----------------

  // The advisor KNOWS the actual 4 outcomes, so no draw expectation at the top.
  //   complete = gemValue(config)
  //   process  = -procCost(cm) + (1/4)·Σ_{the 4 actual} W(apply(config,o_i), t-1, r_i, cm_i)
  //   reroll   = (r>=1 ? -rerollCost(r) + W(config, t, r-1, cm) : N/A)
  //
  // `state` is the advisor state shape:
  //   { config, currentTurn, maxTurns, rerollsRemaining, processCostMultiplier,
  //     totalGoldSpent, rosterBound, outcomes:[4] }
  // outcomes are in the applyOutcome shape (type: raise_effect / lower_effect /
  // change_side_option / change_gold_cost / reroll_increase / do_nothing, ...).
  //
  // A fresh (reset) gem's reroll allotment, derived from the rarity table rather
  // than a magic ternary (maxTurns uniquely identifies the rarity).
  function freshRerollsFor(maxTurns) {
    var R = A.RARITY;
    for (var k in R) { if (R[k].maxTurns === maxTurns) return R[k].maxRerolls; }
    return 3;
  }

  // Returns { bestAction, allActions:[{name,value,aboveBaselineOdds,expectedScore,
  // expectedCost,description}], currentValue, expectedValues, expectedScores } —
  // the SAME shape advisor.js consumes from evaluateActions.
  function topLevelAdvice(state, baseline, goldPerDamage, options) {
    options = options || {};
    var rb = !!state.rosterBound;
    // options.axis "support" grades the cut by supportValue against a support-scale
    // baseline (supportGradeToScore) — the Solver already carries the axis internally.
    var solver = new Solver(baseline, goldPerDamage, rb, { drawModel: options.drawModel, maxTurns: state.maxTurns, axis: options.axis });
    var config = cloneConfig(state.config);
    var t = Math.max(0, (state.maxTurns - state.currentTurn + 1)); // turns remaining incl. current
    var r = state.rerollsRemaining || 0;
    var cm = clampCm(state.processCostMultiplier || 0);
    // includeSim2 === "Consider Complete" (the UI toggle): true/absent ⇒ Complete is
    // RANKED. The old `!== false` read was inverted and silently excluded Complete
    // from every ranking whenever the toggle was ON (caught by Shizu, 2026-07-17).
    var excludeComplete = options.includeSim2 === false;
    var isFirstTurn = state.currentTurn === 1;

    // ---- COMPLETE ----
    // The solver's axis score (gemValue / supportValue) — the SAME units as `baseline`
    // and as every other node's expScore. (Was the legacy additive A.score, a unit
    // mismatch that skewed only Complete's displayed score/pAbove, never the ranking.)
    var curScore = solver._score(config);
    // Turn 1 complete == dismantle (value 0), matching nested.js monteCarloSimulation.
    var completeValue = isFirstTurn ? 0 : solver.gemValue(config);
    var completeNet = completeValue; // no future spend
    var completeAbove = curScore > baseline ? 1 : 0;

    // ---- PROCESS (from the actual 4 outcomes) ----
    var processNet = -Infinity, processScore = NaN, processCost_ = 0, processAbove = 0;
    var actualOutcomes = (state.outcomes || []).slice(0, 4);
    if (t >= 1 && actualOutcomes.length > 0) {
      var pc = rb ? 0 : procCost(cm);
      var sumV = 0, sumScore = 0, sumAbove = 0, sumSpend = 0, cnt = 0;
      for (var i = 0; i < actualOutcomes.length; i++) {
        // Each actual outcome may fan into branches (unnamed change_side_option);
        // average value + stats over its (uniform) branches.
        var brs = outcomeBranchesActual(config, actualOutcomes[i]);
        var bv = 0, bs = 0, ba = 0, bsp = 0, bw = 0;
        for (var k = 0; k < brs.length; k++) {
          var b = brs[k];
          var w = b.w != null ? b.w : 1 / brs.length;
          var t2 = t - 1;
          var r2 = clampReroll(r + b.dRerolls);
          var cm2 = clampCm(cm + b.dCm);
          var ch = solver._node(b.config, t2, r2, cm2);
          bv += w * ch.v;
          var st = { expScore: ch.expScore, pAbove: ch.pAbove, expSpend: ch.expSpend };
          bs += w * st.expScore;
          ba += w * st.pAbove;
          bsp += w * st.expSpend;
          bw += w;
        }
        if (bw > 0) { bv /= bw; bs /= bw; ba /= bw; bsp /= bw; }
        sumV += bv; sumScore += bs; sumAbove += ba; sumSpend += bsp; cnt++;
      }
      if (cnt > 0) {
        processNet = -pc + sumV / cnt;
        processScore = sumScore / cnt;
        processAbove = sumAbove / cnt;
        processCost_ = pc + sumSpend / cnt; // expected future spend along the process line
      }
    }

    // ---- REROLL ----
    // Turn 1 CANNOT reroll: the counter is visible on a fresh gem but the button is
    // greyed out until the gem has been processed once (confirmed in-game by Shizu,
    // 2026-07-17 — this corrects an earlier wrong reading). Mirrors W()/chooseAction.
    var rerollNet = -Infinity, rerollScore = NaN, rerollCost_ = 0, rerollAbove = 0;
    if (r >= 1 && t >= 1 && !isFirstTurn) {
      var rc = rb ? 0 : rerollCost(r);
      var rch = solver._node(config, t, r - 1, cm);
      rerollNet = -rc + rch.v;
      rerollScore = rch.expScore;
      rerollAbove = rch.pAbove;
      rerollCost_ = rc + rch.expSpend;
    }

    // ---- RESET (ranked whenever COMPLETE would win, or on the last turn) ----
    // Shizu 2026-07-19: "calculate reset on every turn that you recommend
    // complete, not just the last turn" — if stopping is the right call, paying
    // COSTS.reset to start the cut over is ALWAYS the live alternative, whatever
    // the turn. Reset (1/1) returns the gem to a fresh unprocessed state (all
    // levels 1, full turns + rerolls, cost multiplier cleared).
    // resetsRemaining now comes from the parsed Reset (x/1) counter (structural
    // engine, ocr/structural-engine.js resetPill read) or manual entry; when it
    // reads 0 the reset has already been spent and MUST NOT be recommended, even
    // though the button's greyed-out state alone can't be read from the DP side.
    // undefined/null (unparsed) still defaults to "assume unused" for backward
    // compatibility with callers that don't pass this field at all.
    var completeWouldWin = !excludeComplete &&
      completeNet >= processNet && completeNet >= rerollNet;
    var resetUsed = state.resetsRemaining === 0;
    var resetNet = -Infinity, resetScore = NaN, resetAbove = 0, resetCost_ = 0;
    if ((t === 1 || completeWouldWin) && A.COSTS && A.COSTS.reset != null && !resetUsed) {
      var freshCfg = {
        baseCost: config.baseCost, gemType: config.gemType,
        willpowerLevel: 1, orderLevel: 1,
        effect1: config.effect1, effect1Level: 1,
        effect2: config.effect2, effect2Level: 1
      };
      var freshRerolls = freshRerollsFor(solver.maxTurns);
      var freshNode = solver._node(freshCfg, solver.maxTurns, freshRerolls, 0);
      var resetGold = A.COSTS.reset;   // the reset itself is paid gold even roster-bound
      resetNet = -resetGold + freshNode.v;
      resetScore = freshNode.expScore;
      resetAbove = freshNode.pAbove;
      resetCost_ = resetGold + freshNode.expSpend;
    }

    var actions = [
      { name: "Process", value: processNet, expectedScore: processScore, expectedCost: processCost_, aboveBaselineOdds: processAbove, description: "Process the gem with the current outcomes" },
      { name: "Reroll", value: rerollNet, expectedScore: rerollScore, expectedCost: rerollCost_, aboveBaselineOdds: rerollAbove, description: "Reroll to get new outcomes" },
      { name: "Complete", value: excludeComplete ? -Infinity : completeNet, expectedScore: curScore, expectedCost: 0, aboveBaselineOdds: completeAbove, description: "Complete and keep the current gem" },
      { name: "Reset", value: resetNet, expectedScore: resetScore, expectedCost: resetCost_, aboveBaselineOdds: resetAbove, description: "Reset the gem to a fresh unprocessed state (once per gem)" }
    ];
    actions.sort(function (a, b) { return b.value - a.value; });

    // ---- Reset combinations (Shizu, 2026-07-17) ----
    // An in-game reset MAY re-roll the two side nodes, so the single ranked Reset
    // value (same-pair assumption) is not the whole story. Whenever reset is a live
    // consideration — the last turn, or Complete winning the argmax — value EVERY
    // side-effect pair the reset could land on, so the user can compare before
    // pressing the in-game button. The class-keyed memo makes same-class pairs free.
    var resetCombos = null;
    if (A.COSTS && A.COSTS.reset != null && !resetUsed &&
        (t === 1 || completeWouldWin || (actions[0] && actions[0].name === "Complete"))) {
      var poolR = A.EFFECT_POOLS[config.baseCost] || [];
      var freshRr = freshRerollsFor(solver.maxTurns);
      resetCombos = [];
      for (var pi = 0; pi < poolR.length; pi++) {
        for (var pj = pi + 1; pj < poolR.length; pj++) {
          var cfgR = {
            baseCost: config.baseCost, gemType: config.gemType,
            willpowerLevel: 1, orderLevel: 1,
            effect1: poolR[pi], effect1Level: 1,
            effect2: poolR[pj], effect2Level: 1
          };
          var nR = solver._node(cfgR, solver.maxTurns, freshRr, 0);
          resetCombos.push({
            effect1: poolR[pi], effect2: poolR[pj],
            net: -A.COSTS.reset + nR.v, expectedScore: nR.expScore,
            current: (poolR[pi] === config.effect1 && poolR[pj] === config.effect2) ||
                     (poolR[pi] === config.effect2 && poolR[pj] === config.effect1)
          });
        }
      }
      resetCombos.sort(function (x, y) { return y.net - x.net; });
    }

    return {
      bestAction: actions[0].name.toLowerCase(),
      includeSim2: excludeComplete,
      expectedValues: { process: processNet, reroll: rerollNet, delete: completeNet },
      expectedScores: { process: processScore, reroll: rerollScore, delete: curScore },
      allActions: actions,
      currentValue: solver.gemValue(config),
      resetCombos: resetCombos,
      resetCost: A.COSTS ? A.COSTS.reset : null,
      _solverNodes: solver.nodes
    };
  }

  // Map ONE advisor-shape actual outcome to its list of branches, each
  // { config, dCm, dRerolls, w } where w are uniform weights summing to 1. Most
  // outcomes are a single branch; an unnamed change_side_option fans uniformly over
  // the candidate replacement effects (matching how the game would resolve it and
  // how the DP's drawDistribution treats it). Uses the SHARED applyOutcome so the
  // top-level transition equals the inside-DP transition.
  function outcomeBranchesActual(config, outcome) {
    var t = outcome.type;
    if (t === "change_gold_cost") {
      return [{ config: cloneConfig(config), dCm: (outcome.change > 0 ? 100 : -100), dRerolls: 0, w: 1 }];
    }
    if (t === "reroll_increase") {
      return [{ config: cloneConfig(config), dCm: 0, dRerolls: outcome.change || 1, w: 1 }];
    }
    if (t === "change_side_option") {
      var target = outcome.target === "effect2" ? "effect2" : "effect1";
      if (outcome.newEffect) {
        return [{ config: applyOutcome(config, outcome), dCm: 0, dRerolls: 0, w: 1 }];
      }
      var pool = A.EFFECT_POOLS[config.baseCost] || [];
      var current = [config.effect1, config.effect2];
      var candidates = pool.filter(function (e) { return current.indexOf(e) === -1; });
      if (candidates.length === 0) {
        return [{ config: cloneConfig(config), dCm: 0, dRerolls: 0, w: 1 }];
      }
      return candidates.map(function (e) {
        return { config: applyOutcome(config, { type: "change_side_option", target: target, newEffect: e }), dCm: 0, dRerolls: 0, w: 1 / candidates.length };
      });
    }
    if (t === "raise_effect" || t === "lower_effect") {
      return [{ config: applyOutcome(config, outcome), dCm: 0, dRerolls: 0, w: 1 }];
    }
    // do_nothing (and any unknown)
    return [{ config: cloneConfig(config), dCm: 0, dRerolls: 0, w: 1 }];
  }

  // ---------------- evaluateActions-compatible wrapper ----------------

  // Drop-in for nested.js evaluateActions(state, baseline, goldPerDamage, numRuns,
  // onProgress, options) but backed by the EXACT DP. numRuns/onProgress are accepted
  // for signature compatibility and ignored (the DP is deterministic). Returns the
  // identical shape advisor.js consumes.
  function evaluateActionsDP(state, baseline, goldPerDamage, numRuns, onProgress, options) {
    var res = topLevelAdvice(state, baseline, goldPerDamage, options || {});
    if (typeof onProgress === "function") onProgress(numRuns || 1, numRuns || 1);
    return res;
  }

  // ---------------- policy helper (for the Monte-Carlo cross-check) ----------------

  // Given a persistent Solver and the CURRENT cut state INCLUDING the actual 4 drawn
  // outcomes, return the DP-preferred action 'process' | 'reroll' | 'complete'. This
  // is exactly the top-level decision (no draw expectation — the 4 are known), but
  // reuses the passed Solver's memo so a full rollout shares one memo. Used by
  // tools/verify-dp.js to simulate the DP-optimal policy. allowComplete=false keeps
  // the policy to Process-vs-Reroll only (turn-1 never completes).
  function chooseAction(solver, config, t, r, cm, outcomes, allowComplete) {
    // COMPLETE (disallowed at the 0-process node t===maxTurns: can't finalize a fresh gem)
    var complete = (allowComplete && t < solver.maxTurns) ? solver.gemValue(config) : -Infinity;

    // PROCESS from the actual 4 outcomes (no future spend term beyond -pc here; we
    // compare NET continuation values, all measured from the same point).
    var process = -Infinity;
    if (t >= 1 && outcomes && outcomes.length > 0) {
      var pc = solver.procCost(cm);
      var sumV = 0, cnt = 0;
      for (var i = 0; i < outcomes.length; i++) {
        var brs = outcomeBranchesActual(config, outcomes[i]);
        var bv = 0, bw = 0;
        for (var k = 0; k < brs.length; k++) {
          var b = brs[k];
          var w = b.w != null ? b.w : 1 / brs.length;
          bv += w * solver.W(b.config, t - 1, clampReroll(r + b.dRerolls), clampCm(cm + b.dCm));
          bw += w;
        }
        if (bw > 0) bv /= bw;
        sumV += bv; cnt++;
      }
      if (cnt > 0) process = -pc + sumV / cnt;
    }

    // REROLL (illegal on a fresh gem: t === maxTurns)
    var reroll = -Infinity;
    if (r >= 1 && t >= 1 && t < solver.maxTurns) {
      reroll = -solver.rerollCost(r) + solver.W(config, t, r - 1, cm);
    }

    // argmax
    var best = "complete", bestV = complete;
    if (process > bestV) { best = "process"; bestV = process; }
    if (reroll > bestV) { best = "reroll"; bestV = reroll; }
    // if nothing finite (e.g. t==0), complete
    if (!isFinite(bestV)) best = "complete";
    return best;
  }

  // ---------------- exports ----------------

  var API = {
    Solver: Solver,
    procCost: procCost,
    rerollCost: rerollCost,
    topLevelAdvice: topLevelAdvice,
    evaluateActionsDP: evaluateActionsDP,
    chooseAction: chooseAction,
    outcomeBranchesActual: outcomeBranchesActual,
    // thin W() helper for self-checks / tools (rosterBound optional, default false)
    W: function (config, t, r, cm, baseline, goldPerDamage, rosterBound, maxTurns) {
      return new Solver(baseline, goldPerDamage, rosterBound, { maxTurns: maxTurns }).W(config, t, r, cm);
    }
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = API;
  } else {
    root.AstrogemDP = API;
    for (var name in API) {
      if (Object.prototype.hasOwnProperty.call(API, name)) root[name] = API[name];
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
