#!/usr/bin/env node
/**
 * tools/build-glyphs.js — harvest the game's digit glyphs from the labeled corpus.
 *
 * The closed-vocabulary reads (wheel levels, points header, Process (x/N), reroll
 * pill) don't need OCR: the game renders one fixed font, and after the engine's
 * resolution normalization every glyph arrives at one fixed size. This tool cuts
 * glyph boxes out of every labeled sample at the engine's own locations, names them
 * from the ground truth (only when the segmentation is unambiguous), averages the
 * bitmaps per character, and emits ocr/glyphs.js.
 *
 * Letters ("Process", "Astrogem Points", "Lv") are harvested too — as DISTRACTOR
 * classes, so a matcher can reject "o"-looks-like-"0" instead of accepting it.
 *
 * Usage:  node tools/build-glyphs.js            # writes ocr/glyphs.js
 */
"use strict";

var fs = require("fs");
var path = require("path");
var sharp = require("sharp");
var L = require("../ocr/layout.js");

var SAMPLES = path.join(__dirname, "..", "samples");
var OUT = path.join(__dirname, "..", "ocr", "glyphs.js");
var CANON_GAP = 246;

// the DIM white mask, matching the engine's find/read mask for footer text (strict
// v>0.72 keeps only a sparse skeleton on 2x-upscaled captures)
function isWhite(r, g, b) { var c = L.hsv(r, g, b); return c.s < 0.3 && c.v > 0.6; }
function isGold(r, g, b) { return L.isGoldText(r, g, b); }

// accumulators: char -> { sum: Float64Array, n }
var acc = {};
function addInstance(ch, mask, box) {
  var bm = L.glyphBitmap(mask, box);
  if (!acc[ch]) acc[ch] = { sum: new Float64Array(L.GLYPH_W * L.GLYPH_H), n: 0 };
  for (var i = 0; i < bm.length; i++) acc[ch].sum[i] += bm[i];
  acc[ch].n++;
}

// segment a rect of the raster through a chroma mask; drop dust boxes
function segRect(raster, rect, pred) {
  var sub = L.crop(raster, rect);
  var mask = L.chromaMask(sub, pred);
  var boxes = L.segmentGlyphs(mask, { minColPx: 1, gapCols: 1 });
  var hs = boxes.map(function (b) { return b.h; }).sort(function (a, b) { return a - b; });
  var medH = hs.length ? hs[hs.length >> 1] : 0;
  return { mask: mask, boxes: boxes.filter(function (b) { return b.h >= medH * 0.55 && b.h <= medH * 1.6 && b.w >= 2; }) };
}

