/**
 * tools/collect-stats.js — bake the Pipeline-tab dataset (data/pipeline.json).
 *
 * Drives the DEPENDENCY-FREE closed-form core (model/astrogem.js) over a dense
 * grid of (gold-per-1%-damage, baseline, base cost) and emits a COMPACT JSON the
 * Pipeline tab loads. Everything here is closed-form (no Monte Carlo): instant,
 * deterministic, reproducible.
 *
 * WHAT IS BAKED, per (gpd, baseline, cost):
 *   For each tier (legendary / relic / ancient):
 *     pAbove    P(score >= baseline) for a random gem in that tier  (closed form)
 *     avgAbove  E[score | score >= baseline]                         (closed form)
 *     directEV  E[direct sale gold]  = sum_{s>=bl} P(s)*goldValue(s) (closed form)
 *     fullEV    tierExpectedValue (joint 3x3 fixed point: keep-or-fuse) per tier
 *     fuse3     fusionValueForTier: per-gem value of fusing 3 of this tier
 *   Plus a documented weekly-throughput block (see THROUGHPUT MODEL below):
 *     boxEV, directPerWk, fusePerWk, totalPerWk, weeks, goldPerWk, avgScore, cpGain
 *
 * The per-tier closed-form numbers are the SOURCE OF TRUTH for the per-gem
 * cut / fuse / throw verdicts. LIVE mode in pipeline.js recomputes those directly
 * from the core for ANY gpd/baseline (instant) and only interpolates the
 * throughput block from this dense grid.
 *
 * ============================ THROUGHPUT MODEL ============================
 * The deployed page (astrogem-pipeline-table) renders a weekly-throughput model
 * ("Time to Complete 24"): how many baseline-clearing gems you net per week and
 * how many weeks to fill 24 gem slots. Its EXACT generator script was not part of
 * the model core we build on, so the throughput layer here is a faithful,
 * fully-documented reconstruction calibrated to the deployed page's regime. The
 * two structural identities the deployed page obeys are reproduced exactly:
 *       totalPerWk = directPerWk + fusePerWk
 *       weeks      = SLOTS / totalPerWk           (SLOTS = 24)
 * Everything feeding those is closed-form from the core. Constants that could not
 * be recovered from the core (weekly cut budget, box schedule) are named below and
 * documented in METHODOLOGY.md so they can be retuned without touching the core.
 * =========================================================================
 */
"use strict";

var fs = require("fs");
var path = require("path");
var A = require("../model/astrogem.js");

// ---------------------------------------------------------------------------
// Grid definition
// ---------------------------------------------------------------------------

// Fixed gold-per-1%-damage tiers the BAKED view renders as columns (task spec).
// The deployed page shows 500k/1M/1.5M/2.5M/5M; the task asks to also include 3.5M.
var FIXED_GPD = [500000, 1000000, 1500000, 2500000, 3500000, 5000000];

// Extra anchors so LIVE mode can interpolate the throughput block smoothly across
// the whole 300k..6M range without being limited to the six fixed tiers.
var EXTRA_GPD = [300000, 750000, 2000000, 3000000, 4000000, 6000000];

var ALL_GPD = FIXED_GPD.concat(EXTRA_GPD).sort(function (a, b) { return a - b; });

var COSTS = [8, 9, 10];
var TIERS = ["legendary", "relic", "ancient"];

// Baselines are now %-DAMAGE thresholds (the weakest equipped gem's % damage), not
// abstract score. A perfect gem is ~1.34-1.44% damage, so a sensible baked set of
// "weakest equipped" thresholds spans ~0.5%..2.5%. These seven values are baked for
// every gpd; the per-gpd window below selects a sub-range to render in the table
// (richer gold/1%-damage => you keep only stronger gems => higher baseline floor).
var BAKED_BASELINES = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5];

// Per-gpd baseline window shown in the BAKED tables (a [min,max] over BAKED_BASELINES).
// Cheap gold/1%: even weak gems are worth keeping -> low baseline. Expensive gold/1%:
// only strong gems clear the bar -> higher baseline.
var BASELINE_WINDOW = {
  300000:  [0.5, 1.5],
  500000:  [0.5, 1.5],
  750000:  [0.5, 2.0],
  1000000: [0.75, 2.0],
  1500000: [0.75, 2.5],
  2000000: [1.0, 2.5],
  2500000: [1.0, 2.5],
  3000000: [1.0, 2.5],
  3500000: [1.0, 2.5],
  4000000: [1.25, 2.5],
  5000000: [1.25, 2.5],
  6000000: [1.5, 2.5]
};
// LIVE mode interpolates the throughput block across the full baked baseline list.

