/**
 * tools/collect-stats.js — bake the Pipeline-tab dataset (data/pipeline.json).
 *
 * ============================================================================
 * BUCKET-PRIMARY MODEL (this is the axis the cut/fuse/throw decision lives on)
 * ============================================================================
 * When a gem drops you assess its EFFECT PAIR — the two of four effects it rolled.
 * The pair IS the gem's archetype = its BUCKET (exact pairs per base cost from
 * ark-grid-solver/collect-statistics-v2.js EFFECT_BUCKETS):
 *
 *   2_damage         (2D)  both effects are damage           -> best archetype
 *   optimal_damage   (Op)  the BETTER single damage effect + a dead effect
 *   suboptimal_damage(Sub) the WORSE  single damage effect + a dead effect
 *   no_damage        (No)  both dead (DPS-worthless)         -> ~0 for DPS
 *
 * The VALUE of a bucket = optimal expected gold from CUTTING A FRESH (level-1)
 * gem of that archetype:
 *     cutValue = W( freshGem, maxTurns[rarity], maxRerolls[rarity], cm=0 )
 * where freshGem has the bucket's two effects and willpower/order/effect1/effect2
 * all at level 1 (mirrors collect-statistics-v2.js buildState), and `W` is the
 * EXACT Bellman DP in model/dp.js — the version that takes the expectation over
 * the fresh random 4-draw INSIDE (Solver.prototype.W / _node), NOT
 * evaluateActionsDP (which needs specific drawn outcomes). The DP value is the
 * source of truth for the per-bucket verdicts the table renders.
 *
 * TIER (legendary/relic/ancient by level-sum) is NOT the primary axis. It is the
 * fusion-FODDER classification: a below-baseline cut becomes fodder, classified by
 * tier, fused 3->1. So tier is baked as the per-bucket `p_fodder_leg/relic/anc`
 * split (for the separate "Fusion / fodder by tier" view — "for after").
 *
 * KEYING: cells are keyed (rarity, cost, bucket, baseline, gpd). Each carries:
 *   cutValue   DP W of the fresh gem                                   (gold)
 *   bestAction turn-1 optimal action ('process'|'reroll'|'complete')
 *   pAbove     P(final cut clears baseline) under the optimal policy   (0..1)
 *   expSpend   E[future gold spent] under the optimal policy           (gold)
 *   expScore   E[final % damage] under the optimal policy              (% dmg)
 *   pFodderLeg/Relic/Anc  fodder tier split (sums to 1 - pAbove)
 * Plus a cell-level (per gpd/baseline/cost) weekly-throughput block.
 *
 * The DP at turn-1 epic is ~3s, so this PARALLELIZES with worker_threads
 * (tools/collect-stats-worker.js) and logs progress + ETA.
 *
 * ============================ THROUGHPUT MODEL ============================
 * The deployed page (ark-grid-solver/index) renders a weekly-throughput model
 * ("Time to Complete 24"): above-baseline gems netted per week and weeks to fill
 * 24 slots. Its EXACT generator was not part of the model core, so the throughput
 * layer is a faithful, documented RECONSTRUCTION. The structural identities the
 * deployed page obeys are reproduced exactly:
 *       totalPerWk = directPerWk + fusePerWk
 *       weeks      = SLOTS / totalPerWk            (SLOTS = 24)
 * Direct/wk now uses the DP per-bucket pAbove averaged over a fresh-drop bucket
 * mix (a fresh gem rolls some effect pair). Constants that could not be recovered
 * from the core (weekly cut budget, box schedule, fresh bucket mix) are named
 * below and in METHODOLOGY.md; retune them without touching the DP verdicts.
 * =========================================================================
 *
 * Usage:
 *   node tools/collect-stats.js [--workers=N] [--test] [--sample=N]
 */
"use strict";

var fs = require("fs");
var path = require("path");
var os = require("os");
var { Worker } = require("worker_threads");
var A = require("../model/astrogem.js");

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

// Fixed gold-per-1%-damage tiers the BAKED view renders as columns. The deployed
// page shows 500k/1M/1.5M/2.5M/5M; the task asks to also include 3.5M.
var FIXED_GPD = [500000, 1000000, 1500000, 2500000, 3500000, 5000000, 7500000, 10000000];

