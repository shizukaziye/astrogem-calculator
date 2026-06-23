/**
 * pipeline.js — "Pipeline Tables" tab (BUCKET-PRIMARY).
 *
 * The cut / fuse / throw decision is made PER EFFECT-PAIR BUCKET — the two effects
 * a gem rolled are its archetype. So every gem cell stacks the FOUR buckets:
 *   2D  (2_damage)         both effects damage          — best
 *   Op  (optimal_damage)   better single damage + dead
 *   Sub (suboptimal_damage)worse  single damage + dead
 *   No  (no_damage)        both dead effects             — no direct damage, but still
 *                                                        worth its TIER's fodder value (never 0)
 * Each bucket row shows its CUT VALUE (the exact Bellman-DP value of cutting a
 * fresh level-1 gem of that archetype) + P(above baseline) + a verdict color.
 *
 * TIER (Leg/Relic/Anc by level-sum) is NOT the cell axis — it is the fusion-FODDER
 * classification, shown in a SEPARATE "Fusion / fodder by tier" section ("for
 * after"): below-baseline cuts become fodder, classified by tier, fused 3->1.
 *
 * >>> NO INTERPOLATION ANYWHERE. <<<
 * Every number on this tab is an EXACT Bellman-DP solve:
 *   BAKED  fetch data/pipeline.json and read each cell by DIRECT KEY LOOKUP. The
 *          bake stores one exact DP solve per (rarity, cost, bucket, baseline, gpd),
 *          keyed by baseline = gradeToScore(grade). The grade rows we render use the
 *          SAME gradeToScore(grade) float, so the key matches exactly — no interp.
 *   LIVE   any gold-per-1%-damage + grade the user types: compute the EXACT DP on
 *          demand in the browser for all 36 cells (3 rarities x 3 costs x 4 buckets)
 *          via window.Solver._node, plus the fodder split (the same optimal-policy
 *          walk the bake uses) and an exact throughput block derived from those
 *          cells. This is ~60-90s, so it runs ONLY on a "Recalculate" click and is
 *          chunked with setTimeout (a few cells, update the progress bar, yield) so
 *          the page never freezes. Real DP for every cell — never interpolated.
 *
 * VERDICT COLORS (reproduced from the deployed ark-grid-solver/index page; bands on
 * the cut-value gold EV):
 *   GREEN   (>= 18k)  worth resetting if below baseline (reroll once, same bucket) ↻
 *   YELLOW->DIM (>0)  worth cutting, not resetting  (10-18k / 5-10k / 1-5k bands)
 *   RED     (<= 0)    don't cut
 *   PURPLE            fuse pre-cutting (NRB) — when fodder-fusion beats the weak cut
 *
 * Reuses styles.css; a SCOPED <style> adds the bucket-grid + verdict-cell styles.
 */
