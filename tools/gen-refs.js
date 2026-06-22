/**
 * gen-refs.js — generate refs.json, the captured-reference battery.
 *
 * Computes a structured set of (inputs -> outputs) for the DETERMINISTIC functions
 * of model/astrogem.js. verify.js (JS) and verify.py (Python) both recompute these
 * and assert equality, keeping the two implementations in lockstep.
 *
 * Run: node tools/gen-refs.js   (writes ../refs.json relative to this file)
 */
"use strict";
var fs = require("fs");
var path = require("path");
var A = require("../model/astrogem.js");

function round6(x) {
  if (x === Infinity || x === -Infinity || (typeof x === "number" && isNaN(x))) return x;
  return Math.round(x * 1e6) / 1e6;
}

// ----- score over a spread of configs across all 3 costs -----
var scoreCases = [];
(function () {
  var configs = [
    // perfect / near-perfect across costs
    { baseCost: 8, gemType: "order", willpowerLevel: 5, orderLevel: 5, effect1: "Additional Damage", effect1Level: 5, effect2: "Attack Power", effect2Level: 5 },
    { baseCost: 9, gemType: "order", willpowerLevel: 5, orderLevel: 5, effect1: "Boss Damage", effect1Level: 5, effect2: "Attack Power", effect2Level: 5 },
    { baseCost: 10, gemType: "order", willpowerLevel: 5, orderLevel: 5, effect1: "Boss Damage", effect1Level: 5, effect2: "Additional Damage", effect2Level: 5 },
    // mixed mid-level
    { baseCost: 8, gemType: "order", willpowerLevel: 3, orderLevel: 4, effect1: "Brand Power", effect1Level: 5, effect2: "Ally Damage Enh.", effect2Level: 2 },
    { baseCost: 9, gemType: "order", willpowerLevel: 4, orderLevel: 3, effect1: "Ally Attack Enh.", effect1Level: 4, effect2: "Boss Damage", effect2Level: 1 },
    { baseCost: 10, gemType: "order", willpowerLevel: 2, orderLevel: 1, effect1: "Brand Power", effect1Level: 3, effect2: "Ally Attack Enh.", effect2Level: 5 },
    // floor / willpower-penalty edges
    { baseCost: 8, gemType: "order", willpowerLevel: 1, orderLevel: 1, effect1: "Additional Damage", effect1Level: 1, effect2: "Attack Power", effect2Level: 1 },
    { baseCost: 10, gemType: "order", willpowerLevel: 1, orderLevel: 1, effect1: "Boss Damage", effect1Level: 1, effect2: "Additional Damage", effect2Level: 1 },
    { baseCost: 9, gemType: "order", willpowerLevel: 5, orderLevel: 4, effect1: "Attack Power", effect1Level: 3, effect2: "Ally Damage Enh.", effect2Level: 4 }
  ];
  for (var i = 0; i < configs.length; i++) {
    var c = configs[i];
    var bd = A.scoreBreakdown(c);
    scoreCases.push({
      config: c,
      score: round6(A.score(c)),
      breakdown: {
        willpowerCost: bd.willpowerCost,
        willpowerScore: round6(bd.willpowerScore),
        effect1Score: round6(bd.effect1Score),
        effect2Score: round6(bd.effect2Score),
        orderScore: round6(bd.orderScore),
        totalScore: round6(bd.totalScore)
      }
    });
  }
})();

// ----- willpowerCost over a grid -----
var willpowerCostCases = [];
[8, 9, 10].forEach(function (bc) {
  for (var wp = 1; wp <= 5; wp++) {
    willpowerCostCases.push({ baseCost: bc, wpLevel: wp, cost: A.willpowerCost(bc, wp), score: round6(A.willpowerScore(A.willpowerCost(bc, wp))) });
  }
});

// ----- classifyTier over sample sums (and full 4..20) -----
var classifyTierCases = [];
for (var s = 4; s <= 20; s++) {
  classifyTierCases.push({ levelSum: s, tier: A.classifyTier(s), ways: A.levelSumWays(s) });
}

// ----- outputLevelSumDist for each tier -----
var outputLevelSumDistCases = {};
["legendary", "relic", "ancient"].forEach(function (t) {
  var d = A.outputLevelSumDist(t);
  var out = {};
  Object.keys(d).forEach(function (k) { out[k] = round6(d[k]); });
  outputLevelSumDistCases[t] = out;
});

// ----- fusionOutputDist for several input mixes -----
var fusionDistCases = [];
[
  ["legendary", "legendary", "legendary"],
  ["relic", "relic", "relic"],
  ["ancient", "ancient", "ancient"],
  ["relic", "legendary", "legendary"],
  ["ancient", "legendary", "legendary"],
  ["ancient", "relic", "legendary"],
  ["ancient", "ancient", "relic"],
  ["ancient", "ancient", "legendary"],
  ["relic", "relic", "legendary"]
].forEach(function (mix) {
  var d = A.fusionOutputDist(mix);
  fusionDistCases.push({ inputs: mix, dist: { legendary: round6(d.legendary), relic: round6(d.relic), ancient: round6(d.ancient) } });
});