// NO INTERPOLATION anywhere: bake ONLY the displayed gold tiers — every baked cell
// is an exact DP solve. Off-grid (live) gold/grade is computed exactly on demand
// in the browser, never interpolated. (Previously there were extra anchors here
// purely to interpolate; removed.)
var ALL_GPD = FIXED_GPD.slice();

var COSTS = [8, 9, 10];
var RARITIES = ["uncommon", "rare", "epic"];
var BUCKETS = ["2_damage", "optimal_damage", "suboptimal_damage", "no_damage"];

// Effect pairs per (cost, bucket) — EXACT from ark-grid-solver/collect-statistics-v2.js.
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

// Bake EXACTLY at the grade rows the pipeline renders (ranks C- … S+), so every
// baked cell is an exact DP value at that baseline grade — no interpolation noise.
// Each grade -> its %-damage threshold via gradeToScore (the SAME fn the UI uses,
// so the UI's grade rows land precisely on these baked baselines = exact lookup).
var BAKED_GRADES = [52, 57, 62, 66, 70, 73, 77, 80, 83, 87, 92, 97]; // C- … S+
var BAKED_BASELINES = BAKED_GRADES.map(function (g) { return A.gradeToScore(g); });

// Per-gpd baseline window shown in the BAKED tables. Cheap gold/1%: even weak gems
// are worth keeping -> low floor. Expensive gold/1%: only strong gems clear -> high.
var BASELINE_WINDOW = {
  500000:  [0.5, 1.5],
  750000:  [0.5, 2.0],
  1000000: [0.75, 2.0],
  1500000: [0.75, 2.5],
  2000000: [1.0, 2.5],
  2500000: [1.0, 2.5],
  3500000: [1.0, 2.5],
  4000000: [1.25, 2.5],
  5000000: [1.25, 2.5],
  7500000: [1.25, 2.5],
  10000000: [1.25, 2.5]
};

var RARITY_PARAMS = A.RARITY; // { uncommon:{maxTurns,maxRerolls}, ... }

// ---------------------------------------------------------------------------
// Throughput constants (documented reconstruction; NOT part of the DP verdicts).
// ---------------------------------------------------------------------------
var SLOTS = 24;
// Weekly cut budget by rarity (cutting an epic is expensive -> fewer).
var CUTS_PER_WEEK = { uncommon: 70, rare: 26, epic: 9 };
var FUSION_INPUTS = 3;
// Fresh-drop BUCKET mix: a dropped gem's effect pair is (roughly) uniform over the
// C(4,2)=6 pairs of the cost's pool; mapped onto our four archetypes that is about
// 1 two-damage pair, 2 optimal, 2 suboptimal, ... but the dead-pair count varies by
// cost. We use a single representative mix (documented; retunable).
var FRESH_BUCKET_MIX = { "2_damage": 0.17, "optimal_damage": 0.33, "suboptimal_damage": 0.33, "no_damage": 0.17 };
// Weekly box gems (handed out by content, not cut). Gold value = directEV of the
// fresh cut of the representative 2-damage bucket at the box's nominal rarity.
var BOX_SCHEDULE = [
  { count: 10, rarity: "uncommon" },
  { count: 10, rarity: "rare" },
  { count: 1,  rarity: "epic" }
];

// ---------------------------------------------------------------------------
// Task list — (rarity, cost, bucket, baseline, gpd) x {NRB, RB}.
// ---------------------------------------------------------------------------
function buildTasks() {
  var tasks = [];
  for (var ri = 0; ri < RARITIES.length; ri++) {
    var rarity = RARITIES[ri];
    var params = RARITY_PARAMS[rarity];
    for (var ci = 0; ci < COSTS.length; ci++) {
      var cost = COSTS[ci];
      for (var bi = 0; bi < BUCKETS.length; bi++) {
        var bucket = BUCKETS[bi];
        var eff = EFFECT_BUCKETS[cost][bucket];
        for (var gi = 0; gi < ALL_GPD.length; gi++) {
          var gpd = ALL_GPD[gi];
          for (var blI = 0; blI < BAKED_BASELINES.length; blI++) {
            var baseline = BAKED_BASELINES[blI];
            for (var rb = 0; rb < 2; rb++) {
              tasks.push({
                id: tasks.length,
                rarity: rarity, cost: cost, bucket: bucket,
                baseline: baseline, gpd: gpd,
                rosterBound: rb === 1,
                effect1: eff.effect1, effect2: eff.effect2,
                maxTurns: params.maxTurns, maxRerolls: params.maxRerolls
              });
            }
          }
        }
      }
    }
  }
  return tasks;
}