(function () {
  "use strict";

  // ---- display constants (mirrored from data/pipeline.json meta) ----
  var FIXED_GPD = [500000, 1000000, 1500000, 2500000, 3500000, 5000000];
  var COSTS = [8, 9, 10];
  var RARITIES = ["uncommon", "rare", "epic"];
  var RARITY_LABEL = { uncommon: "Uncommon", rare: "Rare", epic: "Epic" };
  var BUCKETS = ["2_damage", "optimal_damage", "suboptimal_damage", "no_damage"];
  var BUCKET_LABEL = { "2_damage": "2D", "optimal_damage": "Op", "suboptimal_damage": "Sub", "no_damage": "No" };
  var TIERS = ["legendary", "relic", "ancient"];
  var TIER_LABEL = { legendary: "Leg", relic: "Relic", ancient: "Anc" };

  // Baseline is expressed as a 0-100 gem-quality GRADE. Each grade maps to a
  // %-damage threshold via window.gradeToScore(grade). The bake stores ONE exact DP
  // solve per grade row at baseline = gradeToScore(grade), so the baked cell for a
  // grade is read by DIRECT KEY LOOKUP (no interpolation). One row per rank C- … S+.
  var GRADE_ROWS = [52, 57, 62, 66, 70, 73, 77, 80, 83, 87, 92, 97];

  // Exact effect pairs per (cost, bucket) — used for the LIVE on-demand DP. These
  // mirror data/pipeline.json meta.effectBuckets / tools/collect-stats.js EFFECT_BUCKETS.
  var EFFECT_BUCKETS = {
    8: {
      "2_damage": { effect1: "Additional Damage", effect2: "Attack Power" },
      "optimal_damage": { effect1: "Additional Damage", effect2: "Brand Power" },
      "suboptimal_damage": { effect1: "Attack Power", effect2: "Brand Power" },
      "no_damage": { effect1: "Brand Power", effect2: "Ally Damage Enh." }
    },
    9: {
      "2_damage": { effect1: "Boss Damage", effect2: "Attack Power" },
      "optimal_damage": { effect1: "Boss Damage", effect2: "Ally Damage Enh." },
      "suboptimal_damage": { effect1: "Attack Power", effect2: "Ally Damage Enh." },
      "no_damage": { effect1: "Ally Damage Enh.", effect2: "Ally Attack Enh." }
    },
    10: {
      "2_damage": { effect1: "Boss Damage", effect2: "Additional Damage" },
      "optimal_damage": { effect1: "Boss Damage", effect2: "Brand Power" },
      "suboptimal_damage": { effect1: "Additional Damage", effect2: "Brand Power" },
      "no_damage": { effect1: "Brand Power", effect2: "Ally Attack Enh." }
    }
  };

  // Throughput reconstruction constants (mirrored from tools/collect-stats.js;
  // overridden by DATA.meta when the baked file is present). NOT part of the DP.
  var SLOTS = 24;
  var DEF_CUTS_PER_WEEK = { uncommon: 70, rare: 26, epic: 9 };
  var DEF_FRESH_BUCKET_MIX = { "2_damage": 0.17, optimal_damage: 0.33, suboptimal_damage: 0.33, no_damage: 0.17 };
  var DEF_BOX_SCHEDULE = [{ count: 10, rarity: "uncommon" }, { count: 10, rarity: "rare" }, { count: 1, rarity: "epic" }];
  var FUSION_INPUTS = 3;

  // Verdict gold-EV bands (from the deployed page).
  var V = { green: 18000, yellowHi: 10000, yellowMid: 5000, yellowLo: 1000 };

  var DATA = null;          // baked data/pipeline.json (lazy-fetched, BAKED mode only)
  var MODE = "baked";       // 'baked' | 'live'
  var ROSTER = "nrb";       // 'nrb' | 'rb'
  var LIVE = { gpd: 1500000, grade: 65 };
  var LIVE_RESULT = null;   // last computed exact-DP live result (see computeLive)
  var LIVE_BUSY = false;    // a compute is in flight

  // ---------------------------------------------------------------------------
  // formatting
  // ---------------------------------------------------------------------------
  function fmtGold(g) {
    if (g == null) return "—";
    g = Math.round(g);
    if (g >= 1000000) {
      var m = (g / 1000000).toFixed(g >= 10000000 ? 0 : 1);
      m = m.replace(/\.0$/, "");
      return m + "M";
    }
    if (g >= 1000) {
      var k = (g / 1000).toFixed(g >= 100000 ? 0 : 1);
      k = k.replace(/\.0$/, "");
      return k + "k";
    }
    return String(g);
  }
  function fmtGoldFull(g) { return g == null ? "—" : Math.round(g).toLocaleString("en-US"); }
  function fmtPct(p) { return p == null ? "—" : (p * 100).toFixed(1) + "%"; }
  function fmtNum(x, dp) { return x == null ? "—" : Number(x).toFixed(dp == null ? 2 : dp); }

  // ---------------------------------------------------------------------------
  // verdict for ONE bucket. The fuse (purple) decision is BLOCK-level and computed by
  // gemCell — an unopened gem is fused (or not) BEFORE its side nodes are revealed, so
  // the choice is all-or-nothing across the 4 buckets — and passed in as `blockFuse`.
  // ---------------------------------------------------------------------------
  function verdict(cut, blockFuse) {
    if (blockFuse) return { cls: "v-purple", glyph: "⚜", reset: false };
    if (cut == null) return { cls: "v-red", glyph: "", reset: false };
    if (cut >= V.green) return { cls: "v-green", glyph: "↻", reset: true };
    if (cut > 0) {
      var cls = cut >= V.yellowHi ? "v-y1" : cut >= V.yellowMid ? "v-y2" : cut >= V.yellowLo ? "v-y3" : "v-y4";
      return { cls: cls, glyph: "", reset: false };
    }
    return { cls: "v-red", glyph: "", reset: false };
  }

  // ---------------------------------------------------------------------------
  // baked lookups — DIRECT KEY MATCH (no interpolation).
  //
  // The bake keys each cell by baseline = gradeToScore(grade). The UI computes the
  // SAME gradeToScore(grade) float, so String(baseline) is byte-identical and the
  // direct key hits. As a defensive guard against any float-string drift, when a
  // direct lookup misses we fall back to the cell whose baked baseline is numerically
  // closest to the requested baseline (within a tiny epsilon) — still an exact DP
  // value, never an interpolation.
  // ---------------------------------------------------------------------------
  function cellKey(rarity, cost, bucket, baseline, gpd) { return rarity + "_" + cost + "_" + bucket + "_" + baseline + "_" + gpd; }
  function thruKey(rarity, cost, baseline, gpd) { return rarity + "_" + cost + "_" + baseline + "_" + gpd; }

  // The distinct baked baseline values present in DATA (from meta if available, else
  // recovered from the cell keys), cached so the closest-match fallback is cheap.
  function bakedBaselineList() {
    if (!DATA) return [];
    if (bakedBaselineList._cache && bakedBaselineList._for === DATA) return bakedBaselineList._cache;
    var set = {};
    if (DATA.meta && DATA.meta.bakedBaselines) {
      DATA.meta.bakedBaselines.forEach(function (b) { set[b] = true; });
    } else {
      Object.keys(DATA.cells || {}).forEach(function (k) {
        var parts = k.split("_");
        // key = rarity_cost_<bucket words...>_baseline_gpd  -> baseline is 2nd-from-last
        var bl = parts[parts.length - 2];
        set[bl] = true;
      });
    }
    var list = Object.keys(set).map(Number).filter(function (x) { return isFinite(x); }).sort(function (a, b) { return a - b; });
    bakedBaselineList._cache = list; bakedBaselineList._for = DATA;
    return list;
  }

  // Nearest baked baseline to `bl` (string form, ready to drop into a key). Returns
  // null if no baked baseline is within epsilon (genuinely absent -> render "—").
  function nearestBakedBaseline(bl) {
    var list = bakedBaselineList();
    if (!list.length) return null;
    var best = null, bestD = Infinity;
    for (var i = 0; i < list.length; i++) {
      var d = Math.abs(list[i] - bl);
      if (d < bestD) { bestD = d; best = list[i]; }
    }
    // gradeToScore grades are spaced ~0.05+ apart in %-damage; 1e-6 catches only
    // true float-string drift of an otherwise-identical baseline.
    return (best != null && bestD <= 1e-6) ? best : null;
  }

  // Resolve a baked cell record by (rarity, cost, bucket, baseline, gpd): direct key
  // first, then the closest-baseline guard. Returns the cell object { nrb?, rb? } or null.
  function bakedCell(rarity, cost, bucket, baseline, gpd) {
    if (!DATA || !DATA.cells) return null;
    var c = DATA.cells[cellKey(rarity, cost, bucket, baseline, gpd)];
    if (c) return c;
    var nb = nearestBakedBaseline(baseline);
    if (nb == null) return null;
    return DATA.cells[cellKey(rarity, cost, bucket, nb, gpd)] || null;
  }
  // Per-roster bucket record (the SOURCE OF TRUTH for verdicts). EXACT DP, no interp.
  function bakedBucket(rarity, cost, bucket, baseline, gpd, roster) {
    var c = bakedCell(rarity, cost, bucket, baseline, gpd);
    return c ? (c[roster] || null) : null;
  }
  // Throughput cell record by the same direct-then-closest baseline resolution.
  function bakedThru(rarity, cost, baseline, gpd) {
    if (!DATA || !DATA.thru) return null;
    var t = DATA.thru[thruKey(rarity, cost, baseline, gpd)];
    if (t) return t;
    var nb = nearestBakedBaseline(baseline);
    if (nb == null) return null;
    return DATA.thru[thruKey(rarity, cost, nb, gpd)] || null;
  }

  // A fodder-fusion value proxy for the purple verdict: the per-gem value of fusing
  // 3 of the dominant (legendary) fodder tier at this gpd/baseline, from the core.
  // RETAINED as the graceful null-fallback only — the verdict now uses the REAL
  // unopened (rarity-upgrade) fusion value from unopenedFusion() below.
  function fuse3Proxy(cost, bl, gpd) {
    if (typeof window.fusionValueForTier !== "function") return null;
    return window.fusionValueForTier("legendary", cost, bl, gpd);
  }

  // ---------------------------------------------------------------------------
  // REAL unopened (rarity-upgrade) fusion value — the fuse-value the BLOCK-level
  // purple verdict compares against opening. Confirmed model (per (baseline, gpd)):
  //
  //   OV[roster][rar][cost] = open-value = (1·2D + 2·Op + 2·Sub + 1·No)/6 of the four
  //     buckets' cut-EVs (same 1:2:2:1 reveal odds gemCell uses).
  //   A fused output of (rar,cost) is 50% roster-bound, 50% not:
  //     E[rar][cost] = 0.5·OV_rb[rar][cost] + 0.5·U_nrb[rar][cost].
  //   U_rb[rar][cost]  = OV_rb[rar][cost]                       (RB can't re-fuse)
  //   U_nrb[rar][cost] = max(OV_nrb[rar][cost], fuseA[rar][cost])   (fixed point)
  //   fuseA[uncommon][c] = (0.85·E[unc][c] + 0.135·E[rare][c] + 0.015·E[epic][c] − 500)/3
  //   fuseA[rare][c]     = (1/3)·Out(c) + (2/3)·max_c Out(c) − 500,
  //       Out(c) = 0.52·E[unc][c] + 0.44·E[rare][c] + 0.04·E[epic][c]   (1R + 2 free L)
  //   fuseA[epic]        = null   (epics are never fused → epic blocks never purple)
  //
  // Solve U_nrb by Jacobi iteration (it's a contraction). The verdict uses the RAW
  // fuseA[rar][cost] (NOT the max) — that's the value of fusing instead of opening.
  //
  // getCut(roster, rarity, cost, bucket) -> cut EV (number) | null. Both rosters'
  // cut-EVs must be available (for the 50/50 split). Returns
  //   { uncommon:{8,9,10}, rare:{8,9,10}, epic:{8:null,9:null,10:null} }
  // of raw fuseA values, or null if any required OV bucket is null/missing (caller
  // then passes null → gemCell shows no purple, graceful).
  // ---------------------------------------------------------------------------
  var UNOPENED_FUSION_FEE = 500;
  function unopenedFusion(getCut) {
    var BW = { "2_damage": 1, "optimal_damage": 2, "suboptimal_damage": 2, "no_damage": 1 };
    // open-value (1:2:2:1 mean of the four buckets) for one roster/rarity/cost.
    function openValue(roster, rarity, cost) {
      var acc = 0, wsum = 0;
      for (var k = 0; k < BUCKETS.length; k++) {
        var cut = getCut(roster, rarity, cost, BUCKETS[k]);
        if (cut == null) return null;
        acc += BW[BUCKETS[k]] * cut; wsum += BW[BUCKETS[k]];
      }
      return wsum > 0 ? acc / wsum : null;
    }
    // Build OV[roster][rarity][cost]; bail (null) if any required value is missing.
    var OV = { nrb: {}, rb: {} };
    var rosters = ["nrb", "rb"];
    for (var rs = 0; rs < rosters.length; rs++) {
      var roster = rosters[rs];
      for (var ri = 0; ri < RARITIES.length; ri++) {
        var rar = RARITIES[ri];
        OV[roster][rar] = {};
        for (var ci = 0; ci < COSTS.length; ci++) {
          var ov = openValue(roster, rar, COSTS[ci]);
          if (ov == null) return null;
          OV[roster][rar][COSTS[ci]] = ov;
        }
      }
    }
    // Jacobi fixed point: init U_nrb = OV_nrb, recompute E/Out/fuseA each pass.
    var U_nrb = {};
    for (var r2 = 0; r2 < RARITIES.length; r2++) {
      var rr = RARITIES[r2]; U_nrb[rr] = {};
      for (var c2 = 0; c2 < COSTS.length; c2++) U_nrb[rr][COSTS[c2]] = OV.nrb[rr][COSTS[c2]];
    }
    function E(rar, cost) { return 0.5 * OV.rb[rar][cost] + 0.5 * U_nrb[rar][cost]; }
    var fuseA = null;
    for (var iter = 0; iter < 200; iter++) {
      // recompute fuseA from current U_nrb (via E/Out)
      var fA = { uncommon: {}, rare: {}, epic: {} };
      // Out(c) and its max over costs (for the rare formula)
      var Out = {}, maxOut = -Infinity;
      for (var cc = 0; cc < COSTS.length; cc++) {
        var c = COSTS[cc];
        Out[c] = 0.52 * E("uncommon", c) + 0.44 * E("rare", c) + 0.04 * E("epic", c);
        if (Out[c] > maxOut) maxOut = Out[c];
      }
      for (var cd = 0; cd < COSTS.length; cd++) {
        var cst = COSTS[cd];
        fA.uncommon[cst] = (0.85 * E("uncommon", cst) + 0.135 * E("rare", cst) + 0.015 * E("epic", cst) - UNOPENED_FUSION_FEE) / 3;
        fA.rare[cst] = (1 / 3) * Out[cst] + (2 / 3) * maxOut - UNOPENED_FUSION_FEE;
        fA.epic[cst] = null; // epics are never fused
      }
      // relax U_nrb = max(OV_nrb, fuseA) and measure the change
      var maxChange = 0;
      for (var rk = 0; rk < RARITIES.length; rk++) {
        var rn = RARITIES[rk];
        for (var ck = 0; ck < COSTS.length; ck++) {
          var co = COSTS[ck];
          var fv = fA[rn][co];
          var nv = (fv == null) ? OV.nrb[rn][co] : Math.max(OV.nrb[rn][co], fv);
          var ch = Math.abs(nv - U_nrb[rn][co]);
          if (ch > maxChange) maxChange = ch;
          U_nrb[rn][co] = nv;
        }
      }
      fuseA = fA;
      if (maxChange < 1e-9) break;
    }
    return fuseA; // raw fuse-values; epic.* === null
  }

  // ---------------------------------------------------------------------------
  // LIVE exact DP — compute a fresh-gem cut record on demand (no interpolation).
  //
  // Mirrors tools/collect-stats-worker.js exactly: build the fresh level-1 config
  // for the bucket, solve W via Solver._node (value + pAbove + expScore + expSpend +
  // act in one pass), and — for NRB — walk the SAME optimal policy to get the
  // fusion-fodder tier split (fLeg/fRelic/fAnc, normalized to 1 - pAbove).
  // ---------------------------------------------------------------------------
  function freshConfig(cost, effect1, effect2) {
    return {
      baseCost: cost, gemType: "order",
      willpowerLevel: 1, orderLevel: 1,
      effect1: effect1, effect1Level: 1,
      effect2: effect2, effect2Level: 1
    };
  }

  // --- fodder tier split (replicated from collect-stats-worker.js) -----------
  // Walk the optimal policy the Solver already memoized, folding identical
  // (config,t,r,cm) frames each layer so the work stays bounded by the small
  // reachable state space. Whenever a node terminates (t<=0 or act==='complete')
  // below baseline, add its reach-probability to acc[tier(config)].
  function clampReroll(r) { return r < 0 ? 0 : r; }
  function clampCm(cm) { return Math.max(-100, Math.min(100, cm)); }
  function cloneConfig(c) {
    return { baseCost: c.baseCost, gemType: c.gemType, willpowerLevel: c.willpowerLevel,
      orderLevel: c.orderLevel, effect1: c.effect1, effect1Level: c.effect1Level,
      effect2: c.effect2, effect2Level: c.effect2Level };
  }
  function transitionBranches(config, p) {
    var A = window;
    var t = p.type;
    if (t === "willpower" || t === "order" || t === "effect1" || t === "effect2") {
      var o = { type: p.change > 0 ? "raise_effect" : "lower_effect", target: t, amount: Math.abs(p.change) };
      return [{ config: A.applyOutcome(config, o), dCm: 0, dRerolls: 0 }];
    }
    if (t === "change_effect1" || t === "change_effect2") {
      var target = (t === "change_effect1") ? "effect1" : "effect2";
      var pool = (A.EFFECT_POOLS && A.EFFECT_POOLS[config.baseCost]) || [];
      var current = [config.effect1, config.effect2];
      var candidates = pool.filter(function (e) { return current.indexOf(e) === -1; });
      if (candidates.length === 0) return [{ config: cloneConfig(config), dCm: 0, dRerolls: 0 }];
      var branches = [];
      for (var k = 0; k < candidates.length; k++) {
        var oc = { type: "change_side_option", target: target, newEffect: candidates[k] };
        branches.push({ config: A.applyOutcome(config, oc), dCm: 0, dRerolls: 0, w: 1 / candidates.length });
      }
      return branches;
    }
    if (t === "cost") return [{ config: cloneConfig(config), dCm: p.change, dRerolls: 0 }];
    if (t === "reroll") return [{ config: cloneConfig(config), dCm: 0, dRerolls: p.change || 1 }];
    return [{ config: cloneConfig(config), dCm: 0, dRerolls: 0 }];
  }
  function childConfigs(config, t, r, cm) {
    var A = window;
    var op = A.outcomeProbabilities({ config: config, processCostMultiplier: cm || 0, turnsRemaining: t });
    var out = [];
    for (var i = 0; i < op.possibilities.length; i++) {
      var p = op.possibilities[i];
      var branches = transitionBranches(config, p);
      for (var b = 0; b < branches.length; b++) {
        var br = branches[b];
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
  function fodderTierSplit(solver, rootConfig, t0, r0) {
    var A = window;
    var acc = { legendary: 0, relic: 0, ancient: 0 };
    var baseline = solver.baseline;
    function keyOf(c, t, r, cm) {
      return c.willpowerLevel + "|" + c.orderLevel + "|" + c.effect1 + ":" + c.effect1Level
        + "|" + c.effect2 + ":" + c.effect2Level + "|" + t + "|" + r + "|" + cm;
    }
    function pushFrame(map, config, t, r, cm, prob) {
      var k = keyOf(config, t, r, cm);
      var e = map.get(k);
      if (e) e.prob += prob;
      else map.set(k, { config: config, t: t, r: r, cm: cm, prob: prob });
    }
    function addFodder(c, prob) {
      if (A.score(c) < baseline) acc[A.classifyTier(A.levelSum(c))] += prob;
    }
    var frontier = new Map();
    pushFrame(frontier, rootConfig, t0, r0, 0, 1);
    while (frontier.size > 0) {
      var next = new Map();
      frontier.forEach(function (f) {
        var c = f.config, t = f.t, r = f.r, cm = f.cm, prob = f.prob;
        if (prob <= 0) return;
        if (t <= 0) { addFodder(c, prob); return; }
        var act = solver._node(c, t, r, cm).act;
        if (act === "complete") { addFodder(c, prob); return; }
        if (act === "reroll") { pushFrame(next, c, t, r - 1, cm, prob); return; }
        var kids = childConfigs(c, t, r, cm);
        for (var i = 0; i < kids.length; i++) {
          var k = kids[i];
          pushFrame(next, k.config, t - 1, k.r, k.cm, prob * k.prob);
        }
      });
      frontier = next;
    }
    return acc;
  }

  // Exact per-bucket record for ONE (rarity, cost, bucket, baseline, gpd, roster).
  // { cut, pAbove, expScore, [fLeg, fRelic, fAnc] }. Replicates the worker.
  function liveBucketDP(rarity, cost, bucket, baseline, gpd, roster) {
    var eff = EFFECT_BUCKETS[cost][bucket];
    var cfg = freshConfig(cost, eff.effect1, eff.effect2);
    var R = window.RARITY[rarity];
    var solver = new window.Solver(baseline, gpd, roster === "rb", { maxTurns: R.maxTurns });
    var rec = solver._node(cfg, R.maxTurns, R.maxRerolls, 0);
    var out = { cut: rec.v, pAbove: rec.pAbove, expScore: rec.expScore, expSpend: rec.expSpend };
    if (roster === "nrb") {
      var below = Math.max(0, 1 - rec.pAbove);
      var fl = 0, fr = 0, fa = 0;
      if (below > 1e-9) {
        var split = fodderTierSplit(solver, cfg, R.maxTurns, R.maxRerolls);
        var tot = split.legendary + split.relic + split.ancient;
        if (tot > 0) { var s = below / tot; fl = split.legendary * s; fr = split.relic * s; fa = split.ancient * s; }
      }
      out.fLeg = fl; out.fRelic = fr; out.fAnc = fa;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // render: one bucket-stacked gem cell (4 rows: 2D / Op / Sub / No)
  // getBucket(bucket) -> { cut, pAbove, ... } | null
  // ---------------------------------------------------------------------------
  function gemCell(getBucket, fuse3, roster, sep) {
    // BLOCK-level fuse decision: an unopened gem is fused (or not) BEFORE its side
    // nodes are revealed, so it's all-or-nothing across the 4 buckets. Opening instead
    // yields a random bucket with odds 2D:Op:Sub:No = 1:2:2:1, so the value of opening
    // is that weighted mean of the buckets' cut-EVs. Fuse the whole block iff the
    // fodder-fusion value beats opening.
    var BW = { "2_damage": 1, "optimal_damage": 2, "suboptimal_damage": 2, "no_damage": 1 };
    var blockFuse = false;
    if (roster === "nrb" && fuse3 != null) {
      var acc = 0, wsum = 0, ok = true;
      for (var k = 0; k < BUCKETS.length; k++) {
        var xb = getBucket(BUCKETS[k]);
        if (!xb || xb.cut == null) { ok = false; break; }
        acc += BW[BUCKETS[k]] * xb.cut; wsum += BW[BUCKETS[k]];
      }
      if (ok) blockFuse = fuse3 > (acc / wsum);
    }
    var rows = "";
    for (var i = 0; i < BUCKETS.length; i++) {
      var b = BUCKETS[i];
      var x = getBucket(b);
      var cut = x ? x.cut : null;
      var pa = x ? x.pAbove : null;
      var v = verdict(cut, blockFuse);
      rows += '<div class="bkt-row ' + v.cls + '">'
        + '<span class="bkt-label">' + BUCKET_LABEL[b] + '</span>'
        + '<span class="bkt-val">' + fmtGold(cut) + '</span>'
        + '<span class="bkt-pct">' + fmtPct(pa) + '</span>'
        + '<span class="bkt-reset">' + v.glyph + '</span>'
        + '</div>';
    }
    return '<td class="gem' + (sep ? " sep" : "") + '"><div class="bkt-grid">' + rows + '</div></td>';
  }

  function weeksClass(w) { return w == null ? "slow" : (w <= 8 ? "fast" : (w <= 26 ? "med" : "slow")); }

  // ---------------------------------------------------------------------------
  // Single-lane Pipeline aggregate from EXACT baked throughput cells. Sum the three
  // rarity lanes' Direct/Fuse/Gold, derive Total + Weeks from the sums (identities
  // stay exact); Box EV / Avg Score are cell-level (taken from the cost-`cost` lane).
  // Direct key lookup on each baked thru cell — no interpolation.
  // ---------------------------------------------------------------------------
  function aggThruBaked(baseline, gpd, cost) {
    var d = 0, f = 0, gold = 0, any = false;
    for (var ri = 0; ri < RARITIES.length; ri++) {
      var t = bakedThru(RARITIES[ri], cost, baseline, gpd);
      if (!t) continue;
      any = true;
      d += t.directPerWk || 0; f += t.fusePerWk || 0; gold += t.goldPerWk || 0;
    }
    if (!any) return null;
    var c0 = bakedThru(RARITIES[0], cost, baseline, gpd);
    var tot = d + f;
    return {
      directPerWk: Math.round(d * 100) / 100,
      fusePerWk: Math.round(f * 100) / 100,
      totalPerWk: Math.round(tot * 100) / 100,
      weeks: tot > 0 ? Math.round((SLOTS / tot) * 10) / 10 : null,
      goldPerWk: Math.round(gold),
      boxEV: c0 ? c0.boxEV : null, avgScore: c0 ? c0.avgScore : null
    };
  }

  // ---------------------------------------------------------------------------
  // BAKED table for one gpd tier (roster = 'nrb' | 'rb'). EXACT DP cells, direct lookup.
  // ---------------------------------------------------------------------------
  function bakedTable(gpd, roster) {
    var isNrb = roster === "nrb";

    var head = '<table class="pipe-table"><thead>'
      + '<tr><th rowspan="2">Grade</th>'
      + '<th colspan="3" class="sep">Uncommon</th>'
      + '<th colspan="3" class="sep">Rare</th>'
      + '<th colspan="3" class="sep">Epic</th>'
      + (isNrb ? '<th colspan="8" class="sep">Pipeline (per week)</th>' : '')
      + '</tr><tr>'
      + '<th class="sep">c8</th><th>c9</th><th>c10</th>'
      + '<th class="sep">c8</th><th>c9</th><th>c10</th>'
      + '<th class="sep">c8</th><th>c9</th><th>c10</th>'
      + (isNrb
        ? '<th class="sep">Boxes</th><th>Box EV</th><th>Direct<br>/wk</th><th>Fuse<br>/wk</th>'
          + '<th>Total<br>/wk</th><th>Weeks</th><th>Gold</th><th>Avg<br>Score</th>'
        : '')
      + '</tr></thead><tbody>';

    var box = (DATA.meta && DATA.meta.boxSchedule) || DEF_BOX_SCHEDULE;
    var boxTxt = box.map(function (s) { return s.count + "x" + s.rarity.slice(0, 3); }).join("<br>");

    var body = "";
    for (var bi = 0; bi < GRADE_ROWS.length; bi++) {
      var grade = GRADE_ROWS[bi];
      var blPct = window.gradeToScore(grade);   // grade -> %-damage threshold (= baked key)
      var rank = window.rankFromGrade(grade);
      var row = '<tr><td class="pipe blcell"><b>' + grade + '</b> <span class="dim">(' + rank + ')</span></td>';
      // REAL unopened-fusion value for this (grade, gpd). bakedBucket takes the roster
      // arg, so BOTH nrb & rb OVs are available → solve the fixed point once per row.
      var fuseA = unopenedFusion(function (rs, r, c, b) {
        var rec = bakedBucket(r, c, b, blPct, gpd, rs);
        return rec ? rec.cut : null;
      });
      for (var ri = 0; ri < RARITIES.length; ri++) {
        for (var ci = 0; ci < COSTS.length; ci++) {
          (function (rarity, cost, sep) {
            var f3 = fuseA && fuseA[rarity] ? fuseA[rarity][cost] : null;
            // DIRECT baked lookup per bucket — the exact DP cell at this grade's baseline.
            row += gemCell(function (b) { return bakedBucket(rarity, cost, b, blPct, gpd, roster); }, f3, roster, sep);
          })(RARITIES[ri], COSTS[ci], ci === 0);
        }
      }
      if (isNrb) {
        var agg = aggThruBaked(blPct, gpd, 9);
        row += '<td class="pipe sep boxcell">' + (boxTxt || "—") + '</td>'
          + '<td class="pipe num">' + (agg ? fmtGoldFull(agg.boxEV) : "—") + '</td>'
          + '<td class="pipe num">' + (agg ? fmtNum(agg.directPerWk) : "—") + '</td>'
          + '<td class="pipe num">' + (agg ? fmtNum(agg.fusePerWk) : "—") + '</td>'
          + '<td class="pipe num"><b>' + (agg ? fmtNum(agg.totalPerWk) : "—") + '</b></td>'
          + '<td class="pipe num ' + weeksClass(agg ? agg.weeks : null) + '">' + (agg && agg.weeks != null ? agg.weeks : "—") + '</td>'
          + '<td class="pipe num">' + (agg ? fmtGold(agg.goldPerWk) + "/wk" : "—") + '</td>'
          + '<td class="pipe num"><b>' + (agg ? fmtNum(agg.avgScore) : "—") + '</b></td>';
      }
      row += "</tr>";
      body += row;
    }
    return head + body + "</tbody></table>";
  }

  // ---------------------------------------------------------------------------
  // Fodder VALUE per gem by tier — depends only on (cost, baseline, gpd) via the
  // core's fusionValueForTier, so it's identical for baked and live (and exact).
  function fodderValueTable(gpd, bl) {
    if (typeof window.fusionValueForTier !== "function") return "";
    var rows = "";
    for (var ci = 0; ci < COSTS.length; ci++) {
      var c = COSTS[ci];
      rows += '<tr><td>c' + c + '</td>'
        + '<td class="num sep"><span class="legendary">' + fmtGold(window.fusionValueForTier("legendary", c, bl, gpd)) + '</span></td>'
        + '<td class="num"><span class="relic">' + fmtGold(window.fusionValueForTier("relic", c, bl, gpd)) + '</span></td>'
        + '<td class="num"><span class="ancient">' + fmtGold(window.fusionValueForTier("ancient", c, bl, gpd)) + '</span></td></tr>';
    }
    return '<p class="note"><b>Fodder value per gem</b> — what ONE below-baseline gem of each tier is worth as '
      + 'fusion material (3→1). This is why even a "No"/below-baseline gem is never zero.</p>'
      + '<table class="pipe-table"><thead><tr><th>Cost</th>'
      + '<th class="sep">Legendary</th><th>Relic</th><th>Ancient</th></tr></thead><tbody>'
      + rows + '</tbody></table>';
  }

  // Fusion / fodder by tier section (the "for after" view). Below-baseline cuts
  // become fodder; this shows where that fodder lands per rarity/cost, averaged over
  // the fresh-drop bucket mix. getBucket(rarity,cost,bucket) -> exact record (baked
  // direct lookup or live DP) carrying fLeg/fRelic/fAnc/pAbove.
  function fodderSection(gpd, blPct, grade, getBucket) {
    var mix = (DATA && DATA.meta && DATA.meta.freshBucketMix) || DEF_FRESH_BUCKET_MIX;
    var rows = "";
    for (var ri = 0; ri < RARITIES.length; ri++) {
      var rarity = RARITIES[ri];
      for (var ci = 0; ci < COSTS.length; ci++) {
        var cost = COSTS[ci];
        var fl = 0, fr = 0, fa = 0, pa = 0, wsum = 0;
        for (var bi = 0; bi < BUCKETS.length; bi++) {
          var b = BUCKETS[bi];
          var x = getBucket(rarity, cost, b);
          if (!x) continue;
          var w = mix[b] || 0;
          fl += w * (x.fLeg || 0); fr += w * (x.fRelic || 0); fa += w * (x.fAnc || 0);
          pa += w * (x.pAbove || 0); wsum += w;
        }
        if (wsum > 0) { fl /= wsum; fr /= wsum; fa /= wsum; pa /= wsum; }
        var fodder = fl + fr + fa;
        rows += '<tr><td><b>' + RARITY_LABEL[rarity] + '</b></td><td>c' + cost + '</td>'
          + '<td class="num sep">' + fmtPct(pa) + '</td>'
          + '<td class="num">' + fmtPct(fodder) + '</td>'
          + '<td class="num sep"><span class="legendary">' + fmtPct(fl) + '</span></td>'
          + '<td class="num"><span class="relic">' + fmtPct(fr) + '</span></td>'
          + '<td class="num"><span class="ancient">' + fmtPct(fa) + '</span></td></tr>';
      }
    }
    return '<h2 id="fodder">Fusion / fodder by tier (Leg / Relic / Anc) — for after</h2>'
      + '<p class="note">A below-baseline cut is <b>fodder</b>: classified by tier (level-sum), 3 fuse into 1. '
      + 'This is the secondary axis — the cut decision above is per bucket. Columns: P(cut clears baseline), '
      + 'P(becomes fodder), and the fodder tier split (sums to P(fodder)). Averaged over the fresh-drop bucket mix '
      + 'at ' + fmtGold(gpd) + '/1% dmg, baseline grade ' + grade + ' (' + window.rankFromGrade(grade) + ').</p>'
      + fodderValueTable(gpd, blPct)
      + '<table class="pipe-table"><thead><tr><th>Rarity</th><th>Cost</th>'
      + '<th class="sep">P(above)</th><th>P(fodder)</th>'
      + '<th class="sep">Leg</th><th>Relic</th><th>Anc</th></tr></thead><tbody>'
      + rows + '</tbody></table>';
  }

  // ---------------------------------------------------------------------------
  // BAKED view (all fixed gpd tiers, NRB then RB) + fodder section — exact DP cells.
  // ---------------------------------------------------------------------------
  function bakedResults() {
    var out = '<div class="toc"><b>Jump to:</b> '
      + '<a href="#nrb">Non-Roster Bound</a> <a href="#rb">Roster Bound</a> <a href="#fodder">Fusion / fodder</a></div>';
    out += '<h1 class="sec" id="nrb">Non-Roster Bound</h1>'
      + '<p class="note">NRB gems cost gold to cut. Each cell stacks the four buckets '
      + '(<b>2D</b> / <b>Op</b> / <b>Sub</b> / <b>No</b>); the number is the exact DP value of cutting a fresh gem '
      + 'of that archetype, read by direct lookup from the baked exact-DP grid, colored by verdict. '
      + 'The Pipeline group is the weekly production flow.</p>';
    for (var i = 0; i < FIXED_GPD.length; i++) {
      out += '<h2>' + fmtGold(FIXED_GPD[i]) + ' gold / 1% damage — NRB</h2>' + bakedTable(FIXED_GPD[i], "nrb");
    }
    out += '<h1 class="sec" id="rb">Roster Bound</h1>'
      + '<p class="note">Roster-bound gems are free to cut — always cut. Per-bucket exact-DP cut value + % above baseline shown (no pipeline lane).</p>';
    for (var j = 0; j < FIXED_GPD.length; j++) {
      out += '<h2>' + fmtGold(FIXED_GPD[j]) + ' gold / 1% damage — RB</h2>' + bakedTable(FIXED_GPD[j], "rb");
    }
    // Fodder section uses a representative tier (1.5M, baseline grade 65). Direct
    // lookup of the exact baked cell at that grade's baseline.
    var fodGrade = 65, fodBl = window.gradeToScore(fodGrade);
    out += fodderSection(1500000, fodBl, fodGrade, function (rarity, cost, b) { return bakedBucket(rarity, cost, b, fodBl, 1500000, "nrb"); });
    return out;
  }

  // ---------------------------------------------------------------------------
  // LIVE exact-DP compute (chunked, runs on Recalculate). Computes all 36 cells
  // (3 rarities x 3 costs x 4 buckets) at the user's exact gpd + gradeToScore(grade)
  // for BOTH rosters, plus the throughput block derived exactly from those cells.
  // Reports progress via a bar; yields between chunks so the page stays responsive.
  // ---------------------------------------------------------------------------
  function computeLive(gpd, grade, onProgress, onDone) {
    var blPct = window.gradeToScore(grade);
    // Build the job list: every (roster, rarity, cost, bucket). RB skips fodder.
    var jobs = [];
    var rosters = ["nrb", "rb"];
    for (var rsi = 0; rsi < rosters.length; rsi++) {
      for (var ri = 0; ri < RARITIES.length; ri++) {
        for (var ci = 0; ci < COSTS.length; ci++) {
          for (var bi = 0; bi < BUCKETS.length; bi++) {
            jobs.push({ roster: rosters[rsi], rarity: RARITIES[ri], cost: COSTS[ci], bucket: BUCKETS[bi] });
          }
        }
      }
    }
    var total = jobs.length;
    var cells = { nrb: {}, rb: {} }; // cells[roster][rarity_cost_bucket] = record
    var done = 0, idx = 0;
    var CHUNK = 2; // a couple of cells per tick (epic turn-1 ≈ 2-3s each) then yield

    function recKey(rarity, cost, bucket) { return rarity + "_" + cost + "_" + bucket; }

    function step() {
      var t0 = Date.now();
      // Compute until the chunk budget is hit or ~120ms elapsed (whichever first),
      // then yield so the progress bar can paint.
      var did = 0;
      while (idx < total && did < CHUNK && (Date.now() - t0) < 120) {
        var j = jobs[idx++];
        var rec = liveBucketDP(j.rarity, j.cost, j.bucket, blPct, gpd, j.roster);
        cells[j.roster][recKey(j.rarity, j.cost, j.bucket)] = rec;
        did++; done++;
      }
      if (onProgress) onProgress(done, total);
      if (idx < total) {
        setTimeout(step, 0);
      } else {
        // Build throughput EXACTLY from the computed NRB cells (mirrors the bake's
        // assemble() identities). Per (rarity,cost): freshPAbove over the mix, then
        // direct/fuse/gold, then aggregate the three rarity lanes per cost.
        var result = { gpd: gpd, grade: grade, blPct: blPct, cells: cells, thru: buildLiveThru(cells.nrb, blPct, gpd) };
        if (onDone) onDone(result);
      }
    }
    setTimeout(step, 0);
  }

  // Exact throughput from the live NRB cells — same reconstruction as
  // tools/collect-stats.js assemble(): direct/wk = cuts * mix-weighted pAbove;
  // fuse/wk recycles below-baseline fodder (3->1) through the legendary lane;
  // gold/wk = box gold + cuts * mix-weighted max(0,cut). Per-rarity lanes (cost 9)
  // plus a single aggregate lane per cost (summing the three rarities).
  function buildLiveThru(nrbCells, blPct, gpd) {
    var cuts = (DATA && DATA.meta && DATA.meta.cutsPerWeek) || DEF_CUTS_PER_WEEK;
    var mix = (DATA && DATA.meta && DATA.meta.freshBucketMix) || DEF_FRESH_BUCKET_MIX;
    var box = (DATA && DATA.meta && DATA.meta.boxSchedule) || DEF_BOX_SCHEDULE;
    function recKey(rarity, cost, bucket) { return rarity + "_" + cost + "_" + bucket; }
    function get(rarity, cost, bucket) { return nrbCells[recKey(rarity, cost, bucket)] || null; }

    function freshPAbove(rarity, cost) {
      var p = 0, wsum = 0;
      for (var bi = 0; bi < BUCKETS.length; bi++) {
        var nb = get(rarity, cost, BUCKETS[bi]);
        if (!nb) continue;
        var w = mix[BUCKETS[bi]] || 0;
        p += w * (nb.pAbove || 0); wsum += w;
      }
      return wsum > 0 ? p / wsum : 0;
    }
    function fusionOutPAbove(rarity, cost) {
      // legendary-3-fusion output is dominantly legendary; the bake uses
      // mix.legendary * freshPAbove as a documented conservative proxy. The
      // legendary share of a 3xLeg fusion output (~0.99) — read from the core when
      // available, else the bake's published 0.99.
      var legShare = 0.99;
      if (typeof window.fusionOutputDist === "function") {
        var m = window.fusionOutputDist(["legendary", "legendary", "legendary"]);
        if (m && isFinite(m.legendary)) legShare = m.legendary;
      }
      return legShare * freshPAbove(rarity, cost);
    }
    function cutValMix(rarity, cost) {
      var v = 0, wsum = 0;
      for (var bi = 0; bi < BUCKETS.length; bi++) {
        var nb = get(rarity, cost, BUCKETS[bi]);
        if (!nb) continue;
        var w = mix[BUCKETS[bi]] || 0;
        v += w * Math.max(0, nb.cut); wsum += w;
      }
      return wsum > 0 ? v / wsum : 0;
    }
    function boxEVat(cost) {
      var ev = 0;
      for (var b = 0; b < box.length; b++) {
        var nb = get(box[b].rarity, cost, "2_damage");
        if (nb) ev += box[b].count * Math.max(0, nb.cut);
      }
      return ev;
    }

    // Per-rarity lane (cost 9, like the live throughput table the page showed).
    var perRarity = {};
    for (var ri = 0; ri < RARITIES.length; ri++) {
      var rarity = RARITIES[ri], c = cuts[rarity] || 0, cost = 9;
      var pa = freshPAbove(rarity, cost);
      var direct = c * pa;
      var fuse = (c * (1 - pa) / FUSION_INPUTS) * fusionOutPAbove(rarity, cost);
      var tot = direct + fuse;
      var nb2D = get(rarity, cost, "2_damage");
      perRarity[rarity] = {
        directPerWk: Math.round(direct * 100) / 100,
        fusePerWk: Math.round(fuse * 100) / 100,
        totalPerWk: Math.round(tot * 100) / 100,
        weeks: tot > 0 ? Math.round((SLOTS / tot) * 10) / 10 : null,
        goldPerWk: Math.round(boxEVat(cost) + c * cutValMix(rarity, cost)),
        avgScore: nb2D ? nb2D.expScore : blPct
      };
    }
    // Single aggregate lane per cost (sum the three rarity lanes' direct/fuse/gold).
    function aggForCost(cost) {
      var d = 0, f = 0, gold = 0;
      for (var ri2 = 0; ri2 < RARITIES.length; ri2++) {
        var rarity2 = RARITIES[ri2], c2 = cuts[rarity2] || 0;
        var pa2 = freshPAbove(rarity2, cost);
        d += c2 * pa2;
        f += (c2 * (1 - pa2) / FUSION_INPUTS) * fusionOutPAbove(rarity2, cost);
        gold += boxEVat(cost) / RARITIES.length + c2 * cutValMix(rarity2, cost);
      }
      var nb2D = get(RARITIES[0], cost, "2_damage");
      var tot = d + f;
      return {
        directPerWk: Math.round(d * 100) / 100,
        fusePerWk: Math.round(f * 100) / 100,
        totalPerWk: Math.round(tot * 100) / 100,
        weeks: tot > 0 ? Math.round((SLOTS / tot) * 10) / 10 : null,
        goldPerWk: Math.round(gold),
        boxEV: Math.round(boxEVat(cost)),
        avgScore: nb2D ? nb2D.expScore : blPct
      };
    }
    return { perRarity: perRarity, agg9: aggForCost(9) };
  }

  // ---------------------------------------------------------------------------
  // LIVE view — render the last computed exact-DP result (or a prompt to compute).
  // ---------------------------------------------------------------------------
  function liveResults() {
    var roster = ROSTER;
    if (LIVE_BUSY) {
      // The progress UI is rendered separately (renderLiveProgress); keep the host
      // content stable while computing.
      return liveProgressHtml();
    }
    if (!LIVE_RESULT) {
      return '<div class="placeholder"><b>Live exact-DP mode</b>'
        + '<div class="note">Set a gold-per-1%-damage and a baseline grade above, then click '
        + '<b>Recalculate</b>. The tool will solve the exact Bellman DP on demand for all 36 cells '
        + '(3 rarities × 3 costs × 4 buckets) at your exact numbers — no interpolation. This takes '
        + '~60–90 seconds; a progress bar will show while it runs.</div></div>';
    }

    var res = LIVE_RESULT;
    var gpd = res.gpd, grade = res.grade, blPct = res.blPct;
    var rank = window.rankFromGrade(grade);
    var cellsR = res.cells[roster] || {};
    function recKey(rarity, cost, bucket) { return rarity + "_" + cost + "_" + bucket; }
    function getBucket(rarity, cost, bucket) { return cellsR[recKey(rarity, cost, bucket)] || null; }

    // REAL unopened-fusion value. computeLive solves BOTH rosters (res.cells.nrb &
    // res.cells.rb), so the 50/50 split uses each roster's true OV — no approximation.
    var liveNrb = res.cells.nrb || {}, liveRb = res.cells.rb || {};
    var liveFuseA = unopenedFusion(function (rs, r, c, b) {
      var src = (rs === "rb") ? liveRb : liveNrb;
      var rec = src[recKey(r, c, b)];
      return rec ? rec.cut : null;
    });

    var head = '<table class="pipe-table"><thead>'
      + '<tr><th rowspan="2">Grade</th>'
      + '<th colspan="3" class="sep">Uncommon</th>'
      + '<th colspan="3" class="sep">Rare</th>'
      + '<th colspan="3" class="sep">Epic</th></tr><tr>'
      + '<th class="sep">c8</th><th>c9</th><th>c10</th>'
      + '<th class="sep">c8</th><th>c9</th><th>c10</th>'
      + '<th class="sep">c8</th><th>c9</th><th>c10</th></tr></thead><tbody>';
    var row = '<tr><td class="pipe blcell"><b>' + grade + '</b> <span class="dim">(' + rank + ')</span></td>';
    for (var ri = 0; ri < RARITIES.length; ri++) {
      for (var ci = 0; ci < COSTS.length; ci++) {
        (function (rarity, cost, sep) {
          var f3 = liveFuseA && liveFuseA[rarity] ? liveFuseA[rarity][cost] : null;
          row += gemCell(function (b) { return getBucket(rarity, cost, b); }, f3, roster, sep);
        })(RARITIES[ri], COSTS[ci], ci === 0);
      }
    }
    row += "</tr>";
    var gemTbl = head + row + "</tbody></table>";

    // Weekly throughput (exact from the computed cells) — per rarity, cost 9.
    var thruTbl = "";
    if (roster === "nrb" && res.thru) {
      var pr = res.thru.perRarity;
      thruTbl = '<h2>Weekly throughput (exact DP)</h2>'
        + '<table class="pipe-table"><thead><tr><th>Rarity</th><th class="sep num">Direct/wk</th>'
        + '<th class="num">Fuse/wk</th><th class="num">Total/wk</th><th class="num">Weeks to ' + SLOTS + '</th>'
        + '<th class="num">Gold/wk</th><th class="num">Avg Score</th></tr></thead><tbody>';
      for (var rj = 0; rj < RARITIES.length; rj++) {
        var rar = RARITIES[rj];
        var t = pr[rar] || {};
        thruTbl += '<tr><td><b>' + RARITY_LABEL[rar] + '</b></td>'
          + '<td class="sep num">' + fmtNum(t.directPerWk) + '</td><td class="num">' + fmtNum(t.fusePerWk) + '</td>'
          + '<td class="num"><b>' + fmtNum(t.totalPerWk) + '</b></td>'
          + '<td class="num ' + weeksClass(t.weeks) + '">' + (t.weeks == null ? "—" : t.weeks.toFixed(1)) + '</td>'
          + '<td class="num">' + (t.goldPerWk == null ? "—" : fmtGold(t.goldPerWk) + "/wk") + '</td>'
          + '<td class="num">' + fmtNum(t.avgScore) + '</td></tr>';
      }
      thruTbl += '</tbody></table>';
    }

    // Fodder section (exact from the computed NRB cells).
    var fod = "";
    if (roster === "nrb") {
      var nrbCells = res.cells.nrb || {};
      fod = fodderSection(gpd, blPct, grade, function (rarity, cost, b) { return nrbCells[recKey(rarity, cost, b)] || null; });
    }

    return '<h2>Per-bucket cut value — ' + fmtGold(gpd) + ' gold / 1% damage, baseline grade ' + grade + ' (' + rank + ')'
      + ' (' + (roster === "nrb" ? "Non-Roster Bound" : "Roster Bound") + ')</h2>'
      + '<p class="note"><b>Exact DP, computed on demand</b> — every cell is a fresh Bellman-DP solve at your exact gold + grade, '
      + 'with no interpolation. Each cell stacks the four buckets; the number is the cut value of a fresh gem of that archetype. '
      + 'Verdict bands: green ≥ ' + fmtGold(V.green) + ' (reset-worthy) · yellow > 0 · red ≤ 0 · purple = fuse first.</p>'
      + gemTbl + thruTbl + fod;
  }

  function liveProgressHtml() {
    return '<div class="placeholder"><b id="pl-prog-title">Computing exact DP…</b>'
      + '<div class="note">Solving the exact Bellman DP for all 36 cells at your exact gold + grade — no interpolation. '
      + 'This is the slow-but-exact path (~60–90s).</div>'
      + '<div class="pl-progwrap"><div class="pl-prog" id="pl-prog"><i id="pl-prog-i"></i></div>'
      + '<div class="pl-progtxt" id="pl-prog-txt">0%</div></div></div>';
  }

  // ---------------------------------------------------------------------------
  // legend
  // ---------------------------------------------------------------------------
  function legendHtml() {
    return '<div class="legend-box"><div class="lg-title">How to read these tables</div>'
      + '<div class="grid c2"><div>'
      + '<div class="lg-h">Gem cells — stacked by BUCKET</div>'
      + '<p class="note">Each cost cell stacks the four effect-pair buckets: '
      + '<b>2D</b> (both damage) · <b>Op</b> (best single damage) · <b>Sub</b> (worse single damage) · <b>No</b> (no damage). '
      + 'Per row: the <b>net EV of cutting</b> a fresh gem of that archetype (expected gold AFTER the ~900g/process cost) and its '
      + '<b>% chance to beat your baseline grade</b>. <b>The EV size is the marginality measure</b> — bigger = more worth cutting, '
      + 'near 0 = marginal, ≤0 (or ⚜ = fuse instead) = don\'t cut. Note: at a high gold-per-1%-damage almost every gem is '
      + 'positive-EV, so prioritise by EV size, not just by color. You beat your baseline <b>grade</b> (0–100; your weakest '
      + 'equipped gem\'s grade, converted to a %-damage threshold internally). Values rise with rarity (more turns/rerolls).</p>'
      + '<div class="lg-h">Verdict colors</div>'
      + '<p><span class="sw v-green"></span> <b>Green</b> (≥ ' + fmtGold(V.green) + ') — worth resetting if below baseline (↻)<br>'
      + '<span class="sw v-y1"></span><span class="sw v-y2"></span><span class="sw v-y3"></span> <b>Yellow–dim</b> (&gt; 0) — cut, don\'t reset<br>'
      + '<span class="sw v-red"></span> <b>Red</b> (≤ 0) — don\'t cut<br>'
      + '<span class="sw v-purple"></span> <b>Purple</b> (⚜) — fuse pre-cutting (NRB; fusing the fodder beats the weak cut)</p>'
      + '</div><div>'
      + '<div class="lg-h">Pipeline (NRB only, per week)</div>'
      + '<p class="note"><b>Direct/wk</b> — above-baseline gems/week from cutting.<br>'
      + '<b>Fuse/wk</b> — above-baseline gems/week from recycling fodder (3→1).<br>'
      + '<b>Total/wk</b> = Direct + Fuse · <b>Weeks</b> = ' + SLOTS + ' / Total/wk.<br>'
      + '<span class="sw fast"></span>≤8 &nbsp; <span class="sw med"></span>8–26 &nbsp; <span class="sw slow"></span>&gt;26 weeks<br>'
      + '<b>Gold</b> — weekly gold inflow · <b>Avg Score</b> — % damage of the avg keeper.</p>'
      + '<div class="lg-h">Tier = fusion fodder ("for after")</div>'
      + '<p class="note">Tier (Leg / Relic / Anc by level-sum) is NOT the cut axis — it classifies the FODDER a failed cut '
      + 'becomes. See the "Fusion / fodder by tier" section below.</p>'
      + '</div></div></div>';
  }

  function methodologyHtml() {
    return '<details class="method"><summary>Methodology</summary>'
      + '<p><b>The cut decision is per BUCKET (effect pair).</b> When a gem drops, its two effects are its archetype: '
      + '<b>2_damage</b> (both damage), <b>optimal_damage</b> (better single damage + dead), <b>suboptimal_damage</b> '
      + '(worse single damage + dead), <b>no_damage</b> (both dead). The exact effect pairs per base cost are fixed '
      + '(see data/pipeline.json meta.effectBuckets).</p>'
      + '<p><b>Cut value = exact Bellman DP.</b> A bucket\'s value is W(freshGem, maxTurns[rarity], maxRerolls[rarity]), '
      + 'the optimal expected gold from cutting a fresh level-1 gem of that archetype, taking the expectation over the '
      + 'random 4-draw inside (model/dp.js). It is deterministic (no Monte Carlo). Values increase with rarity because '
      + 'epic gets 9 turns / 3 rerolls vs uncommon\'s 5 / 1.</p>'
      + '<p><b>Scoring is real % damage.</b> Each line scores D = 100·ln(multiplier) (additive in log space, ≈ % damage); '
      + 'a perfect gem ≈ 1.3–1.4%. Baseline is entered as a 0–100 <b>grade</b> (your weakest equipped gem\'s grade), '
      + 'converted to its %-damage threshold via gradeToScore(); gold value = '
      + 'max(0,(score−threshold)) × goldPerDamage (gold per 1% damage).</p>'
      + '<p><b>Tier is the fusion fodder, not the cut axis.</b> A below-baseline cut becomes fodder, classified by '
      + 'level-sum tier (legendary 4–15, relic 16–18, ancient 19–20) and fused 3→1. The bake records the per-bucket '
      + 'fodder tier split (p_fodder_leg/relic/anc, summing to 1−P(above)) by walking the SAME optimal policy the value '
      + 'uses; live mode walks that same policy on demand. Shown separately in "Fusion / fodder by tier".</p>'
      + '<p><b>Verdict colors</b> reproduce the deployed ark-grid-solver page: green ≥ 18k (reset-worthy), a yellow→dim '
      + 'ramp for >0 (10–18k / 5–10k / 1–5k / <1k), red ≤ 0 (don\'t cut), purple = fuse the fodder before cutting (NRB).</p>'
      + '<p><b>Throughput</b> is a documented reconstruction (the deployed page\'s weekly generator was not part of the '
      + 'model core): Direct/wk = weekly cut budget × P(above) over the fresh-drop bucket mix; Fuse/wk recycles '
      + 'below-baseline cuts (3→1); Total/wk = Direct+Fuse; Weeks = ' + SLOTS + '/Total/wk. Constants (cut budget, box '
      + 'schedule, bucket mix) are in data/pipeline.json meta and METHODOLOGY.md — retunable without touching the DP.</p>'
      + '<p><b>No interpolation anywhere.</b> Baked tables read each cell by direct key lookup from the baked exact-DP '
      + 'grid (one solve per grade row at baseline = gradeToScore(grade)). Live mode computes the exact DP on demand in '
      + 'the browser for every cell at your exact gold + grade — slower (~60–90s, run on Recalculate), but exact.</p>'
      + '</details>';
  }

  // ---------------------------------------------------------------------------
  // inputs (sticky, collapsible)
  // ---------------------------------------------------------------------------
  function inputsHtml() {
    return '<div class="inputs" id="pl-inputs">'
      + '<div class="ihdr"><span>Pipeline inputs</span>'
      + '<span class="tgl" id="pl-caret" onclick="window.__plToggleInputs()">▾</span></div>'
      + '<div id="pl-inbody"><div class="barrow">'
      + '<span class="mbtn ' + (MODE === "baked" ? "active" : "") + '" id="pl-m-baked" onclick="window.__plSetMode(\'baked\')">Baked tiers</span>'
      + '<span class="mbtn ' + (MODE === "live" ? "active" : "") + '" id="pl-m-live" onclick="window.__plSetMode(\'live\')">Live</span>'
      + '<span style="width:14px"></span>'
      + '<span class="mbtn ' + (ROSTER === "nrb" ? "active" : "") + '" id="pl-r-nrb" onclick="window.__plSetRoster(\'nrb\')">Non-Roster Bound</span>'
      + '<span class="mbtn ' + (ROSTER === "rb" ? "active" : "") + '" id="pl-r-rb" onclick="window.__plSetRoster(\'rb\')">Roster Bound</span>'
      + '</div>'
      + '<div class="ig" id="pl-live-fields" style="' + (MODE === "live" ? "" : "display:none") + '">'
      + '<div class="fld"><label>Gold per 1% damage</label>'
      + '<input id="pl-gpd" type="number" min="100000" step="50000" value="' + LIVE.gpd + '"></div>'
      + '<div class="fld"><label>Baseline grade <span class="dim">(0–100; weakest equipped gem)</span></label>'
      + '<div style="display:flex;align-items:center;gap:8px">'
      + '<input id="pl-grade" type="number" min="0" max="100" step="1" value="' + LIVE.grade + '" oninput="window.__plGradeRank()" style="flex:1">'
      + '<span id="pl-grade-rank" class="grade-rank">' + window.rankFromGrade(LIVE.grade) + '</span></div></div>'
      + '<div class="fld" style="align-self:end"><button class="primary" id="pl-recalc" onclick="window.__plRecalc()">Recalculate</button></div>'
      + '</div>'
      + '<p class="note" id="pl-mode-note">' + modeNote() + '</p>'
      + '</div></div>';
  }
  function modeNote() {
    return MODE === "baked"
      ? "Baked view: the fixed gold tiers (500k · 1M · 1.5M · 2.5M · 3.5M · 5M), NRB then RB, one row per baseline rank C- … S+ (grades 52–97). Each cell is read by direct lookup from the baked exact-DP grid (one DP solve per grade) — no interpolation."
      : "Live view: computes the EXACT Bellman DP on demand for any gold + baseline grade, for all 36 cells (3 rarities × 3 costs × 4 buckets). No interpolation — real DP for every cell, so it's slower (~60–90s) and runs only on Recalculate.";
  }

  // ---------------------------------------------------------------------------
  // scoped styles (NOT in styles.css)
  // ---------------------------------------------------------------------------
  function scopedStyle() {
    return '<style>'
      + '#tab-pipeline .legend-box{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin:8px 0 16px}'
      + '#tab-pipeline .legend-box .lg-title{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:var(--accent);font-weight:700;margin-bottom:10px}'
      + '#tab-pipeline .lg-h{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--accent);font-weight:700;margin:10px 0 4px}'
      + '#tab-pipeline .sw{display:inline-block;width:13px;height:13px;border-radius:3px;vertical-align:middle;margin-right:5px;border:1px solid #0006}'
      + '#tab-pipeline .toc{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:10px 16px;margin:8px 0}'
      + '#tab-pipeline .toc a{color:var(--accent);text-decoration:none;margin-right:16px}'
      + '#tab-pipeline .toc a:hover{text-decoration:underline}'
      + '#tab-pipeline h1.sec{font-size:16px;color:var(--accent);border-top:2px solid var(--border);padding-top:16px;margin-top:30px}'
      + '#tab-pipeline h2{font-size:15px;color:var(--accent);margin-top:22px}'
      + '#tab-pipeline .pipe-table{width:auto;min-width:100%;font-size:12.5px;margin:6px 0 8px;border-collapse:collapse}'
      + '#tab-pipeline .pipe-table th{position:sticky;top:0;background:var(--panel2);z-index:2;text-align:center;white-space:nowrap;padding:6px 5px;border:1px solid var(--border);font-size:11px;color:var(--accent)}'
      + '#tab-pipeline .pipe-table td{padding:0;text-align:center;vertical-align:top;border:1px solid var(--border)}'
      + '#tab-pipeline .pipe-table td.pipe{padding:5px 8px;vertical-align:middle}'
      + '#tab-pipeline .pipe-table td.blcell{font-weight:700;color:var(--text)}'
      + '#tab-pipeline .pipe-table td.boxcell{font-size:11px;color:var(--dim);padding:4px 6px;vertical-align:middle;line-height:1.4}'
      + '#tab-pipeline .pipe-table td.num{padding:5px 8px;vertical-align:middle;font-variant-numeric:tabular-nums}'
      + '#tab-pipeline .sep{border-left:2px solid var(--accent)!important}'
      + '#tab-pipeline .bkt-grid{display:flex;flex-direction:column}'
      + '#tab-pipeline .bkt-row{display:flex;align-items:center;min-height:22px;padding:1px 5px;gap:6px;border-bottom:1px solid #0003}'
      + '#tab-pipeline .bkt-row:last-child{border-bottom:none}'
      + '#tab-pipeline .bkt-label{width:30px;text-align:left;font-size:10px;font-weight:700;flex-shrink:0;color:#aab2c5}'
      + '#tab-pipeline .bkt-val{flex:1;text-align:right;font-weight:700;font-variant-numeric:tabular-nums}'
      + '#tab-pipeline .bkt-pct{width:42px;text-align:right;color:#cbd2e0;font-size:10.5px;flex-shrink:0}'
      + '#tab-pipeline .bkt-reset{width:14px;text-align:center;font-size:12px;color:#bfe7c8;flex-shrink:0}'
      // verdict backgrounds — green / 4-shade yellow ramp / red / purple (dark, legible)
      + '#tab-pipeline .v-green{background:#1f6b3e!important;color:#d6ffe6}'
      + '#tab-pipeline .v-y1{background:#3a5a2a!important;color:#dff0c0}'
      + '#tab-pipeline .v-y2{background:#4a5520!important;color:#eee6a8}'
      + '#tab-pipeline .v-y3{background:#5a4a1e!important;color:#f0dca0}'
      + '#tab-pipeline .v-y4{background:#544020!important;color:#e8d2a0}'
      + '#tab-pipeline .v-red{background:#4a1c1c!important;color:#ef9a9a}'
      + '#tab-pipeline .v-purple{background:#3a2a66!important;color:#cdb4ff}'
      + '#tab-pipeline .fast{background:#1b4332!important;color:#9be8b4;font-weight:700}'
      + '#tab-pipeline .med{background:#3d3200!important;color:#f0d68a;font-weight:700}'
      + '#tab-pipeline .slow{background:#4a1515!important;color:#ef9a9a;font-weight:700}'
      + '#tab-pipeline .sw.fast{background:#1b4332}#tab-pipeline .sw.med{background:#3d3200}#tab-pipeline .sw.slow{background:#4a1515}'
      + '#tab-pipeline .sw.v-green{background:#1f6b3e}#tab-pipeline .sw.v-y1{background:#3a5a2a}#tab-pipeline .sw.v-y2{background:#4a5520}#tab-pipeline .sw.v-y3{background:#5a4a1e}#tab-pipeline .sw.v-red{background:#4a1c1c}#tab-pipeline .sw.v-purple{background:#3a2a66}'
      + '#tab-pipeline .legendary{color:#f0c674}#tab-pipeline .relic{color:#c79bff}#tab-pipeline .ancient{color:#ff9d6e}'
      + '#tab-pipeline .dim{color:var(--dim);font-weight:400;font-size:10.5px}'
      + '#tab-pipeline .grade-rank{display:inline-block;min-width:34px;text-align:center;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--panel2);color:var(--accent);font-weight:700;font-variant-numeric:tabular-nums}'
      + '#tab-pipeline .tablewrap{overflow-x:auto;max-width:100%}'
      // live exact-DP progress bar (scoped; reuses theme vars)
      + '#tab-pipeline .pl-progwrap{display:flex;align-items:center;gap:10px;margin-top:12px}'
      + '#tab-pipeline .pl-prog{flex:1;height:10px;border-radius:5px;background:var(--border);overflow:hidden}'
      + '#tab-pipeline .pl-prog > i{display:block;height:100%;width:0;background:var(--accent);transition:width .12s}'
      + '#tab-pipeline .pl-progtxt{font-variant-numeric:tabular-nums;color:var(--accent);font-weight:700;min-width:84px;text-align:right}'
      + '</style>';
  }

  // ---------------------------------------------------------------------------
  // render orchestration
  // ---------------------------------------------------------------------------
  function renderBody() {
    var host = document.getElementById("pl-results");
    if (!host) return;
    if (MODE === "baked") {
      if (!DATA) { host.innerHTML = '<div class="placeholder"><b>Loading baked tiers…</b></div>'; return; }
      host.innerHTML = '<div class="tablewrap">' + bakedResults() + '</div>';
    } else {
      host.innerHTML = '<div class="tablewrap">' + liveResults() + '</div>';
    }
  }

  function render() {
    var el = document.getElementById("tab-pipeline");
    if (!el) return;
    el.innerHTML = scopedStyle() + inputsHtml() + legendHtml()
      + '<div id="pl-results"></div>' + methodologyHtml();
    renderBody();
    // BAKED mode needs the baked file; LIVE mode computes everything in-browser and
    // only uses DATA.meta (constants) if it happens to be loaded.
    if (MODE === "baked") ensureData();
  }

  function ensureData() {
    if (DATA || ensureData._loading) return;
    ensureData._loading = true;
    fetch("data/pipeline.json")
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (j) { DATA = j; ensureData._loading = false; if (MODE === "baked") renderBody(); })
      .catch(function (e) {
        ensureData._loading = false;
        if (MODE !== "baked") return;
        var host = document.getElementById("pl-results");
        if (host) {
          host.innerHTML = '<div class="placeholder"><b>Could not load data/pipeline.json</b>'
            + '<div class="note">Serve over http (static server). ' + e.message + '</div></div>';
        }
      });
  }

  // ---------------------------------------------------------------------------
  // event handlers
  // ---------------------------------------------------------------------------
  window.__plSetMode = function (m) {
    MODE = m;
    document.getElementById("pl-m-baked").classList.toggle("active", m === "baked");
    document.getElementById("pl-m-live").classList.toggle("active", m === "live");
    var lf = document.getElementById("pl-live-fields");
    if (lf) lf.style.display = m === "live" ? "" : "none";
    var note = document.getElementById("pl-mode-note");
    if (note) note.textContent = modeNote();
    if (m === "baked") ensureData();
    renderBody();
  };
  window.__plSetRoster = function (rb) {
    ROSTER = rb;
    document.getElementById("pl-r-nrb").classList.toggle("active", rb === "nrb");
    document.getElementById("pl-r-rb").classList.toggle("active", rb === "rb");
    renderBody();
  };
  window.__plRecalc = function () {
    if (LIVE_BUSY) return;
    var g = parseFloat(document.getElementById("pl-gpd").value);
    var gr = parseFloat(document.getElementById("pl-grade").value);
    if (isFinite(g) && g > 0) LIVE.gpd = g;
    if (isFinite(gr) && gr >= 0 && gr <= 100) LIVE.grade = gr;
    if (MODE !== "live") { MODE = "live"; window.__plSetMode("live"); }

    if (typeof window.Solver !== "function") {
      var host0 = document.getElementById("pl-results");
      if (host0) host0.innerHTML = '<div class="placeholder"><b>Model not loaded.</b>'
        + '<div class="note">window.Solver (model/dp.js) is unavailable — cannot compute the exact DP.</div></div>';
      return;
    }

    LIVE_BUSY = true;
    var btn = document.getElementById("pl-recalc");
    if (btn) btn.disabled = true;
    renderBody(); // paints the progress shell (liveProgressHtml)

    var t0 = Date.now();
    computeLive(LIVE.gpd, LIVE.grade,
      function (done, total) {
        var pct = total ? Math.round((done / total) * 100) : 0;
        var bar = document.getElementById("pl-prog-i");
        var txt = document.getElementById("pl-prog-txt");
        if (bar) bar.style.width = pct + "%";
        if (txt) txt.textContent = pct + "% (" + done + "/" + total + " cells)";
      },
      function (result) {
        LIVE_RESULT = result;
        LIVE_BUSY = false;
        if (btn) btn.disabled = false;
        renderBody();
      });
  };
  // Live-update the rank chip next to the grade input as the user types (no recompute).
  window.__plGradeRank = function () {
    var el = document.getElementById("pl-grade");
    var chip = document.getElementById("pl-grade-rank");
    if (!el || !chip) return;
    var gr = parseFloat(el.value);
    chip.textContent = isFinite(gr) ? window.rankFromGrade(Math.max(0, Math.min(100, gr))) : "—";
  };
  window.__plToggleInputs = function () {
    var body = document.getElementById("pl-inbody");
    var caret = document.getElementById("pl-caret");
    if (!body) return;
    var hidden = body.style.display === "none";
    body.style.display = hidden ? "" : "none";
    if (caret) caret.textContent = hidden ? "▾" : "▸";
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", render);
  else render();
})();