(async function () {
  var files = fs.readdirSync(SAMPLES).filter(function (f) { return /\.(png|webp|jpe?g)$/i.test(f); });
  var used = 0;
  for (var fi = 0; fi < files.length; fi++) {
    var img = files[fi];
    var truthFile = path.join(SAMPLES, img.replace(/\.(png|webp|jpe?g)$/i, ".json"));
    if (!fs.existsSync(truthFile)) continue;
    var truth = JSON.parse(fs.readFileSync(truthFile, "utf8"));

    var dec = await sharp(path.join(SAMPLES, img)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    var raster = { width: dec.info.width, height: dec.info.height, data: new Uint8ClampedArray(dec.data.buffer, dec.data.byteOffset, dec.data.length) };
    var found = L.panelOrWhole(raster);
    if (!found || !found.anchors) continue;
    if (L.fitWheel) found.anchors = L.fitWheel(raster, found.anchors);

    // mirror the engine's normalization (crop margin skipped: coordinates only)
    var g0 = found.anchors.gold.y - found.anchors.red.y;
    var fRaw = CANON_GAP / Math.max(8, g0);
    var scaleF = fRaw <= 0.65 ? 0.5 : fRaw <= 1.25 ? 1 : Math.min(3, Math.round(fRaw));
    if (scaleF !== 1) raster = L.upscaleBilinear(raster, scaleF);
    var red = { x: found.anchors.red.x * scaleF, y: found.anchors.red.y * scaleF };
    var gold = { x: found.anchors.gold.x * scaleF, y: found.anchors.gold.y * scaleF };
    var cx = red.x, redY = red.y, goldY = gold.y, gap = goldY - redY;

    used++;

    // ---- Process (x/N): "Process(x/N)" -> label digits + letter distractors ----
    var btn = L.findMaskedTextLine(raster,
      { x: cx + gap * 0.2, y: goldY + gap * 1.95, w: gap * 2.15, h: gap * 0.75 }, isWhite,
      { maxRowFill: 0.75, minH: Math.max(4, Math.round(gap * 0.05)), maxH: Math.round(gap * 0.24), minRowPx: Math.max(4, Math.round(gap * 0.04)), accept: function (r) { return r.w >= gap * 0.5; } });
    if (btn && truth.state && truth.state.currentTurn != null && truth.state.maxTurns != null) {
      var grow = Math.round(btn.h * 0.45);
      var seg = segRect(raster, { x: btn.x - grow, y: btn.y - grow, w: btn.w + grow * 2, h: btn.h + grow * 2 }, isWhite);
      var x = truth.state.maxTurns - truth.state.currentTurn + 1;
      // letters of "Process" merge unpredictably, but the TAIL "( x / N )" segments
      // reliably — label just the last five boxes positionally
      var n = seg.boxes.length;
      if (n >= 7) {
        addInstance("(", seg.mask, seg.boxes[n - 5]);
        addInstance(String(x), seg.mask, seg.boxes[n - 4]);
        addInstance("/", seg.mask, seg.boxes[n - 3]);
        addInstance(String(truth.state.maxTurns), seg.mask, seg.boxes[n - 2]);
        addInstance(")", seg.mask, seg.boxes[n - 1]);
      }
    }

    // ---- footer cost row: "Processing Cost   900" — THE source of '0' glyphs ----
    // (nothing else in the closed vocabulary contains a zero; without it "10"/"12"
    // Astrogem Points can never template-read). The number is right-aligned and far
    // from the label, so: take the line's TRAILING box run after the last wide gap;
    // accept only when it has exactly the cost's digit count (900/450 — skip 1,800,
    // its comma merges unpredictably) and digit-ish aspects. The Balance row below
    // fails the count guard (7 digits + commas), "…1 time" fails the wide-gap guard.
    var costVal = truth.state && truth.state.processCost;
    if (costVal === 900 || costVal === 450) {
      var costDigits = String(costVal).split("");
      var bandTop = goldY + gap * 1.13;
      for (var rowI = 0; rowI < 2; rowI++) {
        var costLn = L.findMaskedTextLine(raster,
          { x: cx - gap * 2.3, y: bandTop, w: gap * 4.6, h: gap * 0.5 }, isWhite,
          { maxRowFill: 0.75, minH: Math.max(4, Math.round(gap * 0.05)), maxH: Math.round(gap * 0.2), minRowPx: Math.max(3, Math.round(gap * 0.03)), accept: function (r) { return r.w >= gap * 0.8; } });
        if (!costLn) break;
        bandTop = costLn.y + costLn.h + 2;   // next iteration scans below this row
        var cgrow = Math.round(costLn.h * 0.45);
        var segC = segRect(raster, { x: costLn.x - cgrow, y: costLn.y - cgrow, w: costLn.w + cgrow * 2, h: costLn.h + cgrow * 2 }, isWhite);
        var bx = segC.boxes;
        if (bx.length < costDigits.length + 2) continue;
        var chs = bx.map(function (b) { return b.h; }).sort(function (a, b) { return a - b; });
        var cmedH = chs.length ? chs[chs.length >> 1] : 0;
        // trailing run = boxes after the last gap wider than 1.5×medH
        var runStart = bx.length - 1;
        while (runStart > 0 && (bx[runStart].x - (bx[runStart - 1].x + bx[runStart - 1].w)) < cmedH * 1.5) runStart--;
        var run = bx.slice(runStart);
        var wideGapBefore = runStart > 0 &&
          (bx[runStart].x - (bx[runStart - 1].x + bx[runStart - 1].w)) >= cmedH * 1.5;
        var aspectsOk = run.every(function (b) { var a = b.w / Math.max(1, b.h); return a >= 0.25 && a <= 1.0; });
        if (wideGapBefore && run.length === costDigits.length && aspectsOk) {
          for (var cdi = 0; cdi < costDigits.length; cdi++) addInstance(costDigits[cdi], segC.mask, run[cdi]);
          break;   // harvested the cost row; don't scan further rows
        }
      }
    }

    // ---- points header: "N Astrogem Points" ----
    var cfg = truth.config || {};
    var pts = (cfg.willpowerLevel | 0) + (cfg.orderLevel | 0) + (cfg.effect1Level | 0) + (cfg.effect2Level | 0);
    var ptsRect = { x: cx - gap * 1.55, y: redY - gap * 1.23, w: gap * 3.1, h: gap * 0.26 };
    var segP = segRect(raster, ptsRect, isWhite);
    var digits = String(pts).split("");
    // label the LEADING digit run positionally when the box count is in the plausible
    // window for "N Astrogem Points" (digits + 8..16 letter boxes; bad merges change
    // the count and skip the sample). The letters feed the DISTRACTOR pool — without
    // them, "Astrogem" letters can pass as digits in the matcher.
    if (segP.boxes.length >= digits.length + 8 && segP.boxes.length <= digits.length + 16) {
      for (var b2 = 0; b2 < digits.length; b2++) addInstance(digits[b2], segP.mask, segP.boxes[b2]);
      var letters = ["A", "s", "t", "r", "o", "g", "e", "m"];
      for (var b3 = 0; b3 < Math.min(letters.length, segP.boxes.length - digits.length); b3++) {
        addInstance(letters[b3], segP.mask, segP.boxes[digits.length + b3]);
      }
    }

    // ---- wheel level lines (gold): W/E "Lv. N"; N node bare digit ----
    function levelLine(p) {
      return L.findMaskedTextLine(raster, { x: p.x - gap * 0.5, y: p.y - gap * 0.35, w: gap * 1.0, h: gap * 0.72 }, isGold, {
        rejectFill: 0.22, maxRowFill: 0.6, minH: Math.max(4, Math.round(gap * 0.05)), maxH: Math.round(gap * 0.22), minRowPx: 3,
        accept: function (r) { var c = r.x + r.w / 2; return Math.abs(c - p.x) <= gap * 0.28 && r.w >= gap * 0.03 && r.w <= gap * 0.85; }
      });
    }
    var geo = L.wheelGeometry({ red: red, gold: gold });
    var wheelJobs = [
      { p: geo.nodeW, val: cfg.effect1Level, kind: "lv" },
      { p: geo.nodeE, val: cfg.effect2Level, kind: "lv" },
      { p: geo.nodeN, val: cfg.willpowerLevel, kind: "bare" }
    ];
    wheelJobs.forEach(function (j) {
      if (j.val == null) return;
      var line = levelLine(j.p);
      if (!line) return;
      var grow2 = Math.round(line.h * 0.5);
      var segL = segRect(raster, { x: line.x - grow2, y: line.y - grow2, w: line.w + grow2 * 2, h: line.h + grow2 * 2 }, isGold);
      // Gold level digits share the WHITE digit templates (same masked shape). Harvest
      // them as plain digit labels ONLY when the digit box is unambiguous, so we don't
      // poison the clean footer-digit templates with the diamond-tip mis-segmentation.
      if (j.kind === "bare") {
        if (segL.boxes.length === 1) addInstance(String(j.val), segL.mask, segL.boxes[0]);
      } else {
        // "Lv. N": the digit is the RIGHTMOST box; only accept clean 3-4 box splits
        if (segL.boxes.length === 3 || segL.boxes.length === 4) {
          addInstance(String(j.val), segL.mask, segL.boxes[segL.boxes.length - 1]);
          addInstance("L", segL.mask, segL.boxes[0]);
          addInstance("v", segL.mask, segL.boxes[1]);
        }
      }
    });

    // ---- outcome amount lines (chartreuse — same face as the gold wheel digits) ----
    var outs = truth.outcomes || [];
    var iconXs = geo.outIconXs, iconY = geo.outIconY;
    for (var oi = 0; oi < Math.min(4, outs.length); oi++) {
      var o = outs[oi];
      if (!o || (o.type !== "raise_effect" && o.type !== "lower_effect")) continue;
      var isLower = o.type === "lower_effect";
      var amtPred = isLower ? L.isRedAmountText : L.isAmountText;   // lowers render RED
      var capRect = { x: iconXs[oi] - gap * 0.44, y: iconY - gap * 0.16, w: gap * 0.88, h: gap * 0.52 };
      var amtLine = L.findMaskedTextLine(raster, capRect, amtPred, {
        rejectFill: isLower ? 0.3 : undefined,
        maxRowFill: 0.7, minH: Math.max(4, Math.round(gap * 0.05)), maxH: Math.round(gap * 0.2), minRowPx: 3,
        accept: function (r) { var c = r.x + r.w / 2; return Math.abs(c - iconXs[oi]) <= gap * 0.24 && r.w >= gap * 0.04 && r.w <= gap * 0.6; }
      });
      if (!amtLine) continue;
      var ag = Math.round(amtLine.h * 0.5);
      var segA = segRect(raster, { x: amtLine.x, y: amtLine.y - ag, w: amtLine.w, h: amtLine.h + ag * 2 }, amtPred);
      // "+N"/"-N" = 2 boxes; "Lv. N" = 2-4 boxes; the digit is LAST either way (the
      // ▲/▼ is green/red-solid, outside the text masks' line bounds)
      if (segA.boxes.length >= 2 && segA.boxes.length <= 4) {
        addInstance(String(o.amount || 1), segA.mask, segA.boxes[segA.boxes.length - 1]);
        if (segA.boxes.length === 2 && segA.boxes[0].w <= segA.boxes[1].w * 1.4) {
          addInstance(isLower ? "-" : "+", segA.mask, segA.boxes[0]);
        }
      }
    }

    // ---- reroll pill "n / m" (white) — model rerolls minus the paid one ----
    var st = truth.state || {};
    if (st.rerollsRemaining != null && st.rerollsRemaining >= 1 && !/charge/i.test(JSON.stringify(truth._note || ""))) {
      var pillRect = { x: geo.rerollPill.x - gap * 0.42, y: geo.rerollPill.y - gap * 0.14, w: gap * 0.84, h: gap * 0.28 };
      var segR = segRect(raster, pillRect, isWhite);
      var freeShown = st.rerollsRemaining - 1;
      var denom = st.maxTurns === 9 ? 2 : 1;
      if (freeShown <= denom && segR.boxes.length === 3) {
        addInstance(String(freeShown), segR.mask, segR.boxes[0]);
        addInstance("/", segR.mask, segR.boxes[1]);
        addInstance(String(denom), segR.mask, segR.boxes[2]);
      }
    }
  }

  // ---- emit ----
  var atlas = {};
  Object.keys(acc).sort().forEach(function (ch) {
    var a = acc[ch];
    var bits = [];
    for (var i = 0; i < a.sum.length; i++) bits.push(a.sum[i] / a.n >= 0.5 ? 1 : 0);
    atlas[ch] = bits;
  });
  var counts = Object.keys(acc).sort().map(function (ch) { return ch + ":" + acc[ch].n; }).join("  ");
  var body = "/**\n * ocr/glyphs.js — GENERATED by tools/build-glyphs.js (do not hand-edit).\n" +
    " * Binary " + L.GLYPH_W + "x" + L.GLYPH_H + " templates of the game's own glyphs, harvested from the labeled\n" +
    " * corpus at the engine's canonical scale. Digit keys: '0'-'9' white footer font,\n" +
    " * 'g1'-'g5' gold wheel font. Letters are DISTRACTOR classes for rejection.\n" +
    " * Instances per class: " + counts + "\n */\n" +
    "(function (root) {\n  \"use strict\";\n  var GLYPH_ATLAS = " + JSON.stringify(atlas) + ";\n" +
    "  if (typeof module !== \"undefined\" && module.exports) module.exports = { GLYPH_ATLAS: GLYPH_ATLAS };\n" +
    "  else root.OcrGlyphs = { GLYPH_ATLAS: GLYPH_ATLAS };\n})(typeof globalThis !== \"undefined\" ? globalThis : this);\n";
  fs.writeFileSync(OUT, body);
  console.log("samples used: " + used);
  console.log("classes: " + Object.keys(atlas).length);
  console.log("instances: " + counts);
  console.log("wrote " + OUT);
})().catch(function (e) { console.error(e); process.exit(1); });