// ---------------------------------------------------------------------------
// Worker pool. Each worker takes stripe indices (i % numWorkers === workerId).
// ---------------------------------------------------------------------------
function runWithWorkers(tasks, numWorkers) {
  var workerPath = path.join(__dirname, "collect-stats-worker.js");
  var results = new Array(tasks.length).fill(null);
  var completed = 0;
  var perRarity = { uncommon: 0, rare: 0, epic: 0 };
  var total = tasks.length;
  var startTime = Date.now();
  var PROGRESS_EVERY = 50;
  var active = [];

  // Empirical per-cell cost multipliers (rare ~6x, epic ~25x uncommon) for ETA.
  var perRarityTotal = { uncommon: 0, rare: 0, epic: 0 };
  for (var i = 0; i < tasks.length; i++) perRarityTotal[tasks[i].rarity]++;

  function runWorker(workerId) {
    return new Promise(function (resolve, reject) {
      var worker = new Worker(workerPath, { workerData: { tasks: tasks, workerId: workerId, numWorkers: numWorkers } });
      active.push(worker);
      worker.on("message", function (msg) {
        if (msg.type !== "result") return;
        var task = tasks[msg.id];
        if (msg._error) {
          console.error("  [task " + msg.id + " error] " + msg._error.split("\n")[0]);
        }
        results[msg.id] = {
          rarity: task.rarity, cost: task.cost, bucket: task.bucket,
          baseline: task.baseline, gpd: task.gpd, rosterBound: task.rosterBound,
          cutValue: msg.cutValue, bestAction: msg.bestAction,
          pAbove: msg.pAbove, expScore: msg.expScore, expSpend: msg.expSpend,
          fodderLeg: msg.fodderLeg, fodderRelic: msg.fodderRelic, fodderAnc: msg.fodderAnc
        };
        completed++;
        if (task.rarity) perRarity[task.rarity]++;
        if (completed % PROGRESS_EVERY === 0 || completed === total) {
          var elapsed = (Date.now() - startTime) / 1000;
          var frac = completed / total;
          var eta = frac > 0 ? elapsed * (1 - frac) / frac : 0;
          var etaStr = eta >= 60 ? "~" + Math.floor(eta / 60) + "m " + Math.round(eta % 60) + "s" : "~" + Math.round(eta) + "s";
          console.log("[" + new Date().toISOString().slice(11, 19) + "] "
            + completed + "/" + total + " (" + (frac * 100).toFixed(1) + "%) | "
            + "unc " + perRarity.uncommon + "/" + perRarityTotal.uncommon + ", "
            + "rare " + perRarity.rare + "/" + perRarityTotal.rare + ", "
            + "epic " + perRarity.epic + "/" + perRarityTotal.epic + " | "
            + elapsed.toFixed(0) + "s elapsed, " + etaStr + " left");
        }
      });
      worker.on("error", reject);
      worker.on("exit", function (code) {
        active = active.filter(function (w) { return w !== worker; });
        if (code !== 0) reject(new Error("Worker " + workerId + " exited with code " + code));
        else resolve();
      });
    });
  }

  function shutdown() {
    for (var k = 0; k < active.length; k++) { try { active[k].terminate(); } catch (e) {} }
  }
  process.on("SIGINT", function () { console.log("\nSIGINT: terminating workers..."); shutdown(); process.exit(130); });

  return Promise.all(Array.from({ length: numWorkers }, function (_, w) { return runWorker(w); }))
    .then(function () { return results; });
}

// ---------------------------------------------------------------------------
// Assemble the keyed cell map + throughput block from the worker results.
// ---------------------------------------------------------------------------
function r0(x) { return x == null ? null : Math.round(x); }
function r2(x) { return x == null ? null : Math.round(x * 100) / 100; }
function r4(x) { return x == null ? null : Math.round(x * 1e4) / 1e4; }
function rWeeks(x) { return (x == null || x === Infinity) ? null : Math.round(x * 10) / 10; }

