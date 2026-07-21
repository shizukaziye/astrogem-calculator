#!/usr/bin/env node
/**
 * tools/eval-ocr.js — A/B accuracy harness for the screenshot-reading engines.
 *
 * Given pairs of files in samples/:
 *     samples/<name>.png   (a real Lost Ark Processing screenshot)
 *     samples/<name>.json  (the hand-checked ground truth, see samples/README.md)
 * it scores each engine's per-field accuracy and prints a per-engine table.
 *
 * HONEST STATUS: we have NO real screenshots yet. With an empty samples/ this
 * prints the expected file format + instructions and exits 0 — the real A/B only
 * happens once you drop screenshots + ground-truth JSON into samples/.
 *
 * Engines scored:
 *   - tesseract : runs Tesseract.js on the FULL image in Node, then feeds the OCR
 *                 text through the SAME parser functions the browser engine uses
 *                 (ocr/tesseract-engine.js exports parseConfig/parseCuttingState/
 *                 parseOutcomes) + constraintSnap. NOTE: the browser engine also
 *                 does regional <canvas> cropping which Node can't do, so Node
 *                 scores are a conservative lower bound on the in-browser engine.
 *   - (the Workers-AI full-parse row was removed 2026-07-18; the WS4 verifier
 *      replacement will get its own row). Historic usage — skipped
 *                 otherwise.
 *
 * Usage:
 *   node tools/eval-ocr.js
 *   node tools/eval-ocr.js --engines=tesseract
 *   node tools/eval-ocr.js --worker-url=https://astrogem-vision.<sub>.workers.dev
 *   WORKER_URL=... node tools/eval-ocr.js --engines=workersai
 */
"use strict";

var fs = require("fs");
var path = require("path");

var ROOT = path.resolve(__dirname, "..");
var SAMPLES_DIR = path.join(ROOT, "samples");

var engineApi = require(path.join(ROOT, "ocr", "engine.js"));
var tesseractMod = require(path.join(ROOT, "ocr", "tesseract-engine.js"));

// ---- args ----
function parseArgs(argv) {
  var out = { engines: null, workerUrl: process.env.WORKER_URL || null, json: false, dump: false, gates: [], only: null };
  argv.forEach(function (a) {
    var m;
    if ((m = a.match(/^--engines=(.+)$/))) out.engines = m[1].split(",").map(function (s) { return s.trim(); });
    else if ((m = a.match(/^--only=(.+)$/))) out.only = m[1].split(",").map(function (s) { return s.trim().toLowerCase(); });
    else if ((m = a.match(/^--worker-url=(.+)$/))) out.workerUrl = m[1];
    else if (a === "--json") out.json = true;
    else if (a === "--dump") out.dump = true;
    else if ((m = a.match(/^--gate=(.+)$/))) {
      // --gate=<engine>:<minFields>,<minOutcomes>   e.g. --gate=structural:0.95,0.95
      // (fields = the per-field average incl. the outcome-set score — the headline metric)
      var g = m[1].match(/^([a-z0-9_-]+):([\d.]+)\s*,\s*([\d.]+)$/i);
      if (g) out.gates.push({ engine: g[1], fields: parseFloat(g[2]), outcomes: parseFloat(g[3]) });
      else console.log("Ignoring malformed --gate (want --gate=<engine>:<fields>,<outcomes>): " + a);
    }
  });
  return out;
}
var ARGS = parseArgs(process.argv.slice(2));

// ---- sample discovery ----
function findSamples() {
  if (!fs.existsSync(SAMPLES_DIR)) return [];
  var files = fs.readdirSync(SAMPLES_DIR);
  var imgs = files.filter(function (f) { return /\.(png|jpg|jpeg|webp)$/i.test(f); });
  // --only=<substr,substr>: fast iteration on specific samples (name substring match)
  if (ARGS.only) imgs = imgs.filter(function (f) {
    var lf = f.toLowerCase();
    return ARGS.only.some(function (s) { return lf.indexOf(s) !== -1; });
  });
  var pairs = [];
  imgs.forEach(function (img) {
    var base = img.replace(/\.(png|jpg|jpeg|webp)$/i, "");
    var jsonName = base + ".json";
    if (files.indexOf(jsonName) !== -1) {
      pairs.push({ name: base, image: path.join(SAMPLES_DIR, img), truth: path.join(SAMPLES_DIR, jsonName) });
    } else {
      pairs.push({ name: base, image: path.join(SAMPLES_DIR, img), truth: null });
    }
  });
  return pairs;
}