// ---------------------------------------------------------------------------
// Throughput-model constants (documented; not part of the closed-form core).
// Retune these freely — they do not affect the per-gem closed-form verdicts.
// ---------------------------------------------------------------------------
var SLOTS = 24;            // gem slots to fill ("Time to Complete 24")

// Weekly cutting budget: how many fresh gems you cut per week, by rarity. Cutting
// an epic costs more turns/gold, so you cut fewer; uncommon are cheap and plenty.
// These set the SCALE of Direct/wk = cutsPerWk * P(above baseline). Calibrated so
// the low-baseline Total/wk lands in the deployed page's ~15-25/wk regime.
var CUTS_PER_WEEK = { uncommon: 70, rare: 26, epic: 9 };

// Pre-cut fusion: 3 uncommons (same cost) -> 1 gem (mostly legendary). This is the
// "UC Fuse" lane. We model the post-cut fodder recycling generically as: every
// below-baseline cut becomes fodder, and 3 fodder gems fuse into 1 output whose
// P(above) is taken at the OUTPUT tier mix. fusePerWk counts net above-baseline
// gems produced by recycling that fodder once.
var FUSION_INPUTS = 3;     // 3 gems per fusion (game rule)

// Weekly box rewards: gems handed out by content each week (not cut). The deployed
// page shows "10x1.2k / 10x1.8k / 1x43k" style entries. We model a fixed weekly
// schedule of {count, tier} box gems; their gold value is their tierExpectedValue,
// and they contribute to Direct/wk via the tier's P(above baseline).
//   - 10 low-tier "legendary" boxes  (cheap weekly gem income)
//   - 10 mid  "relic" boxes
//   - 1  high "ancient" box (e.g. a weekly chest), only while still useful
var BOX_SCHEDULE = [
  { count: 10, tier: "legendary" },
  { count: 10, tier: "relic" },
  { count: 1,  tier: "ancient" }
];

// Combat-power % gain: score IS % damage now, so an above-baseline keeper adds
// exactly (avgAbove - baseline) % damage. cpGain reports the % damage of the
// AVERAGE final equipped gem above baseline (a small, intuitive number).

// ---------------------------------------------------------------------------
// Closed-form per-tier statistics
// ---------------------------------------------------------------------------

// { pAbove, avgAbove, directEV } for a random gem of (cost, tier) at (baseline,gpd).
function tierAboveStats(cost, tier, baseline, gpd) {
  var dist = A.scoreDistributionForTier(cost, tier);
  var pAbove = 0, dExp = 0, scoreWeighted = 0;
  dist.forEach(function (p, sc) {
    if (sc >= baseline) {
      pAbove += p;
      dExp += p * A.goldValue(sc, baseline, gpd);
      scoreWeighted += p * sc;
    }
  });
  var avgAbove = pAbove > 0 ? scoreWeighted / pAbove : baseline;
  return { pAbove: pAbove, avgAbove: avgAbove, directEV: dExp };
}

// All closed-form numbers for one (cost, baseline, gpd) cell.
function cellClosedForm(cost, baseline, gpd) {
  var ev = A.tierExpectedValue(cost, baseline, gpd);
  var per = {};
  for (var i = 0; i < TIERS.length; i++) {
    var tier = TIERS[i];
    var s = tierAboveStats(cost, tier, baseline, gpd);
    per[tier] = {
      pAbove: s.pAbove,
      avgAbove: s.avgAbove,
      directEV: s.directEV,
      fullEV: ev[tier],
      fuse3: A.fusionValueForTier(tier, cost, baseline, gpd)
    };
  }
  return per;
}

// ---------------------------------------------------------------------------
// Throughput block (documented reconstruction; identities reproduced exactly)
// ---------------------------------------------------------------------------

// Output-tier mix when fusing 3 of a given input tier (from the core).
function fuseMixPAbove(inputTier, cost, baseline) {
  var mix = A.fusionOutputDist([inputTier, inputTier, inputTier]);
  var p = 0;
  for (var i = 0; i < TIERS.length; i++) {
    var t = TIERS[i];
    p += mix[t] * tierAboveStats(cost, t, baseline, /*gpd*/ 1).pAbove;
  }
  return p; // P(fusion output clears baseline)
}