// ----- outcomeProbabilities for a few states -----
var outcomeProbCases = [];
[
  // fresh epic, lots of turns
  { config: { baseCost: 9, willpowerLevel: 1, orderLevel: 1, effect1: "Boss Damage", effect1Level: 1, effect2: "Attack Power", effect2Level: 1 }, currentTurn: 1, maxTurns: 9, processCostMultiplier: 0 },
  // mid-progress, some stats maxed (exclusions kick in)
  { config: { baseCost: 8, willpowerLevel: 5, orderLevel: 4, effect1: "Additional Damage", effect1Level: 5, effect2: "Attack Power", effect2Level: 2 }, currentTurn: 4, maxTurns: 9, processCostMultiplier: 50 },
  // last turn (turnsRemaining == 1 -> cost & reroll excluded)
  { config: { baseCost: 10, willpowerLevel: 3, orderLevel: 3, effect1: "Boss Damage", effect1Level: 3, effect2: "Additional Damage", effect2Level: 3 }, currentTurn: 9, maxTurns: 9, processCostMultiplier: 0 },
  // cost already at +100 (cost+100 excluded), 2 turns left
  { config: { baseCost: 9, willpowerLevel: 2, orderLevel: 5, effect1: "Ally Attack Enh.", effect1Level: 1, effect2: "Boss Damage", effect2Level: 4 }, currentTurn: 6, maxTurns: 7, processCostMultiplier: 100 }
].forEach(function (st) {
  var op = A.outcomeProbabilities(st);
  // Capture the byType map (sorted keys) + totalBase + count.
  var byType = {};
  Object.keys(op.byType).sort().forEach(function (k) { byType[k] = round6(op.byType[k]); });
  outcomeProbCases.push({
    state: st,
    nPossibilities: op.possibilities.length,
    totalBase: round6(op.totalBase),
    turnsRemaining: op.turnsRemaining,
    byType: byType
  });
});

// ----- goldValue over a small grid -----
var goldValueCases = [];
[
  [10, 8, 1500000], [20, 12, 2500000], [5, 10, 500000], [16.5, 10, 5000000], [12, 12, 1000000]
].forEach(function (g) {
  goldValueCases.push({ score: g[0], baseline: g[1], goldPerDamage: g[2], value: round6(A.goldValue(g[0], g[1], g[2])) });
});

// ----- tierExpectedValue over the required grid -----
var tierExpectedValueCases = [];
[8, 9, 10].forEach(function (bc) {
  [6, 8, 10, 12].forEach(function (bl) {
    [500000, 1500000, 5000000].forEach(function (gpd) {
      var ev = A.tierExpectedValue(bc, bl, gpd);
      tierExpectedValueCases.push({
        baseCost: bc, baseline: bl, goldPerDamage: gpd,
        ev: { legendary: round6(ev.legendary), relic: round6(ev.relic), ancient: round6(ev.ancient) }
      });
    });
  });
});

var refs = {
  meta: {
    generated: new Date().toISOString(),
    note: "Captured references for the deterministic core. Regenerate with `node tools/gen-refs.js`. Constants are the CURRENT canonical generation (not the superseded 27.3/1.65/2.27/4.32).",
    SCORE_PER_PERCENT_DAMAGE: A.SCORE_PER_PERCENT_DAMAGE,
    COSTS: A.COSTS,
    floatTolerance: 1e-6
  },
  score: scoreCases,
  willpowerCost: willpowerCostCases,
  classifyTier: classifyTierCases,
  outputLevelSumDist: outputLevelSumDistCases,
  fusionOutputDist: fusionDistCases,
  outcomeProbabilities: outcomeProbCases,
  goldValue: goldValueCases,
  tierExpectedValue: tierExpectedValueCases
};

var outPath = path.join(__dirname, "..", "refs.json");
fs.writeFileSync(outPath, JSON.stringify(refs, null, 2) + "\n");
console.log("Wrote " + outPath);
console.log("  score cases:            " + scoreCases.length);
console.log("  willpowerCost cases:    " + willpowerCostCases.length);
console.log("  classifyTier cases:     " + classifyTierCases.length);
console.log("  fusionOutputDist cases: " + fusionDistCases.length);
console.log("  outcomeProb cases:      " + outcomeProbCases.length);
console.log("  goldValue cases:        " + goldValueCases.length);
console.log("  tierExpectedValue cases:" + tierExpectedValueCases.length);
