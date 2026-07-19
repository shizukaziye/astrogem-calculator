#!/usr/bin/env node
/**
 * tools/build-level-refs.js — bake pristine level-digit reference patches.
 *
 * Harvests 32×32 greyscale patches of the wheel level digits (N willpower,
 * S order/chaos — bare digits; W/E — the trailing "Lv." digit) from NATIVE-tier
 * labeled samples (source wheel gap ≥ 110px — the sharpest renderings), keyed by
 * the LABEL value, ≤3 exemplars per class per node. Emits ocr/level-refs.js.
 *
 * These feed the engine's ANALYSIS-BY-SYNTHESIS level rescue (see
 * structural-engine.js synthLevelRescue): the pristine patch is blurred to
 * candidate degradations and correlated against the observed patch — the method
 * that finally read the gold-on-gold digits on the degraded corpus tier
 * (2026-07-19; raw+gradient dual scoring, agreement-gated).
 *
 * Rerun after adding native-tier samples:  node tools/build-level-refs.js
 */
"use strict";
var fs = require("fs");
var path = require("path");
var sharp = require("sharp");
var L = require("../ocr/layout.js");

var ROOT = path.resolve(__dirname, "..");
var PS = 32, PATCH_GAP = 0.13, CANON = 246;
var MIN_NATIVE_GAP = 110, MAX_PER_CLASS = 3;

// samples excluded from harvesting (the degraded tier the refs exist to serve)
var DEGRADED = {
  "live-stability-t6-15pts": 1, "live-stability-t8-charge": 1, "live-stability-t9-pet": 1,
  "live-share-0719-rare7t-tooltip": 1, "rare1-c9-chaos-station": 1
};

function lumOf(sub) {
  var out = new Float32Array(sub.width * sub.height);
  for (var i = 0, j = 0; i < sub.data.length; i += 4, j++) {
    out[j] = 0.299 * sub.data[i] + 0.587 * sub.data[i + 1] + 0.114 * sub.data[i + 2];
  }
  return out;
}
function sampleF(img, w, h, x, y) {
  var x0 = Math.max(0, Math.min(w - 1, Math.floor(x))), y0 = Math.max(0, Math.min(h - 1, Math.floor(y)));
  var x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  var fx = x - x0, fy = y - y0;
  return img[y0 * w + x0] * (1 - fx) * (1 - fy) + img[y0 * w + x1] * fx * (1 - fy) +
         img[y1 * w + x0] * (1 - fx) * fy + img[y1 * w + x1] * fx * fy;
}
function rawPatch(lum, w, h, cx, cy, gap) {
  var side = PATCH_GAP * gap, out = new Float32Array(PS * PS);
  for (var py = 0; py < PS; py++) for (var px = 0; px < PS; px++) {
    out[py * PS + px] = sampleF(lum, w, h, cx - side / 2 + (px + 0.5) * side / PS, cy - side / 2 + (py + 0.5) * side / PS);
  }
  return out;
}
function centerEnergy(p) {
  var e = 0, a = Math.floor(PS / 4), b = PS - a;
  for (var y = a; y < b; y++) for (var x = a; x < b; x++) {
    var dx = p[y * PS + x + 1] - p[y * PS + x - 1];
    var dy = p[(y + 1) * PS + x] - p[(y - 1) * PS + x];
    e += dx * dx + dy * dy;
  }
  return e;
}
// self-align the harvest center by maximizing central gradient energy (±0.02 gap):
// without this the baked refs sit a pixel or two off and raw-vs-grad rankings
// diverge at classify time (measured: N raw said 3 while grad said 5)
function alignedPatch(lum, w, h, cx, cy, gap) {
  var span = 0.02, best = null, bestE = -1;
  for (var dy = -span; dy <= span + 1e-9; dy += span / 2) {
    for (var dx = -span; dx <= span + 1e-9; dx += span / 2) {
      var p = rawPatch(lum, w, h, cx + dx * gap, cy + dy * gap, gap);
      var e = centerEnergy(p);
      if (e > bestE) { bestE = e; best = p; }
    }
  }
  return best;
}

function loadNorm(file) {
  return sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true }).then(function (dec) {
    var raster = { width: dec.info.width, height: dec.info.height,
      data: new Uint8ClampedArray(dec.data.buffer, dec.data.byteOffset, dec.data.length) };
    var found = L.panelOrWhole(raster);
    if (!found || !found.anchors) return null;
    found.anchors = L.fitWheel ? L.fitWheel(raster, found.anchors) : found.anchors;
    var g0 = found.anchors.gold.y - found.anchors.red.y;
    var fRaw = CANON / Math.max(8, g0);
    var scaleF = fRaw <= 0.65 ? 0.5 : fRaw <= 1.25 ? 1 : Math.min(3, Math.round(fRaw));
    var mg = 0.06, mgBot = 0.16;
    var cr = { x: found.rect.x - found.rect.w * mg, y: found.rect.y - found.rect.h * mg,
      w: found.rect.w * (1 + 2 * mg), h: found.rect.h * (1 + mg + mgBot) };
    var ox = Math.max(0, Math.round(cr.x)), oy = Math.max(0, Math.round(cr.y));
    raster = L.crop(raster, cr);
    var sh2 = function (p) { return { x: (p.x - ox) * scaleF, y: (p.y - oy) * scaleF }; };
    if (Math.abs(scaleF - 1) > 0.04) raster = L.upscaleBilinear(raster, scaleF); else scaleF = 1;
    var anchors = { red: sh2(found.anchors.red), gold: sh2(found.anchors.gold) };
    if (found.anchors.w) anchors.w = sh2(found.anchors.w);
    if (found.anchors.e) anchors.e = sh2(found.anchors.e);
    return { raster: raster, geo: L.wheelGeometry(anchors), lum: null, g0: g0 };
  });
}