// Build the weekly-throughput numbers for one rarity at (cost, baseline, gpd).
// rarity selects the weekly cut budget. We aggregate over a representative tier
// mix for freshly-cut gems: a fresh cut lands in some tier per the natural level-
// sum tier split; we use the documented fresh-cut tier mix below.
var FRESH_TIER_MIX = { legendary: 0.86, relic: 0.13, ancient: 0.01 };

function throughput(rarity, cost, baseline, gpd, perTier) {
  var cuts = CUTS_PER_WEEK[rarity];

  // Direct/wk: fresh cuts that clear baseline, summed over the fresh-tier mix.
  var pAboveFresh = 0;
  for (var i = 0; i < TIERS.length; i++) {
    var t = TIERS[i];
    pAboveFresh += FRESH_TIER_MIX[t] * perTier[t].pAbove;
  }
  var directPerWk = cuts * pAboveFresh;

  // Fuse/wk: below-baseline fresh cuts become fodder; every FUSION_INPUTS fodder
  // make one fused output; count outputs that clear baseline.
  var fodderPerWk = cuts * (1 - pAboveFresh);
  var fusionsPerWk = fodderPerWk / FUSION_INPUTS;
  // Fodder is mostly legendary; recycle through the legendary fusion lane.
  var pFusedAbove = fuseMixPAbove("legendary", cost, baseline);
  var fusePerWk = fusionsPerWk * pFusedAbove;

  // Box EV: gold value/week of weekly box gems above baseline.
  var boxEV = 0, boxDirect = 0;
  for (var b = 0; b < BOX_SCHEDULE.length; b++) {
    var box = BOX_SCHEDULE[b];
    var ts = perTier[box.tier];
    boxEV += box.count * ts.directEV;       // gold value of the box gems (keepers)
    boxDirect += box.count * ts.pAbove;     // above-baseline box gems / wk
  }

  // Identities reproduced exactly:
  var totalPerWk = directPerWk + fusePerWk; // (boxes feed gold, not the 24-count)
  var weeks = totalPerWk > 0 ? SLOTS / totalPerWk : Infinity;

  // Gold/wk: gold value flowing in per week = box gems + value of fresh cuts
  // (their full EV, keep-or-fuse) + recycled fodder value.
  var goldPerWk = boxEV
    + cuts * (FRESH_TIER_MIX.legendary * perTier.legendary.fullEV
      + FRESH_TIER_MIX.relic * perTier.relic.fullEV
      + FRESH_TIER_MIX.ancient * perTier.ancient.fullEV);

  // Avg final gem score: expected score of an equipped keeper (above baseline),
  // tier-weighted across the fresh mix.
  var avgScore = 0, wsum = 0;
  for (var k = 0; k < TIERS.length; k++) {
    var tt = TIERS[k];
    var w = FRESH_TIER_MIX[tt] * perTier[tt].pAbove;
    avgScore += w * perTier[tt].avgAbove;
    wsum += w;
  }
  avgScore = wsum > 0 ? avgScore / wsum : baseline;

  // Combat-power % gain of the average keeper over baseline (score is % damage).
  var cpGain = Math.max(0, avgScore - baseline);

  return {
    boxEV: boxEV,
    boxDirect: boxDirect,
    directPerWk: directPerWk,
    fusePerWk: fusePerWk,
    totalPerWk: totalPerWk,
    weeks: weeks,
    goldPerWk: goldPerWk,
    avgScore: avgScore,
    cpGain: cpGain
  };
}

