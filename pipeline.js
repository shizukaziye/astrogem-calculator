/**
 * pipeline.js — "Pipeline Tables" tab (BUCKET-PRIMARY, economic methodology).
 *
 * One CLICKABLE gold-per-1%-damage tier at a time (button row, one per gpd present in
 * data/pipeline.json), each a full grade × {Uncommon/Rare/Epic × c8/c9/c10} grid plus
 * a weekly-economy Pipeline group. Per-table NRB/RB toggle. The arbitrary-baseline
 * "live" DP mode is gone — every baseline shown is a baked grade row read by direct
 * key lookup (exact + instant).
 *
 * Each gem cell stacks the FOUR effect-pair buckets (2D / Op / Sub / No). Each bucket
 * row shows the exact Bellman-DP cut value (expected gold AFTER process cost) + P(above
 * baseline) + a verdict color (reset / cut-band / fuse). All cut/pAbove/spend/fodder
 * numbers come straight from the baked exact-DP grid (data/pipeline.json).
 *
 * The Pipeline group implements the documented ECONOMIC METHODOLOGY (mirrors
 * /tmp/pipe-method/generate_pipeline.py with the OVERRIDES baked into the editable
 * CONST block below): box buy decisions, weekly gem income, per-gem cut/fuse/reset
 * processing, post-cut L/R/A fusion (A+2L → R+2L → 3L), weeks-to-24, weekly gold, and
 * the cp% combat-power gain. cp% uses the conditional score-when-above of each kept
 * gem; that conditional is the one quantity not stored per-gpd in the bake, so it is
 * carried in COND_SCORE below (a compact offline solve at a 5M reference gpd; it is
 * gpd-stable to <0.001, and the per-gpd P(above) used to weight it IS read live from
 * the baked cells, so the cp% tracks each gpd exactly in the dimension that moves).
 */