// ---- scoring ----
// Compare a parsed (constraint-snapped) result against ground truth, field by field.
// Ground truth and parsed both have { config, state, outcomes }. We snap the ground
// truth too so we compare like-for-like legal states.
function scoreOne(parsed, truthRaw) {
  var truth = engineApi.constraintSnap(truthRaw);
  var fields = [];
  // Per-field confidence from the engine (via constraintSnap's passthrough); absent -> 1.
  var conf = parsed.confidence || {};
  var confC = conf.config || {}, confS = conf.state || {}, confO = conf.outcomes || [];
  var CONF_BY_LABEL = {
    baseCost: confC.baseCost, gemType: confC.gemType,
    willpowerLevel: confC.willpowerLevel, orderLevel: confC.orderLevel,
    effect1: confC.effect1, effect1Level: confC.effect1Level,
    effect2: confC.effect2, effect2Level: confC.effect2Level,
    currentTurn: confS.currentTurn, maxTurns: confS.rarity,
    rerollsRemaining: confS.rerollsRemaining, processCostMultiplier: confS.processCostMultiplier
  };
  function cmp(label, a, b) {
    var c = CONF_BY_LABEL[label];
    fields.push({ label: label, ok: String(a) === String(b), got: a, want: b, conf: c == null ? 1 : c });
  }

  var pc = parsed.config, tc = truth.config;
  cmp("baseCost", pc.baseCost, tc.baseCost);
  cmp("gemType", pc.gemType, tc.gemType);
  cmp("willpowerLevel", pc.willpowerLevel, tc.willpowerLevel);
  cmp("orderLevel", pc.orderLevel, tc.orderLevel);
  cmp("effect1", pc.effect1, tc.effect1);
  cmp("effect1Level", pc.effect1Level, tc.effect1Level);
  cmp("effect2", pc.effect2, tc.effect2);
  cmp("effect2Level", pc.effect2Level, tc.effect2Level);

  var ps = parsed.state, ts = truth.state;
  cmp("currentTurn", ps.currentTurn, ts.currentTurn);
  cmp("maxTurns", ps.maxTurns, ts.maxTurns);
  cmp("rerollsRemaining", ps.rerollsRemaining, ts.rerollsRemaining);
  cmp("processCostMultiplier", ps.processCostMultiplier, ts.processCostMultiplier);

  // outcomes: compare as an unordered multiset by a canonical key (the 4 lines can
  // come back in any order). Score = fraction of truth outcomes matched.
  function outKey(o) {
    if (!o) return "none";
    if (o.type === "raise_effect" || o.type === "lower_effect") return o.type + ":" + o.target + ":" + o.amount;
    if (o.type === "change_side_option") return "change:" + o.target;
    if (o.type === "change_gold_cost") return "cost:" + (o.change > 0 ? "+" : "-");
    if (o.type === "reroll_increase") return "reroll:" + o.change;
    return "do_nothing";
  }
  var gotKeys = (parsed.outcomes || []).map(outKey);
  var wantKeys = (truth.outcomes || []).map(outKey);
  var pool = gotKeys.slice();
  var matched = 0;
  wantKeys.forEach(function (k) {
    var i = pool.indexOf(k);
    if (i !== -1) { matched++; pool.splice(i, 1); }
  });
  var outcomeScore = wantKeys.length ? matched / wantKeys.length : 1;
  var outcomeConf = confO.length ? Math.min.apply(null, confO.map(function (c) { return c == null ? 1 : c; })) : 1;
  fields.push({ label: "outcomes(" + matched + "/" + wantKeys.length + ")", ok: matched === wantKeys.length, score: outcomeScore, conf: outcomeConf });

  var scalarFields = fields.filter(function (f) { return f.score == null; });
  var correct = scalarFields.filter(function (f) { return f.ok; }).length;
  // The HEADLINE per-sample metric (Shizu's definition): mean over the 13 scored
  // fields — the 12 scalars (0/1 each) + the outcome multiset score.
  var headline = (correct + outcomeScore) / (scalarFields.length + 1);
  // Confidence flagging at the UI threshold: of the WRONG fields, how many carried
  // conf < 0.8 (i.e. would have been highlighted "confirm me")?
  var CONF_T = 0.8;
  var wrongAll = scalarFields.filter(function (f) { return !f.ok; });
  if (matched !== wantKeys.length) wrongAll = wrongAll.concat([{ label: "outcomes", conf: outcomeConf }]);
  var wrongFlagged = wrongAll.filter(function (f) { return (f.conf == null ? 1 : f.conf) < CONF_T; }).length;
  // SILENT errors: wrong yet confident — the UI would NOT highlight these. The most
  // dangerous class; --dump prints them so each one can be hunted individually.
  var silent = wrongAll.filter(function (f) { return (f.conf == null ? 1 : f.conf) >= CONF_T; })
    .map(function (f) { return f.label + (f.got !== undefined ? "(" + f.got + "≠" + f.want + ")" : "") + " conf=" + (f.conf == null ? 1 : f.conf).toFixed(2); });
  // false alarms: flagged yet CORRECT (the cost of the safety net — each one is a
  // needless "confirm me" tap for the user, and a wasted pull for the AI verifier)
  var faFields = scalarFields.filter(function (f) { return f.ok && (f.conf == null ? 1 : f.conf) < CONF_T; });
  var falseAlarms = faFields.length;
  var faDetail = faFields.map(function (f) { return { field: f.label, conf: f.conf == null ? 1 : f.conf }; });
  if (matched === wantKeys.length && outcomeConf < CONF_T) { falseAlarms++; faDetail.push({ field: "outcomes", conf: outcomeConf }); }
  return {
    fields: fields,
    scalarCorrect: correct,
    scalarTotal: scalarFields.length,
    outcomeScore: outcomeScore,
    headline: headline,
    wholeParse: correct === scalarFields.length && matched === wantKeys.length,
    wrongTotal: wrongAll.length,
    wrongFlagged: wrongFlagged,
    silent: silent,
    falseAlarms: falseAlarms,
    faDetail: faDetail,
    gotOutcomeKeys: gotKeys,
    wantOutcomeKeys: wantKeys
  };
}

