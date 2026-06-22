/**
 * verify.js — recompute every entry in refs.json using model/astrogem.js and
 * assert equality. Floats compared with abs tolerance 1e-6; tiers/dists exact.
 * Prints a PASS/FAIL summary and process.exit(1) on any mismatch.
 *
 * Run: node verify.js   (or `npm run verify`)
 */
"use strict";
var fs = require("fs");
var path = require("path");
var A = require("./model/astrogem.js");

var refs = JSON.parse(fs.readFileSync(path.join(__dirname, "refs.json"), "utf8"));
var TOL = refs.meta.floatTolerance || 1e-6;

var pass = 0, fail = 0;
var failures = [];

function approx(a, b) {
  if (a === b) return true;
  if (typeof a !== "number" || typeof b !== "number") return false;
  if (!isFinite(a) || !isFinite(b)) return a === b;
  return Math.abs(a - b) <= TOL;
}
function r6(x) {
  if (!isFinite(x)) return x;
  return Math.round(x * 1e6) / 1e6;
}
function check(label, got, want, exact) {
  var ok = exact ? (got === want) : approx(got, want);
  if (ok) { pass++; }
  else { fail++; failures.push(label + "  got=" + got + "  want=" + want); }
}

// ---- score ----
refs.score.forEach(function (cse, i) {
  var c = cse.config;
  check("score[" + i + "].score", r6(A.score(c)), cse.score);
  var bd = A.scoreBreakdown(c);
  check("score[" + i + "].wpCost", bd.willpowerCost, cse.breakdown.willpowerCost, true);
  check("score[" + i + "].wpScore", r6(bd.willpowerScore), cse.breakdown.willpowerScore);
  check("score[" + i + "].e1Score", r6(bd.effect1Score), cse.breakdown.effect1Score);
  check("score[" + i + "].e2Score", r6(bd.effect2Score), cse.breakdown.effect2Score);
  check("score[" + i + "].orderScore", r6(bd.orderScore), cse.breakdown.orderScore);
  check("score[" + i + "].total", r6(bd.totalScore), cse.breakdown.totalScore);
});

// ---- willpowerCost ----
refs.willpowerCost.forEach(function (cse, i) {
  check("willpowerCost[" + i + "].cost", A.willpowerCost(cse.baseCost, cse.wpLevel), cse.cost, true);
  check("willpowerCost[" + i + "].score", r6(A.willpowerScore(A.willpowerCost(cse.baseCost, cse.wpLevel))), cse.score);
});

// ---- classifyTier ----
refs.classifyTier.forEach(function (cse, i) {
  check("classifyTier[" + i + "].tier", A.classifyTier(cse.levelSum), cse.tier, true);
  check("classifyTier[" + i + "].ways", A.levelSumWays(cse.levelSum), cse.ways, true);
});

// ---- outputLevelSumDist ----
["legendary", "relic", "ancient"].forEach(function (t) {
  var got = A.outputLevelSumDist(t);
  var want = refs.outputLevelSumDist[t];
  Object.keys(want).forEach(function (k) {
    check("outputLevelSumDist." + t + "[" + k + "]", r6(got[k]), want[k]);
  });
});

// ---- fusionOutputDist ----
refs.fusionOutputDist.forEach(function (cse, i) {
  var d = A.fusionOutputDist(cse.inputs);
  check("fusionOutputDist[" + i + "].L", r6(d.legendary), cse.dist.legendary);
  check("fusionOutputDist[" + i + "].R", r6(d.relic), cse.dist.relic);
  check("fusionOutputDist[" + i + "].A", r6(d.ancient), cse.dist.ancient);
});

// ---- outcomeProbabilities ----
refs.outcomeProbabilities.forEach(function (cse, i) {
  var op = A.outcomeProbabilities(cse.state);
  check("outcomeProb[" + i + "].nPoss", op.possibilities.length, cse.nPossibilities, true);
  check("outcomeProb[" + i + "].totalBase", r6(op.totalBase), cse.totalBase);
  check("outcomeProb[" + i + "].turnsRemaining", op.turnsRemaining, cse.turnsRemaining, true);
  Object.keys(cse.byType).forEach(function (k) {
    check("outcomeProb[" + i + "].byType." + k, r6(op.byType[k]), cse.byType[k]);
  });
  // Also assert the JS recompute has no EXTRA keys.
  check("outcomeProb[" + i + "].byTypeKeyCount", Object.keys(op.byType).length, Object.keys(cse.byType).length, true);
});

// ---- goldValue ----
refs.goldValue.forEach(function (cse, i) {
  check("goldValue[" + i + "]", r6(A.goldValue(cse.score, cse.baseline, cse.goldPerDamage)), cse.value);
});

// ---- tierExpectedValue ----
refs.tierExpectedValue.forEach(function (cse, i) {
  var ev = A.tierExpectedValue(cse.baseCost, cse.baseline, cse.goldPerDamage);
  check("tierEV[" + i + "].L", r6(ev.legendary), cse.ev.legendary);
  check("tierEV[" + i + "].R", r6(ev.relic), cse.ev.relic);
  check("tierEV[" + i + "].A", r6(ev.ancient), cse.ev.ancient);
});

// ---- summary ----
console.log("=== verify.js (JS self-consistency) ===");
console.log("PASS: " + pass + "   FAIL: " + fail);
if (fail > 0) {
  console.log("\nFailures:");
  failures.slice(0, 40).forEach(function (f) { console.log("  " + f); });
  if (failures.length > 40) console.log("  ... and " + (failures.length - 40) + " more");
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
