/**
 * ocr/layout.js — the structural parser's pure image-analysis core.
 *
 * Environment-agnostic: every function works on a plain raster object
 *   { width, height, data: Uint8ClampedArray (RGBA) }
 * so the SAME decision logic runs in the browser (canvas ImageData) and in Node
 * (sharp -> raw RGBA), keeping tools/eval-ocr.js scores honest about what ships.
 *
 * What lives here:
 *   - downsample(raster, maxDim)           box-filter downscale
 *   - hueClass(r,g,b)                      the proven bucket classifier (red / gold /
 *                                          green / blue / violet / grey by hue+sat)
 *   - medianPatch(raster, cx, cy, half)    robust patch color (median per channel)
 *   - findPanel(raster)                    locate the Processing modal: the RED
 *                                          (Willpower, N) diamond above the GOLD
 *                                          (Points, S) diamond is a stat-independent
 *                                          signature; panel rect derives from their
 *                                          geometry. Works for cropped modals AND
 *                                          full-screen captures.
 *   - ROI                                  the panel-normalized region model measured
 *                                          from the real samples (tools/dump-structural.js
 *                                          is the calibration/debug harness)
 *   - roiRect(panel, key)                  ROI -> absolute pixel rect
 *   - crop(raster, rect)                   raster excerpt
 *   - chromaMask(raster, opts)             binarize colored text (gold digits, green ▲)
 *   - colorClusterStats(raster, classFn)   pixel-count + centroid per hue class (▲/▼
 *                                          detection without glyph OCR)
 *
 * The wheel-pair signature: on EVERY Processing screen the North diamond is Willpower
 * (red) and the South diamond is Order/Chaos Points (gold), vertically aligned through
 * the wheel center with a stable gap ratio. Measured on the 3 real samples (2 crop
 * resolutions): red center ≈ (0.494, 0.398), gold ≈ (0.494, 0.578) of the MODAL, i.e.
 * gap ≈ 0.180 of modal height; modal aspect ≈ 0.90 (w/h).
 */