// ---- engines ----
// Node-side Tesseract: full-frame OCR -> same parsers -> constraintSnap.
function makeNodeTesseractParser() {
  var Tesseract;
  try { Tesseract = require("tesseract.js"); }
  catch (e) { return null; }
  var workerP = null;
  function getWorker() {
    if (!workerP) {
      workerP = Tesseract.createWorker("eng", 1, { logger: function () {} }).then(function (w) {
        return w.setParameters({ tessedit_pageseg_mode: "6" }).catch(function () {}).then(function () { return w; });
      });
    }
    return workerP;
  }
  return {
    name: "tesseract",
    label: "Tesseract.js (Node, full-frame)",
    async parse(imagePath) {
      var worker = await getWorker();
      var res = await worker.recognize(imagePath);
      var text = String((res && res.data && res.data.text) || "");
      var cfg = tesseractMod.parseConfig(text);
      var cut = tesseractMod.parseCuttingState(text);
      var outcomes = tesseractMod.parseOutcomes(text, {
        baseCost: cfg.baseCost || 10, gemType: cfg.gemType, effect1: cfg.effect1, effect2: cfg.effect2
      });
      var raw = {
        config: cfg,
        state: {
          currentTurn: null, maxTurns: cut.maxTurns, turnsRemaining: cut.turnsRemaining,
          rerollsShownFree: cut.rerollsShownFree, rerollsShownDenom: cut.rerollsShownDenom,
          resetsRemaining: cut.resetsRemaining,
          processCost: cut.processCost,
          processCostMultiplier: cut.processCostMultiplier, totalGoldSpent: 0, rosterBound: false
        },
        rarity: cfg.rarity, outcomes: outcomes
      };
      return engineApi.constraintSnap(raw);
    },
    async dispose() { if (workerP) { var w = await workerP; try { await w.terminate(); } catch (e) {} } }
  };
}

