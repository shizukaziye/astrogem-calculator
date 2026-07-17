#!/usr/bin/env node
/**
 * tools/dump-structural.js — calibration + diagnostics for the structural parser.
 *
 * For every image in samples/ (or a name filter): decode via sharp, run
 * ocr/layout.js panel detection, then sample the wheel nodes and outcome icons and
 * print their colors + hue classes. This is how the ROI constants in ocr/layout.js
 * were measured and how regressions get eyeballed (eval-ocr gives the score, this
 * gives the why).
 *
 * Also supports a synthetic full-screen check: --mount composites each modal crop
 * onto dark 2560x1440 and 3840x2160 frames at random-ish offsets and verifies the
 * panel detector recovers the placement (IoU printed).
 *
 * Usage:
 *   node tools/dump-structural.js [name-filter] [--mount]
 */
"use strict";
var fs = require("fs");
var path = require("path");
var sharp = require("sharp");
var L = require("../ocr/layout.js");

var ROOT = path.resolve(__dirname, "..");
var SAMPLES = path.join(ROOT, "samples");
var filter = (process.argv[2] && !process.argv[2].startsWith("--")) ? process.argv[2] : "";
var MOUNT = process.argv.indexOf("--mount") !== -1;

async function loadRaster(file) {
  var { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) };
}

function fmtRect(r) { return r ? Math.round(r.x) + "," + Math.round(r.y) + " " + Math.round(r.w) + "x" + Math.round(r.h) : "none"; }
function iou(a, b) {
  var x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  var x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  var inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return inter / (a.w * a.h + b.w * b.h - inter);
}

function samplePanel(img, panel, anchors) {
  var out = { nodes: {}, outcomes: [] };
  var geo = anchors ? L.wheelGeometry(anchors) : null;
  ["nodeN", "nodeW", "nodeE", "nodeS"].forEach(function (k) {
    var p = geo ? geo[k] : L.roiPoint(panel, k);
    var c = L.medianPatch(img, p.x, p.y, Math.max(4, panel.w * 0.01));
    out.nodes[k] = { rgb: c.join(","), cls: L.hueClass(c[0], c[1], c[2]) };
  });
  var iconY = geo ? geo.outIconY : (panel.y + L.ROI.outIconY * panel.h);
  var xs = geo ? geo.outIconXs : L.ROI.outIconXs.map(function (fx) { return panel.x + fx * panel.w; });
  xs.forEach(function (cx, i) {
    var c = L.medianPatch(img, cx, iconY, Math.max(4, panel.w * 0.01));
    out.outcomes.push({ i: i, rgb: c.join(","), cls: L.hueClass(c[0], c[1], c[2]) });
  });
  return out;
}

(async function main() {
  var imgs = fs.readdirSync(SAMPLES)
    .filter(function (f) { return /\.(png|jpg|jpeg|webp)$/i.test(f); })
    .filter(function (f) { return f.indexOf(filter) !== -1; });
  if (!imgs.length) { console.log("no images match"); return; }

  for (var fi = 0; fi < imgs.length; fi++) {
    var f = imgs[fi];
    var img = await loadRaster(path.join(SAMPLES, f));
    console.log("\n=== " + f + " (" + img.width + "x" + img.height + ") ===");
    var found = L.panelOrWhole(img);
    if (!found) { console.log("  PANEL: NOT FOUND"); continue; }
    console.log("  PANEL: " + fmtRect(found.rect) + "  method=" + found.method + "  score=" + found.score.toFixed(2));
    if (found.anchors) {
      var a = found.anchors;
      console.log("  anchors (image fractions): red=(" + (a.red.x / img.width).toFixed(4) + "," + (a.red.y / img.height).toFixed(4) +
        ")  gold=(" + (a.gold.x / img.width).toFixed(4) + "," + (a.gold.y / img.height).toFixed(4) +
        ")  gapFrac=" + ((a.gold.y - a.red.y) / img.height).toFixed(4) +
        "  gapPx=" + Math.round(a.gold.y - a.red.y));
    }
    var s = samplePanel(img, found.rect, found.anchors);
    console.log("  nodes: N=" + s.nodes.nodeN.cls + "(" + s.nodes.nodeN.rgb + ")  W=" + s.nodes.nodeW.cls + "(" + s.nodes.nodeW.rgb + ")" +
      "  E=" + s.nodes.nodeE.cls + "(" + s.nodes.nodeE.rgb + ")  S=" + s.nodes.nodeS.cls + "(" + s.nodes.nodeS.rgb + ")");
    console.log("  outcome icons: " + s.outcomes.map(function (o) { return "#" + (o.i + 1) + "=" + o.cls; }).join("  "));

    if (MOUNT) {
      for (var mi = 0; mi < 2; mi++) {
        var MW = mi === 0 ? 2560 : 3840, MH = mi === 0 ? 1440 : 2160;
        // scale the modal to ~72% of mount height (typical in-game modal proportion)
        var targetH = Math.round(MH * 0.72);
        var scale = targetH / img.height;
        var targetW = Math.round(img.width * scale);
        var left = Math.round((MW - targetW) * (mi === 0 ? 0.5 : 0.62));
        var top = Math.round((MH - targetH) * 0.45);
        var resized = await sharp(path.join(SAMPLES, f)).resize(targetW, targetH).toBuffer();
        var mounted = await sharp({ create: { width: MW, height: MH, channels: 4, background: { r: 10, g: 14, b: 22, alpha: 1 } } })
          .composite([{ input: resized, left: left, top: top }])
          .png().toBuffer();
        var mimg = await (async function () {
          var { data, info } = await sharp(mounted).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
          return { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) };
        })();
        var truth = { x: left, y: top, w: targetW, h: targetH };
        var det = L.findPanel(mimg);
        var quality = det ? iou(det.rect, truth) : 0;
        console.log("  mount " + MW + "x" + MH + ": detected=" + fmtRect(det && det.rect) + "  truth=" + fmtRect(truth) +
          "  IoU=" + quality.toFixed(3) + (quality >= 0.90 ? "  OK" : "  *** LOW ***"));
        if (det) {
          var ms = samplePanel(mimg, det.rect, det.anchors);
          console.log("    mounted outcome icons: " + ms.outcomes.map(function (o) { return "#" + (o.i + 1) + "=" + o.cls; }).join("  "));
        } else {
          // diagnostic: what blobs DID the detector see?
          var sm = L.downsample(mimg, 640);
          var rb = L.findBlobs(sm, "red", 0.42, 0.25), gb = L.findBlobs(sm, "gold", 0.42, 0.25);
          console.log("    (diag) red blobs: " + rb.slice(0, 3).map(function (b) { return Math.round(b.cx) + "," + Math.round(b.cy) + "×" + b.count; }).join(" | ") +
            "   gold blobs: " + gb.slice(0, 3).map(function (b) { return Math.round(b.cx) + "," + Math.round(b.cy) + "×" + b.count; }).join(" | "));
        }
      }
    }
  }

  // negative control: a non-game image must be rejected
  var noise = { width: 400, height: 400, data: new Uint8ClampedArray(400 * 400 * 4) };
  for (var i = 0; i < noise.data.length; i += 4) {
    noise.data[i] = (i * 7) % 251; noise.data[i + 1] = (i * 13) % 241; noise.data[i + 2] = (i * 3) % 239; noise.data[i + 3] = 255;
  }
  console.log("\nnegative control (noise 400x400): " + (L.findPanel(noise) ? "*** FALSE POSITIVE ***" : "rejected OK"));
})().catch(function (e) { console.error("dump-structural fatal:", e); process.exit(1); });