(function () {
  "use strict";

  // ===========================================================================
  // EDITABLE CONSTANTS  (the doc/generator is stale — these OVERRIDE it; tweak here,
  // no re-bake needed). Everything the economic methodology needs is in this block.
  // ===========================================================================
  var CONST = {
    SLOTS: 24,                 // gems needed to fill the loadout
    RESET_COST: 20000,         // gold per reset (restart the cut from level 1, same side nodes, ONCE)
    RESET_THRESHOLD: 20000,    // a below-baseline finished gem is reset only if its cut-EV >= this
    FUSION_COST: 500,          // gold per fuse (3 gems -> 1)

    // Daily NRB gem income (per day) -> x7 for weekly.
    DAILY_INCOME: { uncommon: 4.4, rare: 0.9, epic: 0.4 },

    // Box model. A box type is bought (weekly, up to `max`) iff its box-gem EV > cost.
    //   vendor box 1185g (<=10/wk); mat box 1.4*900+4.2*30+10*25 = 1636g (<=20/wk).
    //   vendor + mat give the SAME gem: 80% UC / 15% Rare / 5% Epic x 60/30/10 cost.
    //   epic box 43000g (<=1/wk) -> one guaranteed epic.
    BOX_VENDOR: { cost: 1185, max: 10 },
    BOX_MAT: { cost: 1.4 * 900 + 4.2 * 30 + 10 * 25, max: 20 },
    BOX_EPIC: { cost: 43000, max: 1 },
    BOX_RARITY_MIX: { uncommon: 0.80, rare: 0.15, epic: 0.05 },
    COST_MIX: { 8: 0.60, 9: 0.30, 10: 0.10 },

    // cp% = 1.3*(1 + Total%dmg/100) - 1, Total%dmg = 24 * (avgScore - baseline).
    // baseline = a gem with willpower 4.25, order 4.25, no side-effects (= 0 damage).
    // Scoring is linear in level, so the baseline score is interpolated; we use the
    // cost-weighted (60/30/10) baseline so it is a single scalar comparable to avgScore.
    CP_MULT: 1.3,
    CP_BASELINE_WP: 4.25,
    CP_BASELINE_ORDER: 4.25
  };

  // Pre-cut fusion output mixes (rarity upgrade on fuse) + 50/50 NRB/RB split.
  var UC_FUSE = { uncommon: 0.85, rare: 0.135, epic: 0.015 };   // 3 UC same cost -> same cost out
  var RARE_FUSE = { uncommon: 0.52, rare: 0.44, epic: 0.04 };   // 1R + 2UC -> cost from inputs

  // Post-cut L/R/A fusion output mixes. Priority A+2L -> R+2L -> 3L.
  var FUSE_A2L = { legendary: 0.35, relic: 0.40, ancient: 0.25 };
  var FUSE_R2L = { legendary: 0.73, relic: 0.25, ancient: 0.02 };
  var FUSE_3L = { legendary: 0.99, relic: 0.01, ancient: 0.00 };

  // ---- display / model axes ----
  var COSTS = [8, 9, 10];
  var RARITIES = ["uncommon", "rare", "epic"];
  var RARITY_LABEL = { uncommon: "Uncommon", rare: "Rare", epic: "Epic" };
  var BUCKETS = ["2_damage", "optimal_damage", "suboptimal_damage", "no_damage"];
  var BUCKET_LABEL = { "2_damage": "2D", "optimal_damage": "Op", "suboptimal_damage": "Sub", "no_damage": "No" };
  var BUCKET_DESC = { "2_damage": "both effects damage", "optimal_damage": "best single damage + dead", "suboptimal_damage": "worse single damage + dead", "no_damage": "both effects dead" };
  var TIERS = ["legendary", "relic", "ancient"];
  var BW = { "2_damage": 1, "optimal_damage": 2, "suboptimal_damage": 2, "no_damage": 1 };
  var BW_TOTAL = 6;

  // Baseline grades (rank C- … S+), each -> a %-damage threshold via gradeToScore. The
  // bake stores one exact DP solve per grade at baseline = gradeToScore(grade), read by
  // direct key lookup (no interpolation).
  var GRADE_ROWS = [52, 57, 62, 66, 70, 73, 77, 80, 83, 87, 92, 97];

  // Verdict gold-EV bands.
  var V = { green: CONST.RESET_THRESHOLD, yellowHi: 10000, yellowMid: 5000, yellowLo: 1000 };

  // ---------------------------------------------------------------------------
  // COND_SCORE — conditional expected score-when-above (the % damage of a KEPT gem of
  // each archetype), keyed grade -> "rarity_cost_bucket" -> score. Offline exact-DP
  // solve at a 5M reference gpd (gpd-stable to <0.001). Used ONLY for the cp% column;
  // it is weighted by the per-gpd baked P(above) so cp% still tracks each gpd exactly.
  // For gpds not listed (e.g. future tiers) the value is reused as-is — it is the
  // conditional score, which is gpd-invariant. See the offline bake in the task notes.
  // ---------------------------------------------------------------------------
  var COND_SCORE = /*__COND_SCORE__*/ null;

  var DATA = null;          // baked data/pipeline.json (lazy-fetched)
  var ROSTER = "nrb";       // 'nrb' | 'rb' (Global only; KR has no roster-bound gems)
  var REGION = "global";    // 'global' | 'kr'
  var KR_FLOOR = { 8: 20000, 9: 30000, 10: 40000 };  // KR: tradable-epic floor sale value by cost
  var GPD = null;           // currently-selected gpd (set after data loads)
  var GPD_LIST = [];        // gpds present in DATA.cells, ascending

  // ---------------------------------------------------------------------------
  // formatting
  // ---------------------------------------------------------------------------
  function fmtGold(g) {
    if (g == null || !isFinite(g)) return "—";
    g = Math.round(g);
    if (Math.abs(g) >= 1000000) {
      var m = (g / 1000000).toFixed(Math.abs(g) >= 10000000 ? 0 : 1);
      m = m.replace(/\.0$/, "");
      return m + "M";
    }
    if (Math.abs(g) >= 1000) {
      var k = (g / 1000).toFixed(Math.abs(g) >= 100000 ? 0 : 1);
      k = k.replace(/\.0$/, "");
      return k + "k";
    }
    return String(g);
  }
  function fmtGoldFull(g) { return (g == null || !isFinite(g)) ? "—" : Math.round(g).toLocaleString("en-US"); }
  // Grade-tier colored pill for a rank string (uses the shared Astrogem.rankColor palette).
  function rankBadge(rank) {
    var c = (window.Astrogem && window.Astrogem.rankColor) ? window.Astrogem.rankColor(rank) : { bg: "#6f747a", fg: "#fff" };
    return '<span class="rank-badge" style="background:' + c.bg + ';color:' + c.fg + '">' + rank + '</span>';
  }
  function fmtPct(p) { return (p == null || !isFinite(p)) ? "—" : (p * 100).toFixed(1) + "%"; }
  function fmtNum(x, dp) { return (x == null || !isFinite(x)) ? "—" : Number(x).toFixed(dp == null ? 2 : dp); }
  function gpdName(g) {
    if (g >= 1000000) { var m = (g / 1000000).toFixed(1).replace(/\.0$/, ""); return m + "M"; }
    return (g / 1000).toFixed(0) + "k";
  }

  // ---------------------------------------------------------------------------
  // verdict for ONE bucket. The fuse (purple) decision is BLOCK-level (computed by
  // gemCell from the unopened-fusion value) and passed in as `blockFuse`.
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
  // baked lookups — DIRECT KEY MATCH (no interpolation), with a tiny closest-baseline
  // guard against float-string drift (still an exact DP cell, never interpolated).
  // ---------------------------------------------------------------------------
  function cellKey(rarity, cost, bucket, baseline, gpd) { return rarity + "_" + cost + "_" + bucket + "_" + baseline + "_" + gpd; }

  function bakedBaselineList() {
    if (!DATA) return [];
    if (bakedBaselineList._cache && bakedBaselineList._for === DATA) return bakedBaselineList._cache;
    var set = {};
    if (DATA.meta && DATA.meta.bakedBaselines) {
      DATA.meta.bakedBaselines.forEach(function (b) { set[b] = true; });
    } else {
      Object.keys(DATA.cells || {}).forEach(function (k) {
        var parts = k.split("_");
        set[parts[parts.length - 2]] = true;
      });
    }
    var list = Object.keys(set).map(Number).filter(function (x) { return isFinite(x); }).sort(function (a, b) { return a - b; });
    bakedBaselineList._cache = list; bakedBaselineList._for = DATA;
    return list;
  }
  function nearestBakedBaseline(bl) {
    var list = bakedBaselineList();
    if (!list.length) return null;
    var best = null, bestD = Infinity;
    for (var i = 0; i < list.length; i++) {
      var d = Math.abs(list[i] - bl);
      if (d < bestD) { bestD = d; best = list[i]; }
    }
    return (best != null && bestD <= 1e-6) ? best : null;
  }
  function bakedCell(rarity, cost, bucket, baseline, gpd) {
    if (!DATA || !DATA.cells) return null;
    var c = DATA.cells[cellKey(rarity, cost, bucket, baseline, gpd)];
    if (c) return c;
    var nb = nearestBakedBaseline(baseline);
    if (nb == null) return null;
    return DATA.cells[cellKey(rarity, cost, bucket, nb, gpd)] || null;
  }
  // Per-roster bucket record (SOURCE OF TRUTH for verdicts + the pipeline). EXACT DP.
  function bakedBucket(rarity, cost, bucket, baseline, gpd, roster) {
    var c = bakedCell(rarity, cost, bucket, baseline, gpd);
    return c ? (c[roster] || null) : null;
  }
  // gpds present in DATA.cells, ascending.
  function gpdsInData() {
    if (!DATA || !DATA.cells) return [];
    var set = {};
    Object.keys(DATA.cells).forEach(function (k) {
      var p = k.split("_");
      var g = Number(p[p.length - 1]);
      if (isFinite(g)) set[g] = true;
    });
    return Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
  }

  // ---------------------------------------------------------------------------
  // weighted EV across the 4 buckets (1:2:2:1), clamped per bucket (>=0). This is the
  // "open value" of an unopened gem of (rarity,cost) at (baseline,gpd,roster).
  // ---------------------------------------------------------------------------
  function gev(rarity, cost, baseline, gpd, roster) {
    var t = 0;
    for (var i = 0; i < BUCKETS.length; i++) {
      var rec = bakedBucket(rarity, cost, BUCKETS[i], baseline, gpd, roster);
      if (rec && rec.cut != null) t += Math.max(rec.cut, 0) * BW[BUCKETS[i]];
    }
    return t / BW_TOTAL;
  }

  // ---------------------------------------------------------------------------
  // REAL unopened (rarity-upgrade) fusion value — what the BLOCK-level purple verdict
  // compares against opening. (Retained from the prior implementation; confirmed model.)
  // getCut(roster, rarity, cost, bucket) -> cut EV | null. Returns
  //   { fuse:{uncommon:{8,9,10}, rare:{8,9,10}, epic:{8:null…}},   // raw fuse value/block
  //     steer:{uncommon:{8:8,…}, rare:{8:bestCost,…}, epic:{…}},   // cost to STEER fusion toward
  //     ovNrb:{rarity:{cost}} }                                    // NRB open value/block
  // or null if any required OV bucket is missing. The steer cost is the argmax-cost the
  // fusion output is pushed toward: UC keeps its own cost; a Rare fuses its 2 partners
  // toward argmax_c Out[c] (the cost whose rarity-mixed output EV is highest).
  // ---------------------------------------------------------------------------
  function unopenedFusion(getCut) {
    function openValue(roster, rarity, cost) {
      var acc = 0, wsum = 0;
      for (var k = 0; k < BUCKETS.length; k++) {
        var cut = getCut(roster, rarity, cost, BUCKETS[k]);
        if (cut == null) return null;
        acc += BW[BUCKETS[k]] * cut; wsum += BW[BUCKETS[k]];
      }
      return wsum > 0 ? acc / wsum : null;
    }
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
    var U_nrb = {};
    for (var r2 = 0; r2 < RARITIES.length; r2++) {
      var rr = RARITIES[r2]; U_nrb[rr] = {};
      for (var c2 = 0; c2 < COSTS.length; c2++) U_nrb[rr][COSTS[c2]] = OV.nrb[rr][COSTS[c2]];
    }
    function E(rar, cost) {
      if (REGION === "kr") {
        // KR has no roster-bound gems; 50% of fusion outputs are TRADABLE instead. A
        // tradable EPIC has a floor sale value (KR_FLOOR by cost); tradable UC/rare = a
        // normal gem. So fusing toward epics gains that floor as a safety net.
        var trad = (rar === "epic") ? Math.max(U_nrb[rar][cost], KR_FLOOR[cost]) : U_nrb[rar][cost];
        return 0.5 * trad + 0.5 * U_nrb[rar][cost];
      }
      return 0.5 * OV.rb[rar][cost] + 0.5 * U_nrb[rar][cost];
    }
    var fuseA = null, bestCost = 8;
    for (var iter = 0; iter < 200; iter++) {
      var fA = { uncommon: {}, rare: {}, epic: {} };
      var Out = {}, maxOut = -Infinity;
      bestCost = COSTS[0];
      for (var cc = 0; cc < COSTS.length; cc++) {
        var c = COSTS[cc];
        Out[c] = RARE_FUSE.uncommon * E("uncommon", c) + RARE_FUSE.rare * E("rare", c) + RARE_FUSE.epic * E("epic", c);
        if (Out[c] > maxOut) { maxOut = Out[c]; bestCost = c; }
      }
      for (var cd = 0; cd < COSTS.length; cd++) {
        var cst = COSTS[cd];
        fA.uncommon[cst] = (UC_FUSE.uncommon * E("uncommon", cst) + UC_FUSE.rare * E("rare", cst) + UC_FUSE.epic * E("epic", cst) - CONST.FUSION_COST) / 3;
        fA.rare[cst] = (1 / 3) * Out[cst] + (2 / 3) * maxOut - CONST.FUSION_COST;
        fA.epic[cst] = null;
      }
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
    // steer cost per (rarity, cost): UC fuse keeps its own cost; a Rare steers its 2
    // partners toward the single best cost (argmax_c Out[c] == bestCost). Epic never fuses.
    var steer = { uncommon: {}, rare: {}, epic: {} };
    for (var sc = 0; sc < COSTS.length; sc++) {
      steer.uncommon[COSTS[sc]] = COSTS[sc];
      steer.rare[COSTS[sc]] = bestCost;
      steer.epic[COSTS[sc]] = null;
    }
    return { fuse: fuseA, steer: steer, ovNrb: U_nrb };
  }

  // ---------------------------------------------------------------------------
  // PRE-CUT fuse DECISIONS for one (baseline, gpd, roster). Mirrors generate_pipeline.py
  // compute_fuse_decisions: per UC cost & per rare cost, decide whether fusing beats
  // cutting directly, using UC opportunity cost = max(direct, fuse_value).
  // Returns { uc:{8,9,10:bool}, rare:{8,9,10:bool}, rareUcCost:{8,9,10}, fuseEvByCost }.
  // ---------------------------------------------------------------------------
  function fuseDecisions(bl, gpd, roster) {
    var ucSf = {}, ucFpi = {}, ucValue = {};
    for (var i = 0; i < COSTS.length; i++) {
      var c = COSTS[i];
      var ucDirect = gev("uncommon", c, bl, gpd, roster);
      var fuseEv = 0;
      for (var ri = 0; ri < RARITIES.length; ri++) {
        var orar = RARITIES[ri], rate = UC_FUSE[orar];
        fuseEv += Math.max(gev(orar, c, bl, gpd, "nrb"), 0) * rate * 0.5;
        fuseEv += Math.max(gev(orar, c, bl, gpd, "rb"), 0) * rate * 0.5;
      }
      var fpi = (fuseEv - CONST.FUSION_COST) / 3;
      ucSf[c] = fpi > ucDirect;
      ucFpi[c] = fpi;
      ucValue[c] = Math.max(ucDirect, fpi);
    }
    var fuseEvByCost = {};
    for (var j = 0; j < COSTS.length; j++) {
      var cc = COSTS[j], ev = 0;
      for (var rj = 0; rj < RARITIES.length; rj++) {
        var or2 = RARITIES[rj], rt = RARE_FUSE[or2];
        ev += Math.max(gev(or2, cc, bl, gpd, "nrb"), 0) * rt * 0.5;
        ev += Math.max(gev(or2, cc, bl, gpd, "rb"), 0) * rt * 0.5;
      }
      fuseEvByCost[cc] = ev;
    }
    var rSf = {}, rUc = {};
    for (var k = 0; k < COSTS.length; k++) {
      var rc = COSTS[k];
      var rareEv = gev("rare", rc, bl, gpd, roster);
      var bestMarg = -Infinity, bestUc = 8;
      for (var u = 0; u < COSTS.length; u++) {
        var uc = COSTS[u], uOpp = ucValue[uc], outEv;
        if (rc === uc) outEv = fuseEvByCost[rc];
        else outEv = (1 / 3) * fuseEvByCost[rc] + (2 / 3) * fuseEvByCost[uc];
        var marg = outEv - CONST.FUSION_COST - 2 * uOpp;
        if (marg > bestMarg) { bestMarg = marg; bestUc = uc; }
      }
      rSf[rc] = bestMarg > rareEv;
      rUc[rc] = bestUc;
    }
    return { uc: ucSf, rare: rSf, rareUcCost: rUc, fuseEvByCost: fuseEvByCost };
  }

  // ---------------------------------------------------------------------------
  // FUSION HIT RATE — P(a fused output of the given output-tier mix clears baseline),
  // cost-weighted. Per-tier P(random gem above baseline) from scoreDistributionForTier.
  // ---------------------------------------------------------------------------
  function pTierAbove(cost, tier, bl) {
    if (typeof window.scoreDistributionForTier !== "function") return 0;
    var dist = window.scoreDistributionForTier(cost, tier);
    var p = 0;
    dist.forEach(function (prob, sc) { if (sc > bl) p += prob; });
    return p;
  }
  function fusionHit(bl, mix) {
    var t = 0;
    for (var ci = 0; ci < COSTS.length; ci++) {
      var c = COSTS[ci], inner = 0;
      for (var ti = 0; ti < TIERS.length; ti++) inner += mix[TIERS[ti]] * pTierAbove(c, TIERS[ti], bl);
      t += CONST.COST_MIX[c] * inner;
    }
    return t;
  }

  // ---------------------------------------------------------------------------
  // cp% baseline score (wp 4.25, order 4.25, dead effects), cost-weighted 60/30/10.
  // Scoring is linear in level, so this is exact. Cached.
  // ---------------------------------------------------------------------------
  function cpBaselineScore() {
    if (cpBaselineScore._v != null) return cpBaselineScore._v;
    if (!window.Astrogem || typeof window.Astrogem.cpBaseline !== "function") return null;
    var s = 0;
    for (var ci = 0; ci < COSTS.length; ci++) {
      var c = COSTS[ci];
      // Shared zero-point with the Grader: A.cpBaseline(c) == score of a
      // wp-4.25/order-4.25/dead-effect gem at cost c (the only allowed pipeline edit).
      s += CONST.COST_MIX[c] * window.Astrogem.cpBaseline(c);
    }
    cpBaselineScore._v = s;
    return s;
  }

  // Conditional score-when-above for a cell, from COND_SCORE (5M-ref offline solve).
  // Falls back to the cell's own baked expScore if the table is absent.
  function condScoreFor(grade, rarity, cost, bucket, baseline) {
    if (COND_SCORE && COND_SCORE[grade]) {
      var v = COND_SCORE[grade][rarity + "_" + cost + "_" + bucket];
      if (v != null) return v;
    }
    return baseline;
  }

  // avgScore for the produced loadout at (grade, baseline, gpd): the P(above)-weighted
  // mean (over rarity x cost x bucket, with cost weights 60/30/10 and bucket weights
  // 1:2:2:1) of each archetype's conditional score-when-above. P(above) is the per-gpd
  // baked value, so avgScore tracks gpd exactly in the dimension that moves.
  function avgScore(grade, baseline, gpd) {
    var ta = 0, ss = 0;
    for (var ri = 0; ri < RARITIES.length; ri++) {
      for (var ci = 0; ci < COSTS.length; ci++) {
        for (var bi = 0; bi < BUCKETS.length; bi++) {
          var rec = bakedBucket(RARITIES[ri], COSTS[ci], BUCKETS[bi], baseline, gpd, "nrb");
          if (!rec) continue;
          var p = rec.pAbove || 0;
          if (p <= 0) continue;
          var s = condScoreFor(grade, RARITIES[ri], COSTS[ci], BUCKETS[bi], baseline);
          var w = CONST.COST_MIX[COSTS[ci]] * BW[BUCKETS[bi]] / BW_TOTAL * p;
          ta += w; ss += w * s;
        }
      }
    }
    return ta > 0 ? ss / ta : baseline;
  }

  // ---------------------------------------------------------------------------
  // THE PIPELINE — full weekly economy for one (grade, baseline, gpd). NRB perspective.
  // Mirrors generate_pipeline.py compute_pipeline with the CONST overrides.
  // ---------------------------------------------------------------------------
  function computePipeline(grade, baseline, gpd) {
    var bl = baseline;
    // pre-fetch bucket records (NRB) per (rarity, cost)
    var ba = {};
    for (var ri = 0; ri < RARITIES.length; ri++) {
      for (var ci = 0; ci < COSTS.length; ci++) {
        var d = {};
        for (var bi = 0; bi < BUCKETS.length; bi++) {
          var rec = bakedBucket(RARITIES[ri], COSTS[ci], BUCKETS[bi], bl, gpd, "nrb");
          if (rec) d[BUCKETS[bi]] = rec;
        }
        ba[RARITIES[ri] + "_" + COSTS[ci]] = d;
      }
    }
    var fd = fuseDecisions(bl, gpd, "nrb");

    // box decisions: buy a type iff box-gem EV > its cost
    var bev = 0;
    for (var ro = 0; ro < RARITIES.length; ro++) {
      var orar = RARITIES[ro];
      for (var co = 0; co < COSTS.length; co++) {
        bev += CONST.BOX_RARITY_MIX[orar] * CONST.COST_MIX[COSTS[co]] * gev(orar, COSTS[co], bl, gpd, "nrb");
      }
    }
    var buyVendor = bev > CONST.BOX_VENDOR.cost;
    var buyMat = bev > CONST.BOX_MAT.cost;
    var eev = 0;
    for (var ce = 0; ce < COSTS.length; ce++) eev += CONST.COST_MIX[COSTS[ce]] * gev("epic", COSTS[ce], bl, gpd, "nrb");
    var buyEpic = eev > CONST.BOX_EPIC.cost;

    var boxCount = (buyVendor ? CONST.BOX_VENDOR.max : 0) + (buyMat ? CONST.BOX_MAT.max : 0);
    var W = { uncommon: CONST.DAILY_INCOME.uncommon * 7, rare: CONST.DAILY_INCOME.rare * 7, epic: CONST.DAILY_INCOME.epic * 7 };
    var tuc = W.uncommon + boxCount * CONST.BOX_RARITY_MIX.uncommon;
    var trr = W.rare + boxCount * CONST.BOX_RARITY_MIX.rare;
    var tep = W.epic + boxCount * CONST.BOX_RARITY_MIX.epic + (buyEpic ? 1.0 : 0);

    var at = 0, lp = 0, rp = 0, ap = 0, cg = 0, rg = 0, fg = 0;
    var bg = (buyVendor ? CONST.BOX_VENDOR.max * CONST.BOX_VENDOR.cost : 0)
      + (buyMat ? CONST.BOX_MAT.max * CONST.BOX_MAT.cost : 0)
      + (buyEpic ? CONST.BOX_EPIC.cost : 0);

    // process a batch of `count` gems of (rarity, cost): distribute across buckets, add
    // above-baseline hits, cutting gold; route below-baseline gems to reset or fodder.
    function pgb(count, rarity, cost) {
      var bd = ba[rarity + "_" + cost];
      for (var i = 0; i < BUCKETS.length; i++) {
        var rec = bd[BUCKETS[i]];
        if (!rec) continue;
        var b = count * BW[BUCKETS[i]] / BW_TOTAL;
        var p = rec.pAbove || 0;
        var ev = rec.cut;
        at += b * p;
        cg += b * (rec.expSpend || 0);
        if (rec.act === "complete") continue;
        var fl = rec.fLeg || 0, fr = rec.fRelic || 0, fa = rec.fAnc || 0;
        if (ev >= CONST.RESET_THRESHOLD) {
          // legendary fodder is RESET (one more pAbove try); relic/ancient -> pools
          rp += b * fr; ap += b * fa;
          var nr = b * fl; rg += nr * CONST.RESET_COST;
          at += nr * p;
          var rf = nr * (1 - p);
          lp += rf * fl; rp += rf * fr; ap += rf * fa;
        } else {
          lp += b * fl; rp += b * fr; ap += b * fa;
        }
      }
    }

    // UC processing (with pre-cut fuse where decided)
    if (fd.uc[8] || fd.uc[9] || fd.uc[10]) {
      var ucToFuse = { 8: 0, 9: 0, 10: 0 };
      for (var cu = 0; cu < COSTS.length; cu++) {
        var c1 = COSTS[cu], cnt1 = tuc * CONST.COST_MIX[c1];
        if (fd.uc[c1]) {
          var bd1 = ba["uncommon_" + c1];
          for (var bi1 = 0; bi1 < BUCKETS.length; bi1++) {
            var r1 = bd1[BUCKETS[bi1]]; if (!r1) continue;
            var b1 = cnt1 * BW[BUCKETS[bi1]] / BW_TOTAL;
            at += b1 * (r1.pAbove || 0);
            cg += b1 * (r1.expSpend || 0);
            ucToFuse[c1] += b1 * (1 - (r1.pAbove || 0));
          }
        } else {
          pgb(cnt1, "uncommon", c1);
        }
      }
      for (var cf = 0; cf < COSTS.length; cf++) {
        var c2 = COSTS[cf], nf = ucToFuse[c2] / 3;
        if (nf <= 0) continue;
        fg += nf * CONST.FUSION_COST;
        for (var rr2 = 0; rr2 < RARITIES.length; rr2++) {
          var orar2 = RARITIES[rr2], rt2 = UC_FUSE[orar2];
          pgb(nf * rt2 * 0.5, orar2, c2);   // NRB output
          pgb(nf * rt2 * 0.5, orar2, c2);   // RB output (processed as NRB lane per methodology)
        }
      }
    } else {
      for (var cu2 = 0; cu2 < COSTS.length; cu2++) pgb(tuc * CONST.COST_MIX[COSTS[cu2]], "uncommon", COSTS[cu2]);
    }

    // Rare processing (with pre-cut fuse where decided)
    if (fd.rare[8] || fd.rare[9] || fd.rare[10]) {
      var rToFuse = { 8: 0, 9: 0, 10: 0 };
      for (var cr = 0; cr < COSTS.length; cr++) {
        var c3 = COSTS[cr], cnt3 = trr * CONST.COST_MIX[c3];
        if (fd.rare[c3]) {
          var bd3 = ba["rare_" + c3];
          for (var bi3 = 0; bi3 < BUCKETS.length; bi3++) {
            var r3 = bd3[BUCKETS[bi3]]; if (!r3) continue;
            var b3 = cnt3 * BW[BUCKETS[bi3]] / BW_TOTAL;
            at += b3 * (r3.pAbove || 0);
            cg += b3 * (r3.expSpend || 0);
            rToFuse[c3] += b3 * (1 - (r3.pAbove || 0));
          }
        } else {
          pgb(cnt3, "rare", c3);
        }
      }
      for (var crc = 0; crc < COSTS.length; crc++) {
        var rcst = COSTS[crc], nfr = rToFuse[rcst];
        if (nfr <= 0) continue;
        var ucc = fd.rareUcCost[rcst];
        fg += nfr * CONST.FUSION_COST;
        var costDist = (rcst === ucc) ? [[rcst, 1.0]] : [[rcst, 1 / 3], [ucc, 2 / 3]];
        for (var rr3 = 0; rr3 < RARITIES.length; rr3++) {
          var orar3 = RARITIES[rr3], rate3 = RARE_FUSE[orar3];
          for (var cdix = 0; cdix < costDist.length; cdix++) {
            var oc = costDist[cdix][0], cprob = costDist[cdix][1];
            pgb(nfr * rate3 * cprob * 0.5, orar3, oc);
            pgb(nfr * rate3 * cprob * 0.5, orar3, oc);
          }
        }
      }
    } else {
      for (var cr2 = 0; cr2 < COSTS.length; cr2++) pgb(trr * CONST.COST_MIX[COSTS[cr2]], "rare", COSTS[cr2]);
    }

    // Epic processing (never fused pre-cut)
    for (var ce2 = 0; ce2 < COSTS.length; ce2++) pgb(tep * CONST.COST_MIX[COSTS[ce2]], "epic", COSTS[ce2]);

    // post-cut L/R/A fusion: A+2L -> R+2L -> 3L
    var ha = fusionHit(bl, FUSE_A2L), hr = fusionHit(bl, FUSE_R2L), hl = fusionHit(bl, FUSE_3L);
    var na = ap, nr2 = rp, nl = lp;
    var nA2L = nl >= 2 ? Math.min(na, nl / 2) : 0;
    var aboveA2L = nA2L * ha, belowA2L = nA2L - aboveA2L;
    var rl = nl - nA2L * 2, rr = nr2;
    rl += belowA2L * FUSE_A2L.legendary; rr += belowA2L * FUSE_A2L.relic;
    var nR2L = rl >= 2 ? Math.min(rr, rl / 2) : 0;
    var aboveR2L = nR2L * hr, belowR2L = nR2L - aboveR2L;
    var rl2 = rl - nR2L * 2; rl2 += belowR2L * FUSE_R2L.legendary;
    var above3L = (rl2 / 3) * hl;

    var tf = aboveA2L + aboveR2L + above3L;
    var gt = at + tf;
    var gw = bg + cg + rg + fg;
    var wk = gt > 0 ? CONST.SLOTS / gt : null;
    var gtot = wk != null ? gw * wk : null;

    var avg = avgScore(grade, bl, gpd);
    var baseScore = cpBaselineScore();
    var avgDmg = (baseScore != null) ? (avg - baseScore) : null;
    var totDmg = avgDmg != null ? CONST.SLOTS * avgDmg : null;
    var cpPct = totDmg != null ? CONST.CP_MULT * (1 + totDmg / 100) - 1 : null;

    return {
      boxEV: bev, buyVendor: buyVendor, buyMat: buyMat, buyEpic: buyEpic,
      direct: at, fuse: tf, total: gt, weeks: wk, goldWeek: gw, goldTotal: gtot,
      avgScore: avg, avgDmg: avgDmg, totalDmg: totDmg, cpPct: cpPct,
      fuseDec: fd
    };
  }

  // score (≈ %dmg, the same unit as the baked baseline) -> 0-100 grade, via the linear
  // gradeToScore map (recover slope/intercept from two evaluations). For the popup only.
  function scoreToGrade(s) {
    if (s == null || !isFinite(s) || typeof window.gradeToScore !== "function") return null;
    var s0 = window.gradeToScore(0), s100 = window.gradeToScore(100);
    if (s100 === s0) return null;
    return 100 * (s - s0) / (s100 - s0);
  }
  function gradePill(s) {
    var g = scoreToGrade(s);
    if (g == null) return "—";
    var gr = Math.round(Math.max(0, Math.min(100, g)) * 10) / 10;
    var rk = (typeof window.rankFromGrade === "function") ? window.rankFromGrade(gr) : "";
    return gr.toFixed(1) + (rk ? " " + rankBadge(rk) : "");
  }

  // Popup HTML registry: gemCell stores the rich tip keyed by a cell id; the shared
  // hover handler (wireTips) looks it up and positions a single floating popover so
  // the markup never has to survive HTML-attribute escaping.
  var TIPS = {};
  var TIP_SEQ = 0;

  // Build the rich hover popover for one (rarity, cost) block at (baseline, gpd, roster).
  // fuse3 = block fuse value (NRB); steerCost = cost to steer the fusion toward;
  // ovNrb = NRB open value (1:2:2:1 weighted mean of the 4 bucket cut-EVs).
  function buildTip(rarity, cost, baseline, gpd, roster, fuse3, steerCost, ovNrb) {
    var head = '<div class="pt-head">' + RARITY_LABEL[rarity] + ' · c' + cost
      + ' <span class="pt-rs">' + (roster === "nrb" ? "NRB" : "RB") + '</span></div>';

    // per-bucket rows
    var rowsHtml = '<table class="pt-tbl"><thead><tr>'
      + '<th>Pair</th><th>Cut-EV</th><th>Hit %</th><th>Exp. spend</th><th>Exp. score</th></tr></thead><tbody>';
    var avgAcc = 0, avgW = 0;
    for (var i = 0; i < BUCKETS.length; i++) {
      var b = BUCKETS[i];
      var rec = bakedBucket(rarity, cost, b, baseline, gpd, roster);
      var cut = rec ? rec.cut : null;
      var pa = rec ? rec.pAbove : null;
      var spend = rec ? rec.expSpend : null;
      var esc = rec ? rec.expScore : null;
      if (cut != null) { avgAcc += BW[b] * cut; avgW += BW[b]; }
      rowsHtml += '<tr><td class="pt-pair"><b>' + BUCKET_LABEL[b] + '</b> <span class="pt-dim">' + BUCKET_DESC[b] + '</span></td>'
        + '<td class="pt-num">' + fmtGold(cut) + '</td>'
        + '<td class="pt-num">' + fmtPct(pa) + '</td>'
        + '<td class="pt-num">' + (spend ? fmtGold(spend) : "—") + '</td>'
        + '<td class="pt-num">' + fmtNum(esc, 3) + '</td></tr>';
    }
    rowsHtml += '</tbody></table>';
    // Weighted-average cell value: (1·2D + 2·Op + 2·Sub + 1·No) / 6.
    rowsHtml += '<div class="pt-avg">Average value <span class="pt-dim">(1·2D + 2·Op + 2·Sub + 1·No)/6</span>: <b>' + fmtGold(avgW ? avgAcc / avgW : null) + '</b></div>';

    // Below-baseline → fodder value & how to fuse, scoped to THIS cell's cost (the
    // fusion/fodder table for one cost): what a Leg/Relic/Anc fodder gem is worth, the
    // recipe that consumes it, the fused-output EV, and the chance it clears baseline.
    // (The raw L/R/A landing odds were dropped — the values + recipes are more useful.)
    var fodderBlock = "";
    if (typeof window.fusionValueForTier === "function" && typeof window.tierExpectedValue === "function") {
      var tev = window.tierExpectedValue(cost, baseline, gpd);
      var fuRecipe = { legendary: "3L", relic: "R+2L", ancient: "A+2L" };
      var fuMix = { legendary: FUSE_3L, relic: FUSE_R2L, ancient: FUSE_A2L };
      var fuName = { legendary: "Legendary", relic: "Relic", ancient: "Ancient" };
      var fuCls = { legendary: "pt-leg-t", relic: "pt-rel-t", ancient: "pt-anc-t" };
      var frows = "";
      for (var ti = 0; ti < TIERS.length; ti++) {
        var t = TIERS[ti];
        frows += '<tr><td class="pt-pair"><b class="' + fuCls[t] + '">' + fuName[t] + '</b></td>'
          + '<td class="pt-num">' + fmtGold(window.fusionValueForTier(t, cost, baseline, gpd)) + '</td>'
          + '<td class="pt-num">' + fuRecipe[t] + '</td>'
          + '<td class="pt-num">' + fmtGold(tev ? tev[t] : null) + '</td>'
          + '<td class="pt-num">' + fmtPct(fusionHit(baseline, fuMix[t])) + '</td></tr>';
      }
      fodderBlock = '<div class="pt-sec"><div class="pt-sec-h">Below baseline → fodder value &amp; fusion (c' + cost + ')</div>'
        + '<table class="pt-tbl"><thead><tr><th>Fodder</th><th>Value</th><th>Fuse</th><th>Output EV</th><th>Hit %</th></tr></thead><tbody>'
        + frows + '</tbody></table></div>';
    }

    // fusion decision for the block (NRB only — RB gems are always cut)
    var fuseBlock = "";
    if (roster === "nrb" && fuse3 != null && ovNrb != null && isFinite(fuse3) && isFinite(ovNrb)) {
      var win = fuse3 - ovNrb;
      var who = win > 0 ? "fuse" : "open";
      var verdictTxt = win > 0
        ? '<b class="pt-win">Fuse wins</b> by ' + fmtGold(Math.abs(win))
        : '<b class="pt-win pt-open">Open wins</b> by ' + fmtGold(Math.abs(win));
      var steerTxt = (rarity === "epic")
        ? '<span class="pt-dim">epic — never fused</span>'
        : (rarity === "uncommon")
          ? 'keep <b>c' + cost + '</b> (UC fuse holds cost)'
          : 'steer toward <b>c' + (steerCost || cost) + '</b>';
      fuseBlock = '<div class="pt-sec"><div class="pt-sec-h">Block fusion decision (NRB)</div>'
        + '<div class="pt-fuse-grid">'
        + '<span class="pt-k">Steer cost</span><span class="pt-v">' + steerTxt + '</span>'
        + '<span class="pt-k">Fuse-EV</span><span class="pt-v ' + (who === "fuse" ? "pt-hot" : "") + '">' + fmtGold(fuse3) + '</span>'
        + '<span class="pt-k">Open-EV</span><span class="pt-v ' + (who === "open" ? "pt-hot" : "") + '">' + fmtGold(ovNrb) + '<span class="pt-dim"> (1:2:2:1 mean)</span></span>'
        + '<span class="pt-k">Verdict</span><span class="pt-v">' + verdictTxt + '</span>'
        + '</div></div>';
    } else if (roster === "rb") {
      fuseBlock = '<div class="pt-sec pt-dim" style="font-size:11px">Roster-bound gems are free to cut — always cut (no pre-cut fuse / box economy).</div>';
    }

    return head + rowsHtml + fodderBlock + fuseBlock;
  }

  // ---------------------------------------------------------------------------
  // render: one bucket-stacked gem cell (4 rows: 2D / Op / Sub / No). The in-table
  // hit-% is GONE (it lives in the hover popup now); each cell carries a data-tip id
  // resolved against the TIPS registry on hover.
  // ---------------------------------------------------------------------------
  function gemCell(getBucket, fuse3, roster, sep, tipMeta) {
    var blockFuse = false, ovNrb = null;
    if (roster === "nrb" && fuse3 != null) {
      var acc = 0, wsum = 0, ok = true;
      for (var k = 0; k < BUCKETS.length; k++) {
        var xb = getBucket(BUCKETS[k]);
        if (!xb || xb.cut == null) { ok = false; break; }
        acc += BW[BUCKETS[k]] * xb.cut; wsum += BW[BUCKETS[k]];
      }
      if (ok) { ovNrb = acc / wsum; blockFuse = fuse3 > ovNrb; }
    }
    var rows = "";
    for (var i = 0; i < BUCKETS.length; i++) {
      var b = BUCKETS[i];
      var x = getBucket(b);
      var cut = x ? x.cut : null;
      var v = verdict(cut, blockFuse);
      rows += '<div class="bkt-row ' + v.cls + '">'
        + '<span class="bkt-label">' + BUCKET_LABEL[b] + '</span>'
        + '<span class="bkt-val">' + fmtGold(cut) + '</span>'
        + '<span class="bkt-reset">' + v.glyph + '</span>'
        + '</div>';
    }
    var tipId = "";
    if (tipMeta) {
      tipId = "t" + (TIP_SEQ++);
      TIPS[tipId] = buildTip(tipMeta.rarity, tipMeta.cost, tipMeta.baseline, tipMeta.gpd, roster, fuse3, tipMeta.steerCost, ovNrb);
    }
    return '<td class="gem' + (sep ? " sep" : "") + '" data-tip="' + tipId + '"><div class="bkt-grid">' + rows + '</div></td>';
  }

  function weeksClass(w) { return w == null ? "slow" : (w <= 8 ? "fast" : (w <= 26 ? "med" : "slow")); }

  // ---------------------------------------------------------------------------
  // The main grid table for the selected gpd + roster.
  // ---------------------------------------------------------------------------
  function gpdTable(gpd, roster) {
    // Pipeline economy columns are NRB BY NATURE (income/boxes/gold are not roster-bound),
    // so they show in BOTH views; only the gem-cell cut-EVs swap by roster.
    var head = '<table class="pipe-table"><thead>'
      + '<tr><th rowspan="2">Grade</th>'
      + '<th colspan="3" class="sep">Uncommon</th>'
      + '<th colspan="3" class="sep">Rare</th>'
      + '<th colspan="3" class="sep">Epic</th>'
      + '<th colspan="9" class="sep">Pipeline economy (NRB-based, per week unless noted)</th>'
      + '</tr><tr>'
      + '<th class="sep">c8</th><th>c9</th><th>c10</th>'
      + '<th class="sep">c8</th><th>c9</th><th>c10</th>'
      + '<th class="sep">c8</th><th>c9</th><th>c10</th>'
      + '<th class="sep">Boxes</th><th>Direct<br>/wk</th><th>Fuse<br>/wk</th>'
      + '<th>Total<br>/wk</th><th>Weeks</th><th>Gold</th><th>Avg<br>%dmg</th><th>Total<br>%dmg</th><th>cp%</th>'
      + '</tr></thead><tbody>';

    var body = "";
    for (var bi = 0; bi < GRADE_ROWS.length; bi++) {
      var grade = GRADE_ROWS[bi];
      var blPct = window.gradeToScore(grade);
      var rank = window.rankFromGrade(grade);
      var row = '<tr><td class="pipe blcell"><b>' + grade + '</b> ' + rankBadge(rank) + '</td>';

      var uf = unopenedFusion(function (rs, r, c, b) {
        var rec = bakedBucket(r, c, b, blPct, gpd, rs);
        return rec ? rec.cut : null;
      });
      var fuseA = uf ? uf.fuse : null;
      var steer = uf ? uf.steer : null;
      for (var ri = 0; ri < RARITIES.length; ri++) {
        for (var ci = 0; ci < COSTS.length; ci++) {
          (function (rarity, cost, sep) {
            var f3 = fuseA && fuseA[rarity] ? fuseA[rarity][cost] : null;
            var sc = steer && steer[rarity] ? steer[rarity][cost] : null;
            row += gemCell(
              function (b) { return bakedBucket(rarity, cost, b, blPct, gpd, roster); },
              f3, roster, sep,
              { rarity: rarity, cost: cost, baseline: blPct, gpd: gpd, steerCost: sc });
          })(RARITIES[ri], COSTS[ci], ci === 0);
        }
      }
      // Pipeline economy — always computed on the NRB lane, shown for both rosters.
      var p = computePipeline(grade, blPct, gpd);
      var boxes = [];
      if (p.buyVendor) boxes.push(CONST.BOX_VENDOR.max + "×1185");
      if (p.buyMat) boxes.push(CONST.BOX_MAT.max + "×mat");
      if (p.buyEpic) boxes.push(CONST.BOX_EPIC.max + "×43k");
      var boxTxt = boxes.length ? boxes.join("<br>") : "—";
      var goldCell = "—";
      if (isFinite(p.goldWeek)) {
        goldCell = fmtGold(p.goldWeek) + "/wk";
        if (p.goldTotal != null) goldCell += '<br><span class="dim">(' + fmtGold(p.goldTotal) + ' total)</span>';
      }
      row += '<td class="pipe sep boxcell">' + boxTxt + '</td>'
        + '<td class="pipe num">' + fmtNum(p.direct) + '</td>'
        + '<td class="pipe num">' + fmtNum(p.fuse) + '</td>'
        + '<td class="pipe num"><b>' + fmtNum(p.total) + '</b></td>'
        + '<td class="pipe num ' + weeksClass(p.weeks) + '">' + (p.weeks != null ? p.weeks.toFixed(1) : "—") + '</td>'
        + '<td class="pipe num" style="font-size:11px">' + goldCell + '</td>'
        + '<td class="pipe num">' + fmtNum(p.avgDmg, 3) + '</td>'
        + '<td class="pipe num">' + fmtNum(p.totalDmg, 1) + '</td>'
        + '<td class="pipe num cpcell">' + (p.cpPct != null ? (p.cpPct * 100).toFixed(1) + "%" : "—") + '</td>';
      row += "</tr>";
      body += row;
    }
    return head + body + "</tbody></table>";
  }

  // ---------------------------------------------------------------------------
  // Fusion / fodder table — keyed to the SELECTED gpd, ONE ROW PER BASELINE. Mirrors
  // generate_pipeline.py render_fusion_table: post-cut L/R/A fodder value, fused-output
  // EV, hit rate, and best legendary cost to fuse with.
  // ---------------------------------------------------------------------------
  function fusionTable(gpd) {
    if (typeof window.fusionValueForTier !== "function" || typeof window.tierExpectedValue !== "function") return "";
    var head = '<table class="pipe-table fusion"><thead>'
      + '<tr><th rowspan="2">Grade<br><span class="dim">(baseline)</span></th>'
      + '<th colspan="3" class="sep">Fodder value / gem</th>'
      + '<th colspan="3" class="sep">Fused-output EV</th>'
      + '<th colspan="3" class="sep">Hit rate (% above)</th>'
      + '<th colspan="2" class="sep">Best Leg. cost</th></tr>'
      + '<tr><th class="sep legendary">Leg</th><th class="relic">Relic</th><th class="ancient">Anc</th>'
      + '<th class="sep legendary">Leg</th><th class="relic">Relic</th><th class="ancient">Anc</th>'
      + '<th class="sep legendary">3L</th><th class="relic">R+2L</th><th class="ancient">A+2L</th>'
      + '<th class="sep">w/ Relic</th><th>w/ Ancient</th></tr></thead><tbody>';

    var body = "";
    for (var bi = 0; bi < GRADE_ROWS.length; bi++) {
      var grade = GRADE_ROWS[bi];
      var bl = window.gradeToScore(grade);
      var rank = window.rankFromGrade(grade);
      var fodL = 0, fodR = 0, fodA = 0, evL = 0, evR = 0, evA = 0;
      for (var ci = 0; ci < COSTS.length; ci++) {
        var c = COSTS[ci], cw = CONST.COST_MIX[c];
        var tev = window.tierExpectedValue(c, bl, gpd);
        fodL += cw * window.fusionValueForTier("legendary", c, bl, gpd);
        fodR += cw * window.fusionValueForTier("relic", c, bl, gpd);
        fodA += cw * window.fusionValueForTier("ancient", c, bl, gpd);
        evL += cw * tev.legendary; evR += cw * tev.relic; evA += cw * tev.ancient;
      }
      var hL = fusionHit(bl, FUSE_3L), hR = fusionHit(bl, FUSE_R2L), hA = fusionHit(bl, FUSE_A2L);
      function bestLeg(mix) {
        var bc = 8, bn = -Infinity;
        for (var k = 0; k < COSTS.length; k++) {
          var cc = COSTS[k], tv = window.tierExpectedValue(cc, bl, gpd), net = 0;
          for (var ti = 0; ti < TIERS.length; ti++) net += mix[TIERS[ti]] * tv[TIERS[ti]];
          net -= 2 * window.fusionValueForTier("legendary", cc, bl, gpd);
          if (net > bn) { bn = net; bc = cc; }
        }
        return bc;
      }
      body += '<tr><td class="pipe blcell"><b>' + grade + '</b> ' + rankBadge(rank) + '</td>'
        + '<td class="pipe num sep legendary">' + fmtGold(fodL) + '</td><td class="pipe num relic">' + fmtGold(fodR) + '</td><td class="pipe num ancient">' + fmtGold(fodA) + '</td>'
        + '<td class="pipe num sep legendary">' + fmtGold(evL) + '</td><td class="pipe num relic">' + fmtGold(evR) + '</td><td class="pipe num ancient">' + fmtGold(evA) + '</td>'
        + '<td class="pipe num sep">' + fmtPct(hL) + '</td><td class="pipe num">' + fmtPct(hR) + '</td><td class="pipe num">' + fmtPct(hA) + '</td>'
        + '<td class="pipe num sep">' + bestLeg(FUSE_R2L) + '-cost</td><td class="pipe num">' + bestLeg(FUSE_A2L) + '-cost</td></tr>';
    }
    return '<h2 id="fodder">Fusion / fodder values — ' + gpdName(gpd) + ' gold / 1% damage</h2>'
      + '<p class="note"><b>Each row is a baseline</b> (the grade of your weakest equipped gem). All values are for the '
      + '<b>' + gpdName(gpd) + ' gold / 1% damage</b> tier selected above. A below-baseline cut becomes <b>fodder</b>, classified '
      + 'by tier (Leg / Relic / Anc by level-sum). <b>Fodder value</b> = what ONE such gem is worth as fusion material (the 2 '
      + 'legendaries in an A+2L / R+2L fuse are free surplus, so only the ' + fmtGold(CONST.FUSION_COST) + ' fee is paid). '
      + '<b>Fused-output EV</b> = expected gold value of a fused output gem of that rarity. <b>Hit rate</b> = chance the fused '
      + 'output (3L / R+2L / A+2L mix) clears this baseline. <b>Best Leg. cost</b> = which legendary cost maximises net value '
      + 'when fusing a relic / ancient with 2 legendaries.</p>'
      + head + body + "</tbody></table>";
  }

  // ---------------------------------------------------------------------------
  // Legend — visibly mirrors ONE real gem cell with callouts.
  // ---------------------------------------------------------------------------
  function sampleCellSvg() {
    // Static sample of the bucket-stacked cell (matches the live cell: label · cut-EV · ↻).
    var rows = [
      { lbl: "2D", val: "31k", cls: "v-green", glyph: "↻" },
      { lbl: "Op", val: "9.2k", cls: "v-y2", glyph: "" },
      { lbl: "Sub", val: "1.4k", cls: "v-y3", glyph: "" },
      { lbl: "No", val: "0", cls: "v-red", glyph: "" }
    ];
    var rh = "";
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      rh += '<div class="bkt-row ' + r.cls + '">'
        + '<span class="bkt-label">' + r.lbl + '</span>'
        + '<span class="bkt-val">' + r.val + '</span>'
        + '<span class="bkt-reset">' + r.glyph + '</span></div>';
    }
    return '<div class="lg-cellwrap">'
      + '<div class="lg-cell"><div class="lg-cell-hdr">Uncommon · c9</div><div class="bkt-grid">' + rh + '</div></div>'
      + '<div class="lg-callouts">'
      + '<p class="lg-co">Every gem column is split into <b>four rows, one per effect pair</b>. The pair is fixed when the gem rolls, so each row answers: <i>if your gem ends up with this pair, is it worth cutting?</i></p>'
      + '<dl class="lg-defs">'
      + '<dt>2D</dt><dd>both effects deal damage</dd>'
      + '<dt>Op</dt><dd>the better single damage effect, other dead</dd>'
      + '<dt>Sub</dt><dd>the weaker single damage effect, other dead</dd>'
      + '<dt>No</dt><dd>both effects dead</dd>'
      + '</dl>'
      + '<p class="lg-co">The <b>number</b> is the cut’s expected gold after the cutting cost. <b>Higher is better</b>; the cell color tells you what to do:</p>'
      + '<div class="lg-keyrows">'
      + '<div class="lg-keyrow"><span class="sw v-green"></span><span><b>Cut, and reset if it lands low</b> — cut-EV ≥ ' + fmtGold(V.green) + ' (marked <b class="reset-ico">↻</b>)</span></div>'
      + '<div class="lg-keyrow"><span class="sw v-y2"></span><span><b>Cut, but don’t reset</b> — cut-EV is positive but under ' + fmtGold(V.green) + '</span></div>'
      + '<div class="lg-keyrow"><span class="sw v-red"></span><span><b>Don’t cut</b> — cut-EV is zero or negative</span></div>'
      + '<div class="lg-keyrow"><span class="sw v-purple"></span><span><b>Fuse the whole gem first</b> — a rarity upgrade beats cutting it (NRB only, marked ⚜)</span></div>'
      + '</div>'
      + '<p class="lg-co lg-hover">Hover any cell for the full breakdown: hit chance, expected spend &amp; score, fodder split, and fuse-vs-open.</p>'
      + '</div></div>';
  }

  function legendHtml() {
    return '<div class="legend-box">'
      + '<div class="lg-title">How to read these tables</div>'
      + '<div class="lg-cols">'
      // --- left column: reading one gem cell ---
      + '<div class="lg-sec">'
      + '<div class="lg-h">Reading a gem cell</div>'
      + sampleCellSvg()
      + '</div>'
      // --- right column: the weekly pipeline columns ---
      + '<div class="lg-sec">'
      + '<div class="lg-h">The weekly pipeline columns</div>'
      + '<p class="lg-co">Right of the gem grid, each baseline row shows what one week of cutting toward all ' + CONST.SLOTS + ' gems looks like at that quality target.</p>'
      + '<dl class="lg-defs lg-defs-wide">'
      + '<dt>Boxes</dt><dd>Gem boxes worth buying that week — bought only when a box’s expected gem value beats its price (vendor ' + fmtGold(CONST.BOX_VENDOR.cost) + ' · mat ' + fmtGold(CONST.BOX_MAT.cost) + ' · epic ' + fmtGold(CONST.BOX_EPIC.cost) + ').</dd>'
      + '<dt>Direct · Fuse · Total</dt><dd>Above-baseline gems earned per week: <b>Direct</b> from cutting and resetting, <b>Fuse</b> from fusing the leftovers, <b>Total</b> their sum.</dd>'
      + '<dt>Weeks</dt><dd>Weeks to fill all ' + CONST.SLOTS + ' slots at that rate (' + CONST.SLOTS + ' ÷ Total), shaded by speed: '
      + '<span class="lg-pill fast">≤ 8</span><span class="lg-pill med">8–26</span><span class="lg-pill slow">&gt; 26</span></dd>'
      + '<dt>Gold</dt><dd>Net gold per week from the whole loop — boxes, cutting, resets, and fusion combined.</dd>'
      + '<dt>cp%</dt><dd>Combat-power gain once all ' + CONST.SLOTS + ' gems clear this baseline: ' + CONST.CP_MULT + ' × (1 + Total%dmg ÷ 100) − 1, with Total%dmg = ' + CONST.SLOTS + ' × average gem damage. Zero point: a willpower-/order-' + CONST.CP_BASELINE_WP + ' gem with dead side-effects.</dd>'
      + '</dl>'
      + '</div>'
      + '</div>'
      + '<p class="lg-foot">The pipeline columns are always computed Non-Roster-Bound — income, boxes, and gold don’t depend on roster binding — so they stay the same in both views. Switching to Roster Bound only changes the per-gem cut-EVs in the grid.</p>'
      + '</div>';
  }

  function methodologyHtml() {
    return '<details class="method"><summary>How these tables are computed</summary>'
      + '<p><b>The cut decision is per BUCKET (effect pair).</b> A gem\'s two effects are its archetype: <b>2_damage</b> (both '
      + 'damage), <b>optimal_damage</b> (better single damage + dead), <b>suboptimal_damage</b> (worse single + dead), '
      + '<b>no_damage</b> (both dead). Each bucket\'s cut value is the exact Bellman-DP value of cutting a fresh level-1 gem of '
      + 'that archetype (model/dp.js), read by direct key lookup from the baked exact-DP grid (data/pipeline.json) — no '
      + 'interpolation, every baseline shown is a baked grade row.</p>'
      + '<p><b>Scoring is real % damage.</b> Each gem line scores D = 100·ln(multiplier) (additive in log space). The baseline is '
      + 'entered as a 0–100 grade (your weakest equipped gem); gold value = max(0, (score − threshold)) × gold-per-1%-damage.</p>'
      + '<p><b>Economic pipeline.</b> Boxes are bought when their box-gem EV beats their cost (vendor ' + fmtGold(CONST.BOX_VENDOR.cost) + ' / '
      + 'mat ' + fmtGold(CONST.BOX_MAT.cost) + ' / epic ' + fmtGold(CONST.BOX_EPIC.cost) + '); weekly gem income is the dailies (UC '
      + CONST.DAILY_INCOME.uncommon + ' / Rare ' + CONST.DAILY_INCOME.rare + ' / Epic ' + CONST.DAILY_INCOME.epic + ' per day ×7) plus box gems. Each gem is cut; a below-baseline '
      + 'finished gem is <b>reset</b> (pay ' + fmtGold(CONST.RESET_COST) + ', one more try) when its cut-EV ≥ ' + fmtGold(CONST.RESET_THRESHOLD) + '. '
      + 'Below-baseline gems otherwise become fodder; pre-cut a weak block is fused into a rarity upgrade when that beats opening (purple). '
      + 'Post-cut fodder is fused L/R/A in priority A+2L → R+2L → 3L. Weeks = ' + CONST.SLOTS + ' / (Direct + Fuse per week).</p>'
      + '<p><b>cp%.</b> cp% = ' + CONST.CP_MULT + '·(1 + Total%dmg/100) − 1, Total%dmg = ' + CONST.SLOTS + '·(avgScore − baseline), baseline = the '
      + 'score of a wp ' + CONST.CP_BASELINE_WP + ' / order ' + CONST.CP_BASELINE_ORDER + ' gem with dead side-effects (= 0 damage; interpolated, since scoring is linear). '
      + 'avgScore is the P(above)-weighted mean of each kept archetype\'s conditional score-when-above (an offline 5M-reference exact-DP '
      + 'solve, gpd-stable; the per-gpd P(above) that weights it is read live from the baked cells).</p>'
      + '<p><b>All constants are editable</b> in the CONST block at the top of pipeline.js — daily income, box costs/caps, reset cost, '
      + 'fusion fee, cp% coefficients — tweakable without a re-bake. gpd tiers are enumerated from whatever exists in data/pipeline.json.</p>'
      + '</details>';
  }

  // ---------------------------------------------------------------------------
  // inputs (sticky, collapsible): clickable gpd selector + NRB/RB toggle.
  // ---------------------------------------------------------------------------
  function inputsHtml() {
    var gpdBtns = "";
    for (var i = 0; i < GPD_LIST.length; i++) {
      var g = GPD_LIST[i];
      gpdBtns += '<span class="mbtn gpd-btn ' + (g === GPD ? "active" : "") + '" data-gpd="' + g + '" onclick="window.__plSetGpd(' + g + ')">' + gpdName(g) + '</span>';
    }
    // One compact row (gpd tiers + roster toggle), tucked above the viewport and
    // revealed on hover (see #pl-inputs styles) so the table gets the vertical space.
    // Region toggle (Global / KR) + gpd tiers; the NRB/RB toggle is Global-only (KR has
    // no roster-bound gems). One compact row, tucked above the viewport, hover to reveal.
    var rosterToggle = (REGION === "global")
      ? '<span class="pl-sep"></span>'
        + '<span class="mbtn ' + (ROSTER === "nrb" ? "active" : "") + '" id="pl-r-nrb" onclick="window.__plSetRoster(\'nrb\')">Non-Roster Bound</span>'
        + '<span class="mbtn ' + (ROSTER === "rb" ? "active" : "") + '" id="pl-r-rb" onclick="window.__plSetRoster(\'rb\')">Roster Bound</span>'
      : '';
    return '<div class="inputs" id="pl-inputs">'
      + '<div class="pl-bar">'
      + '<span class="pl-region">'
      + '<span class="mbtn ' + (REGION === "global" ? "active" : "") + '" id="pl-rg-global" onclick="window.__plSetRegion(\'global\')">Global</span>'
      + '<span class="mbtn ' + (REGION === "kr" ? "active" : "") + '" id="pl-rg-kr" onclick="window.__plSetRegion(\'kr\')">KR</span>'
      + '</span>'
      + '<span class="pl-sep"></span>'
      + '<span class="pl-gpd" id="pl-gpd-row">' + (gpdBtns || '<span class="note">Loading tiers…</span>') + '</span>'
      + rosterToggle
      + '</div>'
      + '<div class="pl-handle" role="button" tabindex="0" onclick="window.__plToggleBar()">region / gpd &#9662;</div>'
      + '</div>';
  }
  function modeNote() {
    return "Pick a gold-per-1%-damage tier above to show its table. Each row is a baseline rank (C- … S+, grades "
      + GRADE_ROWS[0] + "–" + GRADE_ROWS[GRADE_ROWS.length - 1] + "); every cell is read by direct lookup from the baked exact-DP grid (instant, no interpolation). "
      + (ROSTER === "nrb"
        ? "NRB gems cost gold to cut — the cell cut-EVs include that cost."
        : "Roster-bound gems are free to cut (always cut). The Pipeline economy stays visible (it's NRB-based); only the cell cut-EVs swap.");
  }

  // ---------------------------------------------------------------------------
  // scoped styles
  // ---------------------------------------------------------------------------
  function scopedStyle() {
    return '<style>'
      // The Pipeline table is wide (~1520px natural min), so break it out of the centered
      // .wrap (max-width:1180px) — BUT cap it to a comfortable centered width with side
      // deadspace, never edge-to-edge. --pl-w = min(1560px, viewport - 96px): on a wide
      // window it tops out at 1560 (leaving margins); on a narrower one it tracks the
      // viewport. The negative-margin recenters this block on the viewport regardless of
      // .wrap's own width. If the window ever gets narrower than the table, only the inner
      // .tablewrap scrolls (overflow-x:auto) — the page itself never scrolls sideways.
      + '#tab-pipeline.active{--pl-w:min(1560px, calc(100vw - 96px));width:var(--pl-w);max-width:none;margin-left:calc(-1 * ((var(--pl-w) - 100%) / 2));margin-right:0}'
      + '#tab-pipeline > *{padding-left:0;padding-right:0}'
      + '#tab-pipeline .legend-box{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:16px 18px;margin:8px 0 16px}'
      + '#tab-pipeline .legend-box .lg-title{font-size:13px;font-weight:800;letter-spacing:-.01em;color:var(--text);margin:0 0 14px}'
      + '#tab-pipeline .lg-cols{display:grid;grid-template-columns:1fr 1fr;gap:28px}'
      + '#tab-pipeline .lg-cols > .lg-sec + .lg-sec{padding-left:28px;border-left:1px solid var(--border)}'
      + '@media(max-width:1080px){#tab-pipeline .lg-cols{grid-template-columns:1fr;gap:0}'
      + '#tab-pipeline .lg-cols > .lg-sec + .lg-sec{padding-left:0;border-left:none;padding-top:16px;margin-top:16px;border-top:1px solid var(--border)}}'
      + '#tab-pipeline .lg-h{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--accent);font-weight:700;margin:0 0 12px}'
      + '#tab-pipeline .lg-co{font-size:12.5px;line-height:1.55;color:var(--text);margin:0 0 12px}'
      + '#tab-pipeline .lg-co i{color:var(--dim);font-style:italic}'
      + '#tab-pipeline .lg-defs{display:grid;grid-template-columns:max-content 1fr;gap:7px 14px;margin:0 0 12px;font-size:12.5px;line-height:1.5;align-items:baseline}'
      + '#tab-pipeline .lg-defs dt{font-weight:800;color:var(--accent);font-variant-numeric:tabular-nums;white-space:nowrap}'
      + '#tab-pipeline .lg-defs dd{margin:0;color:var(--text)}'
      + '#tab-pipeline .lg-defs-wide dt{color:var(--high)}'
      + '#tab-pipeline .lg-pill{display:inline-block;font-size:10.5px;font-weight:700;border-radius:5px;padding:1px 7px;margin:0 0 0 5px;font-variant-numeric:tabular-nums;vertical-align:baseline}'
      + '#tab-pipeline .lg-keyrows{display:grid;gap:8px;margin:2px 0 0}'
      + '#tab-pipeline .lg-keyrow{display:flex;align-items:flex-start;gap:9px;font-size:12.5px;line-height:1.45;color:var(--text)}'
      + '#tab-pipeline .lg-keyrow .sw{margin-top:2px;flex-shrink:0}'
      + '#tab-pipeline .lg-keyrow b{font-weight:700}'
      + '#tab-pipeline .lg-hover{color:#8fd0ff;margin:12px 0 0}'
      + '#tab-pipeline .lg-foot{font-size:11.5px;line-height:1.5;color:var(--dim);margin:18px 0 0;padding-top:14px;border-top:1px solid var(--border)}'
      + '#tab-pipeline .sw{display:inline-block;width:13px;height:13px;border-radius:3px;vertical-align:middle;margin-right:5px;border:1px solid #0006}'
      + '#tab-pipeline h1.sec{font-size:16px;color:var(--accent);border-top:2px solid var(--border);padding-top:16px;margin-top:30px}'
      + '#tab-pipeline h2{font-size:15px;color:var(--accent);margin-top:22px}'
      // sample-cell legend
      + '#tab-pipeline .lg-cellwrap{display:flex;gap:18px;align-items:flex-start;margin:6px 0 4px;flex-wrap:wrap}'
      + '#tab-pipeline .lg-cell{flex:0 0 200px;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--panel2)}'
      + '#tab-pipeline .lg-cell-hdr{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);font-weight:700;padding:5px 8px;border-bottom:1px solid var(--border);background:var(--panel)}'
      + '#tab-pipeline .lg-callouts{flex:1;min-width:280px;display:flex;flex-direction:column;gap:6px}'
      + '#tab-pipeline .reset-ico{color:#bfe7c8}'
      + '#tab-pipeline .pipe-table{width:100%;min-width:100%;font-size:12.5px;margin:6px 0 8px;border-collapse:collapse}'
      + '#tab-pipeline .pipe-table.fusion{font-size:12px}'
      + '#tab-pipeline .pipe-table th{position:sticky;top:0;background:var(--panel2);z-index:2;text-align:center;white-space:nowrap;padding:6px 5px;border:1px solid var(--border);font-size:11px;color:var(--accent)}'
      + '#tab-pipeline .pipe-table td{padding:0;text-align:center;vertical-align:top;border:1px solid var(--border)}'
      + '#tab-pipeline .pipe-table td.pipe{padding:5px 8px;vertical-align:middle}'
      + '#tab-pipeline .pipe-table td.blcell{font-weight:700;color:var(--text);white-space:nowrap}'
      + '#tab-pipeline .pipe-table td.boxcell{font-size:11px;color:var(--dim);padding:4px 6px;vertical-align:middle;line-height:1.4}'
      + '#tab-pipeline .pipe-table td.num{padding:5px 8px;vertical-align:middle;font-variant-numeric:tabular-nums}'
      + '#tab-pipeline .pipe-table td.cpcell{font-weight:700;color:#8fd0ff}'
      + '#tab-pipeline .sep{border-left:2px solid var(--accent)!important}'
      + '#tab-pipeline .bkt-grid{display:flex;flex-direction:column}'
      + '#tab-pipeline .bkt-row{display:flex;align-items:center;min-height:22px;padding:1px 5px;gap:6px;border-bottom:1px solid #0003}'
      + '#tab-pipeline .bkt-row:last-child{border-bottom:none}'
      + '#tab-pipeline .bkt-label{width:30px;text-align:left;font-size:10px;font-weight:700;flex-shrink:0;color:#aab2c5}'
      + '#tab-pipeline .bkt-val{flex:1;text-align:right;font-weight:700;font-variant-numeric:tabular-nums}'
      + '#tab-pipeline .bkt-reset{width:14px;text-align:center;font-size:12px;color:#bfe7c8;flex-shrink:0}'
      + '#tab-pipeline td.gem{cursor:help}'
      + '#tab-pipeline td.gem:hover{outline:2px solid var(--accent);outline-offset:-2px}'
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
      + '#tab-pipeline th.legendary{color:#f0c674}#tab-pipeline th.relic{color:#c79bff}#tab-pipeline th.ancient{color:#ff9d6e}'
      + '#tab-pipeline .dim{color:var(--dim);font-weight:400;font-size:10.5px}'
      + '#tab-pipeline .rank-badge{display:inline-block;padding:1px 7px;border-radius:99px;font-size:10.5px;font-weight:800;line-height:1.5;vertical-align:middle;font-variant-numeric:tabular-nums}'
      + '#tab-pipeline .gpd-btn{min-width:48px;text-align:center}'
      // Top bar: tucked above (only a small handle peeks); slides down on hover so the table keeps the space.
      // The bar reveals DOWNWARD (over the table), never upward — sticking at top:0 it
      // would otherwise slide up over the app .tabbar at scroll 0. Only the small handle
      // shows by default (22px reserved); hovering it fades the full bar in just below.
      + '#tab-pipeline #pl-inputs{height:22px;margin:0;padding:0;border:none;border-radius:0;background:none;backdrop-filter:none;z-index:30;overflow:visible}'
      + '#tab-pipeline #pl-inputs .pl-handle{position:absolute;top:0;left:0;height:22px;line-height:21px;margin-left:28px;padding:0 14px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.09em;color:var(--dim);background:rgba(13,16,23,.97);border:1px solid var(--border);border-top:none;border-radius:0 0 8px 8px;cursor:pointer;user-select:none;z-index:1}'
      + '#tab-pipeline #pl-inputs .pl-bar{position:absolute;left:0;right:0;top:22px;opacity:0;visibility:hidden;pointer-events:none;transform:translateY(-6px);transition:opacity .15s ease,transform .15s ease,visibility .15s;display:flex;flex-wrap:wrap;align-items:center;gap:7px;padding:10px 16px 10px 28px;background:rgba(13,16,23,.98);border:1px solid var(--border);border-radius:0 0 10px 10px;backdrop-filter:blur(6px)}'
      + '#tab-pipeline #pl-inputs:hover .pl-bar,#tab-pipeline #pl-inputs.pl-open .pl-bar{opacity:1;visibility:visible;pointer-events:auto;transform:translateY(0)}'
      + '#tab-pipeline #pl-inputs:hover .pl-handle,#tab-pipeline #pl-inputs.pl-open .pl-handle{color:var(--accent);border-color:var(--accent)}'
      + '#tab-pipeline #pl-inputs .pl-gpd{display:inline-flex;flex-wrap:wrap;gap:7px}'
      + '#tab-pipeline #pl-inputs .pl-sep{width:1px;align-self:stretch;background:var(--border);margin:2px 4px}'
      + '#tab-pipeline #pl-inputs .pl-region{display:inline-flex;flex-wrap:wrap;gap:7px}'
      + '#tab-pipeline .tablewrap{overflow-x:auto;max-width:100%}'
      // ---- hover popover (appended to <body>, so NOT scoped under #tab-pipeline) ----
      + '.pl-pop{position:absolute;z-index:9999;max-width:420px;min-width:330px;background:#10131c;'
      + 'border:1px solid #39414f;border-radius:10px;box-shadow:0 10px 34px #000a,0 0 0 1px #0006;'
      + 'padding:11px 13px;color:#e7e9ee;font:12px/1.45 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",Arial,sans-serif;pointer-events:auto}'
      + '.pl-pop .pt-head{font-size:13px;font-weight:800;color:#8fd0ff;margin-bottom:7px;display:flex;align-items:center;gap:8px}'
      + '.pl-pop .pt-rs{font-size:9px;letter-spacing:.08em;background:#243049;color:#9cc6ff;border-radius:99px;padding:1px 8px;font-weight:800}'
      + '.pl-pop .pt-tbl{width:100%;border-collapse:collapse;margin:0 0 4px}'
      + '.pl-pop .pt-tbl th{font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:#8893a8;font-weight:700;text-align:right;padding:2px 4px;border-bottom:1px solid #2a3142}'
      + '.pl-pop .pt-tbl th:first-child{text-align:left}'
      + '.pl-pop .pt-tbl td{padding:3px 4px;border-bottom:1px solid #1c2230;font-variant-numeric:tabular-nums}'
      + '.pl-pop .pt-tbl tr:last-child td{border-bottom:none}'
      + '.pl-pop .pt-avg{margin:6px 0 2px;font-size:12px;font-variant-numeric:tabular-nums}'
      + '.pl-pop .pt-num{text-align:right;font-weight:700}'
      + '.pl-pop .pt-pair{font-size:11px}.pl-pop .pt-pair b{color:#cdd6e8}'
      + '.pl-pop .pt-dim{color:#7e889c;font-weight:400;font-size:10px}'
      + '.pl-pop .pt-sec{margin-top:8px;border-top:1px solid #2a3142;padding-top:7px}'
      + '.pl-pop .pt-sec-h{font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:#8fd0ff;font-weight:800;margin-bottom:5px}'
      + '.pl-pop .pt-fod-row{display:flex;align-items:center;gap:7px;margin:3px 0}'
      + '.pl-pop .pt-fod-lbl{width:26px;font-size:10px;font-weight:700;color:#aab2c5;flex-shrink:0}'
      + '.pl-pop .pt-fod-bar{flex:1;display:flex;height:9px;border-radius:5px;overflow:hidden;background:#1c2230}'
      + '.pl-pop .pt-leg{background:#f0c674}.pl-pop .pt-rel{background:#c79bff}.pl-pop .pt-anc{background:#ff9d6e}'
      + '.pl-pop .pt-fod-pct{font-size:9.5px;white-space:nowrap;flex-shrink:0;font-variant-numeric:tabular-nums}'
      + '.pl-pop .pt-leg-t{color:#f0c674}.pl-pop .pt-rel-t{color:#c79bff}.pl-pop .pt-anc-t{color:#ff9d6e}'
      + '.pl-pop .pt-fuse-grid{display:grid;grid-template-columns:auto 1fr;gap:3px 10px;align-items:baseline}'
      + '.pl-pop .pt-k{font-size:10px;color:#8893a8;font-weight:700;text-transform:uppercase;letter-spacing:.04em}'
      + '.pl-pop .pt-v{font-size:12px;font-variant-numeric:tabular-nums}'
      + '.pl-pop .pt-v.pt-hot{font-weight:800;color:#cdd6e8}'
      + '.pl-pop .pt-win{color:#6ee7a8}.pl-pop .pt-win.pt-open{color:#ffb86b}'
      + '.pl-pop .rank-badge{display:inline-block;padding:0 6px;border-radius:99px;font-size:10px;font-weight:800;vertical-align:middle}'
      + '</style>';
  }

  // ---------------------------------------------------------------------------
  // render orchestration
  // ---------------------------------------------------------------------------
  function resultsHtml() {
    if (!DATA) return '<div class="placeholder"><b>Loading baked tiers…</b></div>';
    if (GPD == null) return '<div class="placeholder"><b>No gpd tiers found in data/pipeline.json</b></div>';
    var out = '<h2 id="grid">' + gpdName(GPD) + ' gold / 1% damage — ' + (ROSTER === "nrb" ? "Non-Roster Bound" : "Roster Bound") + '</h2>';
    out += '<div class="tablewrap">' + gpdTable(GPD, ROSTER) + '</div>';
    out += '<div class="tablewrap">' + fusionTable(GPD) + '</div>';
    return out;
  }

  function renderBody() {
    var host = document.getElementById("pl-results");
    if (!host) return;
    TIPS = {}; TIP_SEQ = 0;            // rebuild the hover registry for this render
    host.innerHTML = resultsHtml();
    wireTips(host);
  }

  // ---------------------------------------------------------------------------
  // Hover popover: one floating element, shown on mouseover of any [data-tip] cell,
  // positioned to stay inside the viewport (flips left when it would clip the right
  // edge; clamps vertically). Content comes from the TIPS registry built by gemCell.
  // ---------------------------------------------------------------------------
  function popEl() {
    var el = document.getElementById("pl-pop");
    if (!el) {
      el = document.createElement("div");
      el.id = "pl-pop";
      el.className = "pl-pop";
      el.style.display = "none";
      document.body.appendChild(el);
    }
    return el;
  }
  function positionPop(el, cell) {
    var r = cell.getBoundingClientRect();
    var pw = el.offsetWidth, ph = el.offsetHeight;
    var pad = 10, gap = 8;
    var vw = document.documentElement.clientWidth, vh = window.innerHeight;
    // prefer to the right of the cell; flip to the left if it would clip.
    var left = r.right + gap;
    if (left + pw > vw - pad) left = r.left - gap - pw;
    if (left < pad) left = Math.max(pad, Math.min(vw - pw - pad, r.left));   // last resort: clamp
    var top = r.top;
    if (top + ph > vh - pad) top = vh - ph - pad;
    if (top < pad) top = pad;
    el.style.left = (left + window.pageXOffset) + "px";
    el.style.top = (top + window.pageYOffset) + "px";
  }
  function wireTips(host) {
    var el = popEl();
    var hideT = null;
    function show(cell) {
      var id = cell.getAttribute("data-tip");
      if (!id || !TIPS[id]) return;
      if (hideT) { clearTimeout(hideT); hideT = null; }
      el.innerHTML = TIPS[id];
      el.style.display = "block";
      el.style.visibility = "hidden";
      // measure then place
      positionPop(el, cell);
      el.style.visibility = "visible";
    }
    function hide() { hideT = setTimeout(function () { el.style.display = "none"; }, 60); }
    host.addEventListener("mouseover", function (e) {
      var cell = e.target.closest ? e.target.closest("td.gem[data-tip]") : null;
      if (cell && cell.getAttribute("data-tip")) show(cell);
    });
    host.addEventListener("mousemove", function (e) {
      var cell = e.target.closest ? e.target.closest("td.gem[data-tip]") : null;
      if (cell && el.style.display === "block" && cell.getAttribute("data-tip")) {
        // only reposition if hovering a different cell than currently shown
        if (cell !== wireTips._cur) { wireTips._cur = cell; show(cell); }
      }
    });
    host.addEventListener("mouseout", function (e) {
      var to = e.relatedTarget;
      if (to && (el.contains(to))) return;             // moving into the popover itself
      var cell = e.target.closest ? e.target.closest("td.gem[data-tip]") : null;
      if (cell && to && cell.contains(to)) return;     // still within the same cell
      wireTips._cur = null;
      hide();
    });
    // let the popover itself be hoverable without flicker (it never overlaps the cell anyway)
    el.onmouseenter = function () { if (hideT) { clearTimeout(hideT); hideT = null; } };
    el.onmouseleave = function () { hide(); };
  }

  function render() {
    var el = document.getElementById("tab-pipeline");
    if (!el) return;
    el.innerHTML = scopedStyle() + inputsHtml() + legendHtml()
      + '<div id="pl-results"></div>' + methodologyHtml();
    renderBody();
    ensureData();
  }

  // Re-render just the inputs row (to refresh the gpd buttons once data arrives) + body.
  function refreshInputs() {
    var host = document.getElementById("pl-inputs");
    if (host && host.parentNode) {
      var tmp = document.createElement("div");
      tmp.innerHTML = inputsHtml();
      host.parentNode.replaceChild(tmp.firstChild, host);
    }
  }

  function ensureData() {
    if (DATA || ensureData._loading) return;
    ensureData._loading = true;
    fetch("data/pipeline.json", { cache: "no-cache" })  // revalidate so re-bakes show without a hard-refresh (304 when unchanged)
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (j) {
        DATA = j; ensureData._loading = false;
        GPD_LIST = gpdsInData();
        if (GPD == null && GPD_LIST.length) {
          // default to 1.5M if present, else the middle tier
          GPD = GPD_LIST.indexOf(1500000) >= 0 ? 1500000 : GPD_LIST[Math.floor(GPD_LIST.length / 2)];
        }
        refreshInputs();
        renderBody();
      })
      .catch(function (e) {
        ensureData._loading = false;
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
  window.__plSetGpd = function (g) {
    GPD = g;
    var btns = document.querySelectorAll("#pl-gpd-row .gpd-btn");
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle("active", Number(btns[i].dataset.gpd) === g);
    renderBody();
  };
  window.__plSetRoster = function (rb) {
    ROSTER = rb;
    var a = document.getElementById("pl-r-nrb"), b = document.getElementById("pl-r-rb");
    if (a) a.classList.toggle("active", rb === "nrb");
    if (b) b.classList.toggle("active", rb === "rb");
    var note = document.getElementById("pl-mode-note");
    if (note) note.textContent = modeNote();
    renderBody();
  };
  window.__plSetRegion = function (rg) {
    var inp0 = document.getElementById("pl-inputs");
    var wasOpen = !!(inp0 && inp0.classList.contains("pl-open"));   // keep the bar open across the rebuild (mobile)
    REGION = (rg === "kr") ? "kr" : "global";
    if (REGION === "kr") ROSTER = "nrb";   // KR has no roster-bound gems
    refreshInputs();   // rebuild the bar (region/roster buttons, RB hidden in KR)
    renderBody();      // recompute the grid with the region's fusion economics
    if (wasOpen) { var inp1 = document.getElementById("pl-inputs"); if (inp1) inp1.classList.add("pl-open"); }
  };
  window.__plToggleBar = function () {   // tap the handle (mobile has no hover) to open/close the bar
    var el = document.getElementById("pl-inputs");
    if (el) el.classList.toggle("pl-open");
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