// ---------------------------------------------------------------------------
// Rounding helpers — keep the JSON small.
// ---------------------------------------------------------------------------
function r0(x) { return Math.round(x); }                       // integer gold
function r2(x) { return Math.round(x * 100) / 100; }           // 2 dp (per/wk, score)
function r4(x) { return Math.round(x * 1e4) / 1e4; }           // probabilities
function rWeeks(x) { return x === Infinity ? null : Math.round(x * 10) / 10; }

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
function build() {
  var cells = {}; // key "gpd_bl_cost" -> { perTier, throughput:{rarity:...} }
  var t0 = Date.now();
  var n = 0;

  for (var gi = 0; gi < ALL_GPD.length; gi++) {
    var gpd = ALL_GPD[gi];
    for (var bi = 0; bi < BAKED_BASELINES.length; bi++) {
      var bl = BAKED_BASELINES[bi];
      for (var ci = 0; ci < COSTS.length; ci++) {
        var cost = COSTS[ci];
        var perTier = cellClosedForm(cost, bl, gpd);

        // Compact per-tier block. Only the fields the BAKED tables render are kept:
        // pAbove (%), directEV (gold), fuse3 (fodder value). avgAbove/fullEV are
        // recomputed instantly from the core in LIVE mode, so they aren't baked.
        var tierOut = {};
        for (var ti = 0; ti < TIERS.length; ti++) {
          var tier = TIERS[ti];
          var p = perTier[tier];
          tierOut[tier] = {
            pAbove: r4(p.pAbove),
            directEV: r0(p.directEV),
            fuse3: r0(p.fuse3)
          };
        }

        // Throughput. boxEV / avgScore / cpGain do NOT depend on rarity (they are
        // driven by the fresh-tier mix and the box schedule), so store them once at
        // the cell level and keep only the per-rarity weekly counts in `thru`.
        var thru = {};
        var cellBoxEV = null, cellAvgScore = null, cellCpGain = null;
        ["uncommon", "rare", "epic"].forEach(function (rar) {
          var tp = throughput(rar, cost, bl, gpd, perTier);
          if (cellBoxEV === null) {
            cellBoxEV = r0(tp.boxEV);
            cellAvgScore = r2(tp.avgScore);
            cellCpGain = r4(tp.cpGain);
          }
          // Round directPerWk/fusePerWk first, then derive total and weeks from the
          // ROUNDED values so the displayed identities are exact on the page:
          //   totalPerWk == directPerWk + fusePerWk  and  weeks == SLOTS / totalPerWk.
          var dWk = r2(tp.directPerWk);
          var fWk = r2(tp.fusePerWk);
          var totWk = r2(dWk + fWk);
          thru[rar] = {
            directPerWk: dWk,
            fusePerWk: fWk,
            totalPerWk: totWk,
            weeks: totWk > 0 ? rWeeks(SLOTS / totWk) : null,
            goldPerWk: r0(tp.goldPerWk)
          };
        });

        cells[gpd + "_" + bl + "_" + cost] = {
          tiers: tierOut,
          boxEV: cellBoxEV,
          avgScore: cellAvgScore,
          cpGain: cellCpGain,
          thru: thru
        };
        n++;
      }
    }
  }

  var data = {
    meta: {
      generated: new Date().toISOString(),
      generator: "tools/collect-stats.js",
      core: "model/astrogem.js (closed-form, dependency-free)",
      scoreUnit: "percent_damage",  // score = D = 100*ln(multiplier) ~ % damage
      COSTS: A.COSTS,
      fixedGpd: FIXED_GPD,
      anchorGpd: ALL_GPD,
      baselineWindow: BASELINE_WINDOW,
      bakedBaselines: BAKED_BASELINES,
      slots: SLOTS,
      cutsPerWeek: CUTS_PER_WEEK,
      boxSchedule: BOX_SCHEDULE,
      freshTierMix: FRESH_TIER_MIX,
      note: "Scores and baselines are REAL % DAMAGE (D = 100*ln(multiplier)); goldPerDamage "
        + "is gold per 1% damage. Closed-form per-tier values are exact (source of truth for "
        + "verdicts). Throughput block is a documented reconstruction (see METHODOLOGY.md); the "
        + "deployed page's tier EVs were SAMPLED with a non-uniform partition sampler "
        + "and run ~10-30% lower than this uniform-over-partitions closed-form core.",
      verdictThresholds: { greenGold: 20000, yellowGold: 0 },
      cells: n
    },
    cells: cells
  };

  var outPath = path.join(__dirname, "..", "data", "pipeline.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(data) + "\n");
  var kb = (fs.statSync(outPath).size / 1024).toFixed(1);
  console.log("Wrote " + outPath);
  console.log("  cells: " + n + " (" + ALL_GPD.length + " gpd x "
    + BAKED_BASELINES.length + " baselines x " + COSTS.length + " costs)");
  console.log("  size:  " + kb + " KB");
  console.log("  time:  " + ((Date.now() - t0) / 1000).toFixed(2) + "s");
}

build();
