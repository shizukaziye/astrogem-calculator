#!/usr/bin/env node
/**
 * tools/lint-labels.js — validate the ground-truth labels in samples/*.json.
 *
 * The corpus IS the parser's training and gating data, and this week proved the
 * labels are fallible: two "parser failures" turned out to be LABEL errors (a
 * raise/lower transcribed backwards; a user live-correction contradicting the
 * screenshot's own points header). A wrong label poisons the glyph harvest, the
 * eval, and every calibration decision downstream — so labels get linted like code.
 *
 * Checks (ERRORS fail the run, WARNINGS print but pass):
 *   pairing     every .json has an image (.png/.webp/.jpg) and vice versa
 *   config      baseCost ∈ {8,9,10}; gemType order|chaos; levels 1-5;
 *               effects ∈ EFFECT_POOLS[baseCost], distinct
 *   state       maxTurns ∈ {5,7,9}; 1 ≤ currentTurn ≤ maxTurns;
 *               0 ≤ rerollsRemaining ≤ 9;
 *               processCost ∈ {450,900,1800} matching the multiplier (WARNING —
 *               roster-bound gems can display differently)
 *   outcomes    exactly 4; shapes per samples/README.md field reference;
 *               raise amount + current level > 5 or lower below 1 → WARNING
 *               (the game may offer overflow outcomes; not yet observed)
 *
 * The one thing a JSON linter CANNOT catch is a self-consistent transcription
 * error (both label errors this week were that) — those only fall to the
 * parser-vs-label disagreement list in tools/eval-ocr.js. When the parser and a
 * label disagree, zoom the pixels before trusting either.
 *
 * Usage:  node tools/lint-labels.js          (also wired into `npm run eval-gate`)
 */
"use strict";

var fs = require("fs");
var path = require("path");
var A = require("../model/astrogem.js");

var SAMPLES = path.join(__dirname, "..", "samples");
var errors = [], warnings = [];
function err(f, msg) { errors.push(f + ": " + msg); }
function warn(f, msg) { warnings.push(f + ": " + msg); }

var files = fs.readdirSync(SAMPLES);
var jsons = files.filter(function (f) { return /\.json$/i.test(f); });
var images = files.filter(function (f) { return /\.(png|webp|jpe?g)$/i.test(f); });

// pairing
jsons.forEach(function (j) {
  var stem = j.replace(/\.json$/i, "");
  if (!images.some(function (im) { return im.replace(/\.(png|webp|jpe?g)$/i, "") === stem; }))
    err(j, "no matching image file");
});
images.forEach(function (im) {
  var stem = im.replace(/\.(png|webp|jpe?g)$/i, "");
  if (!jsons.some(function (j) { return j.replace(/\.json$/i, "") === stem; }))
    warn(im, "image has no label (unlabeled sample — eval will skip it)");
});

var OUTCOME_TARGETS = ["willpower", "order", "effect1", "effect2"];

jsons.forEach(function (f) {
  var t;
  try { t = JSON.parse(fs.readFileSync(path.join(SAMPLES, f), "utf8")); }
  catch (e) { err(f, "invalid JSON: " + e.message); return; }
  var c = t.config || {}, s = t.state || {}, outs = t.outcomes;

  // config
  if ([8, 9, 10].indexOf(c.baseCost) === -1) err(f, "baseCost " + c.baseCost + " ∉ {8,9,10}");
  if (["order", "chaos"].indexOf(c.gemType) === -1) err(f, "gemType '" + c.gemType + "'");
  ["willpowerLevel", "orderLevel", "effect1Level", "effect2Level"].forEach(function (k) {
    if (!(c[k] >= 1 && c[k] <= 5)) err(f, k + " " + c[k] + " ∉ 1..5");
  });
  var pool = (A.EFFECT_POOLS || {})[c.baseCost] || [];
  ["effect1", "effect2"].forEach(function (k) {
    if (pool.length && pool.indexOf(c[k]) === -1) err(f, k + " '" + c[k] + "' not in the cost-" + c.baseCost + " pool [" + pool.join(", ") + "]");
  });
  if (c.effect1 && c.effect1 === c.effect2) err(f, "effect1 === effect2 ('" + c.effect1 + "')");

  // state
  if ([5, 7, 9].indexOf(s.maxTurns) === -1) err(f, "maxTurns " + s.maxTurns + " ∉ {5,7,9}");
  else if (!(s.currentTurn >= 1 && s.currentTurn <= s.maxTurns)) err(f, "currentTurn " + s.currentTurn + " ∉ 1.." + s.maxTurns);
  if (!(s.rerollsRemaining >= 0 && s.rerollsRemaining <= 9)) err(f, "rerollsRemaining " + s.rerollsRemaining + " ∉ 0..9");
  if ([-100, 0, 100].indexOf(s.processCostMultiplier) === -1) err(f, "processCostMultiplier " + s.processCostMultiplier);
  else {
    var expCost = 900 * (1 + s.processCostMultiplier / 100);
    if (s.processCost !== expCost) warn(f, "processCost " + s.processCost + " ≠ 900×(1+" + s.processCostMultiplier + "/100)=" + expCost);
  }

  // outcomes
  if (!Array.isArray(outs) || outs.length !== 4) { err(f, "outcomes must be exactly 4 (got " + (outs && outs.length) + ")"); return; }
  outs.forEach(function (o, i) {
    var tag = "outcomes[" + i + "]";
    switch (o.type) {
      case "raise_effect":
      case "lower_effect":
        if (OUTCOME_TARGETS.indexOf(o.target) === -1) err(f, tag + " target '" + o.target + "'");
        if (!(o.amount >= 1 && o.amount <= 4)) err(f, tag + " amount " + o.amount + " ∉ 1..4");
        // overflow sanity (WARNING: overflow outcomes not yet observed in-game)
        var lvlKey = { willpower: "willpowerLevel", order: "orderLevel", effect1: "effect1Level", effect2: "effect2Level" }[o.target];
        if (lvlKey && c[lvlKey] != null) {
          if (o.type === "raise_effect" && c[lvlKey] + o.amount > 5) warn(f, tag + " raises " + o.target + " " + c[lvlKey] + "+" + o.amount + " past 5");
          if (o.type === "lower_effect" && c[lvlKey] - o.amount < 1) warn(f, tag + " lowers " + o.target + " " + c[lvlKey] + "−" + o.amount + " below 1");
        }
        break;
      case "change_side_option":
        if (["effect1", "effect2"].indexOf(o.target) === -1) err(f, tag + " change target '" + o.target + "'");
        break;
      case "change_gold_cost":
        if ([100, -100].indexOf(o.change) === -1) err(f, tag + " change " + o.change + " ∉ {±100}");
        break;
      case "reroll_increase":
        if ([1, 2].indexOf(o.change) === -1) err(f, tag + " reroll change " + o.change + " ∉ {1,2}");
        break;
      case "do_nothing":
        break;
      default:
        err(f, tag + " unknown type '" + o.type + "'");
    }
  });
});

warnings.forEach(function (w) { console.log("WARN  " + w); });
errors.forEach(function (e) { console.log("ERROR " + e); });
console.log("lint-labels: " + jsons.length + " labels, " + errors.length + " error(s), " + warnings.length + " warning(s)");
process.exit(errors.length ? 1 : 0);