// key: rarity_cost_bucket_baseline_gpd  (NRB and RB held in one cell record)
function cellKey(rarity, cost, bucket, baseline, gpd) {
  return rarity + "_" + cost + "_" + bucket + "_" + baseline + "_" + gpd;
}

function assemble(results) {
  // Index NRB/RB results by (rarity,cost,bucket,baseline,gpd).
  var byKey = {};
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    if (!r) continue;
    var k = cellKey(r.rarity, r.cost, r.bucket, r.baseline, r.gpd);
    if (!byKey[k]) byKey[k] = {};
    byKey[k][r.rosterBound ? "rb" : "nrb"] = r;
  }

  // Per-bucket cells (the SOURCE OF TRUTH for verdicts).
  var cells = {};
  Object.keys(byKey).forEach(function (k) {
    var rec = byKey[k];
    var nrb = rec.nrb, rb = rec.rb;
    var out = {};
    if (nrb) {
      out.nrb = {
        cut: r0(nrb.cutValue),
        act: nrb.bestAction,
        pAbove: r4(nrb.pAbove),
        expScore: r4(nrb.expScore),
        expSpend: r0(nrb.expSpend),
        fLeg: r4(nrb.fodderLeg), fRelic: r4(nrb.fodderRelic), fAnc: r4(nrb.fodderAnc)
      };
    }
    if (rb) {
      out.rb = {
        cut: r0(rb.cutValue),
        act: rb.bestAction,
        pAbove: r4(rb.pAbove),
        expScore: r4(rb.expScore),
        expSpend: r0(rb.expSpend)
      };
    }
    cells[k] = out;
  });

  // -------------------------------------------------------------------------
  // Throughput block, per (rarity, cost, baseline, gpd). Uses NRB cut values.
  // directPerWk = cutsPerWeek[rarity] * (fresh-bucket-mix-weighted pAbove)
  // fusePerWk   = recycle below-baseline fodder 3->1 through the legendary lane
  // -------------------------------------------------------------------------
  function nrbBucket(rarity, cost, bucket, baseline, gpd) {
    var c = cells[cellKey(rarity, cost, bucket, baseline, gpd)];
    return c && c.nrb ? c.nrb : null;
  }

  // P(above) of the fresh-drop bucket mix at (rarity, cost, baseline, gpd).
  function freshPAbove(rarity, cost, baseline, gpd) {
    var p = 0, wsum = 0;
    for (var bi = 0; bi < BUCKETS.length; bi++) {
      var b = BUCKETS[bi];
      var nb = nrbBucket(rarity, cost, b, baseline, gpd);
      if (!nb) continue;
      var w = FRESH_BUCKET_MIX[b];
      p += w * (nb.pAbove || 0); wsum += w;
    }
    return wsum > 0 ? p / wsum : 0;
  }
  // Fodder-recycle yield: a below-baseline fresh cut is mostly legendary fodder; a
  // legendary 3->1 fusion outputs mostly legendary (99/1/0). We model the recycled
  // output's P(above) as the legendary-fusion-output mix's P(above), using the
  // 2-damage bucket as the recycled archetype proxy (best case fodder is salvageable).
  function fusionOutPAbove(rarity, cost, baseline, gpd) {
    var mix = A.fusionOutputDist(["legendary", "legendary", "legendary"]);
    // Approximate the recycled output P(above) by the fresh-bucket-mix pAbove of the
    // output tier mix; we only have per-bucket fresh-cut stats, so use freshPAbove
    // scaled by the legendary share (dominant) — a documented, conservative proxy.
    return mix.legendary * freshPAbove(rarity, cost, baseline, gpd);
  }

  // Box EV: gold value/week of box gems = box count * 2D-bucket directEV (cut value
  // proxy) at the box's rarity. We approximate a box gem's gold value by the cut
  // value of a fresh 2-damage gem at that rarity (a box gem is a free cut target).
  function boxEVat(cost, baseline, gpd) {
    var ev = 0;
    for (var b = 0; b < BOX_SCHEDULE.length; b++) {
      var box = BOX_SCHEDULE[b];
      var nb = nrbBucket(box.rarity, cost, "2_damage", baseline, gpd);
      if (nb) ev += box.count * Math.max(0, nb.cut);
    }
    return ev;
  }

  var thru = {}; // key rarity_cost_baseline_gpd
  for (var ri = 0; ri < RARITIES.length; ri++) {
    var rarity = RARITIES[ri];
    var cuts = CUTS_PER_WEEK[rarity];
    for (var ci = 0; ci < COSTS.length; ci++) {
      var cost = COSTS[ci];
      for (var gi = 0; gi < ALL_GPD.length; gi++) {
        var gpd = ALL_GPD[gi];
        for (var blI = 0; blI < BAKED_BASELINES.length; blI++) {
          var bl = BAKED_BASELINES[blI];
          var pa = freshPAbove(rarity, cost, bl, gpd);
          var directPerWk = cuts * pa;
          var fodderPerWk = cuts * (1 - pa);
          var fusionsPerWk = fodderPerWk / FUSION_INPUTS;
          var fusePerWk = fusionsPerWk * fusionOutPAbove(rarity, cost, bl, gpd);
          var dWk = r2(directPerWk), fWk = r2(fusePerWk);
          var totWk = r2((dWk || 0) + (fWk || 0));
          // Gold/wk: box gold + fresh-cut value (mix-weighted) + recycled fodder value.
          var cutVal = 0, wsum = 0;
          for (var bi2 = 0; bi2 < BUCKETS.length; bi2++) {
            var nb = nrbBucket(rarity, cost, BUCKETS[bi2], bl, gpd);
            if (!nb) continue;
            var w = FRESH_BUCKET_MIX[BUCKETS[bi2]];
            cutVal += w * Math.max(0, nb.cut); wsum += w;
          }
          cutVal = wsum > 0 ? cutVal / wsum : 0;
          var goldPerWk = boxEVat(cost, bl, gpd) + cuts * cutVal;
          // Avg keeper % damage above baseline (fresh 2D bucket is the canonical keeper).
          var nb2D = nrbBucket(rarity, cost, "2_damage", bl, gpd);
          var avgScore = nb2D ? nb2D.expScore : bl;
          thru[rarity + "_" + cost + "_" + bl + "_" + gpd] = {
            directPerWk: dWk,
            fusePerWk: fWk,
            totalPerWk: totWk,
            weeks: totWk > 0 ? rWeeks(SLOTS / totWk) : null,
            goldPerWk: r0(goldPerWk),
            boxEV: r0(boxEVat(cost, bl, gpd)),
            avgScore: r4(avgScore),
            cpGain: r4(Math.max(0, (avgScore || bl) - bl))
          };
        }
      }
    }
  }

  return { cells: cells, thru: thru };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  var testMode = process.argv.indexOf("--test") !== -1;
  var sampleArg = process.argv.find(function (a) { return a.indexOf("--sample=") === 0; });
  var workersArg = process.argv.find(function (a) { return a.indexOf("--workers=") === 0; });
  var numWorkers = workersArg
    ? parseInt(workersArg.split("=")[1], 10)
    : Math.max(1, Math.min((os.cpus().length || 2) - 1, 16));

  var tasks = buildTasks();
  if (testMode) {
    var n = sampleArg ? Math.max(1, parseInt(sampleArg.split("=")[1], 10)) : 12;
    // Take a spread: a few of each rarity so --test exercises the epic path too.
    tasks = tasks.filter(function (t) { return t.baseline === 1.0 && t.gpd === 1500000 && !t.rosterBound; }).slice(0, n);
    tasks = tasks.map(function (t, i) { return Object.assign({}, t, { id: i }); });
  }

  console.log("=== Astrogem Pipeline DP bake ===");
  console.log("Grid: " + RARITIES.length + " rarities x " + COSTS.length + " costs x "
    + BUCKETS.length + " buckets x " + ALL_GPD.length + " gpd x " + BAKED_BASELINES.length
    + " baselines x 2 (NRB/RB) = " + tasks.length + " DP solves");
  console.log("gpd tiers: " + ALL_GPD.map(function (g) { return (g / 1e6) + "M"; }).join(", "));
  console.log("Workers: " + numWorkers + " (of " + (os.cpus().length || "?") + " CPUs)");
  console.log("Value = W(freshGem, maxTurns[rarity], maxRerolls[rarity], cm=0)  [exact Bellman DP]");
  console.log("");

  var t0 = Date.now();
  runWithWorkers(tasks, numWorkers).then(function (results) {
    var elapsed = (Date.now() - t0) / 1000;
    var errors = results.filter(function (r) { return r && r.bestAction === "error"; }).length;
    console.log("\nDP solves complete in " + elapsed.toFixed(1) + "s"
      + (errors ? " (" + errors + " errors)" : "")
      + " (" + (tasks.length / elapsed).toFixed(2) + " solves/sec, " + numWorkers + " workers)");

    var asm = assemble(results);

    var data = {
      meta: {
        generated: new Date().toISOString(),
        generator: "tools/collect-stats.js",
        core: "model/dp.js (exact Bellman DP) over model/astrogem.js + model/nested.js",
        scoreUnit: "percent_damage",
        valueDef: "cell.cut = W(freshGem level-1, maxTurns[rarity], maxRerolls[rarity], cm=0); "
          + "bucket = effect pair (2_damage/optimal_damage/suboptimal_damage/no_damage). "
          + "Tier (Leg/Relic/Anc) is the fusion-fodder split p_fodder_*, NOT the primary axis.",
        effectBuckets: EFFECT_BUCKETS,
        bucketLabels: { "2_damage": "2D", "optimal_damage": "Op", "suboptimal_damage": "Sub", "no_damage": "No" },
        rarityParams: RARITY_PARAMS,
        fixedGpd: FIXED_GPD,
        anchorGpd: ALL_GPD,
        baselineWindow: BASELINE_WINDOW,
        bakedBaselines: BAKED_BASELINES,
        costs: COSTS,
        rarities: RARITIES,
        buckets: BUCKETS,
        slots: SLOTS,
        cutsPerWeek: CUTS_PER_WEEK,
        boxSchedule: BOX_SCHEDULE,
        freshBucketMix: FRESH_BUCKET_MIX,
        // Verdict thresholds reproduced from ark-grid-solver/index (gold EV bands).
        verdict: { green: 18000, yellowHi: 10000, yellowMid: 5000, yellowLo: 1000, red: 0 },
        elapsedSec: Math.round(elapsed * 10) / 10,
        nCells: Object.keys(asm.cells).length,
        nThru: Object.keys(asm.thru).length
      },
      cells: asm.cells,
      thru: asm.thru
    };

    var outPath = path.join(__dirname, "..", "data", "pipeline.json");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(data) + "\n");
    var kb = (fs.statSync(outPath).size / 1024).toFixed(1);
    console.log("Wrote " + outPath);
    console.log("  cells: " + data.meta.nCells + " bucket cells, " + data.meta.nThru + " throughput cells");
    console.log("  size:  " + kb + " KB");
    console.log("  total: " + ((Date.now() - t0) / 1000).toFixed(1) + "s");

    // Sanity: c10 epic at (baseline 1.0, 1.5M) must order 2D >> Op > Sub >> No.
    if (!testMode) {
      var g = 1500000, blI = 3, blS = BAKED_BASELINES[blI], cS = 10, rS = "epic";
      var vals = BUCKETS.map(function (b) {
        var c = asm.cells[cellKey(rS, cS, b, blS, g)];
        return c && c.nrb ? c.nrb.cut : null;
      });
      console.log("\nSanity (epic c10, grade " + BAKED_GRADES[blI] + " / bl=" + blS.toFixed(3) + ", " + (g / 1e6) + "M): "
        + "2D=" + vals[0] + " Op=" + vals[1] + " Sub=" + vals[2] + " No=" + vals[3]);
      var ok = vals[0] > vals[1] && vals[1] > vals[2] && vals[2] > vals[3];
      console.log("  ordering 2D>Op>Sub>No: " + (ok ? "PASS" : "FAIL"));
    }
  }).catch(function (e) {
    console.error(e);
    process.exit(1);
  });
}

main();