(function (root) {
  "use strict";

  // ---- basic raster ops ----
  function downsample(img, maxDim) {
    var w = img.width, h = img.height;
    var scale = Math.max(w, h) / maxDim;
    if (scale <= 1) return { width: w, height: h, data: img.data, scale: 1 };
    var nw = Math.max(1, Math.round(w / scale)), nh = Math.max(1, Math.round(h / scale));
    var out = new Uint8ClampedArray(nw * nh * 4);
    for (var y = 0; y < nh; y++) {
      var sy0 = Math.floor(y * h / nh), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * h / nh));
      for (var x = 0; x < nw; x++) {
        var sx0 = Math.floor(x * w / nw), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * w / nw));
        var r = 0, g = 0, b = 0, n = 0;
        for (var sy = sy0; sy < sy1; sy++) {
          var row = sy * w;
          for (var sx = sx0; sx < sx1; sx++) {
            var i = (row + sx) * 4;
            r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
          }
        }
        var o = (y * nw + x) * 4;
        out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
      }
    }
    return { width: nw, height: nh, data: out, scale: scale };
  }

  function crop(img, rect) {
    var x0 = Math.max(0, Math.round(rect.x)), y0 = Math.max(0, Math.round(rect.y));
    var w = Math.min(img.width - x0, Math.round(rect.w)), h = Math.min(img.height - y0, Math.round(rect.h));
    w = Math.max(1, w); h = Math.max(1, h);
    var out = new Uint8ClampedArray(w * h * 4);
    for (var y = 0; y < h; y++) {
      var src = ((y0 + y) * img.width + x0) * 4;
      out.set(img.data.subarray(src, src + w * 4), y * w * 4);
    }
    return { width: w, height: h, data: out };
  }

  // ---- color science ----
  // Hue/sat/val from 0-255 RGB. Hue in degrees [0,360), sat/val in [0,1].
  function hsv(r, g, b) {
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    var v = mx / 255, s = mx ? d / mx : 0, hDeg = 0;
    if (d > 0) {
      if (mx === r) hDeg = 60 * (((g - b) / d) % 6);
      else if (mx === g) hDeg = 60 * ((b - r) / d + 2);
      else hDeg = 60 * ((r - g) / d + 4);
      if (hDeg < 0) hDeg += 360;
    }
    return { h: hDeg, s: s, v: v };
  }

  // The proven bucket classifier (validated 12/12 on the real outcome icons across two
  // capture resolutions). Buckets: red / gold / green / blue / violet / grey.
  function hueClass(r, g, b) {
    var c = hsv(r, g, b);
    if (c.s < 0.18) return "grey";
    if (c.h < 20 || c.h >= 340) return "red";
    if (c.h < 55) return "gold";
    if (c.h < 170) return "green";
    if (c.h < 260) return "blue";
    if (c.h < 340) return "violet";
    return "grey";
  }

  function medianPatch(img, cx, cy, half) {
    var R = [], G = [], B = [];
    var x0 = Math.max(0, Math.round(cx - half)), x1 = Math.min(img.width - 1, Math.round(cx + half));
    var y0 = Math.max(0, Math.round(cy - half)), y1 = Math.min(img.height - 1, Math.round(cy + half));
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        var i = (y * img.width + x) * 4;
        R.push(img.data[i]); G.push(img.data[i + 1]); B.push(img.data[i + 2]);
      }
    }
    function med(a) { a.sort(function (p, q) { return p - q; }); return a[a.length >> 1]; }
    return R.length ? [med(R), med(G), med(B)] : [0, 0, 0];
  }

  // ---- panel detection: the red-over-gold wheel signature ----
  // Scan a downsampled frame for saturated RED and GOLD blobs; accept a (red, gold)
  // pair that is vertically aligned (|dx| small vs the gap) with gold BELOW red.
  // Panel rect derives from the measured geometry:
  //   wheelCenter = midpoint(red, gold); gap = goldY - redY
  //   modalHeight = gap / GAP_RATIO; modalWidth = modalHeight * ASPECT
  //   modalTop = redY - RED_Y * modalHeight ... etc (constants below).
  // Measured from FULL-RES REFINED diamond centers on the 3 real samples
  // (tools/dump-structural.js prints these): red=(0.495,0.405), gold_y=0.569,
  // gapFrac 0.1628/0.1676/0.1617 → 0.164. (The first seeds came from downsampled
  // blob centroids and ran ~10% hot on the gap — glow and the gold level digit
  // drag centroids; always calibrate against the refined centers.)
  var SIG = {
    RED_X: 0.495, RED_Y: 0.405, GOLD_Y: 0.569,   // stat-node CENTERS in modal units
    GAP_RATIO: 0.164,                             // (GOLD_Y - RED_Y)
    ASPECT: 0.91                                  // modal w/h (0.901 / 0.916 / 0.921 across samples)
  };

  function findBlobs(small, wantClass, minSat, minVal) {
    // connected-components on the class mask (4-neighborhood, iterative flood)
    var w = small.width, h = small.height, N = w * h;
    var mask = new Uint8Array(N);
    for (var i = 0; i < N; i++) {
      var o = i * 4;
      var c = hsv(small.data[o], small.data[o + 1], small.data[o + 2]);
      if (c.s >= minSat && c.v >= minVal && hueClass(small.data[o], small.data[o + 1], small.data[o + 2]) === wantClass) mask[i] = 1;
    }
    var seen = new Uint8Array(N), blobs = [], stack = [];
    for (var s0 = 0; s0 < N; s0++) {
      if (!mask[s0] || seen[s0]) continue;
      var minX = w, maxX = 0, minY = h, maxY = 0, cnt = 0, sx = 0, sy = 0;
      stack.length = 0; stack.push(s0); seen[s0] = 1;
      while (stack.length) {
        var p = stack.pop();
        var px = p % w, py = (p / w) | 0;
        cnt++; sx += px; sy += py;
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
        if (px > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
        if (px < w - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
        if (py > 0 && mask[p - w] && !seen[p - w]) { seen[p - w] = 1; stack.push(p - w); }
        if (py < h - 1 && mask[p + w] && !seen[p + w]) { seen[p + w] = 1; stack.push(p + w); }
      }
      if (cnt >= 12) blobs.push({ cx: sx / cnt, cy: sy / cnt, count: cnt, w: maxX - minX + 1, h: maxY - minY + 1 });
    }
    blobs.sort(function (a, b) { return b.count - a.count; });
    return blobs.slice(0, 12);
  }

  // findPanel(raster) -> { rect:{x,y,w,h}, method, score, anchors } or null.
  // `anchors` carries the FULL-RES red (Willpower/N) and gold (Points/S) diamond
  // centers — the whole downstream geometry is derived from them (self-locating),
  // so slightly different crop margins between captures cannot shift the sampling.
  function findPanel(img) {
    var small = downsample(img, 640);
    var k = small.scale;
    var reds = findBlobs(small, "red", 0.42, 0.25);
    var golds = findBlobs(small, "gold", 0.42, 0.25);
    var best = null;
    for (var i = 0; i < reds.length; i++) {
      for (var j = 0; j < golds.length; j++) {
        var R = reds[i], G = golds[j];
        var gap = G.cy - R.cy;
        if (gap <= 0) continue;
        // vertical alignment: |dx| well under the gap; similar blob sizes (same-size diamonds)
        var dx = Math.abs(G.cx - R.cx);
        if (dx > gap * 0.25) continue;
        var sizeRatio = Math.max(R.count, G.count) / Math.max(1, Math.min(R.count, G.count));
        if (sizeRatio > 3.5) continue;
        // diamond size vs gap — LOOSE band: coarse blob centroids under-estimate the
        // true center-to-center gap (glow/digits merge into the blobs), so the ratio
        // wobbles; the full-res refine below fixes precision, this only prunes junk.
        var diaOverGap = Math.max(R.w, R.h) / gap;
        if (diaOverGap < 0.08 || diaOverGap > 1.1) continue;
        var modalH = gap / SIG.GAP_RATIO;
        var modalW = modalH * SIG.ASPECT;
        var cx = (R.cx + G.cx) / 2;
        var top = R.cy - SIG.RED_Y * modalH;
        var left = cx - SIG.RED_X * modalW;
        // plausibility: the modal must mostly fit the frame
        var fitPenalty = 0;
        if (left < -modalW * 0.1 || top < -modalH * 0.1) fitPenalty += 0.3;
        if (left + modalW > small.width + modalW * 0.1 || top + modalH > small.height + modalH * 0.1) fitPenalty += 0.3;
        var score = Math.min(1, (R.count + G.count) / 600) * (1 - dx / Math.max(1, gap)) - fitPenalty;
        if (!best || score > best.score) {
          best = {
            score: score,
            rect: { x: left * k, y: top * k, w: modalW * k, h: modalH * k },
            anchors: { red: { x: R.cx * k, y: R.cy * k }, gold: { x: G.cx * k, y: G.cy * k } }
          };
        }
      }
    }
    if (!best || best.score < 0.15) return null;

    // ---- FULL-RES anchor refine ----
    // The coarse anchors are downsampled blob CENTROIDS (glow / the gold level digit
    // drag them off the diamond centers). Re-locate each diamond precisely: crop a
    // window around the coarse anchor at full resolution, find the largest matching
    // blob, take ITS centroid. The diamond dwarfs any digit in the window.
    function refine(anchor, wantClass, winHalf) {
      var rect = { x: anchor.x - winHalf, y: anchor.y - winHalf, w: winHalf * 2, h: winHalf * 2 };
      var x0 = Math.max(0, Math.round(rect.x)), y0 = Math.max(0, Math.round(rect.y));
      var sub = crop(img, rect);
      // work at ≤200px for speed; blob centroid maps back through the sub-scale
      var subSmall = downsample(sub, 200);
      var blobs = findBlobs(subSmall, wantClass, 0.40, 0.22);
      if (!blobs.length) return anchor;
      var b = blobs[0];
      return { x: x0 + b.cx * subSmall.scale, y: y0 + b.cy * subSmall.scale };
    }
    var coarseGap = best.anchors.gold.y - best.anchors.red.y;
    var winHalf = Math.max(24, coarseGap * 0.45);
    var redC = refine(best.anchors.red, "red", winHalf);
    var goldC = refine(best.anchors.gold, "gold", winHalf);
    // rebuild the panel rect from the REFINED centers (the modal model)
    var gap = goldC.y - redC.y;
    if (gap > 4) {
      var modalH2 = gap / SIG.GAP_RATIO, modalW2 = modalH2 * SIG.ASPECT;
      var cx2 = (redC.x + goldC.x) / 2;
      best.rect = { x: cx2 - SIG.RED_X * modalW2, y: redC.y - SIG.RED_Y * modalH2, w: modalW2, h: modalH2 };
      best.anchors = { red: redC, gold: goldC };
    }

    // clamp to the frame
    var r = best.rect;
    var x0c = Math.max(0, r.x), y0c = Math.max(0, r.y);
    var x1c = Math.min(img.width, r.x + r.w), y1c = Math.min(img.height, r.y + r.h);
    return { rect: { x: x0c, y: y0c, w: x1c - x0c, h: y1c - y0c }, method: "hue", score: Math.max(0, Math.min(1, best.score)), anchors: best.anchors };
  }

  // Anchor-derived geometry: everything the parser samples, positioned from the
  // MEASURED red/gold diamond centers (gap = their vertical distance). All ratios in
  // GAP units, measured against the refined centers on the real samples — this makes
  // the wheel and the outcome row independent of crop margins entirely.
  //   W/E nodes: vertical midpoint, ±0.70·gap horizontally.
  //   outcome icon row: 0.975·gap below the gold node; icons at cx + {-1.39,-0.47,
  //   +0.46,+1.39}·gap. Reroll pill center ≈ (cx + 2.30·gap, gold.y + 0.956·gap).
  function wheelGeometry(anchors) {
    var gap = anchors.gold.y - anchors.red.y;
    var cx = (anchors.red.x + anchors.gold.x) / 2;
    var cy = (anchors.red.y + anchors.gold.y) / 2;
    var iconY = anchors.gold.y + 0.975 * gap;
    return {
      gap: gap,
      nodeN: { x: anchors.red.x, y: anchors.red.y },
      nodeS: { x: anchors.gold.x, y: anchors.gold.y },
      nodeW: { x: cx - 0.70 * gap, y: cy },
      nodeE: { x: cx + 0.70 * gap, y: cy },
      outIconY: iconY,
      outIconXs: [cx - 1.39 * gap, cx - 0.47 * gap, cx + 0.46 * gap, cx + 1.39 * gap],
      rerollPill: { x: cx + 2.30 * gap, y: anchors.gold.y + 0.956 * gap }
    };
  }

  // Whole-image shortcut: an already-cropped modal (all three real samples) has aspect
  // ≈ 0.88-0.94 and its own red/gold pair at the expected relative spot. Anchors ride
  // along in every path (null only on the blind assume-whole fallback).
  function panelOrWhole(img) {
    var aspect = img.width / img.height;
    var found = findPanel(img);
    if (found) {
      // if the found rect ≈ the whole image, treat as whole (higher confidence)
      var r = found.rect;
      var cover = (r.w * r.h) / (img.width * img.height);
      if (cover > 0.82 && aspect > 0.84 && aspect < 0.98) {
        return { rect: { x: 0, y: 0, w: img.width, h: img.height }, method: "whole+hue", score: Math.max(found.score, 0.9), anchors: found.anchors };
      }
      return found;
    }
    if (aspect > 0.84 && aspect < 0.98) {
      return { rect: { x: 0, y: 0, w: img.width, h: img.height }, method: "assume-whole", score: 0.4, anchors: null };
    }
    return null;
  }

  // ---- the panel-normalized region model ----
  // Fractions of the PANEL rect (x, y, w, h). Seeded from the session's image reads;
  // tools/dump-structural.js re-measures and these constants get updated from evidence.
  var ROI = {
    gemName:   { x: 0.15, y: 0.155, w: 0.70, h: 0.055 },
    points:    { x: 0.28, y: 0.208, w: 0.44, h: 0.042 },
    // wheel node centers (points, not rects)
    nodeN:     { cx: 0.494, cy: 0.398 },
    nodeW:     { cx: 0.355, cy: 0.478 },
    nodeE:     { cx: 0.635, cy: 0.478 },
    nodeS:     { cx: 0.494, cy: 0.578 },
    // level-text bands under/inside each node
    lvlN:      { x: 0.42, y: 0.408, w: 0.15, h: 0.035 },
    lvlW:      { x: 0.28, y: 0.487, w: 0.16, h: 0.035 },
    lvlE:      { x: 0.56, y: 0.487, w: 0.16, h: 0.035 },
    lvlS:      { x: 0.42, y: 0.588, w: 0.15, h: 0.035 },
    divider:   { x: 0.10, y: 0.645, w: 0.80, h: 0.045 },
    // outcome columns: icon centers + caption bands
    outIconY:  0.728,
    outIconXs: [0.243, 0.410, 0.578, 0.746],
    outText:   [
      { x: 0.135, y: 0.700, w: 0.215, h: 0.075 },
      { x: 0.305, y: 0.700, w: 0.215, h: 0.075 },
      { x: 0.470, y: 0.700, w: 0.215, h: 0.075 },
      { x: 0.640, y: 0.700, w: 0.215, h: 0.075 }
    ],
    rerollPill:{ x: 0.845, y: 0.705, w: 0.135, h: 0.040 },
    costRow:   { x: 0.10, y: 0.800, w: 0.80, h: 0.042 },
    balanceRow:{ x: 0.10, y: 0.842, w: 0.80, h: 0.042 },
    processBtn:{ x: 0.50, y: 0.925, w: 0.46, h: 0.055 }
  };

  function roiRect(panel, key) {
    var r = ROI[key];
    return { x: panel.x + r.x * panel.w, y: panel.y + r.y * panel.h, w: r.w * panel.w, h: r.h * panel.h };
  }
  function roiPoint(panel, key) {
    var r = ROI[key];
    return { x: panel.x + r.cx * panel.w, y: panel.y + r.cy * panel.h };
  }

  // ---- chroma-mask binarization (colored text on dark art) ----
  // Returns a NEW raster: white where the predicate matches, black elsewhere —
  // exactly what a whitelist OCR pass wants.
  function chromaMask(img, pred) {
    var out = new Uint8ClampedArray(img.data.length);
    for (var i = 0; i < img.data.length; i += 4) {
      var keep = pred(img.data[i], img.data[i + 1], img.data[i + 2]);
      var v = keep ? 0 : 255;      // dark text on white bg (Tesseract's preference)
      out[i] = v; out[i + 1] = v; out[i + 2] = v; out[i + 3] = 255;
    }
    return { width: img.width, height: img.height, data: out };
  }
  // Common predicates
  function isGoldText(r, g, b) { var c = hsv(r, g, b); return c.h >= 30 && c.h < 60 && c.s > 0.45 && c.v > 0.55; }
  function isWhiteText(r, g, b) { var c = hsv(r, g, b); return c.s < 0.25 && c.v > 0.72; }
  function isGreenUp(r, g, b) { var c = hsv(r, g, b); return c.h >= 75 && c.h < 150 && c.s > 0.45 && c.v > 0.45; }
  function isRedDown(r, g, b) { var c = hsv(r, g, b); return (c.h < 18 || c.h >= 345) && c.s > 0.45 && c.v > 0.40; }

  // Pixel-count + centroid for a predicate — the ▲/▼ detector (color, not glyph).
  function colorClusterStats(img, pred) {
    var n = 0, sx = 0, sy = 0;
    for (var y = 0; y < img.height; y++) {
      for (var x = 0; x < img.width; x++) {
        var i = (y * img.width + x) * 4;
        if (pred(img.data[i], img.data[i + 1], img.data[i + 2])) { n++; sx += x; sy += y; }
      }
    }
    return { count: n, cx: n ? sx / n : 0, cy: n ? sy / n : 0, frac: n / (img.width * img.height) };
  }

  // ---- exports ----
  var API = {
    downsample: downsample,
    crop: crop,
    hsv: hsv,
    hueClass: hueClass,
    medianPatch: medianPatch,
    findBlobs: findBlobs,
    findPanel: findPanel,
    panelOrWhole: panelOrWhole,
    wheelGeometry: wheelGeometry,
    ROI: ROI,
    SIG: SIG,
    roiRect: roiRect,
    roiPoint: roiPoint,
    chromaMask: chromaMask,
    isGoldText: isGoldText,
    isWhiteText: isWhiteText,
    isGreenUp: isGreenUp,
    isRedDown: isRedDown,
    colorClusterStats: colorClusterStats
  };

  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else { root.OcrLayout = API; }
})(typeof globalThis !== "undefined" ? globalThis : this);
