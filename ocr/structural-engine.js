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
  var LREFS = null, NREFS = null;
  try {
    var _lr = IS_NODE ? require("./level-refs.js") : root.OcrLevelRefs;
    if (_lr) { LREFS = _lr.LEVEL_REFS; NREFS = _lr.NAME_REFS; }
  } catch (e) {}
  // blurred-variant caches for the synthesis rescues — MODULE scope: building
  // them costs ~400 blur+normalize passes and they depend only on the baked
  // refs, so one build serves every parse (they used to be rebuilt inside
  // every parseStructural call)
  var _synthTVCache = null, _nsynthTVCache = null;

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

  // Glyph-box hygiene: segmentGlyphs output minus dust and off-height fragments
  // (0.55–1.7 × the median height). One definition — the same recipe used to be
  // hand-rolled at every template site. (tools/build-glyphs.js keeps a 1.6 upper
  // bound; unifying it changes the harvested atlas, parked with the atlas
  // recalibration — see docs/how-the-advisor-works.md §6.)
  function segmentDigitBoxes(mask) {
    var boxes = L.segmentGlyphs(mask, { minColPx: 1, gapCols: 1 });
    var hs = boxes.map(function (b) { return b.h; }).sort(function (a, b) { return a - b; });
    var medH = hs.length ? hs[hs.length >> 1] : 0;
    return boxes.filter(function (b) { return b.h >= medH * 0.55 && b.h <= medH * 1.7 && b.w >= 2; });
  }

  async function parseStructural(raster, ocrFn) {
    var confidence = { config: {}, state: {}, outcomes: [0, 0, 0, 0] };
    var out = { config: {}, state: {}, outcomes: [], rarity: null, confidence: confidence };
    var ocrFails = 0;   // dead-OCR calls (worker never loaded / crashed mid-parse)

    // phase timing (lands in _debug.timing) — the optimization loop's ruler:
    // tmark(name) charges the elapsed time since the previous mark to `name`;
    // OCR wall-time is also accumulated separately (it overlaps the phases)
    var _tPrev = Date.now(), _timing = {}, _ocrMs = 0;
    function tmark(name) { var n = Date.now(); _timing[name] = (_timing[name] || 0) + (n - _tPrev); _tPrev = n; }
    var _ocrInner = ocrFn;
    ocrFn = function (r, o) {
      var t0 = Date.now();
      return _ocrInner(r, o).then(function (res) { _ocrMs += Date.now() - t0; return res; });
    };

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
      // crop with a margin so edge regions (reroll pill, footer buttons) survive.
      // The BOTTOM margin is deliberately larger: on several live shots the panel
      // rect detected short and the symmetric 6% cropped the Process button half
      // out of the raster — every footer vote then failed and the turn defaulted
      // to 1. Nothing below the button matters except chat, which the pair regex
      // and the {5,7,9} gate ignore.
      var mg = 0.06, mgBot = 0.16;
      // the panel's rect in ORIGINAL-image coordinates, exposed for the AI
      // verifier's crop (the raster below is cropped+rescaled and useless for it)
      out._srcPanel = {
        x: Math.max(0, Math.round(found.rect.x - found.rect.w * mg)),
        y: Math.max(0, Math.round(found.rect.y - found.rect.h * mg)),
        w: Math.round(found.rect.w * (1 + 2 * mg)),
        h: Math.round(found.rect.h * (1 + mg + mgBot))
      };
      var cr = {
        x: found.rect.x - found.rect.w * mg, y: found.rect.y - found.rect.h * mg,
        w: found.rect.w * (1 + 2 * mg), h: found.rect.h * (1 + mg + mgBot)
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
    tmark("normalize");

    function roiCrop(key) { return L.crop(raster, L.roiRect(panel, key)); }
    async function ocrText(sub, opts) {
      try {
        var r = await ocrFn(sub, opts || {});
        if (r && r.failed) ocrFails++;   // resolved-but-dead OCR backend
        return { text: r.text || "", conf: r.conf != null ? r.conf : 0.5 };
      } catch (e) { ocrFails++; return { text: "", conf: 0 }; }
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
    // Dilated micro-OCR: (pre-cropped) sub → chroma mask → 1px dilate (reconnects
    // strokes that antialiasing broke) → nearest upscale → OCR. THE standard
    // dim-text rescue recipe — one definition, six call sites. `scale` is a fixed
    // factor or "auto" (targets ~160px height, capped by `maxAuto`).
    async function dilatedOcr(sub, pred, opts) {
      var sc = opts.scale === "auto"
        ? Math.max(2, Math.min(opts.maxAuto || 4, Math.round(160 / Math.max(1, sub.height))))
        : opts.scale;
      return ocrText(upscale(dilateDark(L.chromaMask(sub, pred)), sc), { whitelist: opts.whitelist, psm: opts.psm });
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
      var boxes = segmentDigitBoxes(mask);
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

    // The FIND mask for dim button/footer text — shared by the footer phase, the
    // pill, and the cost reads, so it lives OUTSIDE the async footer wrapper.
    var dimBtnWhite = function (r, g, b) { var c = L.hsv(r, g, b); return c.s < 0.3 && c.v > 0.6; };

    // ---- footer: Process (x/N) — anchored tight button first, block fallback ----
    // Wrapped as a CONCURRENT phase (launched here, awaited before outcomes): its
    // OCR chain overlaps the pill and gem-name reads across the worker pool. All
    // its state is local; it writes only its own out/confidence fields.
    // OCR confusions to survive (all observed): "(" reads as a glued "1" ("(4/7)" →
    // "14/7"), "/" reads as ":" or "." — so capture the SINGLE digit adjacent to the
    // separator and accept the separator class loosely. N can only be 5/7/9.
    var footerP = (async function footerPhase() {
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
    // ever forms (this was every "turn read at 0.70" flag). (dimBtnWhite is defined
    // above the phase wrapper — it is shared with the pill and cost reads.)
    // DESCENDING locate: the zone's topmost white band is sometimes NOT the button —
    // on shots where the wheel gap measures a few % small, the Balance row slips into
    // the zone top, gets located, OCRs to garbage, and the turn silently defaulted
    // to 1. If a located band yields no valid (x/N) pair, descend below it and retry.
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
      if (out._debug) out._debug.pairTG = tg ? tg.map(function (t) {
        return (t.ch || "?") + ":" + t.score.toFixed(2) + "/" + t.margin.toFixed(2) + "(" + t.box.w + "x" + t.box.h + ")";
      }).join(" ") : "null";
      if (tg) {
        // Anchor on the '/' and take its IMMEDIATE NEIGHBOURS (the proven pill
        // pattern): the old last-two-confident-digits rule was fooled twice over
        // on one live frame — the true '1' is narrow and matches the '+' template
        // (so it never entered the run) while a word-height "Process" letter faked
        // a '5' at exactly the 0.80 floor. The slash can't be faked by either, and
        // the narrow-box-is-'1' aspect rule recovers the digit the atlas can't.
        var si2 = -1;
        for (var sk2 = 0; sk2 < tg.length; sk2++) { if (tg[sk2].ch === "/" && tg[sk2].score >= 0.8) si2 = sk2; }
        if (si2 >= 1 && si2 + 1 < tg.length) {
          var aB = tg[si2 - 1], bB = tg[si2 + 1];
          var a3 = aB.box.w / Math.max(1, aB.box.h) < 0.45 ? 1
            : (aB.ch && /^\d$/.test(aB.ch) && aB.score >= 0.8 ? parseInt(aB.ch, 10) : null);
          var b3 = (bB.ch && /^\d$/.test(bB.ch) && bB.score >= 0.8) ? parseInt(bB.ch, 10) : null;
          if (a3 != null && b3 != null && (b3 === 5 || b3 === 7 || b3 === 9) && a3 >= 1 && a3 <= b3) pairT = { a: a3, b: b3 };
        }
      }
    }
    function pairEq(p, q) { return p && q && p.a === q.a && p.b === q.b; }
    var pair = null, pairConf = 0;
    // template ∧ button-OCR agreement settles the pair WITHOUT the footer block
    if (pairT && pairEq(pairT, pairA)) { pair = pairT; pairConf = 0.96; }
    var footTop = goldY + gap * 1.13;
    var footText = "", footBlockRan = false;
    async function readFootBlock() {
      if (footBlockRan) return;
      footBlockRan = true;
      var footRead = await maskedOcr(
        { x: cx - gap * 2.35, y: footTop, w: gap * 4.7, h: Math.max(gap * 0.6, panel.y + panel.h - footTop - 2) },
        L.isWhiteText, { psm: 6 });
      footText = normText(footRead.text);
    }
    if (!pair) {
      // the block read is the corroborating voter only when the cheap votes
      // disagree — it is the single LARGEST OCR call of the parse and on most
      // clean captures pure redundancy (skip measured safe by the full gate)
      await readFootBlock();
      var pairB = parseProcPair(footText);
      if (pairT && pairEq(pairT, pairB)) { pair = pairT; pairConf = 0.96; }
      else if (pairEq(pairA, pairB)) { pair = pairA; pairConf = 0.95; }
      else if (pairT) { pair = pairT; pairConf = 0.88; }
      else if (pairA && pairB) { pair = pairA; pairConf = 0.6; }
      else if (pairA) { pair = pairA; pairConf = 0.85; }
      else if (pairB) { pair = pairB; pairConf = 0.7; }
    }
    if (!pair) {
      // LAST-RESORT rescue: on several live shots the located band was the Balance
      // row (the wheel gap measured a few % small) AND the psm6 footer block was
      // cut short by a short-detected panel bottom — every vote failed and the turn
      // silently defaulted to 1. Read a button-focused band that ignores the panel
      // bottom entirely; take the FIRST valid pair (the band starts at the button
      // row, so chat lines below cannot override) at capped confidence.
      var rescueTop = goldY + gap * 2.2;
      var rescueRead = await maskedOcr(
        { x: cx + gap * 0.2, y: rescueTop, w: gap * 2.15, h: Math.max(gap * 0.55, raster.height - rescueTop - 2) },
        dimBtnWhite, { psm: 6 });
      var rm2 = /(\d)\s*[:\/l|.]\s*(\d)\s*[\)\]]?/.exec(normText(rescueRead.text));
      if (rm2) {
        var ra = parseInt(rm2[1], 10), rb = parseInt(rm2[2], 10);
        if ((rb === 5 || rb === 7 || rb === 9) && ra >= 1 && ra <= rb) { pair = { a: ra, b: rb }; pairConf = 0.75; }
      }
    }
    var turnsRemaining = pair ? pair.a : null, maxT = pair ? pair.b : null;
    out.rarity = maxT === 5 ? "uncommon" : maxT === 7 ? "rare" : maxT === 9 ? "epic" : null;
    out.state.maxTurns = maxT;
    out.state.turnsRemaining = turnsRemaining;
    confidence.state.rarity = maxT != null ? pairConf : 0;
    confidence.state.currentTurn = turnsRemaining != null ? pairConf : 0;

    // Processing Cost: when the footer block was SKIPPED, the no-OCR template
    // read goes first (its {450,900,1800} whitelist is the guard); the block's
    // word-anchored regexes remain the primary when the block ran anyway, and
    // the block is only fetched here if the template missed.
    var cval = null;
    var costConf = 0.9;
    var _costTplTried = false;
    function costTemplateRead() {
      if (_costTplTried || cval != null) return;
      _costTplTried = true;
      // TEMPLATE rescue: the footer psm6 block reads garbage on many low-res shots
      // (measured: the cost went unread on 40/56 — the single biggest false-alarm
      // class, every one a wasted "confirm me"). The cost ROW is structurally easy:
      // locate the "Processing Cost   <number>" line, take the TRAILING box run
      // after the last wide gap (right-aligned number; the coin icon is saturated
      // and masked out), template-read the digits, accept only {450, 900, 1800}.
      // NOTE: the "Processing Cost" LABEL is blue-grey and fails the white mask —
      // on many shots the masked row is JUST the right-aligned number (~3 glyphs),
      // so the accept is narrow and the {450,900,1800} whitelist is the real guard.
      var costLn = locateLine(
        { x: cx - gap * 2.3, y: goldY + gap * 1.13, w: gap * 4.6, h: gap * 0.5 },
        dimBtnWhite,
        { maxRowFill: 0.75, minH: Math.max(4, Math.round(gap * 0.05)), maxH: Math.round(gap * 0.2),
          minRowPx: Math.max(3, Math.round(gap * 0.03)), accept: function (r) { return r.w >= gap * 0.22; } });
      if (out._debug) out._debug.costLn = costLn ? { y: Math.round(costLn.y), w: Math.round(costLn.w) } : null;
      if (costLn) {
        var tgC2 = templateGlyphs(costLn, dimBtnWhite);
        if (out._debug) out._debug.costTG = tgC2 ? tgC2.map(function (t) { return (t.ch || "?") + ":" + t.score.toFixed(2) + "@" + t.box.x; }).join(" ") : "null";
        if (tgC2 && tgC2.length >= 3) {
          var chs2 = tgC2.map(function (t) { return t.box.h; }).sort(function (a, b) { return a - b; });
          var cmedH2 = chs2[chs2.length >> 1];
          var runStart2 = tgC2.length - 1;
          while (runStart2 > 0 && (tgC2[runStart2].box.x - (tgC2[runStart2 - 1].box.x + tgC2[runStart2 - 1].box.w)) < cmedH2 * 1.5) runStart2--;
          var run2 = tgC2.slice(runStart2);
          // the number is right-aligned: either a trailing run after a wide gap
          // (label survived the mask) or the whole masked line sits right of center
          var wholeLineIsRun = runStart2 === 0 && tgC2.length <= 5 && costLn.x > cx;
          if ((runStart2 > 0 || wholeLineIsRun) && run2.length >= 3 && run2.length <= 5) {
            var digs2 = "";
            for (var ri2 = 0; ri2 < run2.length; ri2++) {
              var rb2 = run2[ri2];
              if (rb2.box.w <= 4 && rb2.box.h <= cmedH2 * 0.4) continue;   // the thousands comma
              var dm2 = iouDigit(tgC2.mask, rb2.box);
              if (!dm2 || dm2.score < 0.3) { digs2 = null; break; }
              digs2 += dm2.ch;
            }
            if (digs2) {
              var cv2 = parseInt(digs2, 10);
              if (cv2 === 450 || cv2 === 900 || cv2 === 1800) { cval = cv2; costConf = 0.85; }
            }
          } else if (runStart2 > 0 && run2.length === 1) {
            // ZERO rung — "Processing Cost 0" is REAL (the -100% outcome landed;
            // two live frames 2026-07-19, iou 0.96 on both). A lone trailing
            // glyph after the wide gap IS the right-aligned value, and 0 is the
            // only 1-digit cost, so demand a STRONG '0' on a round-ish box.
            // (A mask-eaten "900" leaving only its last digit would need the two
            // left digits — same font, same brightness, adjacent — to vanish
            // alone; not a real failure mode outside occlusion, which kills the
            // label boxes this branch requires via runStart2 > 0.)
            var zb = run2[0].box;
            var zd = iouDigit(tgC2.mask, zb);
            if (out._debug) out._debug.costZero = zd ? zd.ch + ":" + zd.score.toFixed(2) : "null";
            if (zd && zd.ch === "0" && zd.score >= 0.7 &&
                zb.h >= cmedH2 * 0.6 && zb.w >= zb.h * 0.45 && zb.w <= zb.h * 1.15) {
              cval = 0; costConf = 0.85;
            }
          }
        }
      }
    }
    if (!footBlockRan) costTemplateRead();   // skip path: the no-OCR read goes first
    if (cval == null) {
      await readFootBlock();
      var costM = footText.match(/cost\D{0,12}?([\d.,]{3,7})/i);
      if (costM) {
        var cv = parseInt(costM[1].replace(/[.,]/g, ""), 10);
        if (cv >= 100 && cv <= 9999) cval = cv;
      }
      if (cval == null) {
        // "1,800" OCRs with the comma as '.', ',' or a bare SPACE ("1 800" — live miss)
        var tokM = footText.match(/(^|\D)(450|900|1[.,\s]?800)(\D|$)/);
        if (tokM) cval = parseInt(tokM[2].replace(/[.,\s]/g, ""), 10);
      }
      if (cval == null) costTemplateRead();
      if (cval == null) {
        // psm6 text zero: the LABEL survives OCR only fuzzily ("Pools nog Jost 0"
        // — live), so anchor on the 'ost' stem then a LONE 0. The non-digit gap
        // cannot skip a leading digit, so 450/900/1,800 (and caption "+100%")
        // can never satisfy this.
        var zM = footText.match(/ost[^\d\n]{0,8}0(?!\d)/i);
        if (zM) { cval = 0; costConf = 0.75; }
      }
    }
    if (cval != null) { out.state.processCost = cval; confidence.state.processCostMultiplier = costConf; }
    if (out.state.processCost == null) confidence.state.processCostMultiplier = 0.3;
    if (out._debug) out._debug.costRead = { footText: footBlockRan ? footText.slice(0, 90) : "(block skipped)", cval: cval };
    })();   // footerPhase — awaited before the outcomes section

    tmark("footerLaunch");
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
    // template view of the pill, with the ASPECT rule: '1' is the only narrow digit,
    // and its serif flag makes dim OCR read it as '2' (three live "1/2" pills parsed
    // as 2/2 — one model reroll too many). The box shape is the tiebreaker.
    var tPair = null;
    {
      var tgR = templateGlyphs(pillRect, dimBtnWhite);
      if (tgR) {
        // Anchor on the SLASH and take the POSITIONALLY adjacent boxes. The old
        // rule ("exactly 3 score≥0.75 digit/slash glyphs") had a poisoning hole:
        // the ⟳ icon can template-match a digit (live 5d800868: icon→'3'@0.75+)
        // while the true serif-'1' scores UNDER the filter — the survivors
        // [icon,'/', '2'] then satisfied exactly-3 and "3/2" outvoted a correct
        // OCR "1/2" in arbitration. Adjacency is structural: the numerator is
        // the box immediately left of the '/', and the icon sits a full icon-
        // width further out, so it can never be picked — however it classifies.
        var slashI = -1;
        for (var gi = 0; gi < tgR.length; gi++) if (tgR[gi].ch === "/" && tgR[gi].score >= 0.7) slashI = gi;
        if (slashI > 0 && slashI < tgR.length - 1) {
          var nb = tgR[slashI - 1], db2 = tgR[slashI + 1];
          var gapL = tgR[slashI].box.x - (nb.box.x + nb.box.w);
          var gapR = db2.box.x - (tgR[slashI].box.x + tgR[slashI].box.w);
          var hRef = Math.max(nb.box.h, db2.box.h, tgR[slashI].box.h);
          if (gapL <= hRef * 1.2 && gapR <= hRef * 1.2) {
            // aspect rule FIRST and score-free: '1' is the only narrow digit and
            // its serif flag both misclassifies and UNDER-SCORES at dim tiers
            var rn = nb.box.w / Math.max(1, nb.box.h) < 0.45 ? 1
              : (/^\d$/.test(nb.ch || "") && nb.score >= 0.7 ? parseInt(nb.ch, 10) : null);
            var rd = db2.box.w / Math.max(1, db2.box.h) < 0.45 ? 1
              : (/^\d$/.test(db2.ch || "") && db2.score >= 0.7 ? parseInt(db2.ch, 10) : null);
            if (rn != null && rd != null && rn <= 9 && (rd === 1 || rd === 2)) tPair = { n: rn, d: rd };   // stacked counters (3/2…) legal
          }
        }
      }
    }
    if (pillM) {
      var pa = parseInt(pillM[1], 10), pb = parseInt(pillM[2], 10);
      // rerolls STACK past the denominator (reroll_increase outcomes): 3/2, 5/2…
      // are legal — only the denominator is rarity-bounded (1 or 2)
      if (pa <= 9 && (pb === 1 || pb === 2)) {
        if (tPair && (tPair.n !== pa || tPair.d !== pb)) {
          // disagree → the aspect-checked template wins, flagged for a look
          out.state.rerollsShownFree = tPair.n;
          out.state.rerollsShownDenom = tPair.d;
          confidence.state.rerollsRemaining = 0.75;
        } else {
          out.state.rerollsShownFree = pa;
          out.state.rerollsShownDenom = pb;
          confidence.state.rerollsRemaining = tPair ? 0.92 : 0.9;
        }
      }
    }
    if (out.state.rerollsShownFree == null && tPair) {
      out.state.rerollsShownFree = tPair.n;
      out.state.rerollsShownDenom = tPair.d;
      confidence.state.rerollsRemaining = 0.85;
    }
    if (out.state.rerollsShownFree == null) {
      // CHARGE DETECTION runs BEFORE the dim digit rescue (ORDER MATTERS — live
      // bug 2026-07-18): the rescue OCRs with a digits-only whitelist, which forces
      // Tesseract to TRANSLITERATE a crisp grey "Charge" into digits; at native
      // resolution that hallucinated a two-digit pill and this branch never ran.
      // Confirm the WORD (any brightness), then the BUTTON COLOR decides —
      // gold = paid reroll purchasable (1), grey = paid spent (0).
      var pillCrop = L.crop(raster, pillRect);
      var goldBtn = L.colorClusterStats(pillCrop, function (r, g, b) {
        var c = L.hsv(r, g, b); return c.h >= 30 && c.h < 55 && c.s > 0.45 && c.v > 0.5;
      });
      var chRead = await maskedOcr(pillRect, dimBtnWhite, { psm: 7 });
      var chWord = /charg|harge|chorge/i.test(normText(chRead.text));
      if (!chWord && goldBtn.frac <= 0.35) {
        // the DISABLED (all-spent) Charge renders dimmer than the standard mask
        // floor — retry the word at a low floor with dilation
        var chDimPred = function (r, g, b) { var c = L.hsv(r, g, b); return c.s < 0.4 && c.v > 0.32; };
        var chRead2 = await dilatedOcr(pillCrop, chDimPred, { scale: 3, psm: 7 });
        chWord = /charg|harge|chorge/i.test(normText(chRead2.text));
      }
      if (goldBtn.frac > 0.35) {
        out.state.rerollsChargeSeen = true;                       // gold face is decisive
        confidence.state.rerollsRemaining = 0.85;
      } else if (chWord) {
        out.state.rerollsChargeSpent = true;                      // grey Charge
        confidence.state.rerollsRemaining = 0.8;
      }
    }
    if (out.state.rerollsShownFree == null && !out.state.rerollsChargeSeen && !out.state.rerollsChargeSpent) {
      // dim-pill rescue: on dark captures BOTH the plain OCR and the template view
      // come up empty and the snap then DEFAULTS by rarity (three live "1/2" pills
      // became 2/2 → one phantom reroll). Same medicine as the grey captions:
      // dilate + ×3 upscale before OCR. Capped conf — a rescue read stays checkable.
      // (Runs strictly AFTER Charge detection; see the ordering note above.)
      var pillSub = L.crop(raster, pillRect);
      // the pill text can render DIMMER than the standard mask floor (v≈0.55 grey on
      // a dark pill — verified by eye on a live "1 / 2"): use a lower threshold here
      var pillDim = function (r, g, b) { var c = L.hsv(r, g, b); return c.s < 0.35 && c.v > 0.45; };
      var pillR2 = await dilatedOcr(pillSub, pillDim, { scale: 3, whitelist: "0123456789/", psm: 7 });
      var pillM2 = pillR2.text.match(/(\d)\s*\/\s*(\d)/);
      if (!pillM2) {
        // the thin '/' vanishes before the digits do: exactly two digits ⇒ n,d
        var bare = (pillR2.text || "").replace(/\D/g, "");
        if (bare.length === 2 && (bare[1] === "1" || bare[1] === "2")) pillM2 = [null, bare[0], bare[1]];
      }
      if (pillM2) {
        var pa2 = parseInt(pillM2[1], 10), pb2 = parseInt(pillM2[2], 10);
        if (pa2 <= 9 && (pb2 === 1 || pb2 === 2)) {
          out.state.rerollsShownFree = pa2;
          out.state.rerollsShownDenom = pb2;
          confidence.state.rerollsRemaining = 0.75;
        }
      }
    }
    if (out.state.rerollsShownFree == null && !out.state.rerollsChargeSeen && !out.state.rerollsChargeSpent) {
      // PILL RELOCATION rescue (2026-07-19 "2.3%" audit): on some capture framings
      // the anchor-derived pill center sits high-left and the button CLIPS the
      // rect corner — every mask rung then OCRs a truncated line (225202/225159:
      // a plainly visible "1/2" read empty and the snap defaulted to fresh-3).
      // Self-locate the text line in a zone grown toward the panel edge (right/
      // down only — the outcome captions at the left stay out), the idiom every
      // other read uses. The located line is WORD-CHECKED before any digit
      // whitelist touches it (the 2026-07-18 lesson: a digits whitelist
      // transliterates "Charge"), and the commit requires a real slash pair.
      var pzone = { x: pillRect.x, y: pillRect.y, w: pillRect.w + gap * 0.30, h: pillRect.h + gap * 0.24 };
      var pDim2 = function (r, g, b) { var c = L.hsv(r, g, b); return c.s < 0.35 && c.v > 0.45; };
      var pline = L.findMaskedTextLine(raster, pzone, pDim2, {
        rejectFill: 0.5, maxRowFill: 0.75, minRowPx: 2,
        minH: Math.max(4, Math.round(gap * 0.05)), maxH: Math.round(gap * 0.18),
        accept: function (r) { return r.w >= gap * 0.12 && r.w <= gap * 0.75; }
      });
      if (pline) {
        var pgrow = Math.round(pline.h * 0.5);
        var prect2 = { x: pline.x - pgrow, y: pline.y - pgrow, w: pline.w + pgrow * 2, h: pline.h + pgrow * 2 };
        var pChk = await maskedOcr(prect2, pDim2, { psm: 7 });   // unwhitelisted first
        if (!/charg|harge|chorge/i.test(normText(pChk.text))) {
          var pReM = pChk.text.match(/(\d)\s*\/\s*(\d)/);
          if (!pReM) {
            var pRe = await dilatedOcr(L.crop(raster, prect2), pDim2, { scale: 3, whitelist: "0123456789/", psm: 7 });
            pReM = pRe.text.match(/(\d)\s*\/\s*(\d)/);
          }
          if (pReM) {
            var pa3 = parseInt(pReM[1], 10), pb3 = parseInt(pReM[2], 10);
            if (pa3 <= 9 && (pb3 === 1 || pb3 === 2)) {
              out.state.rerollsShownFree = pa3;
              out.state.rerollsShownDenom = pb3;
              confidence.state.rerollsRemaining = 0.75;   // rescue read — stays checkable
            }
          }
        }
      }
    }
    if (out.state.rerollsShownFree == null && !out.state.rerollsChargeSeen && !out.state.rerollsChargeSpent) {
      // same clipping, Charge case: the ⟳ icon is absent on Charge pills, so
      // relocation can't fire — retry the WORD on a modestly expanded rect
      // (right/down toward the panel edge only; the gold outcome icons stay
      // outside, so recomputing the gold-face fraction here is safe).
      var chRectW = { x: pillRect.x - gap * 0.15, y: pillRect.y - gap * 0.10, w: pillRect.w + gap * 0.40, h: pillRect.h + gap * 0.24 };
      var chSubW = L.crop(raster, chRectW);
      var chDimPredW = function (r, g, b) { var c = L.hsv(r, g, b); return c.s < 0.4 && c.v > 0.32; };
      var chReadW = await dilatedOcr(chSubW, chDimPredW, { scale: 3, psm: 7 });
      if (/charg|harge|chorge/i.test(normText(chReadW.text))) {
        var goldW = L.colorClusterStats(chSubW, function (r, g, b) {
          var c = L.hsv(r, g, b); return c.h >= 30 && c.h < 55 && c.s > 0.45 && c.v > 0.5;
        });
        if (goldW.frac > 0.2) out.state.rerollsChargeSeen = true;   // gold face
        else out.state.rerollsChargeSpent = true;                    // grey
        confidence.state.rerollsRemaining = 0.7;   // clipped-geometry read — flagged
      }
    }
    if (out.state.rerollsShownFree == null && !out.state.rerollsChargeSeen && !out.state.rerollsChargeSpent) {
      confidence.state.rerollsRemaining = 0.25;
    }

    tmark("pill");
    // ---- reset pill ("Reset (x/1)": x ∈ {0,1}) ----
    // Plain grey text on a dim button, not the reroll pill's colored-diamond icon,
    // so it needs none of that pill's Charge/dim-state machinery: one masked read
    // plus a dilated rescue for low-contrast captures is enough. x is the ONLY
    // free variable (denominator is always 1), so false reads are cheap to reject
    // with a tight regex. Feeds dp.js's Reset gating (model/dp.js topLevelAdvice):
    // resetsRemaining===0 means the reset was already spent and must not be
    // recommended; unparsed (undefined) keeps the historical "assume unused"
    // default so callers that don't read this field are unaffected.
    // Measured 2026-07-20 on both real "already used" samples: the button's grey
    // text tops out at v≈0.5-0.6, under dimBtnWhite's v>0.6 floor, so the plain
    // read misses it on both — same shape as the reroll pill's dim states. Try the
    // tight/bright predicate first anyway (cheap, and may catch a brighter
    // available "(1/1)" state no sample has shown yet), then fall back to a wider
    // dim predicate through the dilated rescue. The ROI itself was tightened to
    // exclude the ornate border glow directly above the button — at the original
    // (taller) crop that glow's highlight streaks passed the dim predicate as
    // false-positive glyphs and broke PSM-7's single-line read entirely.
    var resetRect = geo && geo.resetPill
      ? rectAround(geo.resetPill, gap * 0.85, gap * 0.11)
      : L.roiRect(panel, "resetPill");
    var resetRead = await maskedOcr(resetRect, dimBtnWhite, { whitelist: "Reset()01/ ", psm: 7 });
    var resetM = normText(resetRead.text).match(/reset\D{0,4}([01])\s*[:\/l|.]\s*1\b/i);
    if (!resetM) {
      var resetDimPred = function (r, g, b) { var c = L.hsv(r, g, b); return c.s < 0.4 && c.v > 0.30; };
      var resetSub = L.crop(raster, resetRect);
      var resetR2 = await dilatedOcr(resetSub, resetDimPred, { scale: 3, whitelist: "Reset()01/ ", psm: 7 });
      resetM = normText(resetR2.text).match(/reset\D{0,4}([01])\s*[:\/l|.]\s*1\b/i);
    }
    if (resetM) {
      out.state.resetsRemaining = parseInt(resetM[1], 10);
      confidence.state.resetsRemaining = 0.85;
    } else {
      confidence.state.resetsRemaining = 0.2;
    }
    tmark("resetPill");
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
    var suffixHit = null, suffixAmbig = false;
    Object.keys(GEM_NAME_COST).forEach(function (sfx) {
      if (nameText.indexOf(sfx) !== -1) suffixHit = sfx;
    });
    if (!suffixHit) {
      // Fuzzy pass: SCORE every suffix by 5-gram coverage and take the best — never
      // first-match-wins. "immutaBILITY" contains most of "staBILITY"'s grams, so the
      // old first-hit loop returned stability (cost 8) whenever OCR (or Shizu's pet
      // sprite sitting on the name) mangled "Immutability" — a systematic wrong cost
      // that then poisoned the effect pool. Prefix grams get a bonus: the START of
      // the word ("immut" vs "stab") is the discriminative part.
      var letters = nameText.replace(/[^a-z]/g, "");
      var bestS = null, secondS = 0;
      Object.keys(GEM_NAME_COST).forEach(function (sfx) {
        var hits = 0, total = 0;
        for (var k = 0; k + 5 <= sfx.length; k++) {
          total++;
          if (letters.indexOf(sfx.slice(k, k + 5)) !== -1) hits++;
        }
        var score = total ? hits / total : 0;
        if (letters.indexOf(sfx.slice(0, 5)) !== -1) score += 0.25;   // prefix bonus
        if (!bestS || score > bestS.score) { secondS = bestS ? bestS.score : 0; bestS = { sfx: sfx, score: score }; }
        else if (score > secondS) secondS = score;
      });
      if (bestS && bestS.score >= 0.5) {
        suffixHit = bestS.sfx;
        suffixAmbig = (bestS.score - secondS) < 0.15;   // two suffixes nearly tied
      }
    }
    if (suffixHit) { out.config.baseCost = GEM_NAME_COST[suffixHit]; confidence.config.baseCost = suffixAmbig ? 0.6 : 0.85; }
    else confidence.config.baseCost = 0;

    tmark("gemName");
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
      return { vec: vec, top: top, isDigit: isDigit, full: full };
    }
    // ---- ANALYSIS-BY-SYNTHESIS level rescue (2026-07-19) ----
    // The method that finally read the degraded-tier digits classically: pristine
    // 32×32 reference patches (ocr/level-refs.js, native-tier harvest) are BLURRED
    // to candidate degradations and correlated against the observed patch over a
    // sub-pixel alignment grid. Scored two independent ways (raw luminance +
    // gradient magnitude); a value commits ONLY when both scorings rank the same
    // digit first with a real gradient margin — on the measured corpus that gate
    // shipped 8 correct commits and refused every wrong one. Fires only when the
    // template AND OCR ladders both came back empty, so clean frames never pay.
    var SYNTH_PS = 32, SYNTH_PATCH_GAP = 0.13;
    function _synthZnorm(p2) {
      var out = new Float32Array(p2.length), mean = 0, i;
      for (i = 0; i < p2.length; i++) mean += p2[i];
      mean /= p2.length;
      var va = 0;
      for (i = 0; i < p2.length; i++) { out[i] = p2[i] - mean; va += out[i] * out[i]; }
      var sd = Math.sqrt(va / p2.length) || 1;
      for (i = 0; i < out.length; i++) out[i] /= sd;
      return out;
    }
    function _synthGrad(p2) {
      var PSZ = SYNTH_PS, g = new Float32Array(PSZ * PSZ);
      for (var y = 1; y < PSZ - 1; y++) for (var x = 1; x < PSZ - 1; x++) {
        var dx = p2[y * PSZ + x + 1] - p2[y * PSZ + x - 1], dy = p2[(y + 1) * PSZ + x] - p2[(y - 1) * PSZ + x];
        g[y * PSZ + x] = Math.sqrt(dx * dx + dy * dy);
      }
      return _synthZnorm(g);
    }
    function _synthBlur(p2, sigma) {
      var PSZ = SYNTH_PS;
      var r = Math.max(1, Math.ceil(sigma * 2.5)), k = [], ks = 0, i;
      for (i = -r; i <= r; i++) { var v = Math.exp(-i * i / (2 * sigma * sigma)); k.push(v); ks += v; }
      for (i = 0; i < k.length; i++) k[i] /= ks;
      var tmp = new Float32Array(PSZ * PSZ), out = new Float32Array(PSZ * PSZ), x, y, s, j;
      for (y = 0; y < PSZ; y++) for (x = 0; x < PSZ; x++) {
        s = 0;
        for (j = -r; j <= r; j++) s += p2[y * PSZ + Math.max(0, Math.min(PSZ - 1, x + j))] * k[j + r];
        tmp[y * PSZ + x] = s;
      }
      for (y = 0; y < PSZ; y++) for (x = 0; x < PSZ; x++) {
        s = 0;
        for (j = -r; j <= r; j++) s += tmp[Math.max(0, Math.min(PSZ - 1, y + j)) * PSZ + x] * k[j + r];
        out[y * PSZ + x] = s;
      }
      return out;
    }
    function _synthCos(a, b) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i] * b[i]; return s / a.length; }
    function _synthPatch(cx, cy) {
      var PSZ = SYNTH_PS, side = SYNTH_PATCH_GAP * gap, out = new Float32Array(PSZ * PSZ);
      var W2 = raster.width, H2 = raster.height, d = raster.data;
      for (var py = 0; py < PSZ; py++) for (var px = 0; px < PSZ; px++) {
        var sx = cx - side / 2 + (px + 0.5) * side / PSZ, sy = cy - side / 2 + (py + 0.5) * side / PSZ;
        var x0 = Math.max(0, Math.min(W2 - 1, Math.floor(sx))), y0 = Math.max(0, Math.min(H2 - 1, Math.floor(sy)));
        var x1 = Math.min(W2 - 1, x0 + 1), y1 = Math.min(H2 - 1, y0 + 1);
        var fx = sx - x0, fy = sy - y0;
        function lumAt(xx, yy) { var ii = (yy * W2 + xx) * 4; return 0.299 * d[ii] + 0.587 * d[ii + 1] + 0.114 * d[ii + 2]; }
        out[py * PSZ + px] = lumAt(x0, y0) * (1 - fx) * (1 - fy) + lumAt(x1, y0) * fx * (1 - fy) +
                             lumAt(x0, y1) * (1 - fx) * fy + lumAt(x1, y1) * fx * fy;
      }
      return out;
    }
    function _synthVariants() {
      if (_synthTVCache || !LREFS) return _synthTVCache;
      var _synthTV;
      var SIGMAS = [0.6, 1.0, 1.5, 2.1, 2.8, 3.6];
      _synthTV = {};
      // per-node reference pools ONLY: pooling W↔E was tried (same font, and
      // doubling exemplars is tempting) and produced the one agreeing-wrong
      // commit ever measured (share-W read 2 for a 1) — the face-gradient
      // difference matters more than exemplar count
      var SOURCES = { N: ["N"], S: ["S"], W: ["W"], E: ["E"] };
      ["N", "S", "W", "E"].forEach(function (k) {
        _synthTV[k] = {};
        SOURCES[k].forEach(function (srcK) {
          Object.keys(LREFS[srcK] || {}).forEach(function (cls) {
            var arr = _synthTV[k][cls] = _synthTV[k][cls] || [];
            (LREFS[srcK][cls] || []).forEach(function (ref) {
              var base = new Float32Array(ref.q);
              SIGMAS.forEach(function (sg) {
                var b = _synthBlur(base, sg);
                arr.push({ raw: _synthZnorm(b), grad: _synthGrad(b) });
              });
            });
          });
        });
      });
      _synthTVCache = _synthTV;
      return _synthTVCache;
    }
    function synthLevelRescue(kind, p) {
      var dbgS = out._debug ? ((out._debug.synth = out._debug.synth || {})) : null;
      var tv = _synthVariants();
      if (!tv || !tv[kind] || !Object.keys(tv[kind]).length) { if (dbgS) dbgS[kind] = "no-refs"; return null; }
      var cx, cy, wideScan = false;
      if (kind === "N" || kind === "S") { cx = p.x; cy = p.y + gap * 0.175; }
      else {
        // W/E: anchor on the BELOW-CENTER Lv line (the caption band above is a trap)
        var lbox = { x: p.x - gap * 0.5, y: p.y - gap * 0.02, w: gap * 1.0, h: gap * 0.38 };
        var lopts = {
          rejectFill: 0.22, maxRowFill: 0.6,
          minH: Math.max(4, Math.round(gap * 0.05)), maxH: Math.round(gap * 0.22), minRowPx: 3,
          accept: function (r) { return Math.abs(r.x + r.w / 2 - p.x) <= gap * 0.28 && r.w >= gap * 0.03 && r.w <= gap * 0.85; }
        };
        var lline = L.findMaskedTextLine(raster, lbox, L.isGoldText, lopts);
        if (!lline) lline = L.findMaskedTextLine(raster, lbox, L.isGoldText, Object.assign({}, lopts, { minRowPx: 1 }));
        if (!lline) {
          var lrelax = function (r2, g2, b2) { var c2 = L.hsv(r2, g2, b2); return c2.h >= 28 && c2.h <= 72 && c2.s > 0.28 && c2.v > 0.42; };
          lline = L.findMaskedTextLine(raster, lbox, lrelax, Object.assign({}, lopts, { minRowPx: 1 }));
        }
        if (!lline || lline.w < gap * 0.18) {
          // NO locatable line — or only a FRAGMENT (a full "Lv. N" line is
          // ≥0.27 gap wide; a 0.11-gap fragment's right edge points nowhere
          // near the digit, which is how t8-E anchored off garbage) — position
          // becomes a fitted parameter: scan the whole plausible Lv-digit
          // region (covers 1-line and 2-line name layouts). The agreement gate
          // stays the arbiter; refusal is still the default.
          cx = p.x + gap * 0.16; cy = p.y + gap * 0.17; wideScan = true;
        } else {
          cx = lline.x + lline.w - gap * 0.05; cy = lline.y + lline.h / 2;
        }
      }
      var xspan = wideScan ? 0.11 : (kind === "W" || kind === "E") ? 0.07 : 0.03;
      var yspan = wideScan ? 0.12 : 0.03;
      var perRaw = {}, perGrad = {}, dy, dx, cls, i;
      for (dy = -yspan; dy <= yspan + 0.0001; dy += 0.0075) {
        for (dx = -xspan; dx <= xspan + 0.0001; dx += 0.0075) {
          var op = _synthPatch(cx + dx * gap, cy + dy * gap);
          var oraw = _synthZnorm(op), ograd = _synthGrad(op);
          for (cls in tv[kind]) {
            var arr = tv[kind][cls];
            for (i = 0; i < arr.length; i++) {
              var sr = _synthCos(oraw, arr[i].raw);
              if (!(cls in perRaw) || sr > perRaw[cls]) perRaw[cls] = sr;
              var sg = _synthCos(ograd, arr[i].grad);
              if (!(cls in perGrad) || sg > perGrad[cls]) perGrad[cls] = sg;
            }
          }
        }
      }
      function rank(per) {
        return Object.keys(per).map(function (v) { return { v: parseInt(v, 10), s: per[v] }; })
          .sort(function (a, b) { return b.s - a.s; });
      }
      var ra = rank(perRaw), rg = rank(perGrad);
      if (!ra.length || !rg.length) { if (dbgS) dbgS[kind] = "no-scores"; return null; }
      var gm = rg.length > 1 ? rg[0].s - rg[1].s : 1;
      if (dbgS) dbgS[kind] = "raw " + ra[0].v + "@" + ra[0].s.toFixed(3) + " grad " + rg[0].v + "@" + rg[0].s.toFixed(3) + " gm " + gm.toFixed(3);
      // COMMIT GATE: both scorings agree on the winner, gradient margin above a
      // NODE-SPECIFIC noise floor: S needs 0.015 (its gold-on-gold correlations
      // run tighter spreads — a clean capture's S once agree-wronged at exactly
      // 0.010), the others 0.01 (t6-E's correct fill sits at 0.012). Callers
      // that OVERRIDE an existing read demand ≥ 0.03 via the returned gm.
      if (ra[0].v !== rg[0].v) return null;
      if (gm < (kind === "S" ? 0.015 : 0.01)) return null;
      return { value: ra[0].v, conf: 0.55, gm: gm };
    }

    // ---- name-band synthesis (same method, 6-class, wide patches) ----
    var NPW = 48, NPH = 16;
    function _nZnorm(p2) {
      var out = new Float32Array(p2.length), mean = 0, i;
      for (i = 0; i < p2.length; i++) mean += p2[i];
      mean /= p2.length;
      var va = 0;
      for (i = 0; i < p2.length; i++) { out[i] = p2[i] - mean; va += out[i] * out[i]; }
      var sd = Math.sqrt(va / p2.length) || 1;
      for (i = 0; i < out.length; i++) out[i] /= sd;
      return out;
    }
    function _nGrad(p2) {
      var g = new Float32Array(NPW * NPH);
      for (var y = 1; y < NPH - 1; y++) for (var x = 1; x < NPW - 1; x++) {
        var dx = p2[y * NPW + x + 1] - p2[y * NPW + x - 1], dy = p2[(y + 1) * NPW + x] - p2[(y - 1) * NPW + x];
        g[y * NPW + x] = Math.sqrt(dx * dx + dy * dy);
      }
      return _nZnorm(g);
    }
    function _nBlur(p2, sigma) {
      var r = Math.max(1, Math.ceil(sigma * 2.5)), k = [], ks = 0, i;
      for (i = -r; i <= r; i++) { var v = Math.exp(-i * i / (2 * sigma * sigma)); k.push(v); ks += v; }
      for (i = 0; i < k.length; i++) k[i] /= ks;
      var tmp = new Float32Array(NPW * NPH), out = new Float32Array(NPW * NPH), x, y, s, j;
      for (y = 0; y < NPH; y++) for (x = 0; x < NPW; x++) {
        s = 0;
        for (j = -r; j <= r; j++) s += p2[y * NPW + Math.max(0, Math.min(NPW - 1, x + j))] * k[j + r];
        tmp[y * NPW + x] = s;
      }
      for (y = 0; y < NPH; y++) for (x = 0; x < NPW; x++) {
        s = 0;
        for (j = -r; j <= r; j++) s += tmp[Math.max(0, Math.min(NPH - 1, y + j)) * NPW + x] * k[j + r];
        out[y * NPW + x] = s;
      }
      return out;
    }
    function _nPatch(cx, cy) {
      var out = new Float32Array(NPW * NPH);
      var bw = gap * 1.06, bh = gap * 0.34;
      var W2 = raster.width, H2 = raster.height, d = raster.data;
      function lumAt(xx, yy) { var ii = (yy * W2 + xx) * 4; return 0.299 * d[ii] + 0.587 * d[ii + 1] + 0.114 * d[ii + 2]; }
      for (var py = 0; py < NPH; py++) for (var px = 0; px < NPW; px++) {
        var sx = cx - bw / 2 + (px + 0.5) * bw / NPW, sy = cy - bh / 2 + (py + 0.5) * bh / NPH;
        var x0 = Math.max(0, Math.min(W2 - 1, Math.floor(sx))), y0 = Math.max(0, Math.min(H2 - 1, Math.floor(sy)));
        var x1 = Math.min(W2 - 1, x0 + 1), y1 = Math.min(H2 - 1, y0 + 1);
        var fx = sx - x0, fy = sy - y0;
        out[py * NPW + px] = lumAt(x0, y0) * (1 - fx) * (1 - fy) + lumAt(x1, y0) * fx * (1 - fy) +
                             lumAt(x0, y1) * (1 - fx) * fy + lumAt(x1, y1) * fx * fy;
      }
      return out;
    }
    function _nsynthVariants() {
      if (_nsynthTVCache || !NREFS) return _nsynthTVCache;
      var SIGMAS = [0.5, 0.9, 1.4, 2.0];
      var _nsynthTV = { W: {}, E: {} };
      ["W", "E"].forEach(function (k) {
        var other = k === "W" ? "E" : "W";
        var names = {};
        Object.keys(NREFS[k] || {}).forEach(function (n) { names[n] = NREFS[k][n]; });
        // other-side fill ONLY for classes this side has never seen (name bands
        // are big white text — cross-side transfer is safe for absent classes,
        // and same-side refs stay primary; digit-pooling's lesson respected)
        Object.keys(NREFS[other] || {}).forEach(function (n) { if (!names[n]) names[n] = NREFS[other][n]; });
        Object.keys(names).forEach(function (n) {
          var arr = [];
          names[n].forEach(function (ref) {
            var base = new Float32Array(ref.q);
            SIGMAS.forEach(function (sg) {
              var b = _nBlur(base, sg);
              arr.push({ raw: _nZnorm(b), grad: _nGrad(b) });
            });
          });
          _nsynthTV[k][n] = arr;
        });
      });
      _nsynthTVCache = _nsynthTV;
      return _nsynthTVCache;
    }
    // Classify the name band against reference patches; candidates constrained to
    // `allowed` (the cost pool) minus `avoid`. Same dual-scoring agreement gate.
    function synthNameRescue(kind, p, allowed, avoid) {
      var tv = _nsynthVariants();
      if (!tv || !tv[kind]) return null;
      var cands = Object.keys(tv[kind]).filter(function (n) {
        if (avoid && n === avoid) return false;
        if (allowed && allowed.indexOf(n) === -1) return false;
        return true;
      });
      if (cands.length < 2) return null;   // a 1-candidate "choice" proves nothing
      var cx = p.x, cy = p.y - gap * 0.16;
      var perRaw = {}, perGrad = {}, dy, dx, i;
      for (dy = -0.03; dy <= 0.0301; dy += 0.01) {
        for (dx = -0.03; dx <= 0.0301; dx += 0.01) {
          var op = _nPatch(cx + dx * gap, cy + dy * gap);
          var oraw = _nZnorm(op), ograd = _nGrad(op);
          for (i = 0; i < cands.length; i++) {
            var n = cands[i], arr = tv[kind][n];
            for (var j = 0; j < arr.length; j++) {
              var sr = 0, sg = 0, a = arr[j];
              for (var q2 = 0; q2 < oraw.length; q2++) { sr += oraw[q2] * a.raw[q2]; sg += ograd[q2] * a.grad[q2]; }
              sr /= oraw.length; sg /= oraw.length;
              if (!(n in perRaw) || sr > perRaw[n]) perRaw[n] = sr;
              if (!(n in perGrad) || sg > perGrad[n]) perGrad[n] = sg;
            }
          }
        }
      }
      function rank(per) {
        return Object.keys(per).map(function (n) { return { n: n, s: per[n] }; })
          .sort(function (a, b) { return b.s - a.s; });
      }
      var ra = rank(perRaw), rg = rank(perGrad);
      if (!ra.length || !rg.length) return null;
      var gmN = rg.length > 1 ? rg[0].s - rg[1].s : 1;
      if (out._debug) (out._debug.synthName = out._debug.synthName || {})[kind] =
        "raw " + ra[0].n + "@" + ra[0].s.toFixed(3) + " | grad " + rg[0].n + "@" + rg[0].s.toFixed(3) + " gm " + gmN.toFixed(3);
      if (ra[0].n !== rg[0].n) return null;
      if (gmN < 0.015) return null;
      return ra[0].n;
    }

    // Read one level node: return the committed digit (template if strong, else the
    // OCR ladder — "Lv. N" isolation is the hard case) AND the raw template score
    // vector (feeds the constraint enumeration for the weak/free nodes below).
    // hasLvPrefix (W/E): the digit is BY CONSTRUCTION the last box of the line and
    // sits right of the "Lv. " prefix — a live native frame (41d1b9bb) had the 'L'
    // erode to a 5px sliver that classified as '1' @0.91 while the true '2' eroded
    // into a '/', so the L committed at 0.95 and the checksum pushed the error into
    // the free S node: a SILENT coherent-wrong board. Structure beats scores here.
    async function readLevelFull(p, isGoldFace, hasLvPrefix, nodeKind) {
      var box = { x: p.x - gap * 0.5, y: p.y - gap * 0.35, w: gap * 1.0, h: gap * 0.72 };
      var pred = L.isGoldText;
      if (isGoldFace) {
        // tight, digit-centred box: the wide generic box mixes dark nebula corners
        // into the median, dragging the luminance threshold under the FACE level so
        // the whole diamond passes and the locate rejects (measured onFrac 0.31)
        box = { x: p.x - gap * 0.35, y: p.y - gap * 0.06, w: gap * 0.7, h: gap * 0.42 };
      }
      if (isGoldFace) {
        // GOLD-ON-GOLD (the S/order digit): the ink is VIVID pure yellow (s≈0.9)
        // while the face is muted brown-gold (s≈0.5) and its specular sheen washes
        // toward WHITE (s drops further) — saturation separates what luminance and
        // plain chroma could not. The white "Chaos/Order Points" label (s≈0) is out
        // by construction.
        pred = function (r, g, b) {
          var c = L.hsv(r, g, b);
          return c.h >= 42 && c.h <= 64 && c.s > 0.72 && c.v > 0.7;
        };
        if (out._debug) {
          var mT = L.chromaMask(L.crop(raster, box), pred), onN = 0;
          for (var mi = 0; mi < mT.data.length; mi += 4) if (mT.data[mi] < 128) onN++;
          out._debug.sMask = { onFrac: Math.round(onN / (mT.width * mT.height) * 1000) / 1000, boxW: mT.width, boxH: mT.height };
        }
      }
      var lineOptsLv = {
        rejectFill: 0.22, maxRowFill: 0.6,
        minH: Math.max(4, Math.round(gap * 0.05)), maxH: Math.round(gap * 0.22), minRowPx: 3,
        accept: function (r) { var c = r.x + r.w / 2; return Math.abs(c - p.x) <= gap * 0.28 && r.w >= gap * 0.03 && r.w <= gap * 0.85; }
      };
      var line = L.findMaskedTextLine(raster, box, pred, lineOptsLv);
      // erosion rescue (windowed native scale, gap≈202): the digit mask is clean but
      // its thinnest rows carry 1-2 pixels, under minRowPx — a live willpower '2'
      // located as NULL, leaving {N,S} both free and the enumeration tie-breaking
      // blind. Retry relaxed ONLY after the standard locate fails; not for the
      // gold-face S node, where a relaxed locate latches onto specular noise.
      if (!line && !isGoldFace) {
        // retry BELOW CENTER only: the digit/Lv line always sits there, and the
        // relaxed row threshold otherwise latches onto the caption band above
        // (measured -0.364 gap on the chat tier — it read caption garbage)
        var boxLow = { x: box.x, y: p.y - gap * 0.02, w: box.w, h: gap * 0.38 };
        line = L.findMaskedTextLine(raster, boxLow, pred, Object.assign({}, lineOptsLv, { minRowPx: 1 }));
      }
      if (out._debug && isGoldFace) out._debug.sLine = line ? { x: Math.round(line.x), y: Math.round(line.y), w: Math.round(line.w), h: Math.round(line.h) } : null;
      if (!line) {
        // no locatable line at all — the synthesis rescue is the only reader left
        // (it anchors itself: fixed offsets for bare digits, its own below-center
        // locate for W/E) and this no-line path is precisely where the degraded
        // tier lands
        if (LREFS && nodeKind) {
          var sr0 = synthLevelRescue(nodeKind, p);
          if (sr0) return { value: sr0.value, conf: isGoldFace ? Math.min(sr0.conf, 0.5) : sr0.conf, vec: null, src: "synth" };
        }
        return { value: null, conf: 0, vec: null };
      }
      var grow = Math.round(line.h * 0.5);
      var lineX = { x: line.x, y: line.y - grow, w: line.w, h: line.h + grow * 2 };

      // template pass: rightmost digit-classified box → value + score vector
      var vec = null, tmVal = null, tmConf = 0;
      if (GLYPHS) {
        var mask = L.chromaMask(L.crop(raster, lineX), pred);
        var boxes = segmentDigitBoxes(mask);
        var db = null, dbBox = null, lvDet = out._debug ? [] : null;
        if (lvDet) for (var li = 0; li < boxes.length; li++) {
          var svd = digitScoreVec(mask, boxes[li]);
          lvDet.push(Math.round(boxes[li].x) + "+" + Math.round(boxes[li].w) + "x" + Math.round(boxes[li].h) +
            (svd.full ? "=" + svd.full.ch + ":" + svd.full.score.toFixed(2) : "=?") + (svd.isDigit ? "*" : ""));
        }
        // Prefixed nodes ("Lv. N"): the digit lives RIGHT of the prefix — "Lv. "
        // owns the left ~60% of the line, so boxes there are letters no matter how
        // digit-like they score (the eroded-'L'→'1' silent). Commit = last
        // digit-classified box in the right zone; when none classifies, the
        // rightmost in-zone box still donates its score vector to the solver.
        // Bare-digit nodes (N/S) have no prefix to fake digits, keep the plain
        // last-digit-classified rule.
        for (var i = 0; i < boxes.length; i++) {
          var bx = boxes[i];
          if (hasLvPrefix && (bx.x + bx.w / 2) <= mask.width * 0.55) continue;
          var sv = digitScoreVec(mask, bx);
          if (sv.isDigit) { db = sv; dbBox = bx; }
          else if (hasLvPrefix && !db) db = { vec: sv.vec, top: sv.top, isDigit: false };   // vec-only candidate
        }
        if (lvDet) (out._debug.lvDetail = out._debug.lvDetail || []).push(
          { line: { x: Math.round(lineX.x), y: Math.round(lineX.y), w: Math.round(lineX.w), h: Math.round(lineX.h) }, boxes: lvDet.join(" ") });
        // NARROW-FRAGMENT re-mask (the absorber shape): at the windowed tiers the
        // digit's antialiased strokes BLEND with the face tint (gold-over-green
        // shifts hue to ~80) and isGoldText erodes the glyph to a sliver that
        // classifies '1' (live 2aa9a4b2: green "Lv. 3" → a 6x16 fragment →
        // '1'@0.82, SILENT). Re-mask with a blend-tolerant pred (h up to <100 —
        // true face greens stay out; ≥22 — face reds stay out) and re-take the
        // SAME glyph, matched by its right edge. Adoption needs a now-WIDE box
        // classifying at the full commit bars — and a wide box is IoU-vetoable
        // downstream, which the sliver never was. A true '1' stays narrow under
        // the relaxed mask too, so this cannot rewrite genuine ones; clean
        // frames produce full-width digits and never enter this branch.
        if (!isGoldFace && db && db.isDigit && dbBox && dbBox.w / Math.max(1, dbBox.h) < 0.45) {
          var lvPredRelaxed = function (r2, g2, b2) {
            var c2 = L.hsv(r2, g2, b2);
            return c2.h >= 22 && c2.h < 100 && c2.s > 0.35 && c2.v > 0.5;
          };
          var maskR = L.chromaMask(L.crop(raster, lineX), lvPredRelaxed);
          var boxesR = segmentDigitBoxes(maskR);
          var re = null, reBox = null;
          for (var rj = 0; rj < boxesR.length; rj++) {
            var bR = boxesR[rj];
            if (Math.abs((bR.x + bR.w) - (dbBox.x + dbBox.w)) > 4) continue;   // same glyph only
            if (bR.w / Math.max(1, bR.h) < 0.45) continue;                     // still a sliver — no gain
            var svR = digitScoreVec(maskR, bR);
            if (svR.isDigit) { re = svR; reBox = bR; }
          }
          if (re) {
            db = re; dbBox = reBox; mask = maskR;
            if (out._debug) (out._debug.lvRelax = out._debug.lvRelax || {})[nodeKind] =
              Math.round(reBox.w) + "x" + Math.round(reBox.h) + "=" + re.full.ch + ":" + re.full.score.toFixed(2);
          }
        }
        if (db) {
          vec = db.vec;
          var b1 = -1, b1v = null, b2 = -1;
          for (var v = 1; v <= 5; v++) { var s = db.vec[v]; if (s > b1) { b2 = b1; b1 = s; b1v = v; } else if (s > b2) b2 = s; }
          if (db.isDigit && dbBox && b1 >= 0.78 && (b1 - b2) >= 0.05) {
            // proven bitmapSim commit — but ink-IoU gets a VETO: sim's background-
            // dominated score let a live "Lv. 5" read as a confident 3 (which the
            // checksum then propagated into the unreadable S digit). If IoU clearly
            // prefers a DIFFERENT digit, do not commit — fall to OCR / the solve.
            var vetoed = false;
            if (DIGIT_ATLAS && dbBox.w / Math.max(1, dbBox.h) >= 0.45) {
              var im = iouDigit(mask, dbBox, ["1", "2", "3", "4", "5"]);
              if (im && im.ch !== String(b1v) && im.margin >= 0.08) vetoed = true;
            }
            if (!vetoed) { tmVal = b1v; tmConf = Math.min(0.95, 0.75 + (b1 - b2) * 2); }
          }
        }
      }
      if (tmVal != null) {
        // the luminance-read S digit is real evidence, but the face is hostile ground
        // — cap it so the checksum solve still arbitrates (and flags) disagreements.
        // Gold-face template reads also get a synthesis CROSS-CHECK: at degraded
        // tiers a noise blob can template-match a digit (t6: a junk '1' returned
        // here and blocked every later rung); a strong synth disagreement wins,
        // agreement or a refused gate keeps the template read.
        // NARROW boxes get the same cross-check on EVERY node: w/h < 0.45 is
        // exactly the shape the ink-IoU veto above must skip, and it is the
        // doppelgänger-absorber shape — a mask fragment of a wider digit
        // template-matches '1' (live 2aa9a4b2: green "Lv. 3" lost its left
        // half, the 6x16 sliver committed '1'@0.82 SILENTLY and the checksum
        // pushed the error into a synth-refuted S). Wide boxes → IoU veto;
        // narrow boxes → synthesis veto. No commit escapes both.
        if (LREFS && nodeKind && (isGoldFace || (dbBox && dbBox.w / Math.max(1, dbBox.h) < 0.45))) {
          var srT = synthLevelRescue(nodeKind, p);
          // OVERRIDE bar: replacing a committed template read needs gm ≥ 0.03
          // (a clean capture's correct '3' was once overridden by an
          // agreeing-wrong '5' at a sub-0.015 margin)
          if (srT && srT.value !== tmVal && srT.gm >= 0.03) { tmVal = srT.value; tmConf = 0.5; }
        }
        return { value: tmVal, conf: isGoldFace ? Math.min(tmConf, 0.6) : tmConf, vec: vec, src: "tm" };
      }
      // OCR ladder (proven on "Lv. N"): plain → single-char → dilate
      var read = await maskedOcr(lineX, pred, { whitelist: "Lv.12345 ", psm: 7 });
      var m = read.text.match(/([1-5])\s*$/) || read.text.match(/([1-5])/);
      if (!m) { read = await maskedOcr(lineX, pred, { whitelist: "12345", psm: 10 }); m = read.text.match(/([1-5])/); }
      if (!m) {
        read = await dilatedOcr(L.crop(raster, lineX), pred, { scale: "auto", maxAuto: 5, whitelist: "Lv.12345 ", psm: 7 });
        m = read.text.match(/([1-5])\s*$/) || read.text.match(/([1-5])/);
      }
      var conf = m ? Math.min(0.9, read.conf + 0.2) : 0;
      if (isGoldFace) conf = Math.min(conf, 0.45);
      if (LREFS && nodeKind && (!m || conf < 0.5)) {
        // last rung: analysis-by-synthesis vs the pristine reference patches —
        // agreement-gated, modest conf; the checksum arbitrates from here (and
        // for S the value flows through the sHint channel, never pinned). It also
        // arbitrates a sub-0.5 OCR read: at that confidence the ladder is
        // guessing (dilated OCR hallucinates '1's on degraded masks and the junk
        // read was BLOCKING this rung), while the agreement gate measured
        // 8 correct commits / 0 wrong ones on the degraded corpus. AGREEMENT
        // keeps the OCR provenance (vec intact for the corroborator) with a lift;
        // only DISAGREEMENT replaces the read.
        var sr = synthLevelRescue(nodeKind, p);
        if (sr) {
          var mVal = m ? parseInt(m[1], 10) : null;
          if (mVal != null && mVal === sr.value) {
            return { value: mVal, conf: Math.max(conf, isGoldFace ? 0.45 : 0.55), vec: vec, src: "ocr" };
          }
          // null-fill at the base gate; OVERRIDING a read value needs gm ≥ 0.03
          if (mVal == null || sr.gm >= 0.03) {
            return { value: sr.value, conf: isGoldFace ? Math.min(sr.conf, 0.5) : sr.conf, vec: vec, src: "synth" };
          }
        }
      }
      return { value: m ? parseInt(m[1], 10) : null, conf: conf, vec: vec, src: "ocr" };
    }
    // the four node reads are data-independent — issue them CONCURRENTLY so the
    // OCR pool (parse-worker.js) can overlap them; with a single serialized OCR
    // backend (Node eval, inline fallback) the queue preserves old behavior
    var lvFull = await Promise.all([
      readLevelFull(nodes.nodeN, false, false, "N"),   // willpower (bare digit)
      readLevelFull(nodes.nodeW, false, true, "W"),    // effect1 ("Lv. N")
      readLevelFull(nodes.nodeE, false, true, "E"),    // effect2 ("Lv. N")
      readLevelFull(nodes.nodeS, true, false, "S")     // order (gold-on-gold bare digit)
    ]);
    // The S (order) luminance read is a HINT, never a pinned value: at low res the
    // gold-on-gold digit is marginal and a wrong pin corrupts the checksum's
    // arithmetic. The hint breaks enumeration ties (this is what un-swaps a live
    // "Atk Power 5 / Chaos Points 3" board) and corroborates-or-flags the solved S.
    tmark("levelReads");
    var sHint = lvFull[3].value;
    lvFull[3] = { value: null, conf: 0, vec: lvFull[3].vec };
    var scoreVecs = lvFull.map(function (r) { return r.vec; });
    if (out._debug) out._debug.levelReads = lvFull.map(function (r) { return r.value + "@" + r.conf.toFixed(2); }).concat("sHint=" + sHint);

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
            // The S-hint participates in the BOUNDS (never pinned): on three live
            // misses the hint was right (1/4/4) while the header's second digit
            // matched a lookalike — hint-tightened bounds prune those candidates,
            // and a wrong hint only yields a wrong-but-SOFT pts the solve flags.
            if (sHint != null && nUnk > 0) { kSum += sHint; nUnk--; }
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
                // 0.36 floor: a 0.30-0.33 IoU is noise-level — committing it beat the
                // (better) run-OCR rescue to a WRONG value on two live '13' headers
                if (dm && dm.score >= 0.36) { dch = dm.ch; dsc = dm.score; }
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
            } else if (aIdx >= 1) {
              // template couldn't resolve the digit run (a dim '3' matches nothing
              // well) — OCR the RUN CROP alone at high magnification; accept only a
              // bounds-consistent value, always soft
              var runX0 = tgP[0].box.x, runX1 = tgP[aIdx - 1].box.x + tgP[aIdx - 1].box.w;
              var runBox = { x: ptsRect.x + Math.max(0, runX0 - 3), y: ptsRect.y, w: (runX1 - runX0) + 6, h: ptsRect.h };
              var runSub = L.crop(raster, runBox);
              var runRead = await dilatedOcr(runSub, dimBtnWhite, { scale: 4, whitelist: "0123456789", psm: 7 });
              var runM = (runRead.text || "").match(/(\d{1,2})/);
              if (runM) {
                var rv2 = parseInt(runM[1], 10);
                if (rv2 >= Math.max(4, loP) && rv2 <= Math.min(20, hiP)) { ptsT = rv2; ptsTSoft = true; }
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
      var dRead = await dilatedOcr(ptsSub, L.isWhiteText, { scale: "auto", psm: 7 });
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
    // TWO OR MORE synth commits mean the frame sits at the degraded tier where
    // the header read is junk-prone too (live: "18" on a 15-point board arrived
    // as a HARD read and bulldozed a correct gold hint) — demote pts to soft
    // authority there. One incidental synth consult on an otherwise-clean frame
    // is NOT the signature (requiring 2 keeps clean-frame confidences intact).
    var _synthCommits = lvFull.filter(function (r) { return r && r.src === "synth"; }).length;
    if (pts != null && !ptsSoft && _synthCommits >= 2) ptsSoft = true;

    // ---- JOINT LEVEL SOLVE ----
    // The 4 levels are 1-5 and SUM to the header points — a hard constraint that
    // couples the nodes. Pick the assignment maximizing total template score subject
    // to that sum; the unreadable gold-on-gold S digit is then forced by the other
    // three + points, not guessed. Each node's confidence = how much total score
    // you'd sacrifice to change JUST it (constraint-forced => near-certain; two
    // near-tied assignments => flagged). One solver, no special cases.
    function nodeScore(i, v) { return scoreVecs[i] ? (scoreVecs[i][v] || 0) : 0; }
    // FEASIBILITY GATE on the finished pts read (all rungs, not just the template
    // path): committed levels + the S-hint bound the possible total. Applied only
    // with ≥2 unknown nodes — there a wrong pts FORCES garbage assignments with no
    // way back (live: a blurred '15' OCR'd as '18' excluded the true levels
    // entirely); with 0-1 unknowns the existing mismatch machinery arbitrates.
    if (pts != null) {
      var kSumF = 0, nUnkF = 0;
      for (var kf = 0; kf < 4; kf++) { if (lvFull[kf].value != null) kSumF += lvFull[kf].value; else nUnkF++; }
      var hintF = (sHint != null && nUnkF > 0) ? 1 : 0;
      // a SOFT pts read doesn't get to lean on the hint: on the degraded tier a
      // junk header read (t6 live: "18", truth 15) slipped this gate via hint
      // credit and forced the free pair onto an infeasible sum
      if (ptsSoft ? nUnkF >= 2 : (nUnkF - hintF) >= 2) {
        var kAdj = kSumF + (hintF ? sHint : 0), uAdj = nUnkF - hintF;
        if (pts < Math.max(4, kAdj + uAdj) || pts > Math.min(20, kAdj + 5 * uAdj)) { pts = null; ptsSoft = false; }
      }
    }
    var indep = lvFull.map(function (r) { return { v: r.value, conf: r.conf }; });
    // PIN every committed read (template OR OCR, any confidence): the constraint must
    // NEVER override a value we actually read — it only FILLS truly-null nodes and
    // resolves a sum mismatch. (Overriding low-conf-but-correct reads was the
    // regression.) A committed read keeps its own confidence unless the checksum
    // confirms it. Free nodes (gold-on-gold S, unreadable blur) are the null ones.
    var pinned = indep.map(function (x) { return x.v != null; });
    var levels = [null, null, null, null], conf4 = [0, 0, 0, 0];
    var enumAssigned = [false, false, false, false];
    var freeIdx = [];
    for (var i = 0; i < 4; i++) { if (pinned[i]) { levels[i] = indep[i].v; conf4[i] = indep[i].conf; } else freeIdx.push(i); }

    if (pts != null) {
      var pinnedSum = 0; for (var pI = 0; pI < 4; pI++) if (pinned[pI]) pinnedSum += levels[pI];
      var remaining = pts - pinnedSum;
      if (freeIdx.length === 0) {
        if (remaining === 0) {
          // all four read AND they sum to points: mutually corroborated — but lift
          // proportionally (same coordinated-error risk as the 3-known solve: a
          // wrong pts offsetting one wrong level), so a near-guess stays flagged
          for (var bi = 0; bi < 4; bi++) {
            conf4[bi] = Math.max(conf4[bi], Math.min(ptsSoft ? 0.85 : 0.92, indep[bi].conf + 0.25));
          }
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
          if (!ptsSoft) {
            // The checksum closing CORROBORATES the siblings — it is not proof. A
            // wrong pts plus one wrong level can cohere (seen live: pts '8'→'6'
            // with wp '3'→'1' promoted a 0.52 willpower read to confident). Lift
            // each sibling proportionally to its OWN evidence: a near-guess
            // (<0.55) stays under the 0.8 flag threshold no matter what.
            for (var sb = 0; sb < 4; sb++) if (sb !== fi) conf4[sb] = Math.max(conf4[sb], Math.min(0.88, indep[sb].conf + 0.25));
            conf4[fi] = Math.min(0.85, 0.5 + minSib * 0.5);
          } else conf4[fi] = Math.min(0.65, 0.55 + minSib * 0.4);
          // S-hint arbitration (after the base assignment so it can't be clobbered):
          // the luminance read agreeing with the arithmetic solve is independent
          // corroboration; disagreement drops S into hard-flag territory
          if (fi === 3 && sHint != null) {
            conf4[3] = sHint === remaining ? Math.max(conf4[3], 0.85) : Math.min(conf4[3], 0.5);
            // ...and when the pts read is SOFT, a disagreeing hint WINS the value:
            // soft header reads at the degraded tier are junk-prone (t6 live read
            // "18" on a 15-point board and arithmetic wrote S=4 over a correct
            // hint of 1), while the hint channel is gated evidence
            if (ptsSoft && sHint !== remaining) { levels[3] = sHint; conf4[3] = 0.5; }
            else if (sHint !== remaining) {
              // FIRM pts disagreeing with the hint: the arithmetic blames S, but
              // the hint is gated evidence — the likelier culprit is a '1'-valued
              // W/E sibling (the ABSORBER class: eroded L→1, mask-fragment→1;
              // live 2aa9a4b2: a green "Lv. 3" fragment committed '1'@0.82 and
              // the checksum wrote S=3 over a gm-0.113 synth S=1). Test each such
              // sibling: does the SYNTHESIS prefer the value implied by S=hint?
              // Flip on the standard override bar; otherwise demote the sibling
              // below the flag line — the mismatch proves something here is
              // wrong, and a confident sibling is the one silent shape left.
              var flipped = false;
              for (var si = 1; si <= 2; si++) {
                if (flipped || !pinned[si] || levels[si] !== 1) continue;
                var vImp = remaining + 1 - sHint;   // sibling value if S = hint
                if (vImp >= 2 && vImp <= 5 && LREFS) {
                  var srF = synthLevelRescue(si === 1 ? "W" : "E", si === 1 ? nodes.nodeW : nodes.nodeE);
                  if (srF && srF.value === vImp && srF.gm >= 0.03) {
                    levels[si] = vImp; conf4[si] = 0.75;
                    levels[3] = sHint; conf4[3] = 0.85;
                    flipped = true;
                    continue;
                  }
                }
                conf4[si] = Math.min(conf4[si], 0.75);   // zero-silent guarantee
              }
            }
          }
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
          combos.forEach(function (cm) {
            cm._s = 0;
            for (var q = 0; q < freeIdx.length; q++) {
              cm._s += nodeScore(freeIdx[q], cm[q]);
              // the S luminance hint breaks otherwise-blind ties: without it, a
              // free {effect, order} pair got split by generation order (the live
              // "Atk Power 5 / Chaos Points 3" board came out swapped)
              if (freeIdx[q] === 3 && sHint != null && cm[q] === sHint) cm._s += 0.3;
            }
          });
          combos.sort(function (x, y) { return y._s - x._s; });
          var best = combos[0];
          for (var q2 = 0; q2 < freeIdx.length; q2++) {
            var fidx = freeIdx[q2];
            var alt = -Infinity;
            for (var r = 1; r < combos.length; r++) { if (combos[r][q2] !== best[q2]) { alt = combos[r]._s; break; } }
            levels[fidx] = best[q2];
            enumAssigned[fidx] = true;   // chosen BY the template vector — no self-corroboration
            if (alt === -Infinity) conf4[fidx] = 0.9;
            else conf4[fidx] = Math.max(0.15, Math.min(0.9, 0.5 + (best._s - alt) * 3.0));
          }
        } else { freeIdx.forEach(function (fi2) { levels[fi2] = indep[fi2].v || 1; conf4[fi2] = 0.3; }); }
      }
    }
    // no points (or unsolved free nodes): fall back to the committed per-node reads;
    // the S node takes its luminance hint instead of a blind default-to-1 (live
    // case: hint=4 correct, pts unreadable, S defaulted to 1)
    for (var f = 0; f < 4; f++) if (levels[f] == null) {
      if (f === 3 && sHint != null) { levels[3] = sHint; conf4[3] = 0.6; continue; }
      levels[f] = indep[f].v != null ? indep[f].v : 1;
      conf4[f] = indep[f].v == null ? 0 : Math.min(0.85, indep[f].conf);
    }
    if (ptsSoft) conf4 = conf4.map(function (cv) { return Math.min(cv, 0.7); });

    // TWO-CHANNEL corroborator (false-alarm reduction — every flagged-but-correct
    // field is a wasted "confirm me" tap AND a wasted AI-verifier pull): lift a
    // mid-confidence level to 0.82 when the node's own template score vector
    // INDEPENDENTLY agrees with the final value. Independence rules: enumeration
    // picks are excluded (the enumeration chose BY the vector), template-committed
    // reads are excluded (their conf already IS the vector), and the S node is
    // excluded (its hint/vector are one channel, and hint agreement already boosts
    // to 0.85). What remains — OCR-committed reads and arithmetic solves — gets a
    // genuine second witness. A real margin is required so flat noise can't vote.
    for (var vc = 0; vc < 3; vc++) {
      if (conf4[vc] < 0.5 || conf4[vc] >= 0.8) continue;
      if (enumAssigned[vc]) continue;
      if (lvFull[vc].value != null && lvFull[vc].src === "tm") continue;
      var vv = scoreVecs[vc];
      if (!vv) continue;
      var vb1 = -1, vb1v = null, vb2 = -1;
      for (var vd = 1; vd <= 5; vd++) { var vs = vv[vd]; if (vs > vb1) { vb2 = vb1; vb1 = vs; vb1v = vd; } else if (vs > vb2) vb2 = vs; }
      if (vb1v === levels[vc] && (vb1 - vb2) >= 0.03) conf4[vc] = 0.82;
    }

    out.config.willpowerLevel = levels[0]; confidence.config.willpowerLevel = conf4[0];
    out.config.effect1Level = levels[1]; confidence.config.effect1Level = conf4[1];
    out.config.effect2Level = levels[2]; confidence.config.effect2Level = conf4[2];
    out.config.orderLevel = levels[3]; confidence.config.orderLevel = conf4[3];
    if (out._debug) out._debug.pts = pts + (ptsSoft ? "(soft)" : "") + " levels=" + levels.join(",");
    tmark("ptsAndSolve");

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
    // relaxed variant for the last rescue rung: at small scales the antialiased
    // white text picks up the face tint, and the strict pred's highlight-exclusion
    // eats the TEXT itself (measured on the first flywheel record: strict mask 0.7%
    // ink → junk; this pred → a clean "Atk. Power"). Only ever used after the
    // strict rungs failed, so the highlight-pollution the strict pred exists to
    // prevent cannot regress clean frames.
    function effectNamePredRelaxed() {
      return function (r, g, b) { var c = L.hsv(r, g, b); return c.v > 0.5 && c.s < 0.45; };
    }
    async function readEffectName(p, faceHue, rung) {
      var rect = { x: p.x - gap * 0.55, y: p.y - gap * 0.34, w: gap * 1.1, h: gap * 0.36 };
      var read = rung === "relaxed"
        ? await dilatedOcr(L.crop(raster, rect), effectNamePredRelaxed(), { scale: "auto", maxAuto: 4, psm: 6 })
        : rung === "dilate"
          ? await dilatedOcr(L.crop(raster, rect), effectNamePred(faceHue), { scale: "auto", maxAuto: 4, psm: 6 })
          : await maskedOcr(rect, effectNamePred(faceHue), { psm: 6 });
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
    function lexIn(t, pool, avoid) {
      for (var i = 0; i < EFFECT_LEX.length; i++) {
        var name = EFFECT_LEX[i][0];
        if (pool && pool.indexOf(name) === -1) continue;
        if (avoid && name === avoid) continue;
        if (EFFECT_LEX[i][1].test(t)) return name;
      }
      return null;
    }
    function lexEffect(t, avoid) { return lexIn(t, poolNames, avoid); }
    // Name-read rescue ladder (the FIRST live flywheel record, 2026-07-19: a
    // share-canvas frame OCR'd "Atk. Power" as "Abo Fo" — under the Tesseract
    // floor — so both names came back null and the snap filled pool-order
    // defaults that looked like a W/E swap). Same rescue pattern every other
    // read has: plain → dilated ×auto → relaxed-pred dilated. Later rungs run
    // only when the text still lexes to nothing, so clean frames cost zero
    // extra OCR calls.
    async function readNameLadder(p, faceHue) {
      var nm = await readEffectName(p, faceHue);
      if (!lexIn(nm.text, null, null)) nm = await readEffectName(p, faceHue, "dilate");
      if (!lexIn(nm.text, null, null)) nm = await readEffectName(p, faceHue, "relaxed");
      return nm;
    }
    var nmW = await readNameLadder(nodes.nodeW, hueW);
    var nmE = await readNameLadder(nodes.nodeE, hueE);
    if (out._debug) out._debug.nmTexts = { W: nmW.text.slice(0, 60), E: nmE.text.slice(0, 60) };

    // ---- pair→cost CROSS-CHECK (before pool-constrained lexing) ----
    // The effect pair constrains the cost: some pairs exist in exactly ONE pool
    // (Additional Damage + Boss Damage ⇒ cost 10 only). If the RAW captions name
    // such a pair and it contradicts the name-suffix cost, the suffix read is the
    // likely casualty (pet occlusion / OCR mangle — Shizu's Immutability kept
    // reading as a cost-8 Stability) — adopt the pair-implied cost, re-pool, and
    // keep the cost FLAGGED for confirmation.
    var rawE1 = lexIn(nmW.text, null, null);
    var rawE2 = lexIn(nmE.text, null, rawE1);
    if (rawE1 && rawE2 && rawE1 !== rawE2 && ENGINE_API.EFFECT_POOLS) {
      var costsWithPair = Object.keys(ENGINE_API.EFFECT_POOLS).filter(function (ck) {
        var pl = ENGINE_API.EFFECT_POOLS[ck];
        return pl.indexOf(rawE1) !== -1 && pl.indexOf(rawE2) !== -1;
      }).map(Number);
      // fires on a WRONG suffix read and also on a NULL one (first flywheel
      // record: cost unreadable → snap defaulted to 10 → pool-10 canonicalization
      // rewrote two correctly-read names, which presented as a W/E "swap")
      if (costsWithPair.length === 1 && costsWithPair[0] !== out.config.baseCost) {
        out.config.baseCost = costsWithPair[0];
        confidence.config.baseCost = Math.min(confidence.config.baseCost, 0.75);   // below the flag threshold
        poolNames = (ENGINE_API.EFFECT_POOLS && ENGINE_API.EFFECT_POOLS[out.config.baseCost]) || null;
      }
    }

    out.config.effect1 = lexEffect(nmW.text, null);
    out.config.effect2 = lexEffect(nmE.text, out.config.effect1);
    // a pool-constrained lexicon hit is strong evidence even when the raw OCR conf is
    // low (mangled-but-matched text): floor at 0.82 when the pool was known
    var effFloor = poolNames ? 0.82 : 0;
    confidence.config.effect1 = out.config.effect1 ? Math.max(effFloor, Math.min(0.92, nmW.conf + 0.3)) : 0;
    confidence.config.effect2 = out.config.effect2 ? Math.max(effFloor, Math.min(0.92, nmE.conf + 0.3)) : 0;
    // name rescue ladder when the lexicon got nothing (rare1: a 2-line
    // "Ally Damage Enh." OCR'd as 'jamage and the lexicon rightly refused).
    // Rung 1 — STRUCTURE: fuzzy keyword (edit distance 1 on tokens) × measured
    // LINE COUNT × the cost pool. Each name has a fixed render: 2-line names are
    // Ally Damage Enh. / Ally Attack Enh. / Additional Damage; the rest are
    // 1-line. When exactly ONE pool candidate survives, that's a unique
    // structural identification ("jamage" ×2 lines in pool 9 ⇒ Ally Damage
    // Enh., the only 2-line damage-name there). Rung 2 — patch synthesis.
    // Both commit FLAGGED at 0.6, never the 0.82 pool floor.
    var NAME_2LINE = { "Ally Damage Enh.": 1, "Ally Attack Enh.": 1, "Additional Damage": 1 };
    var FUZZY_KEYS = [
      ["damage", ["Boss Damage", "Ally Damage Enh.", "Additional Damage"]],
      ["attack", ["Attack Power", "Ally Attack Enh."]],
      ["power", ["Attack Power", "Brand Power"]],
      ["boss", ["Boss Damage"]],
      ["brand", ["Brand Power"]],
      ["additional", ["Additional Damage"]],
      ["ally", ["Ally Damage Enh.", "Ally Attack Enh."]]
    ];
    function editDist1(a, b) {
      if (a === b) return true;
      if (Math.abs(a.length - b.length) > 1) return false;
      var i = 0, j = 0, edits = 0;
      while (i < a.length && j < b.length) {
        if (a[i] === b[j]) { i++; j++; continue; }
        if (++edits > 1) return false;
        if (a.length > b.length) i++;
        else if (b.length > a.length) j++;
        else { i++; j++; }
      }
      return edits + (a.length - i) + (b.length - j) <= 1;
    }
    function countNameLines(p) {
      var zone = { x: p.x - gap * 0.55, y: p.y - gap * 0.36, w: gap * 1.1, h: gap * 0.40 };
      var sub = L.crop(raster, zone);
      var mask = L.chromaMask(sub, L.isWhiteText);
      var rows = [], y, x;
      for (y = 0; y < mask.height; y++) {
        var on = 0;
        for (x = 0; x < mask.width; x++) if (mask.data[(y * mask.width + x) * 4] < 128) on++;
        rows.push(on);
      }
      var minPx = Math.max(2, Math.round(mask.width * 0.03));
      var bands = 0, run = 0, minRun = Math.max(3, Math.round(gap * 0.035));
      for (y = 0; y < rows.length; y++) {
        if (rows[y] >= minPx) run++;
        else { if (run >= minRun) bands++; run = 0; }
      }
      if (run >= minRun) bands++;
      return bands;
    }
    function structuralName(nmText, p, allowed, avoid) {
      var toks = nmText.split(/[^a-z]+/).filter(function (t) { return t.length >= 4; });
      var hits = {};
      FUZZY_KEYS.forEach(function (fk) {
        var kw = fk[0];
        for (var ti = 0; ti < toks.length; ti++) {
          if (editDist1(toks[ti], kw)) { fk[1].forEach(function (n) { hits[n] = 1; }); break; }
        }
      });
      var cands = Object.keys(hits).filter(function (n) {
        if (avoid && n === avoid) return false;
        if (allowed && allowed.indexOf(n) === -1) return false;
        return true;
      });
      if (!cands.length) return null;
      if (cands.length > 1) {
        var lines = countNameLines(p);
        if (lines === 1 || lines === 2) {
          cands = cands.filter(function (n) { return (lines === 2) === !!NAME_2LINE[n]; });
        }
      }
      return cands.length === 1 ? cands[0] : null;
    }
    if (!out.config.effect1) {
      var rnW = structuralName(nmW.text, nodes.nodeW, poolNames, null) ||
        (NREFS ? synthNameRescue("W", nodes.nodeW, poolNames, null) : null);
      if (rnW) { out.config.effect1 = rnW; confidence.config.effect1 = 0.6; }
    }
    if (!out.config.effect2) {
      var rnE = structuralName(nmE.text, nodes.nodeE, poolNames, out.config.effect1) ||
        (NREFS ? synthNameRescue("E", nodes.nodeE, poolNames, out.config.effect1) : null);
      if (rnE) { out.config.effect2 = rnE; confidence.config.effect2 = 0.6; }
    }

    tmark("effectNames");
    await footerP;   // join the concurrent footer phase before the final section
    // ---- the 4 outcomes ----
    var iconXs = geo ? geo.outIconXs : L.ROI.outIconXs.map(function (fx) { return panel.x + fx * panel.w; });
    var iconY = geo ? geo.outIconY : panel.y + L.ROI.outIconY * panel.h;
    // the four cells are data-independent — read them CONCURRENTLY (the OCR pool
    // overlaps them; serialized backends preserve old order via their queues);
    // every write below is oi-indexed, so completion order cannot matter
    async function readOutcomeCell(oi) {
      var icol = L.medianPatch(raster, iconXs[oi], iconY, patchHalf);
      var icls = L.hueClass(icol[0], icol[1], icol[2]);
      var ihue = L.hsv(icol[0], icol[1], icol[2]).h;

      // caption band under/around the icon
      var capRect = { x: iconXs[oi] - gap * 0.44, y: iconY - gap * 0.16, w: gap * 0.88, h: gap * 0.52 };
      var capRead = await maskedOcr(capRect, captionText, { psm: 6 });
      var cap = normText(capRead.text).toLowerCase();
      if (out._debug) (out._debug.caps = out._debug.caps || [])[oi] = icls + "· '" + cap.replace(/\n/g, "|").slice(0, 45) + "'";

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

      // GREY cells are exactly two candidates: "Processing Cost ±100%" and
      // "Processing State Maintained" — both captions render DIM GREY, which the
      // white-text OCR half-misses (live: −100% cells read as +100% when the thin
      // '−' dropped, or as do_nothing when the caption missed entirely). Decide by
      // TEMPLATE: a '1','0','0' digit run under a grey mask = the cost cell, and
      // the sign is the box left of the run classified by SHAPE — the '−' bar is
      // short and wide, geometrically unlike '+'.
      var greyCost = null;
      if (icls === "grey") {
        var greyPred = function (r, g, b) { var c = L.hsv(r, g, b); return c.s < 0.32 && c.v > 0.42; };
        // dedicated dim-grey OCR: dilate + ×4 (the standard caption pass only gets ×2
        // and misses most of the grey text — 4 live −100% cells parsed as do_nothing)
        var gSub = L.crop(raster, capRect);
        var gRead2 = await dilatedOcr(gSub, greyPred, { scale: 3, psm: 6 });
        var gTxt = normText(gRead2.text).toLowerCase();
        // cost evidence: "100"-ish in either OCR, or a '0','0' template pair (round
        // dim glyphs match '0' well even when '1'/'−' merge away)
        var zeroPair = false;
        if (GLYPHS) {
          var tgC = templateGlyphs(capRect, greyPred);
          if (tgC) {
            for (var gi = 0; gi + 1 < tgC.length; gi++) {
              if (tgC[gi].ch === "0" && tgC[gi + 1].ch === "0" && tgC[gi].score >= 0.72 && tgC[gi + 1].score >= 0.72) zeroPair = true;
            }
          }
        }
        // "Cost" beheads to 'jos'/'gos' when the whole −100% line drops (live:
        // caption 'frosesz ng jos' — Processing + Cost fragments, no digits at all)
        var costish = /1\s*[o0]\s*[o0]|[cjg]ost|[cjg]os\b/.test(gTxt) || /1\s*[o0]\s*[o0]|[cjg]os\b/.test(cap) || zeroPair;
        var maintainish = /maintain|tained|state/.test(gTxt) || /maintain|state/.test(cap);
        // the third grey candidate: "View Other Items +N time(s)" — two live cells
        // read as do_nothing because only THIS dilated pass can see their captions
        var rerollish = /time|view|item|other/.test(gTxt) || /time|view|item|other/.test(cap);
        if (costish && !maintainish) {
          // SIGN: a '+' is fat and survives dim OCR; the thin '−' is what drops.
          // '+' anywhere ⇒ +100; cost-confirmed with no '+' ⇒ −100, kept flagged.
          var plusSeen = /\+/.test(gTxt) || /\+/.test(cap);
          greyCost = { neg: !plusSeen, conf: plusSeen ? 0.85 : 0.7 };
        } else if (rerollish && !maintainish) {
          var rrG = gTxt.match(/\+\s*([12])/) || cap.match(/\+\s*([12])/);
          o = { type: "reroll_increase", change: rrG ? parseInt(rrG[1], 10) : 1 };
          oconf += rrG ? 0.8 : 0.55;
        }
      }

      if (o) {
        // grey reroll decided above — confidence already accumulated
      } else if (greyCost) {
        o = { type: "change_gold_cost", change: greyCost.neg ? -100 : 100 };
        oconf += greyCost.conf;
      } else if (/maintain|state\s*maint/.test(cap)) {
        // "Processing State Maintained" — the literal do-nothing outcome
        o = { type: "do_nothing" };
        oconf += Math.min(0.9, capRead.conf + 0.3);
      } else if (/chang/.test(cap) && target && (target === "effect1" || target === "effect2")) {
        // "Effect Changed" OCRs as 'ectoct chango' etc. — /chang/ alone is safe here:
        // it's caption-scoped and gated on a colored side-effect icon
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
        // +/− sign to keep it unflagged; else cap below the UI threshold.
        if (target === "order" || target === "willpower") {
          var signSeen = /\+\s*[1-5]/.test(cap) || (/(?:^|\s)[-−]\s*[1-5]/.test(cap) && !/lv/i.test(cap));
          if (!signSeen) {
            // vivid-yellow sign read: these amounts render in the same saturated pure
            // yellow that unlocked the gold-on-gold S digit — a mask the caption's
            // white words and the icon face can't leak into. Sign + digit, directly.
            var vividPred = function (r, g, b) { var c = L.hsv(r, g, b); return c.h >= 38 && c.h <= 64 && c.s > 0.7 && c.v > 0.68; };
            var vRead = await maskedOcr(capRect, vividPred, { whitelist: "+-−12345 ", psm: 7 });
            var vTxt = vRead.text || "";
            if (/\+\s*\d/.test(vTxt)) { o.type = "raise_effect"; signSeen = true; }
            else if (/[-−]\s*\d/.test(vTxt)) { o.type = "lower_effect"; signSeen = true; }
            if (signSeen) {
              var vAmt = vTxt.match(/([1-4])/);
              if (vAmt && !hadAmt) o.amount = parseInt(vAmt[1], 10);
            }
          }
          if (!signSeen) oconf = Math.min(oconf, 0.72);
        }
      } else {
        o = { type: "do_nothing" };
        oconf += 0.2;
      }
      out.outcomes[oi] = o;
      confidence.outcomes[oi] = Math.max(0, Math.min(0.95, oconf * panelConf));
    }
    await Promise.all([0, 1, 2, 3].map(readOutcomeCell));

    // panel-quality attenuation on the art-region fields
    ["willpowerLevel", "orderLevel", "effect1Level", "effect2Level", "effect1", "effect2"].forEach(function (k) {
      confidence.config[k] = (confidence.config[k] || 0) * panelConf;
    });

    // ---- HONESTY GUARD: degraded OCR must never look confident ----
    // If the OCR backend died (worker failed to load, CDN blocked, crash), the
    // parse silently completes on color/template reads alone and the text-derived
    // fields become pool-plausible GUESSES. Measured in the wild: effect names
    // invented at conf ~0.8 in 1-second parses. Cap EVERYTHING at 0.5 so the whole
    // window flags "confirm me", and mark the parse so the UI can say why.
    if (ocrFails >= 3) {
      out.ocrDegraded = true;
      Object.keys(confidence.config).forEach(function (k) { confidence.config[k] = Math.min(confidence.config[k] || 0, 0.5); });
      Object.keys(confidence.state).forEach(function (k) { confidence.state[k] = Math.min(confidence.state[k] || 0, 0.5); });
      for (var ci = 0; ci < confidence.outcomes.length; ci++) confidence.outcomes[ci] = Math.min(confidence.outcomes[ci] || 0, 0.5);
    }
    tmark("outcomes");
    if (out._debug) {
      _timing.ocrTotal = Math.round(_ocrMs);
      out._debug.timing = _timing;
    }
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
    // available when the background offload can run (it imports its OWN
    // Tesseract) — the main-thread CDN bundle is no longer loaded up front;
    // the inline fallback lazy-injects it on demand (see ensureTesseractCdn)
    if (typeof window === "undefined" || typeof document === "undefined") return false;
    if (typeof Worker !== "undefined" && typeof ImageData !== "undefined") return true;
    return typeof window.Tesseract !== "undefined";
  };
  StructuralEngine.prototype.unavailableReason = function () { return "Needs a browser with Web Worker support (or the Tesseract CDN script)."; };

  // Lazy CDN injection for the INLINE FALLBACK only: with the offload healthy,
  // the ~4MB Tesseract bundle never loads (or parses) on the main thread at all.
  var _cdnP = null;
  function ensureTesseractCdn() {
    if (typeof window !== "undefined" && typeof window.Tesseract !== "undefined") return Promise.resolve(true);
    if (_cdnP) return _cdnP;
    _cdnP = new Promise(function (resolve) {
      try {
        var s = document.createElement("script");
        s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
        s.onload = function () { resolve(typeof window.Tesseract !== "undefined"); };
        s.onerror = function () { _cdnP = null; resolve(false); };
        document.head.appendChild(s);
      } catch (e) { _cdnP = null; resolve(false); }
    });
    return _cdnP;
  }

  var _workerP = null;
  function getWorker() {
    if (!_workerP) {
      _workerP = window.Tesseract.createWorker("eng", 1, { logger: function () {} });
      // a failed creation (CDN worker/wasm/traineddata blocked or flaky) must not
      // stick: null the cache so the NEXT call retries instead of failing forever
      _workerP.catch(function () { _workerP = null; });
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
    // Serialize on one worker; set per-call params (whitelist / psm).
    // RESILIENCE (this was a production bug): the queue must never carry a
    // rejection forward — one failed worker init used to poison every later OCR
    // call for the session, so parses "succeeded" in ~1s with pool-guessed effect
    // names at ~0.8 confidence. Now each call starts from a settled queue, a
    // failure resolves to {failed:true} (counted by the engine's honesty guard,
    // which caps ALL confidences at 0.5), and the dead worker is discarded so
    // the next parse retries from scratch.
    var call = _ocrQueue.catch(function () {}).then(function () {
      return getWorker().then(function (w) {
        var params = { tessedit_pageseg_mode: String(opts.psm || 6), user_defined_dpi: "150" };
        params.tessedit_char_whitelist = opts.whitelist || "";
        return w.setParameters(params).catch(function () {}).then(function () {
          return w.recognize(rasterToCanvas(raster));
        }).then(function (res) {
          return { text: (res && res.data && res.data.text) || "", conf: ((res && res.data && res.data.confidence) || 40) / 100 };
        });
      }).catch(function () {
        _workerP = null;   // worker is dead — force a fresh createWorker next time
        return { text: "", conf: 0, failed: true };
      });
    });
    _ocrQueue = call;
    return call;
  }

  // ---- background parse offload (2026-07-19: "don't freeze the website") ----
  // The parse runs in ocr/parse-worker.js when Workers are available; the main
  // thread only decodes the input to a raster (cheap) and transfers the buffer.
  // ANY offload failure disables it for the session and the inline path takes
  // over — identical behavior, just blocking.
  var _bg = null, _bgDisabled = false, _bgSeq = 0, _bgPending = {};
  function bgWorkerUrls() {
    var v = {};
    try {
      ((window.LAZY_TABS && window.LAZY_TABS.advisor) || []).forEach(function (u) {
        var m = String(u).match(/([^\/]+\.js)(\?v=\d+)?$/);
        if (m) v[m[1]] = m[2] || "";
      });
    } catch (e) {}
    function f(name, dir) { return (dir || "") + name + (v[name] || ""); }
    return [
      "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js",
      f("astrogem.js", "../model/"), f("engine.js"), f("layout.js"), f("glyphs.js"),
      f("level-refs.js"), f("tesseract-engine.js"), f("structural-engine.js")
    ];
  }
  function getBgWorker() {
    if (_bgDisabled || typeof Worker === "undefined" || typeof ImageData === "undefined") {
      return Promise.resolve(null);
    }
    if (_bg) return _bg.readyP.then(function (ok) { return ok ? _bg : null; });
    var w;
    try { w = new Worker("ocr/parse-worker.js?v=1"); }
    catch (e) { _bgDisabled = true; return Promise.resolve(null); }
    var readyResolve;
    _bg = { w: w, readyP: new Promise(function (res) { readyResolve = res; }) };
    w.onmessage = function (ev) {
      var m = ev.data || {};
      if (m.type === "ready") readyResolve(true);
      else if (m.type === "init-error") { _bgDisabled = true; readyResolve(false); }
      else if (m.type === "result" && _bgPending[m.id]) {
        var cb = _bgPending[m.id];
        delete _bgPending[m.id];
        cb(m);
      }
    };
    w.onerror = function () {
      _bgDisabled = true;
      try { readyResolve(false); } catch (e) {}
      Object.keys(_bgPending).forEach(function (id) { var cb = _bgPending[id]; delete _bgPending[id]; cb({ error: "worker crashed" }); });
    };
    w.postMessage({ type: "init", urls: bgWorkerUrls() });
    return _bg.readyP.then(function (ok) { return ok ? _bg : null; });
  }
  function bgParse(raster) {
    return getBgWorker().then(function (bg) {
      if (!bg) return null;
      return new Promise(function (resolve) {
        var id = ++_bgSeq;
        _bgPending[id] = function (m) { resolve(m.error ? null : m.result); };
        // TRANSFER the pixels (zero-copy) — the raster is dead to this thread
        // afterwards; the fallback path re-decodes from the original input
        bg.w.postMessage({ type: "parse", id: id, width: raster.width, height: raster.height, buf: raster.data.buffer }, [raster.data.buffer]);
      });
    });
  }

  StructuralEngine.prototype.parseScreenshot = function (input) {
    var self = this;
    function inline() {
      // the fallback needs the main-thread Tesseract — inject it now if the
      // page never loaded it (the offload path doesn't); a failed injection
      // still parses on templates/colors and the honesty guard flags the rest
      return ensureTesseractCdn().then(function () {
        return toRaster(input);
      }).then(function (raster) {
        return parseStructural(raster, browserOcr);
      }).then(function (raw) {
        var snapped = self.constraintSnap(raw);
        snapped.confidence = raw.confidence ? snapped.confidence : undefined;
        if (raw.ocrDegraded) snapped.ocrDegraded = true;
        if (raw._srcPanel) snapped._srcPanel = raw._srcPanel;   // for the AI verifier's crop
        return snapped;
      });
    }
    if (typeof window !== "undefined" && window.__agForceInline) return inline();   // debug hook
    return toRaster(input).then(function (raster) {
      return bgParse(raster).then(function (bgResult) {
        return bgResult || inline();
      });
    }).catch(function () { return inline(); });
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
  // Warm-up at engine load (tab activation) so the FIRST parse doesn't pay the
  // startup: when the background offload is available, warm THAT (its
  // importScripts + Tesseract spin up off-thread) and leave the main-thread
  // Tesseract cold — it only exists as the inline fallback and spinning both
  // doubled memory and startup for nothing. No offload → old main-thread warm.
  if (typeof window !== "undefined") {
    try {
      if (typeof Worker !== "undefined" && typeof ImageData !== "undefined") getBgWorker();
      else if (typeof window.Tesseract !== "undefined") getWorker();
    } catch (e) {}
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
