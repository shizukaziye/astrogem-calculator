/**
 * ocr/structural-engine.js — the FREE-tier screenshot parser ("structural").
 *
 * Philosophy (measured, not guessed — see samples/README.md): Tesseract reads the
 * plain-background footer at ~100% and fails on everything painted over the nebula
 * art; but the art regions are rigidly structured and COLOR-CODED. So this engine
 * reads STRUCTURE first and uses OCR only where it is strong:
 *
 *   panel + wheel      ocr/layout.js — the red-over-gold diamond signature, refined
 *                      to true centers; every sample point derives from the anchors.
 *   outcome targets    icon hue, SELF-CALIBRATED against the same image's own W/E
 *                      diamond colors (no global effect→hue table needed).
 *   outcome direction  green-▲ / red-▼ pixel clusters (color, not glyph — the "▲
 *                      reads as A" failure mode disappears).
 *   outcome kind/amt   micro-OCR of the caption band through a white/gold chroma
 *                      mask at 3-4× upscale, keyword lexicon + digit whitelist.
 *   wheel levels       gold-chroma mask + digit whitelist, cross-checked against
 *                      the "N Astrogem Points" level sum (a free checksum).
 *   gem name/rarity    name-band OCR → GEM_NAME_COST suffix (tesseract-engine's
 *                      table) + Order/Chaos keyword; rarity from Process (x/N).
 *   footer             plain-background OCR: Process (x/N), Processing Cost, and
 *                      the ROI-scoped free-reroll pill (emitted as
 *                      rerollsShownFree/-Denom per the constraintSnap contract).
 *
 * The core (parseStructural) is environment-agnostic: it consumes a raw RGBA raster
 * and an injected async `ocrFn(raster, {whitelist, psm}) -> {text, conf}` so the
 * browser (canvas + CDN Tesseract) and Node (sharp + tesseract.js, via
 * tools/eval-ocr.js) run the IDENTICAL decision logic.
 *
 * Emits the full per-field confidence map (see ocr/engine.js constraintSnap).
 */