// Node structural parser: sharp decodes to raw RGBA, ocr/layout.js + the structural
// core run the SAME decision logic that ships in the browser; micro-crops re-encode
// to PNG for the Node tesseract worker. This row IS the free-tier ship gate.
function makeNodeStructuralParser() {
  var sharp, structural, Tesseract;
  try { sharp = require("sharp"); } catch (e) { console.log("Skipping structural: sharp not installed (npm i -D sharp)."); return null; }
  try { Tesseract = require("tesseract.js"); } catch (e) { console.log("Skipping structural: tesseract.js not installed."); return null; }
  structural = require(path.join(ROOT, "ocr", "structural-engine.js"));
  var workerP = null;
  function getWorker() {
    if (!workerP) workerP = Tesseract.createWorker("eng", 1, { logger: function () {} });
    return workerP;
  }
  var q = Promise.resolve();
  function nodeOcr(raster, opts) {
    q = q.then(async function () {
      var w = await getWorker();
      await w.setParameters({
        tessedit_pageseg_mode: String((opts && opts.psm) || 6),
        tessedit_char_whitelist: (opts && opts.whitelist) || "",
        user_defined_dpi: "150"
      }).catch(function () {});
      var png = await sharp(Buffer.from(raster.data.buffer, raster.data.byteOffset, raster.data.length),
        { raw: { width: raster.width, height: raster.height, channels: 4 } }).png().toBuffer();
      var res = await w.recognize(png);
      return { text: (res.data && res.data.text) || "", conf: ((res.data && res.data.confidence) || 40) / 100 };
    });
    return q;
  }
  return {
    name: "structural",
    label: "Structural (Node, layout + micro-OCR)",
    async parse(imagePath) {
      var dec = await sharp(imagePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      var raster = { width: dec.info.width, height: dec.info.height,
        data: new Uint8ClampedArray(dec.data.buffer, dec.data.byteOffset, dec.data.length) };
      var raw = await structural.parseStructural(raster, nodeOcr);
      return engineApi.constraintSnap(raw);
    },
    async dispose() { if (workerP) { var w = await workerP; try { await w.terminate(); } catch (e) {} } }
  };
}

// (The Workers-AI full-parse row was removed 2026-07-18 with the dormant vision
// worker; the WS4 replacement is a flagged-field VERIFIER with a different
// contract and will get its own eval row when it exists.)

// ---- output helpers ----
function pct(n) { return (n * 100).toFixed(1) + "%"; }
function pad(s, n) { s = String(s); return s.length >= n ? s : s + " ".repeat(n - s.length); }

function printFormatHelp() {
  console.log("");
  console.log("No scored samples found in samples/.");
  console.log("");
  console.log("To run the real A/B, drop matching pairs into samples/:");
  console.log("    samples/<name>.png      <- a Lost Ark 'Processing' screenshot");
  console.log("    samples/<name>.json     <- hand-checked ground truth");
  console.log("");
  console.log("Ground-truth JSON shape (see samples/README.md for the full spec):");
  console.log(JSON.stringify({
    config: {
      baseCost: 10, gemType: "order", willpowerLevel: 3, orderLevel: 4,
      effect1: "Boss Damage", effect1Level: 2, effect2: "Additional Damage", effect2Level: 1
    },
    state: {
      currentTurn: 4, maxTurns: 9, rerollsRemaining: 2,
      processCost: 900, processCostMultiplier: 0, totalGoldSpent: 2700, rosterBound: false
    },
    outcomes: [
      { type: "raise_effect", target: "willpower", amount: 1 },
      { type: "raise_effect", target: "effect1", amount: 2 },
      { type: "change_side_option", target: "effect2" },
      { type: "change_gold_cost", change: -100 }
    ]
  }, null, 2));
  console.log("");
  console.log("Then re-run:  node tools/eval-ocr.js");
  console.log("");
}

// ---- main ----
async function main() {
  console.log("=== OCR engine A/B harness ===");
  var samples = findSamples();
  var scored = samples.filter(function (s) { return s.truth; });
  var unmatched = samples.filter(function (s) { return !s.truth; });

  if (unmatched.length) {
    console.log("Note: " + unmatched.length + " image(s) without a matching .json (skipped): " +
      unmatched.map(function (s) { return path.basename(s.image); }).join(", "));
  }

  if (scored.length === 0) {
    printFormatHelp();
    process.exit(0);
    return;
  }

  // which engines?
  var want = ARGS.engines || ["structural", "tesseract"];
  var engines = [];
  if (want.indexOf("structural") !== -1) {
    var st = makeNodeStructuralParser();
    if (st) engines.push(st);
  }
  if (want.indexOf("tesseract") !== -1) {
    var t = makeNodeTesseractParser();
    if (t) engines.push(t);
    else console.log("Skipping tesseract: tesseract.js not installed (npm i -D tesseract.js).");
  }
  if (engines.length === 0) {
    console.log("No runnable engines selected. Nothing to do.");
    process.exit(0);
    return;
  }

  console.log("Scoring " + scored.length + " sample(s) across: " + engines.map(function (e) { return e.name; }).join(", "));
  console.log("");

  var jsonOut = { samples: scored.length, engines: {} };
  for (var ei = 0; ei < engines.length; ei++) {
    var eng = engines[ei];
    console.log("--- " + eng.label + " ---");
    var totScalarCorrect = 0, totScalar = 0, totOutcome = 0, totHeadline = 0, n = 0;
    var whole = 0, wrongTotal = 0, wrongFlagged = 0;
    var totSilent = 0, totFalseAlarms = 0, silentList = [];
    var fieldAgg = {}; // label -> {ok,total}
    var perSample = [];
    var faAll = [];   // {field, conf} of every false alarm (for the --dump histogram)
    for (var si = 0; si < scored.length; si++) {
      var s = scored[si];
      var truthRaw;
      try { truthRaw = JSON.parse(fs.readFileSync(s.truth, "utf8")); }
      catch (e) { console.log("  " + pad(s.name, 18) + " BAD ground-truth JSON: " + e.message); continue; }
      var parsed;
      try { parsed = await eng.parse(s.image); }
      catch (e) { console.log("  " + pad(s.name, 18) + " engine error: " + e.message); continue; }
      var sc = scoreOne(parsed, truthRaw);
      n++;
      totScalarCorrect += sc.scalarCorrect; totScalar += sc.scalarTotal; totOutcome += sc.outcomeScore;
      totHeadline += sc.headline;
      if (sc.wholeParse) whole++;
      wrongTotal += sc.wrongTotal; wrongFlagged += sc.wrongFlagged;
      totSilent += sc.silent.length; totFalseAlarms += sc.falseAlarms;
      if (sc.faDetail) faAll = faAll.concat(sc.faDetail);
      if (sc.silent.length) silentList.push(s.name + ": " + sc.silent.join(", "));
      sc.fields.forEach(function (f) {
        if (f.score != null) return;
        fieldAgg[f.label] = fieldAgg[f.label] || { ok: 0, total: 0, fa: 0 };
        fieldAgg[f.label].total++;
        if (f.ok) fieldAgg[f.label].ok++;
        if (f.ok && (f.conf == null ? 1 : f.conf) < 0.8) fieldAgg[f.label].fa++;
      });
      var wrong = sc.fields.filter(function (f) { return f.score == null && !f.ok; })
        .map(function (f) { return f.label + "(" + f.got + "≠" + f.want + ")"; });
      perSample.push({ name: s.name, headline: sc.headline, wholeParse: sc.wholeParse, outcomes: sc.outcomeScore });
      console.log("  " + pad(s.name, 18) +
        " fields " + sc.scalarCorrect + "/" + sc.scalarTotal +
        "  outcomes " + pct(sc.outcomeScore) +
        (sc.wholeParse ? "  ✓whole" : "") +
        (wrong.length ? "   miss: " + wrong.join(", ") : ""));
      if (ARGS.dump) {
        console.log("      got : " + sc.gotOutcomeKeys.join("  |  "));
        console.log("      want: " + sc.wantOutcomeKeys.join("  |  "));
        var flagged = sc.fields.filter(function (f) { return f.score == null && (f.conf == null ? 1 : f.conf) < 0.8; })
          .map(function (f) { return f.label + "@" + (f.conf == null ? 1 : f.conf).toFixed(2) + (f.ok ? "✓" : "✗(" + f.got + "≠" + f.want + ")"); });
        if (flagged.length) console.log("      flags: " + flagged.join("  "));
      }
    }
    if (n > 0) {
      var headlineAvg = totHeadline / n, outcomesAvg = totOutcome / n;
      console.log("  " + pad("TOTAL", 18) +
        " fields " + pct(totScalar ? totScalarCorrect / totScalar : 0) +
        "  outcomes " + pct(outcomesAvg) + "  (" + n + " samples)");
      console.log("  HEADLINE per-field avg (12 scalars + outcome set): " + pct(headlineAvg) +
        "   whole-parse: " + whole + "/" + n + " (" + pct(whole / n) + ")" +
        "   flag-coverage: " + (wrongTotal ? wrongFlagged + "/" + wrongTotal + " wrong fields flagged (" + pct(wrongFlagged / wrongTotal) + ")" : "n/a (no errors)"));
      console.log("  SILENT errors (wrong yet confident — the UI would not warn): " + totSilent +
        "   false alarms (flagged yet correct): " + totFalseAlarms +
        " (~" + (totFalseAlarms / n).toFixed(1) + "/shot)");
      silentList.forEach(function (l) { console.log("    SILENT " + l); });
      var faLine = Object.keys(fieldAgg).filter(function (l) { return fieldAgg[l].fa > 0; })
        .sort(function (a, b) { return fieldAgg[b].fa - fieldAgg[a].fa; })
        .map(function (l) { return l + " " + fieldAgg[l].fa; }).join("  ·  ");
      if (faLine) console.log("  false alarms by field: " + faLine);
      if (ARGS.dump) {
        // per-field confidence histogram of the false alarms — the tuning target:
        // a cluster just under the 0.8 threshold is a candidate for a calibrated lift
        var faHist = {};
        faAll.forEach(function (d) {
          var bucket = d.conf >= 0.75 ? "0.75-0.80" : d.conf >= 0.7 ? "0.70-0.75" : d.conf >= 0.6 ? "0.60-0.70" : d.conf >= 0.5 ? "0.50-0.60" : "<0.50";
          faHist[d.field] = faHist[d.field] || {};
          faHist[d.field][bucket] = (faHist[d.field][bucket] || 0) + 1;
        });
        Object.keys(faHist).sort().forEach(function (fld) {
          var bs = faHist[fld];
          console.log("  FA-hist " + fld + ": " + Object.keys(bs).sort().map(function (b) { return b + "×" + bs[b]; }).join("  "));
        });
      }
      var labels = Object.keys(fieldAgg);
      var line = labels.map(function (l) { return l + " " + pct(fieldAgg[l].ok / fieldAgg[l].total); }).join("  ·  ");
      console.log("  per-field: " + line);
      jsonOut.engines[eng.name] = {
        label: eng.label, samples: n,
        headline: headlineAvg, outcomes: outcomesAvg,
        scalarFieldAccuracy: totScalar ? totScalarCorrect / totScalar : 0,
        wholeParse: whole / n,
        flagCoverage: wrongTotal ? wrongFlagged / wrongTotal : null,
        perField: Object.keys(fieldAgg).reduce(function (o, l) { o[l] = fieldAgg[l].ok / fieldAgg[l].total; return o; }, {}),
        perSample: perSample
      };
    }
    if (typeof eng.dispose === "function") await eng.dispose();
    console.log("");
  }

  if (ARGS.json) console.log(JSON.stringify(jsonOut, null, 2));

  // ---- release gates (--gate=<engine>:<fields>,<outcomes>) ----
  var gateFailed = false;
  ARGS.gates.forEach(function (g) {
    var r = jsonOut.engines[g.engine];
    if (!r) { console.log("GATE " + g.engine + ": engine not scored — FAIL"); gateFailed = true; return; }
    var okF = r.headline >= g.fields, okO = r.outcomes >= g.outcomes;
    console.log("GATE " + g.engine + ": per-field " + pct(r.headline) + (okF ? " ≥ " : " < ") + pct(g.fields) +
      " · outcomes " + pct(r.outcomes) + (okO ? " ≥ " : " < ") + pct(g.outcomes) +
      "  ->  " + (okF && okO ? "PASS" : "FAIL"));
    if (!(okF && okO)) gateFailed = true;
  });

  console.log("Done. (Tesseract Node scores are a lower bound; the browser engine adds regional cropping.)");
  process.exit(gateFailed ? 1 : 0);
}

main().catch(function (e) {
  console.error("eval-ocr fatal:", e);
  process.exit(1);
});