// Lv line locate for W/E — BELOW-CENTER only (the caption band above is a trap)
function locateLv(raster, p, gap) {
  var box = { x: p.x - gap * 0.5, y: p.y - gap * 0.02, w: gap * 1.0, h: gap * 0.38 };
  var opts = {
    rejectFill: 0.22, maxRowFill: 0.6,
    minH: Math.max(4, Math.round(gap * 0.05)), maxH: Math.round(gap * 0.22), minRowPx: 3,
    accept: function (r) { return Math.abs(r.x + r.w / 2 - p.x) <= gap * 0.28 && r.w >= gap * 0.03 && r.w <= gap * 0.85; }
  };
  return L.findMaskedTextLine(raster, box, L.isGoldText, opts);
}

var OFF_BARE = 0.175;   // bare digit center sits +0.175 gap below the node anchor

(async function () {
  var files = fs.readdirSync(path.join(ROOT, "samples")).filter(function (f) { return /\.(png|webp)$/.test(f); });
  var refs = { N: {}, S: {}, W: {}, E: {} };
  var used = 0;
  for (var fi = 0; fi < files.length; fi++) {
    var f = files[fi];
    var base = f.replace(/\.(png|webp)$/, "");
    if (DEGRADED[base]) continue;
    var lblFile = path.join(ROOT, "samples", base + ".json");
    if (!fs.existsSync(lblFile)) continue;
    var cfg = (JSON.parse(fs.readFileSync(lblFile, "utf8")).config) || {};
    var ctx = await loadNorm(path.join(ROOT, "samples", f));
    if (!ctx || ctx.g0 < MIN_NATIVE_GAP) continue;
    ctx.lum = lumOf(ctx.raster);
    used++;
    var gap = ctx.geo.gap;
    var nodes = { N: ctx.geo.nodeN, S: ctx.geo.nodeS, W: ctx.geo.nodeW, E: ctx.geo.nodeE };
    var classes = { N: cfg.willpowerLevel, S: cfg.orderLevel, W: cfg.effect1Level, E: cfg.effect2Level };
    for (var kk = 0; kk < 4; kk++) {
      var k = ["N", "S", "W", "E"][kk];
      var cls = classes[k];
      if (!(cls >= 1 && cls <= 5)) continue;
      var arr = refs[k][cls] = refs[k][cls] || [];
      if (arr.length >= MAX_PER_CLASS) continue;
      var p = nodes[k], cx, cy;
      if (k === "N" || k === "S") { cx = p.x; cy = p.y + OFF_BARE * gap; }
      else {
        var line = locateLv(ctx.raster, p, gap);
        if (!line) continue;
        cx = line.x + line.w - gap * 0.05; cy = line.y + line.h / 2;
      }
      var patch = alignedPatch(ctx.lum, ctx.raster.width, ctx.raster.height, cx, cy, gap);
      // quantize to Uint8 (min-max) — the engine re-normalizes anyway
      var mn = Infinity, mx = -Infinity;
      for (var i = 0; i < patch.length; i++) { if (patch[i] < mn) mn = patch[i]; if (patch[i] > mx) mx = patch[i]; }
      var q = new Array(patch.length);
      var rng = (mx - mn) || 1;
      for (var i2 = 0; i2 < patch.length; i2++) q[i2] = Math.round((patch[i2] - mn) / rng * 255);
      arr.push({ src: base, q: q });
    }
  }

  var lines = [];
  lines.push("// GENERATED by tools/build-level-refs.js — do not edit by hand.");
  lines.push("// Pristine 32x32 level-digit reference patches from native-tier samples,");
  lines.push("// keyed refs[node][digit] = [Uint8 patch rows...]; used by the engine's");
  lines.push("// analysis-by-synthesis level rescue. Rebuild after adding native samples.");
  lines.push("(function (root) {");
  lines.push("  \"use strict\";");
  lines.push("  var LEVEL_REFS = " + JSON.stringify(refs) + ";");
  lines.push("  var META = { ps: " + PS + ", patchGap: " + PATCH_GAP + ", built: " + JSON.stringify(new Date().toISOString().slice(0, 10)) + " };");
  lines.push("  if (typeof module !== \"undefined\" && module.exports) module.exports = { LEVEL_REFS: LEVEL_REFS, LEVEL_REFS_META: META };");
  lines.push("  else root.OcrLevelRefs = { LEVEL_REFS: LEVEL_REFS, LEVEL_REFS_META: META };");
  lines.push("})(typeof globalThis !== \"undefined\" ? globalThis : this);");
  fs.writeFileSync(path.join(ROOT, "ocr", "level-refs.js"), lines.join("\n") + "\n");

  var covN = [1, 2, 3, 4, 5].map(function (v) { return v + ":" + ((refs.N[v] || []).length); }).join(" ");
  var covS = [1, 2, 3, 4, 5].map(function (v) { return v + ":" + ((refs.S[v] || []).length); }).join(" ");
  var covW = [1, 2, 3, 4, 5].map(function (v) { return v + ":" + ((refs.W[v] || []).length); }).join(" ");
  var covE = [1, 2, 3, 4, 5].map(function (v) { return v + ":" + ((refs.E[v] || []).length); }).join(" ");
  var kb = Math.round(fs.statSync(path.join(ROOT, "ocr", "level-refs.js")).size / 1024);
  console.log("harvested from " + used + " native-tier samples -> ocr/level-refs.js (" + kb + "KB)");
  console.log("coverage  N " + covN + "  |  S " + covS + "  |  W " + covW + "  |  E " + covE);
})().catch(function (e) { console.error(e); process.exit(1); });