(function (root) {
  "use strict";
  var IS_NODE = typeof module !== "undefined" && module.exports;
  var L = IS_NODE ? require("./layout.js") : root.OcrLayout;
  var ENGINE_API = IS_NODE ? require("./engine.js") : (root.OcrEngineAPI || root);
  var TESS = IS_NODE ? require("./tesseract-engine.js") : (root.OcrTesseractEngine || root);
  var GLYPHS = null;
  try { GLYPHS = IS_NODE ? require("./glyphs.js").GLYPH_ATLAS : (root.OcrGlyphs && root.OcrGlyphs.GLYPH_ATLAS); } catch (e) {}

  var GEM_NAME_COST = (TESS && TESS.GEM_NAME_COST) || {
    stability: 8, corrosion: 8, solidity: 9, distortion: 9, immutability: 10, destruction: 10
  };
  function normText(s) {
    if (TESS && typeof TESS.normalizeOcrText === "function") return TESS.normalizeOcrText(s);
    return String(s || "");
  }

  // ---------------------------------------------------------------------------
  // the core parse
  // ---------------------------------------------------------------------------
  function upscale(raster, factor) {
    // nearest-neighbor upscale (crisp glyph edges beat smooth for masked OCR)
    var f = Math.max(1, Math.round(factor));
    if (f === 1) return raster;
    var w = raster.width * f, h = raster.height * f;
    var out = new Uint8ClampedArray(w * h * 4);
    for (var y = 0; y < h; y++) {
      var sy = (y / f) | 0;
      for (var x = 0; x < w; x++) {
        var si = ((sy * raster.width) + ((x / f) | 0)) * 4, di = (y * w + x) * 4;
        out[di] = raster.data[si]; out[di + 1] = raster.data[si + 1];
        out[di + 2] = raster.data[si + 2]; out[di + 3] = 255;
      }
    }
    return { width: w, height: h, data: out };
  }

  function rectAround(p, halfW, halfH) { return { x: p.x - halfW, y: p.y - halfH, w: halfW * 2, h: halfH * 2 }; }

  // 1px dilation of the dark (text) pixels in a black-on-white mask — reconnects
  // strokes that antialiasing broke on downscaled captures before micro-OCR retries.
  function dilateDark(img) {
    var w = img.width, h = img.height, src = img.data;
    var out = new Uint8ClampedArray(src.length);
    out.set(src);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = (y * w + x) * 4;
        if (src[i] < 128) continue;
        var dark = false;
        for (var dy = -1; dy <= 1 && !dark; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            var nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (src[(ny * w + nx) * 4] < 128) { dark = true; break; }
          }
        }
        if (dark) { out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; }
      }
    }
    return { width: w, height: h, data: out };
  }

  // hue distance on the circle
  function hueDist(a, b) { var d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

  async function parseStructural(raster, ocrFn) {
    var confidence = { config: {}, state: {}, outcomes: [0, 0, 0, 0] };
    var out = { config: {}, state: {}, outcomes: [], rarity: null, confidence: confidence };

    var found = L.panelOrWhole(raster);
    if (!found) {
      // not a Processing screenshot (or unrecognizable) — return an empty parse; the
      // snap will default everything at confidence 0 and the UI highlights it all.
      out.outcomes = [];
      out._debug = { panel: null };
      return out;
    }
    // Four-landmark wheel fit BEFORE anything else: the coarse two-blob anchors can
    // come in with the gap squeezed 15-20% (glow-biased centroids), which mis-scales
    // the normalization AND every anchor-relative region. fitWheel cross-validates
    // two independent rulers (red↔gold vertical vs W↔E horizontal) and keeps the
    // originals when they disagree.
    if (found.anchors && L.fitWheel) {
      found.anchors = L.fitWheel(raster, found.anchors);
    }

    // ---- resolution normalization ----
    // The red→gold wheel distance is the game-UI ruler: it scales 1:1 with however
    // the capture was rendered (720p crop, 1440p, 4K, windowed). Crop to the panel
    // (bounds memory on huge frames), then resample so that distance equals the
    // canonical gap every read below was calibrated at. Any resolution in, ONE
    // effective resolution internally.
    var CANON_GAP = 246;
    var g0 = found.anchors
      ? (found.anchors.gold.y - found.anchors.red.y)
      : found.rect.h * L.SIG.GAP_RATIO;
    var fRaw = CANON_GAP / Math.max(8, g0);
    // snap to coarse steps: fractional factors (e.g. 1.99) interpolate EVERY row and
    // blur thin glyphs below the chroma-mask thresholds; integer factors copy rows.
    // Oversized captures barely need downscaling (bigger glyphs read fine — the
    // resample exists to bound compute on 4K+), so the no-resample zone is wide.
    var scaleF = fRaw <= 0.65 ? 0.5 : fRaw <= 1.25 ? 1 : Math.min(3, Math.round(fRaw));
    {
      // crop with a margin so edge regions (reroll pill, footer buttons) survive
      var mg = 0.06;
      var cr = {
        x: found.rect.x - found.rect.w * mg, y: found.rect.y - found.rect.h * mg,
        w: found.rect.w * (1 + 2 * mg), h: found.rect.h * (1 + 2 * mg)
      };
      // L.crop rounds+clamps the origin — mirror it so coordinate shifts stay exact
      var ox = Math.max(0, Math.round(cr.x)), oy = Math.max(0, Math.round(cr.y));
      raster = L.crop(raster, cr);
      var sh2 = function (p) { return { x: (p.x - ox) * scaleF, y: (p.y - oy) * scaleF }; };
      if (Math.abs(scaleF - 1) > 0.04) raster = L.upscaleBilinear(raster, scaleF);
      else scaleF = 1;
      found = {
        rect: {
          x: (found.rect.x - ox) * scaleF, y: (found.rect.y - oy) * scaleF,
          w: found.rect.w * scaleF, h: found.rect.h * scaleF
        },
        method: found.method + (scaleF !== 1 ? "+norm" + scaleF.toFixed(2) : ""),
        score: found.score,
        anchors: found.anchors ? { red: sh2(found.anchors.red), gold: sh2(found.anchors.gold) } : null
      };
    }
    var panel = found.rect;
    var geo = found.anchors ? L.wheelGeometry(found.anchors) : null;
    var panelConf = found.score;
    out._debug = { panel: found };

    function roiCrop(key) { return L.crop(raster, L.roiRect(panel, key)); }
    async function ocrText(sub, opts) {
      try { var r = await ocrFn(sub, opts || {}); return { text: r.text || "", conf: r.conf != null ? r.conf : 0.5 }; }
      catch (e) { return { text: "", conf: 0 }; }
    }
    // masked micro-OCR: crop → chroma mask → upscale → OCR
    async function maskedOcr(rect, pred, opts) {
      var sub = L.crop(raster, rect);
      var masked = L.chromaMask(sub, pred);
      var scale = Math.max(2, Math.min(4, Math.round(120 / Math.max(1, sub.height))));
      var r = await ocrText(upscale(masked, scale), opts);
      if (out._debug) {
        (out._debug.reads = out._debug.reads || []).push({
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) },
          wl: (opts && opts.whitelist) || "", psm: (opts && opts.psm) || 6,
          text: String(r.text || "").replace(/\n/g, "\\n").slice(0, 70), conf: Math.round(r.conf * 100) / 100
        });
      }
      return r;
    }
    function whiteOrGold(r, g, b) { return L.isWhiteText(r, g, b) || L.isGoldText(r, g, b); }
    // caption cells mix white names, chartreuse amounts, and gold ("Points +1") text
    function captionText(r, g, b) { return L.isWhiteText(r, g, b) || L.isGoldText(r, g, b) || L.isAmountText(r, g, b); }

    // ---- wheel geometry FIRST: every text region derives from the anchors ----
    // Panel-fraction ROIs died on the 2026-07-16 corpus (different crop framings drift
    // them off-target); the wheel anchors are the only invariant. cx/redY/goldY + gap
    // place everything: gem name at redY−1.39·gap, points at −1.10·gap, the footer
    // block from goldY+1.15·gap down (measured on the dev corpus, verified on the
    // low-res corpus).
    var nodes = geo ? geo : {
      nodeN: L.roiPoint(panel, "nodeN"), nodeW: L.roiPoint(panel, "nodeW"),
      nodeE: L.roiPoint(panel, "nodeE"), nodeS: L.roiPoint(panel, "nodeS"),
      gap: panel.h * L.SIG.GAP_RATIO
    };
    var gap = nodes.gap;
    var cx = nodes.nodeN.x, redY = nodes.nodeN.y, goldY = nodes.nodeS.y;
    function bandRect(cy, halfHGap, halfWGap) {
      return { x: cx - halfWGap * gap, y: cy - halfHGap * gap, w: halfWGap * 2 * gap, h: halfHGap * 2 * gap };
    }
    // Template read: segment a rect through `pred` and match every glyph box against
    // the harvested atlas (ocr/glyphs.js — pictures of the game's own font). No OCR:
    // pixel comparison with an honest margin-based confidence. Returns labeled boxes
    // left-to-right, or null when no atlas is loaded.
    function templateGlyphs(rect, pred) {
      if (!GLYPHS) return null;
      var sub = L.crop(raster, rect);
      var mask = L.chromaMask(sub, pred);
      var boxes = L.segmentGlyphs(mask, { minColPx: 1, gapCols: 1 });
      var hs = boxes.map(function (b) { return b.h; }).sort(function (a, b) { return a - b; });
      var medH = hs.length ? hs[hs.length >> 1] : 0;
      boxes = boxes.filter(function (b) { return b.h >= medH * 0.55 && b.h <= medH * 1.7 && b.w >= 2; });
      var items = boxes.map(function (b) {
        var m = L.matchGlyph(mask, b, GLYPHS);
        return { box: b, ch: m ? m.ch : null, score: m ? m.score : 0, margin: m ? m.margin : 0 };
      });
      items.mask = mask;   // for closed-world rematches against a restricted atlas
      return items;
    }
    // digit-only subset of the atlas (closed-world rematch when a box is known to be
    // a digit by POSITION — e.g. the boxes before "Astrogem" in the points header)
    var DIGIT_ATLAS = null;
    if (GLYPHS) {
      DIGIT_ATLAS = {};
      Object.keys(GLYPHS).forEach(function (k) { if (/^[0-9]$/.test(k)) DIGIT_ATLAS[k] = GLYPHS[k]; });
    }
    // Closed-world digit match scored by INK IoU (intersection/union of on-pixels).
    // bitmapSim's mean-abs-diff is dominated by the empty background, so every sparse
    // glyph scores ~0.7 and a narrow '1' ties a wide '7'; IoU only counts ink, so a
    // width mismatch collapses the score. Used where a box is a digit BY POSITION.
    function iouDigit(mask, box, allowed) {
      var bm = L.glyphBitmap(mask, box), scored = [];
      Object.keys(DIGIT_ATLAS).forEach(function (k) {
        if (allowed && allowed.indexOf(k) === -1) return;
        var t = DIGIT_ATLAS[k], inter = 0, uni = 0;
        for (var i = 0; i < bm.length; i++) {
          var a = bm[i] >= 0.5, b = t[i] >= 0.4;
          if (a && b) inter++;
          if (a || b) uni++;
        }
        scored.push({ ch: k, score: uni ? inter / uni : 0 });
      });
      scored.sort(function (p, q) { return q.score - p.score; });
      var best = scored[0];
      if (best) { best.margin = best.score - (scored[1] ? scored[1].score : 0); best.top3 = scored.slice(0, 3).map(function (s) { return s.ch + ":" + s.score.toFixed(2); }).join(","); }
      return best;
    }
    // Best confidently-matched GOLD digit (g1..g5) in a line. BEST-of, not last-of:
    // a gold frame sliver trailing the line segments as its own box and matches "4"
    // (diagonals do) — the true digit outscores it.
    function lastGoldDigit(rect, pred, maxVal) {
      var tl = templateGlyphs(rect, pred);
      if (!tl) return null;
      var best = null;
      for (var i = 0; i < tl.length; i++) {
        var t = tl[i];
        if (t.ch && /^[1-5]$/.test(t.ch) && t.score >= 0.78 && t.margin >= 0.03) {
          var v = parseInt(t.ch, 10);
          if (maxVal && v > maxVal) continue;
          if (!best || t.score >= best.score) best = { score: t.score, margin: t.margin, v: v };
        }
      }
      if (!best) return null;
      return { value: best.v, conf: (best.score >= 0.86 && best.margin >= 0.06) ? 0.95 : 0.85 };
    }

    // Self-locate a text line in a zone, then return a padded OCR rect. Fixed offsets
    // from the (noisy) anchors proved brittle across capture variants — line-locating
    // inside a generous zone is the pattern that made the wheel levels robust.
    function locateLine(zone, pred, opts) {
      var line = L.findMaskedTextLine(raster, zone, pred, opts);
      if (!line) return null;
      var grow = Math.round(line.h * 0.45);
      return { x: line.x - grow, y: line.y - grow, w: line.w + grow * 2, h: line.h + grow * 2, _line: line };
    }
    function lineOpts(minWGap, maxWGap, centerTolGap) {
      return {
        maxRowFill: 0.6, minH: Math.max(4, Math.round(gap * 0.05)), maxH: Math.round(gap * 0.24),
        // a high row threshold: sparkle/glow rows (~10px) must not bridge separate
        // elements (gem icon ↔ name line) into one over-tall rejected band
        minRowPx: Math.max(4, Math.round(gap * 0.10)), rejectFill: 0.45,
        accept: function (r) {
          var c = r.x + r.w / 2;
          return Math.abs(c - cx) <= gap * centerTolGap && r.w >= gap * minWGap && r.w <= gap * maxWGap;
        }
      };
    }

    // ---- footer: Process (x/N) — anchored tight button first, block fallback ----
    // OCR confusions to survive (all observed): "(" reads as a glued "1" ("(4/7)" →
    // "14/7"), "/" reads as ":" or "." — so capture the SINGLE digit adjacent to the
    // separator and accept the separator class loosely. N can only be 5/7/9.
    function parseProcPair(text) {
      // take the LAST valid pair — the Process button is the bottom-most row
      var re = /(\d)\s*[:\/l|.]\s*(\d)\s*[\)\]]?/g, m, best = null;
      var t = normText(text);
      while ((m = re.exec(t))) {
        var a = parseInt(m[1], 10), b = parseInt(m[2], 10);
        if (a >= 0 && a <= 9 && (b === 5 || b === 7 || b === 9) && a <= b) best = { a: a, b: b };
      }
      return best;
    }
    // Two independent reads, then a vote: A = the LOCATED Process-button line (its
    // distance below the gold node wobbles ~2.2-2.5·gap with crop padding — locate,
    // don't fix), B = the whole footer down to the panel bottom (position-free
    // rescue). Agree → high conf; disagree → A wins but flagged.
    // The FIND mask is looser than the read mask: upscaled glyphs keep only a sparse
    // bright skeleton (5-17 px/row at ×2), so v>0.6 + a low row threshold or no band
    // ever forms (this was every "turn read at 0.70" flag).
    var dimBtnWhite = function (r, g, b) { var c = L.hsv(r, g, b); return c.s < 0.3 && c.v > 0.6; };
    var btnZone = { x: cx + gap * 0.2, y: goldY + gap * 1.95, w: gap * 2.15, h: gap * 0.75 };
    var btnRect = locateLine(btnZone, dimBtnWhite, {
      maxRowFill: 0.75, minH: Math.max(4, Math.round(gap * 0.05)), maxH: Math.round(gap * 0.24),
      minRowPx: Math.max(4, Math.round(gap * 0.04)),
      accept: function (r) { return r.w >= gap * 0.5; }
    });
    var procRead = await maskedOcr(
      btnRect || { x: cx + gap * 0.2, y: goldY + gap * 2.13, w: gap * 2.15, h: gap * 0.3 },
      dimBtnWhite, { psm: 7 });
    var pairA = parseProcPair(procRead.text);
    // vote T: template-match the located line — the last two confident digits are
    // (x, N); "Process" letters are distractor classes and can't leak in
    var pairT = null;
    if (btnRect) {
      var tg = templateGlyphs(btnRect, dimBtnWhite);
      if (tg) {
        var ds = tg.filter(function (t) { return t.ch && /^\d$/.test(t.ch) && t.score >= 0.8 && t.margin >= 0.02; });
        if (ds.length >= 2) {
          var a3 = parseInt(ds[ds.length - 2].ch, 10), b3 = parseInt(ds[ds.length - 1].ch, 10);
          if ((b3 === 5 || b3 === 7 || b3 === 9) && a3 >= 1 && a3 <= b3) pairT = { a: a3, b: b3 };
        }
      }
    }
    var footTop = goldY + gap * 1.13;
    var footRead = await maskedOcr(
      { x: cx - gap * 2.35, y: footTop, w: gap * 4.7, h: Math.max(gap * 0.6, panel.y + panel.h - footTop - 2) },
      L.isWhiteText, { psm: 6 });
    var footText = normText(footRead.text);
    var pairB = parseProcPair(footText);
    function pairEq(p, q) { return p && q && p.a === q.a && p.b === q.b; }
    var pair = null, pairConf = 0;
    if (pairT && (pairEq(pairT, pairA) || pairEq(pairT, pairB))) { pair = pairT; pairConf = 0.96; }
    else if (pairEq(pairA, pairB)) { pair = pairA; pairConf = 0.95; }
    else if (pairT) { pair = pairT; pairConf = 0.88; }
    else if (pairA && pairB) { pair = pairA; pairConf = 0.6; }
    else if (pairA) { pair = pairA; pairConf = 0.85; }
    else if (pairB) { pair = pairB; pairConf = 0.7; }
    var turnsRemaining = pair ? pair.a : null, maxT = pair ? pair.b : null;
    out.rarity = maxT === 5 ? "uncommon" : maxT === 7 ? "rare" : maxT === 9 ? "epic" : null;
    out.state.maxTurns = maxT;
    out.state.turnsRemaining = turnsRemaining;
    confidence.state.rarity = maxT != null ? pairConf : 0;
    confidence.state.currentTurn = turnsRemaining != null ? pairConf : 0;

    // Processing Cost: prefer the word-anchored number; fall back to the bare cost
    // tokens (450 / 900 / 1800 are the only possible values; OCR renders 1,800 as
    // "1.800"/"1,800"/"1800")
    var costM = footText.match(/cost\D{0,12}?([\d.,]{3,7})/i);
    var cval = null;
    if (costM) {
      var cv = parseInt(costM[1].replace(/[.,]/g, ""), 10);
      if (cv >= 100 && cv <= 9999) cval = cv;
    }
    if (cval == null) {
      var tokM = footText.match(/(^|\D)(450|900|1[.,]?800)(\D|$)/);
      if (tokM) cval = parseInt(tokM[2].replace(/[.,]/g, ""), 10);
    }
    if (cval != null) { out.state.processCost = cval; confidence.state.processCostMultiplier = 0.9; }
    if (out.state.processCost == null) confidence.state.processCostMultiplier = 0.3;

    // ---- reroll pill (ROI-scoped: the "Reset (1/1)" trap can't reach here) ----
    // The pill's full state machine (Shizu, 2026-07-17):
    //   "2/2" greyed  = turn 1 (nothing spent; the DIM text defeated the old white
    //                   mask — this was "rerolls never parse")
    //   "n/m" bright  = free rerolls remaining
    //   gold Charge   = free spent, PAID reroll purchasable  -> model 1
    //   grey Charge   = paid reroll ALSO spent               -> model 0
    var pillRect = geo
      ? rectAround(geo.rerollPill, geo.gap * 0.42, geo.gap * 0.14)
      : L.roiRect(panel, "rerollPill");
    var pillRead = await maskedOcr(pillRect, dimBtnWhite, { whitelist: "0123456789/", psm: 7 });
    var pillM = pillRead.text.match(/(\d)\s*\/\s*(\d)/);
    if (pillM) {
      var pa = parseInt(pillM[1], 10), pb = parseInt(pillM[2], 10);
      // rerolls STACK past the denominator (reroll_increase outcomes): 3/2, 5/2…
      // are legal — only the denominator is rarity-bounded (1 or 2)
      if (pa <= 9 && (pb === 1 || pb === 2)) {
        out.state.rerollsShownFree = pa;
        out.state.rerollsShownDenom = pb;
        confidence.state.rerollsRemaining = 0.9;
      }
    }
    if (out.state.rerollsShownFree == null) {
      // template rescue: the pill is "n / m" in the footer font
      var tgR = templateGlyphs(pillRect, dimBtnWhite);
      if (tgR) {
        var digsR = tgR.filter(function (t) { return t.ch && /^[\d\/]$/.test(t.ch) && t.score >= 0.8; });
        if (digsR.length === 3 && digsR[1].ch === "/" && /^\d$/.test(digsR[0].ch) && /^\d$/.test(digsR[2].ch)) {
          var rn = parseInt(digsR[0].ch, 10), rd = parseInt(digsR[2].ch, 10);
          if (rn <= 9 && (rd === 1 || rd === 2)) {   // stacked counters (3/2…) are legal
            out.state.rerollsShownFree = rn;
            out.state.rerollsShownDenom = rd;
            confidence.state.rerollsRemaining = 0.85;
          }
        }
      }
    }
    if (out.state.rerollsShownFree == null) {
      // Charge states: confirm the WORD (any brightness), then the BUTTON COLOR
      // decides — gold = paid reroll purchasable (1), grey = paid spent (0).
      var pillCrop = L.crop(raster, pillRect);
      var goldBtn = L.colorClusterStats(pillCrop, function (r, g, b) {
        var c = L.hsv(r, g, b); return c.h >= 30 && c.h < 55 && c.s > 0.45 && c.v > 0.5;
      });
      var chRead = await maskedOcr(pillRect, dimBtnWhite, { psm: 7 });
      var chWord = /charg|harge|chorge/i.test(normText(chRead.text));
      if (goldBtn.frac > 0.35) {
        out.state.rerollsChargeSeen = true;                       // gold face is decisive
        confidence.state.rerollsRemaining = 0.85;
      } else if (chWord) {
        out.state.rerollsChargeSpent = true;                      // grey Charge
        confidence.state.rerollsRemaining = 0.8;
      }
    }
    if (out.state.rerollsShownFree == null && !out.state.rerollsChargeSeen && !out.state.rerollsChargeSpent) {
      confidence.state.rerollsRemaining = 0.25;
    }

    // ---- gem name → gemType + baseCost (suffix table) ----
    // Fixed band primary (best measured); if it produces neither the type keyword nor
    // a suffix, retry on a LOCATED line — the name is the only long SATURATED text
    // above the wheel (the gem icon is saturated too but half as wide).
    var namePred = function (r, g, b) { var c = L.hsv(r, g, b); return c.v > 0.45 && c.s > 0.15; };
    var nameRead = await maskedOcr(bandRect(redY - gap * 1.39, 0.17, 1.95), namePred, { psm: 7 });
    if (!/chaos|order/i.test(nameRead.text)) {
      var isNameText = function (r, g, b) { var c = L.hsv(r, g, b); return c.s > 0.28 && c.v > 0.5; };
      var nameZone = { x: cx - gap * 2.0, y: redY - gap * 1.80, w: gap * 4.0, h: gap * 0.85 };
      var nameRect = locateLine(nameZone, isNameText, lineOpts(0.95, 3.4, 0.6));
      if (nameRect) {
        var nameRead2 = await maskedOcr(nameRect, namePred, { psm: 7 });
        if (/chaos|order/i.test(nameRead2.text)) nameRead = nameRead2;
      }
    }
    var nameText = normText(nameRead.text).toLowerCase();
    out.config.gemType = /chaos/.test(nameText) ? "chaos" : (/order/.test(nameText) ? "order" : null);
    confidence.config.gemType = out.config.gemType ? 0.9 : 0;
    var suffixHit = null;
    Object.keys(GEM_NAME_COST).forEach(function (sfx) {
      if (nameText.indexOf(sfx) !== -1) suffixHit = sfx;
    });
    if (!suffixHit) {
      // fuzzy: strip non-letters and look for a 4+char substring of a known suffix
      var letters = nameText.replace(/[^a-z]/g, "");
      Object.keys(GEM_NAME_COST).forEach(function (sfx) {
        if (suffixHit) return;
        for (var k = 0; k + 5 <= sfx.length; k++) {
          if (letters.indexOf(sfx.slice(k, k + 5)) !== -1) { suffixHit = sfx; break; }
        }
      });
    }
    if (suffixHit) { out.config.baseCost = GEM_NAME_COST[suffixHit]; confidence.config.baseCost = 0.85; }
    else confidence.config.baseCost = 0;

    // ---- wheel levels (gold digits) + effect hue references ----
    var patchHalf = Math.max(4, gap * 0.06);
    function nodeColor(p) { return L.medianPatch(raster, p.x, p.y, patchHalf); }
    var colW = nodeColor(nodes.nodeW), colE = nodeColor(nodes.nodeE);
    var hueW = L.hsv(colW[0], colW[1], colW[2]).h, hueE = L.hsv(colE[0], colE[1], colE[2]).h;

    // Level text sits INSIDE each diamond (name line(s) then the level line, all
    // centered on the node): W/E render "Lv. N", N and S render a bare gold digit.
    // Instead of committing a single digit per node, we produce a SCORE VECTOR over
    // {1..5} (template similarity to the game's own glyph art) and let the joint
    // constraint solve below pick the assignment. `dilate` retries reconnect strokes
    // that antialiasing broke on downscaled captures.
    // A box is a DIGIT candidate only if its best match over the FULL atlas is a
    // gold digit (g1-5) — otherwise the "L"/"v" of "Lv." spuriously matches g5 and we
    // read the wrong box. Returns the g1-5 score vector + whether it's really a digit.
    // Gold level digits are the SAME glyph shapes as the white footer digits once
    // chroma-masked (color-independent silhouettes), so both match ONE digit template
    // set '0'-'9'. (The separate gold 'g1-g5' templates were a harvest artifact —
    // they'd grabbed the diamond ▲ tip, identical across values, so 1/2/3/4 scored
    // flat and couldn't discriminate.)
    function digitScoreVec(mask, box) {
      var bm = L.glyphBitmap(mask, box), vec = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, top = 0;
      for (var v = 1; v <= 5; v++) {
        var t = GLYPHS && GLYPHS["" + v];
        var s = t ? L.bitmapSim(bm, t) : 0;
        vec[v] = s; if (s > top) top = s;
      }
      var full = GLYPHS ? L.matchGlyph(mask, box, GLYPHS) : null;
      var isDigit = full && /^[1-5]$/.test(full.ch);
      return { vec: vec, top: top, isDigit: isDigit };
    }
    // Read one level node: return the committed digit (template if strong, else the
    // OCR ladder — "Lv. N" isolation is the hard case) AND the raw template score
    // vector (feeds the constraint enumeration for the weak/free nodes below).
    async function readLevelFull(p, isGoldFace) {
      var box = { x: p.x - gap * 0.5, y: p.y - gap * 0.35, w: gap * 1.0, h: gap * 0.72 };
      var line = L.findMaskedTextLine(raster, box, L.isGoldText, {
        rejectFill: 0.22, maxRowFill: 0.6,
        minH: Math.max(4, Math.round(gap * 0.05)), maxH: Math.round(gap * 0.22), minRowPx: 3,
        accept: function (r) { var c = r.x + r.w / 2; return Math.abs(c - p.x) <= gap * 0.28 && r.w >= gap * 0.03 && r.w <= gap * 0.85; }
      });
      if (!line) return { value: null, conf: 0, vec: null };
      var grow = Math.round(line.h * 0.5);
      var lineX = { x: line.x, y: line.y - grow, w: line.w, h: line.h + grow * 2 };

      // template pass: rightmost digit-classified box → value + score vector
      var vec = null, tmVal = null, tmMargin = 0;
      if (GLYPHS) {
        var mask = L.chromaMask(L.crop(raster, lineX), L.isGoldText);
        var boxes = L.segmentGlyphs(mask, { minColPx: 1, gapCols: 1 });
        var hs = boxes.map(function (b) { return b.h; }).sort(function (a, b) { return a - b; });
        var medH = hs.length ? hs[hs.length >> 1] : 0;
        boxes = boxes.filter(function (b) { return b.h >= medH * 0.55 && b.h <= medH * 1.7 && b.w >= 2; });
        var db = null;
        for (var i = 0; i < boxes.length; i++) { var sv = digitScoreVec(mask, boxes[i]); if (sv.isDigit) db = sv; }
        if (db) {
          vec = db.vec;
          var b1 = -1, b1v = null, b2 = -1;
          for (var v = 1; v <= 5; v++) { var s = db.vec[v]; if (s > b1) { b2 = b1; b1 = s; b1v = v; } else if (s > b2) b2 = s; }
          if (b1 >= 0.78 && (b1 - b2) >= 0.05) { tmVal = b1v; tmMargin = b1 - b2; }
        }
      }
      if (tmVal != null) {
        var tconf = Math.min(0.95, 0.75 + tmMargin * 2);
        return { value: tmVal, conf: isGoldFace ? Math.min(tconf, 0.45) : tconf, vec: vec };
      }
      // OCR ladder (proven on "Lv. N"): plain → single-char → dilate
      var read = await maskedOcr(lineX, L.isGoldText, { whitelist: "Lv.12345 ", psm: 7 });
      var m = read.text.match(/([1-5])\s*$/) || read.text.match(/([1-5])/);
      if (!m) { read = await maskedOcr(lineX, L.isGoldText, { whitelist: "12345", psm: 10 }); m = read.text.match(/([1-5])/); }
      if (!m) {
        var sub2 = L.crop(raster, lineX), masked2 = dilateDark(L.chromaMask(sub2, L.isGoldText));
        read = await ocrText(upscale(masked2, Math.max(2, Math.min(5, Math.round(160 / Math.max(1, sub2.height))))), { whitelist: "Lv.12345 ", psm: 7 });
        m = read.text.match(/([1-5])\s*$/) || read.text.match(/([1-5])/);
      }
      var conf = m ? Math.min(0.9, read.conf + 0.2) : 0;
      if (isGoldFace) conf = Math.min(conf, 0.45);
      return { value: m ? parseInt(m[1], 10) : null, conf: conf, vec: vec };
    }
    var lvFull = [
      await readLevelFull(nodes.nodeN, false),   // willpower
      await readLevelFull(nodes.nodeW, false),   // effect1
      await readLevelFull(nodes.nodeE, false),   // effect2
      await readLevelFull(nodes.nodeS, true)     // order (gold-on-gold)
    ];
    var scoreVecs = lvFull.map(function (r) { return r.vec; });
    if (out._debug) out._debug.levelReads = lvFull.map(function (r) { return r.value + "@" + r.conf.toFixed(2); });

    // ---- the points checksum ("N Astrogem Points" = level sum) ----
    // Only a digit sitting directly before "As(trogem)" counts — masked reads on dim
    // captures can mangle the digit while keeping "Points" ('5 re Paints' for
    // "6 Astrogem Points"), so a bare leading-digit grab is NOT trustworthy.
    function extractPts(text) {
      // "Astrogem" OCRs as Astroaem/Actroaem/Asroges… — accept A + s/c after the digit
      var m = normText(text).match(/(\d{1,2})\s*[Aa][sc]/);
      if (!m) return null;
      var v = parseInt(m[1], 10);
      return v >= 4 && v <= 20 ? v : null;
    }
    var ptsRect = bandRect(redY - gap * 1.10, 0.13, 1.55);
    var ptsSub = L.crop(raster, ptsRect);
    // template rung first: leading digit run before the first letter-matched box
    // ("Astrogem" letters are distractor classes)
    var ptsT = null;
    var tgP = templateGlyphs(ptsRect, dimBtnWhite);
    if (out._debug) out._debug.ptsTG = tgP ? tgP.map(function (g) {
      return (g.ch || "?") + ":" + (g.score != null ? g.score.toFixed(2) : "-") + "/" + (g.margin != null ? g.margin.toFixed(2) : "-");
    }).join(" ") : "null";
    var ptsTSoft = false;
    if (tgP) {
      // (a) strict leading-digit run (the original rung — high bar, open world)
      var lead = "", pi = 0;
      for (; pi < tgP.length; pi++) {
        var tpg = tgP[pi];
        if (tpg.ch && /^\d$/.test(tpg.ch) && tpg.score >= 0.86 && tpg.margin >= 0.05) lead += tpg.ch;
        else break;
      }
      var nxt = tgP[pi];
      var nxtDigitish = nxt && nxt.ch && /^\d$/.test(nxt.ch) && nxt.score >= 0.8;
      if (!nxtDigitish && lead.length >= 1 && lead.length <= 2) {
        var pv = parseInt(lead, 10);
        if (pv >= 4 && pv <= 20) ptsT = pv;
      }
      // (b) ANCHORED positional read: if "Astrogem" is recognized (its 'A' + letter
      // tail), the 1-2 boxes BEFORE the 'A' are digits BY CONSTRUCTION — re-match
      // them against DIGITS ONLY (closed world: '+'/'g' lookalikes aren't candidates,
      // so the threshold can drop to what dim strokes actually score).
      if (ptsT == null && DIGIT_ATLAS && tgP.mask) {
        var aIdx = -1;
        for (var ai = 1; ai <= 3 && ai < tgP.length; ai++) {
          if (tgP[ai].ch === "A" && tgP[ai].score >= 0.8) { aIdx = ai; break; }
        }
        if (aIdx >= 1) {
          // verify the letter tail so a random 'A'-ish blob can't anchor: ≥2 of the
          // next 3 boxes must match a letter class decently
          var letterHits = 0;
          for (var li = aIdx + 1; li < Math.min(aIdx + 4, tgP.length); li++) {
            if (tgP[li].ch && /^[a-z]$/i.test(tgP[li].ch) && tgP[li].score >= 0.7) letterHits++;
          }
          if (letterHits >= 2) {
            // CONSTRAINT PROPAGATION: the committed level reads already bound the
            // points value (each unread node contributes 1..5), so match each digit
            // only against the values that keep the total FEASIBLE — a dim '0' no
            // longer loses to a lookalike '9' that would imply an impossible sum.
            var kSum = 0, nUnk = 0;
            for (var ki = 0; ki < 4; ki++) { if (lvFull[ki].value != null) kSum += lvFull[ki].value; else nUnk++; }
            var loP = Math.max(4, kSum + nUnk), hiP = Math.min(20, kSum + 5 * nUnk);
            var digs = "", minSc = 1, constrained = false;
            for (var di = 0; di < aIdx; di++) {
              var dbox = tgP[di].box, dch = null, dsc = 0;
              var allowed = null;
              if (aIdx === 2) {
                if (di === 0) allowed = ["1", "2"];   // two-digit pts is 10..20
                else {
                  allowed = [];
                  var tens = digs === "2" ? 20 : 10;
                  for (var dd = 0; dd <= 9; dd++) { if (tens + dd >= loP && tens + dd <= hiP) allowed.push(String(dd)); }
                }
              } else {
                allowed = [];
                for (var d1 = 4; d1 <= 9; d1++) { if (d1 >= loP && d1 <= hiP) allowed.push(String(d1)); }
              }
              if (!allowed.length) { digs = null; break; }
              if (allowed.length < (aIdx === 2 && di === 0 ? 2 : 6)) constrained = true;
              if (dbox.w / Math.max(1, dbox.h) < 0.45) {
                // the ONLY narrow digit is '1' — aspect alone identifies it (dim thin
                // strokes score weak IoU against the thick averaged templates)
                if (allowed.indexOf("1") === -1) { digs = null; break; }   // narrow but '1' infeasible → bail
                dch = "1"; dsc = 0.6;
              } else {
                var dm = iouDigit(tgP.mask, dbox, allowed);
                if (out._debug) (out._debug.ptsDig = out._debug.ptsDig || []).push(
                  (dm ? dm.top3 : "nomatch") + " w" + dbox.w + "h" + dbox.h + " [" + allowed.join("") + "]");
                if (dm && dm.score >= 0.3) { dch = dm.ch; dsc = dm.score; }
              }
              if (!dch) { digs = null; break; }
              digs += dch; minSc = Math.min(minSc, dsc);
            }
            if (digs && digs.length >= 1 && digs.length <= 2) {
              var pv2 = parseInt(digs, 10);
              if (pv2 >= 4 && pv2 <= 20) {
                ptsT = pv2;
                // dim or constraint-assisted reads keep checksum authority CAPPED:
                // solved levels stay in "confirm me" territory, preserving 0-silent
                ptsTSoft = minSc < 0.5 || constrained;
              }
            }
          }
        }
      }
    }
    function logPtsRead(tag, r) {
      if (out._debug) (out._debug.reads = out._debug.reads || []).push({
        rect: { x: Math.round(ptsRect.x), y: Math.round(ptsRect.y), w: Math.round(ptsRect.w), h: Math.round(ptsRect.h) },
        wl: tag, psm: 7, text: String(r.text || "").replace(/\n/g, "\\n").slice(0, 70),
        conf: Math.round(r.conf * 100) / 100
      });
    }
    // retry ladder, strict extraction at every rung: (t) template digits, (a) white
    // mask OCR, (b) + dilate (downscaled captures thin the strokes), (c) unmasked (dim
    // captures defeat the mask entirely; the digit-before-"As" regex filters the junk)
    var ptsRead = await maskedOcr(ptsRect, L.isWhiteText, { psm: 7 });
    var pts = ptsT != null ? ptsT : extractPts(ptsRead.text);
    if (pts == null) {
      var dRead = await ocrText(
        upscale(dilateDark(L.chromaMask(ptsSub, L.isWhiteText)), Math.max(2, Math.min(4, Math.round(160 / Math.max(1, ptsSub.height))))),
        { psm: 7 });
      logPtsRead("(dilated pts)", dRead);
      pts = extractPts(dRead.text);
    }
    if (pts == null) {
      var scale3 = Math.max(2, Math.min(4, Math.round(160 / Math.max(1, ptsSub.height))));
      var rawRead = await ocrText(upscale(ptsSub, scale3), { psm: 7 });
      logPtsRead("(unmasked pts)", rawRead);
      pts = extractPts(rawRead.text);
    }
    var ptsSoft = ptsT != null && ptsTSoft;   // dim anchored template read → capped authority
    if (pts == null) {
      // last resort on the (cleanest) masked text: digit + one word + "Points". This
      // accepted turn3's WRONG '5 re Points' once — hence it runs only after every
      // strict rung missed, and its checksum authority is capped (ptsSoft) so solved
      // levels stay in "confirm me" territory.
      var rm = normText(ptsRead.text).match(/^[^\dA-Za-z]*(\d{1,2})\s+\S{1,12}\s+[Pp]o?ints?\b/);
      if (rm) {
        var rv = parseInt(rm[1], 10);
        if (rv >= 4 && rv <= 20) { pts = rv; ptsSoft = true; }
      }
    }
    // ---- JOINT LEVEL SOLVE ----
    // The 4 levels are 1-5 and SUM to the header points — a hard constraint that
    // couples the nodes. Pick the assignment maximizing total template score subject
    // to that sum; the unreadable gold-on-gold S digit is then forced by the other
    // three + points, not guessed. Each node's confidence = how much total score
    // you'd sacrifice to change JUST it (constraint-forced => near-certain; two
    // near-tied assignments => flagged). One solver, no special cases.
    function nodeScore(i, v) { return scoreVecs[i] ? (scoreVecs[i][v] || 0) : 0; }
    var indep = lvFull.map(function (r) { return { v: r.value, conf: r.conf }; });
    // PIN every committed read (template OR OCR, any confidence): the constraint must
    // NEVER override a value we actually read — it only FILLS truly-null nodes and
    // resolves a sum mismatch. (Overriding low-conf-but-correct reads was the
    // regression.) A committed read keeps its own confidence unless the checksum
    // confirms it. Free nodes (gold-on-gold S, unreadable blur) are the null ones.
    var pinned = indep.map(function (x) { return x.v != null; });
    var levels = [null, null, null, null], conf4 = [0, 0, 0, 0];
    var freeIdx = [];
    for (var i = 0; i < 4; i++) { if (pinned[i]) { levels[i] = indep[i].v; conf4[i] = indep[i].conf; } else freeIdx.push(i); }

    if (pts != null) {
      var pinnedSum = 0; for (var pI = 0; pI < 4; pI++) if (pinned[pI]) pinnedSum += levels[pI];
      var remaining = pts - pinnedSum;
      if (freeIdx.length === 0) {
        if (remaining === 0) {
          // all four read AND they sum to points: mutually confirmed
          for (var bi = 0; bi < 4; bi++) conf4[bi] = Math.max(conf4[bi], ptsSoft ? 0.85 : 0.92);
        } else {
          // mismatch: one committed read (or points) is wrong — re-solve the
          // LEAST-confident read from the checksum, flag it
          var wi = indep.map(function (x, ii) { return { m: x.conf, ii: ii }; })
            .sort(function (p, q) { return p.m - q.m; })[0].ii;
          var fix = pts - (pinnedSum - levels[wi]);
          if (fix >= 1 && fix <= 5) { levels[wi] = fix; conf4[wi] = ptsSoft ? 0.6 : 0.75; }
          else conf4[wi] = 0.3;
        }
      } else if (freeIdx.length === 1) {
        // exactly one unknown: the constraint DETERMINES it (arithmetic, not a guess);
        // clean solve also confirms the 3 committed siblings
        var fi = freeIdx[0];
        if (remaining >= 1 && remaining <= 5) {
          levels[fi] = remaining;
          var minSib = Math.min.apply(null, [0, 1, 2, 3].filter(function (q) { return q !== fi; }).map(function (q) { return indep[q].conf; }));
          if (!ptsSoft && minSib >= 0.5) {
            conf4[fi] = 0.85;
            for (var sb = 0; sb < 4; sb++) if (sb !== fi) conf4[sb] = Math.max(conf4[sb], 0.85);
          } else conf4[fi] = Math.min(ptsSoft ? 0.65 : 0.9, 0.55 + minSib * 0.4);
        } else { levels[fi] = indep[fi].v != null ? indep[fi].v : 1; conf4[fi] = 0.3; }
      } else {
        // ≥2 unknowns: enumerate their assignments summing to `remaining`, pick the
        // max-template-score one; confidence from the assignment margin per node
        var vals = [1, 2, 3, 4, 5], combos = [];
        (function rec(k, acc, sum) {
          if (k === freeIdx.length) { if (sum === remaining) combos.push(acc.slice()); return; }
          for (var vi = 0; vi < 5; vi++) rec(k + 1, acc.concat(vals[vi]), sum + vals[vi]);
        })(0, [], 0);
        if (combos.length) {
          combos.forEach(function (cm) { cm._s = 0; for (var q = 0; q < freeIdx.length; q++) cm._s += nodeScore(freeIdx[q], cm[q]); });
          combos.sort(function (x, y) { return y._s - x._s; });
          var best = combos[0];
          for (var q2 = 0; q2 < freeIdx.length; q2++) {
            var fidx = freeIdx[q2];
            var alt = -Infinity;
            for (var r = 1; r < combos.length; r++) { if (combos[r][q2] !== best[q2]) { alt = combos[r]._s; break; } }
            levels[fidx] = best[q2];
            if (alt === -Infinity) conf4[fidx] = 0.9;
            else conf4[fidx] = Math.max(0.15, Math.min(0.9, 0.5 + (best._s - alt) * 3.0));
          }
        } else { freeIdx.forEach(function (fi2) { levels[fi2] = indep[fi2].v || 1; conf4[fi2] = 0.3; }); }
      }
    }
    // no points (or unsolved free nodes): fall back to the committed per-node reads
    for (var f = 0; f < 4; f++) if (levels[f] == null) {
      levels[f] = indep[f].v != null ? indep[f].v : 1;
      conf4[f] = indep[f].v == null ? 0 : Math.min(0.85, indep[f].conf);
    }
    if (ptsSoft) conf4 = conf4.map(function (cv) { return Math.min(cv, 0.7); });

    out.config.willpowerLevel = levels[0]; confidence.config.willpowerLevel = conf4[0];
    out.config.effect1Level = levels[1]; confidence.config.effect1Level = conf4[1];
    out.config.effect2Level = levels[2]; confidence.config.effect2Level = conf4[2];
    out.config.orderLevel = levels[3]; confidence.config.orderLevel = conf4[3];
    if (out._debug) out._debug.pts = pts + (ptsSoft ? "(soft)" : "") + " levels=" + levels.join(",");

    // ---- effect NAMES: W/E caption OCR (white serif over art — masked) ----
    // Tall band: 2-line names ("Ally Damage / Enh.") start ~0.28·gap above center; the
    // level line begins ~+0.02·gap, so stop just above it. PSM 6: multi-line.
    // The mask is SLOT-AWARE: the diamond's bright specular highlight is near-white
    // but tinted toward the face hue (W is always green, E always blue) — excluding
    // white-ish pixels tinted toward the known face hue keeps the highlight out of
    // the text mask (this was most of the "Ally Damage" misreads).
    function effectNamePred(faceHue) {
      return function (r, g, b) {
        var c = L.hsv(r, g, b);
        if (!(c.v > 0.62 && c.s < 0.35)) return false;
        if (c.s > 0.12 && hueDist(c.h, faceHue) < 45) return false;   // tinted highlight
        return true;
      };
    }
    async function readEffectName(p, faceHue) {
      var rect = { x: p.x - gap * 0.55, y: p.y - gap * 0.34, w: gap * 1.1, h: gap * 0.36 };
      var read = await maskedOcr(rect, effectNamePred(faceHue), { psm: 6 });
      return { text: normText(read.text).toLowerCase().replace(/\n/g, " "), conf: read.conf };
    }
    // Most-specific patterns FIRST: "Enh." appears only in the two Ally effects, so an
    // occluded read like "Damage Enh." (a pet covering "Ally" — real case, 2026-07-16)
    // must hit Ally Damage Enh. before the generic /damage|attack/ effects get a shot.
    var EFFECT_LEX = [
      // "Ally" OCRs as Aliy/AIly/A11y — accept fuzzed leading tokens too
      ["Ally Damage Enh.", /a[li1|]{2}y\s*dam|ally\s*dam|damage\s*enh|dmg\s*enh/],
      ["Ally Attack Enh.", /a[li1|]{2}y\s*at|ally\s*at|attack\s*enh|atk\s*enh/],
      ["Additional Damage", /additional|addit/],
      ["Boss Damage", /boss/],
      ["Brand Power", /brand/],
      ["Attack Power", /atk|attack/]
    ];
    // Only effects legal for the gem's base cost are candidates (the cost-9 pool has no
    // Additional Damage/Brand Power — kills a whole class of misreads); `avoid` keeps
    // one slot's confident read from being duplicated into the other.
    var poolNames = (ENGINE_API.EFFECT_POOLS && ENGINE_API.EFFECT_POOLS[out.config.baseCost]) || null;
    function lexEffect(t, avoid) {
      for (var i = 0; i < EFFECT_LEX.length; i++) {
        var name = EFFECT_LEX[i][0];
        if (poolNames && poolNames.indexOf(name) === -1) continue;
        if (avoid && name === avoid) continue;
        if (EFFECT_LEX[i][1].test(t)) return name;
      }
      return null;
    }
    var nmW = await readEffectName(nodes.nodeW, hueW);
    var nmE = await readEffectName(nodes.nodeE, hueE);
    out.config.effect1 = lexEffect(nmW.text, null);
    out.config.effect2 = lexEffect(nmE.text, out.config.effect1);
    // a pool-constrained lexicon hit is strong evidence even when the raw OCR conf is
    // low (mangled-but-matched text): floor at 0.82 when the pool was known
    var effFloor = poolNames ? 0.82 : 0;
    confidence.config.effect1 = out.config.effect1 ? Math.max(effFloor, Math.min(0.92, nmW.conf + 0.3)) : 0;
    confidence.config.effect2 = out.config.effect2 ? Math.max(effFloor, Math.min(0.92, nmE.conf + 0.3)) : 0;

    // ---- the 4 outcomes ----
    var iconXs = geo ? geo.outIconXs : L.ROI.outIconXs.map(function (fx) { return panel.x + fx * panel.w; });
    var iconY = geo ? geo.outIconY : panel.y + L.ROI.outIconY * panel.h;
    for (var oi = 0; oi < 4; oi++) {
      var icol = L.medianPatch(raster, iconXs[oi], iconY, patchHalf);
      var icls = L.hueClass(icol[0], icol[1], icol[2]);
      var ihue = L.hsv(icol[0], icol[1], icol[2]).h;

      // caption band under/around the icon
      var capRect = { x: iconXs[oi] - gap * 0.44, y: iconY - gap * 0.16, w: gap * 0.88, h: gap * 0.52 };
      var capRead = await maskedOcr(capRect, captionText, { psm: 6 });
      var cap = normText(capRead.text).toLowerCase();

      var o = null, oconf = 0;
      var target = null;
      if (icls === "red") target = "willpower";
      else if (icls === "gold") target = "order";
      else if (icls !== "grey") {
        // self-calibrated: match against this image's own W/E diamond hues
        var dW = hueDist(ihue, hueW), dE = hueDist(ihue, hueE);
        target = dW <= dE ? "effect1" : "effect2";
        if (Math.abs(dW - dE) < 12) oconf -= 0.35;   // near-tie: same-family effects
      }

      if (/maintain|state\s*maint/.test(cap)) {
        // "Processing State Maintained" — the literal do-nothing outcome
        o = { type: "do_nothing" };
        oconf += Math.min(0.9, capRead.conf + 0.3);
      } else if (/effect\s*chang|changed/.test(cap) && target && (target === "effect1" || target === "effect2")) {
        o = { type: "change_side_option", target: target };
        oconf += Math.min(0.9, capRead.conf + 0.3);
      } else if (/time|view|other|item/.test(cap)) {
        var rrM = cap.match(/\+\s*([12])/);
        o = { type: "reroll_increase", change: rrM ? parseInt(rrM[1], 10) : 1 };
        oconf += rrM ? 0.9 : 0.6;
      } else if (/[cjg]ost|1\s*[o0]\s*[o0]\s*%|100/.test(cap)) {
        // cost captions are the ONLY ones containing "100"; the word itself OCRs as
        // Cost/Jost/Gost — the amount is the reliable signature. Checked BEFORE the
        // grey-icon fallback: "+100%" contains "+1" and used to be eaten as reroll+1.
        var neg = /-\s*10|−\s*10/.test(cap);
        o = { type: "change_gold_cost", change: neg ? -100 : 100 };
        oconf += 0.75;
      } else if (icls === "grey" && /\+\s*\d/.test(cap)) {
        var rrM2 = cap.match(/\+\s*([12])/);
        o = { type: "reroll_increase", change: rrM2 ? parseInt(rrM2[1], 10) : 1 };
        oconf += rrM2 ? 0.6 : 0.4;
      } else if (target) {
        // amount ("Lv. 2" / "+1") is the chartreuse line at the caption's bottom —
        // the name above it is white, so a chroma line-locate isolates it even over
        // the nebula art and the icon face behind the text.
        var amt = null, dirUp = false, dirDown = false;
        var capCx = iconXs[oi];
        var amtLine = L.findMaskedTextLine(raster, capRect, L.isAmountText, {
          maxRowFill: 0.7, minH: Math.max(4, Math.round(gap * 0.05)), maxH: Math.round(gap * 0.2), minRowPx: 3,
          // amount text is centered on the cell — skip icon tips / stray sparkles
          accept: function (r) {
            var cx = r.x + r.w / 2;
            return Math.abs(cx - capCx) <= gap * 0.24 && r.w >= gap * 0.05 && r.w <= gap * 0.6;
          }
        });
        if (amtLine) {
          var agrow = Math.round(amtLine.h * 0.5);
          var amtRectX = { x: amtLine.x, y: amtLine.y - agrow, w: amtLine.w, h: amtLine.h + agrow * 2 };
          // template match first (amounts use the same glyph art as the wheel digits)
          var amTm = lastGoldDigit(amtRectX, L.isAmountText, 4);
          if (amTm) amt = amTm.value;
          if (amt == null) {
            var amtRead = await maskedOcr(amtRectX, L.isAmountText, { whitelist: "Lv.+12345 ", psm: 7 });
            // prefix-anchored FIRST — the ▲ hue can bleed into the chartreuse window
            // and OCR the triangle as a trailing digit ("Lv. 2 ▲" → "Lv. 24")
            var am = amtRead.text.match(/(?:lv\.?|\+)\s*([1-4])/i) || amtRead.text.match(/([1-4])/);
            if (am) amt = parseInt(am[1], 10);
          }
          // ▲/▼ sits at the line's right end; classify green-vs-red in that box only.
          // (Whole-cell clustering is hopeless: the outcome ICON — red willpower, green
          // attack — sits BEHIND the caption and swamps the counts.) The arrow is a
          // SOLID blob (density ≥~0.3 of its own bbox); icon-face bleed is diffuse.
          var arrowBox = { x: amtLine.x + amtLine.w - gap * 0.05, y: amtLine.y - agrow, w: gap * 0.25, h: amtLine.h + agrow * 2 };
          var arrowCrop = L.crop(raster, arrowBox);
          var aUp = L.colorClusterStats(arrowCrop, function (rr, gg, bb) {
            var c = L.hsv(rr, gg, bb); return c.h >= 75 && c.h < 145 && c.s > 0.35 && c.v > 0.45;
          });
          var aDown = L.colorClusterStats(arrowCrop, function (rr, gg, bb) {
            // ▼ renders dimmer than ▲ (v down to ~0.42 on blue/gold faces)
            var c = L.hsv(rr, gg, bb); return (c.h < 20 || c.h >= 345) && c.s > 0.45 && c.v > 0.4;
          });
          // arrows are SOLID triangles (density ≥~0.3 of their own bbox); nebula
          // sparkle and face-edge blends are diffuse — density-gate BOTH colors
          var upSolid = aUp.frac > 0.012 && aUp.count >= 8 && aUp.density > 0.25;
          var downSolid = aDown.frac > 0.012 && aDown.count >= 8 && aDown.density > 0.25;
          // the ICON FACE behind the caption shares a hue family with one arrow color:
          // evidence in the icon's own family is worthless (a red willpower face lands
          // compactly in the box and out-counts a real green ▲) — trust the other side
          if (icls === "red") { dirUp = upSolid; dirDown = downSolid && !upSolid; }
          else if (icls === "green") { dirDown = downSolid; dirUp = upSolid && !downSolid; }
          else if (upSolid && downSolid) { dirUp = aUp.count >= aDown.count; dirDown = !dirUp; }
          else { dirUp = upSolid; dirDown = downSolid; }
          if (out._debug) (out._debug.arrows = out._debug.arrows || [])[oi] = {
            up: { count: aUp.count, frac: Math.round(aUp.frac * 1000) / 1000, density: Math.round(aUp.density * 100) / 100 },
            down: { count: aDown.count, frac: Math.round(aDown.frac * 1000) / 1000, density: Math.round(aDown.density * 100) / 100 }
          };
        }
        var redLine = null;
        if (!amtLine) {
          // LOWER amounts render RED with a red ▼ — a red text line is itself the
          // direction signal. Red-on-red (a lower on the red willpower face) is
          // colorimetrically unreadable, like the gold S digit: rejectFill bails and
          // the willpower fallback below covers it.
          redLine = L.findMaskedTextLine(raster, capRect, L.isRedAmountText, {
            rejectFill: 0.3, maxRowFill: 0.7,
            minH: Math.max(4, Math.round(gap * 0.05)), maxH: Math.round(gap * 0.2), minRowPx: 3,
            accept: function (r) {
              var cx = r.x + r.w / 2;
              return Math.abs(cx - capCx) <= gap * 0.24 && r.w >= gap * 0.04 && r.w <= gap * 0.6;
            }
          });
          if (redLine) {
            var rgrow = Math.round(redLine.h * 0.5);
            var redRectX = { x: redLine.x, y: redLine.y - rgrow, w: redLine.w, h: redLine.h + rgrow * 2 };
            // template first: the red lower digits are the same glyph art as the gold
            // ones (the chroma mask makes them identical binary shapes)
            var redTm = lastGoldDigit(redRectX, L.isRedAmountText, 4);
            if (redTm) amt = redTm.value;
            if (amt == null) {
              var redRead = await maskedOcr(redRectX, L.isRedAmountText, { whitelist: "Lv.-12345 ", psm: 7 });
              var rm2 = redRead.text.match(/(?:lv\.?|-|−)\s*([1-4])/i) || redRead.text.match(/([1-4])/);
              if (rm2) amt = parseInt(rm2[1], 10);
            }
            dirDown = true; dirUp = false;
          }
        }
        if (amt == null) {
          var amtM = cap.match(/(?:lv\.?\s*|\+\s*)([1-4])/) || cap.match(/([1-4])\s*$/);
          if (amtM) amt = parseInt(amtM[1], 10);
        }
        var hadAmt = amt != null;
        if (amt == null) amt = 1;
        // direction earns full confidence only with a STRONG signal: a located red
        // amount line, or an arrow blob of real size — a borderline arrow read stays
        // below the flag threshold (two silent lower→raise errors came from here)
        var strongDir = (redLine != null && dirDown) ||
          (dirUp && aUp && aUp.count >= 20) || (dirDown && aDown && aDown.count >= 20);
        if (!amtLine && !redLine && target === "willpower") {
          // red face + red text + red arrow: a willpower LOWER is invisible to every
          // color mask. But a willpower RAISE always shows a green ▲ (green-on-red
          // separates at any resolution) — so green anywhere in the cell decides.
          var wCrop = L.crop(raster, capRect);
          var wUp = L.colorClusterStats(wCrop, function (rr, gg, bb) {
            var c = L.hsv(rr, gg, bb); return c.h >= 75 && c.h < 145 && c.s > 0.4 && c.v > 0.45;
          });
          if (wUp.frac > 0.006 && wUp.count >= 8) { dirUp = true; dirDown = false; }
          else { dirDown = true; dirUp = false; oconf -= 0.25; }
        }
        var type = dirDown && !dirUp ? "lower_effect" : "raise_effect";
        o = { type: type, target: target, amount: amt };
        oconf += (hadAmt ? 0.55 : 0.25) + (strongDir ? 0.3 : (dirUp || dirDown) ? 0.15 : 0.05);
        // SAFETY: on order/points/willpower the direction arrow renders in the icon's
        // OWN hue family (a red raise ▲ on the gold order icon), so the color test is
        // unreliable there — a wrong direction must never be CONFIDENT. Require a clear
        // +/− sign in the caption to keep it unflagged; else cap below the UI threshold.
        if (target === "order" || target === "willpower") {
          var signSeen = /\+\s*[1-5]/.test(cap) || (/(?:^|\s)[-−]\s*[1-5]/.test(cap) && !/lv/i.test(cap));
          if (!signSeen) oconf = Math.min(oconf, 0.72);
        }
      } else {
        o = { type: "do_nothing" };
        oconf += 0.2;
      }
      out.outcomes.push(o);
      confidence.outcomes[oi] = Math.max(0, Math.min(0.95, oconf * panelConf));
    }

    // panel-quality attenuation on the art-region fields
    ["willpowerLevel", "orderLevel", "effect1Level", "effect2Level", "effect1", "effect2"].forEach(function (k) {
      confidence.config[k] = (confidence.config[k] || 0) * panelConf;
    });
    return out;
  }

  // ---------------------------------------------------------------------------
  // browser engine class
  // ---------------------------------------------------------------------------
  function StructuralEngine() {}
  if (typeof ENGINE_API.BaseEngine === "function" || (ENGINE_API.OcrEngine)) {
    var Base = ENGINE_API.BaseEngine || ENGINE_API.OcrEngine;
    StructuralEngine.prototype = Object.create(Base.prototype);
    StructuralEngine.prototype.constructor = StructuralEngine;
  }
  StructuralEngine.prototype.name = "structural";
  StructuralEngine.prototype.label = "Structural (offline, default)";
  StructuralEngine.prototype.isAvailable = function () {
    return typeof window !== "undefined" && typeof window.Tesseract !== "undefined" && typeof document !== "undefined";
  };
  StructuralEngine.prototype.unavailableReason = function () { return "Needs a browser with the Tesseract CDN script loaded."; };

  var _workerP = null;
  function getWorker() {
    if (!_workerP) {
      _workerP = window.Tesseract.createWorker("eng", 1, { logger: function () {} });
    }
    return _workerP;
  }
  function rasterToCanvas(raster) {
    var c = document.createElement("canvas");
    c.width = raster.width; c.height = raster.height;
    var ctx = c.getContext("2d");
    var id = ctx.createImageData(raster.width, raster.height);
    id.data.set(raster.data);
    ctx.putImageData(id, 0, 0);
    return c;
  }
  var _ocrQueue = Promise.resolve();
  function browserOcr(raster, opts) {
    // serialize on one worker; set per-call params (whitelist / psm)
    _ocrQueue = _ocrQueue.then(function () {
      return getWorker().then(function (w) {
        var params = { tessedit_pageseg_mode: String(opts.psm || 6), user_defined_dpi: "150" };
        params.tessedit_char_whitelist = opts.whitelist || "";
        return w.setParameters(params).catch(function () {}).then(function () {
          return w.recognize(rasterToCanvas(raster));
        }).then(function (res) {
          return { text: (res && res.data && res.data.text) || "", conf: ((res && res.data && res.data.confidence) || 40) / 100 };
        });
      });
    });
    return _ocrQueue;
  }

  StructuralEngine.prototype.parseScreenshot = function (input) {
    var self = this;
    return toRaster(input).then(function (raster) {
      return parseStructural(raster, browserOcr);
    }).then(function (raw) {
      var snapped = self.constraintSnap(raw);
      snapped.confidence = raw.confidence ? snapped.confidence : undefined;
      return snapped;
    });
  };
  function toRaster(input) {
    return new Promise(function (resolve, reject) {
      function fromImg(img) {
        var c = document.createElement("canvas");
        c.width = img.naturalWidth || img.width; c.height = img.naturalHeight || img.height;
        var ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        var id = ctx.getImageData(0, 0, c.width, c.height);
        resolve({ width: c.width, height: c.height, data: id.data });
      }
      if (typeof HTMLImageElement !== "undefined" && input instanceof HTMLImageElement) {
        if (input.complete) fromImg(input);
        else { input.onload = function () { fromImg(input); }; input.onerror = reject; }
      } else if (typeof HTMLCanvasElement !== "undefined" && input instanceof HTMLCanvasElement) {
        var ctx = input.getContext("2d");
        var id = ctx.getImageData(0, 0, input.width, input.height);
        resolve({ width: input.width, height: input.height, data: id.data });
      } else if (input && (input instanceof Blob)) {
        var url = URL.createObjectURL(input);
        var img = new Image();
        img.onload = function () { URL.revokeObjectURL(url); fromImg(img); };
        img.onerror = function (e) { URL.revokeObjectURL(url); reject(e); };
        img.src = url;
      } else reject(new Error("Unsupported input type for the structural engine."));
    });
  }
  StructuralEngine.prototype.disposeWorker = function () {
    if (_workerP) {
      _workerP.then(function (w) { try { w.terminate(); } catch (e) {} }).catch(function () {});
      _workerP = null;
    }
  };
  // warm the OCR worker as soon as the engine loads (tab activation) so the first
  // parse doesn't pay the worker + traineddata startup.
  if (typeof window !== "undefined" && typeof window.Tesseract !== "undefined") {
    try { getWorker(); } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // register + export
  // ---------------------------------------------------------------------------
  if (!IS_NODE && ENGINE_API.registerEngine) {
    ENGINE_API.registerEngine(new StructuralEngine());
  } else if (!IS_NODE && root.ocrRegisterEngine) {
    root.ocrRegisterEngine(new StructuralEngine());
  }

  var EXPORT = { parseStructural: parseStructural, StructuralEngine: StructuralEngine };
  if (IS_NODE) module.exports = EXPORT;
  else root.OcrStructuralEngine = EXPORT;
})(typeof globalThis !== "undefined" ? globalThis : this);
