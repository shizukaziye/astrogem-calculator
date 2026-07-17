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

    // ---- footer: Process (x/N) → rarity + currentTurn (plain background, reliable) ----
    var procRead = await maskedOcr(L.roiRect(panel, "processBtn"), L.isWhiteText, { psm: 7 });
    var procM = normText(procRead.text).match(/(\d+)\s*[\/l|]\s*(\d+)/);
    var turnsRemaining = null, maxT = null;
    if (procM) {
      var a = parseInt(procM[1], 10), b = parseInt(procM[2], 10);
      if (a >= 0 && a <= 9 && b >= 5 && b <= 9 && a <= b) { turnsRemaining = a; maxT = b; }
    }
    out.rarity = maxT === 5 ? "uncommon" : maxT === 7 ? "rare" : maxT === 9 ? "epic" : null;
    out.state.maxTurns = maxT;
    out.state.turnsRemaining = turnsRemaining;
    confidence.state.rarity = maxT != null ? Math.min(0.98, procRead.conf + 0.3) : 0;
    confidence.state.currentTurn = turnsRemaining != null ? Math.min(0.98, procRead.conf + 0.3) : 0;

    // ---- footer: Processing Cost ----
    var costRead = await maskedOcr(L.roiRect(panel, "costRow"), whiteOrGold, { whitelist: "ProcesingCost 0123456789,", psm: 7 });
    var costM = costRead.text.replace(/[^\d,]/g, " ").match(/([\d,]{3,6})/);
    if (costM) {
      var cval = parseInt(costM[1].replace(/,/g, ""), 10);
      if (cval >= 100 && cval <= 9999) { out.state.processCost = cval; confidence.state.processCostMultiplier = 0.9; }
    }
    if (out.state.processCost == null) confidence.state.processCostMultiplier = 0.3;

    // ---- reroll pill (ROI-scoped: the "Reset (1/1)" trap can't reach here) ----
    var pillRect = geo
      ? rectAround(geo.rerollPill, geo.gap * 0.42, geo.gap * 0.14)
      : L.roiRect(panel, "rerollPill");
    var pillRead = await maskedOcr(pillRect, L.isWhiteText, { whitelist: "0123456789/", psm: 7 });
    var pillM = pillRead.text.match(/(\d)\s*\/\s*(\d)/);
    if (pillM) {
      var pa = parseInt(pillM[1], 10), pb = parseInt(pillM[2], 10);
      if (pa <= 4 && pb >= 1 && pb <= 4 && pa <= pb) {
        out.state.rerollsShownFree = pa;
        out.state.rerollsShownDenom = pb;
        confidence.state.rerollsRemaining = 0.9;
      }
    }
    if (out.state.rerollsShownFree == null) confidence.state.rerollsRemaining = 0.25;

    // ---- gem name → gemType + baseCost (suffix table) ----
    var nameRead = await maskedOcr(L.roiRect(panel, "gemName"), function (r, g, b) {
      var c = L.hsv(r, g, b); return c.v > 0.45 && c.s > 0.15;   // rarity-colored serif text
    }, { psm: 7 });
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
    var nodes = geo ? geo : {
      nodeN: L.roiPoint(panel, "nodeN"), nodeW: L.roiPoint(panel, "nodeW"),
      nodeE: L.roiPoint(panel, "nodeE"), nodeS: L.roiPoint(panel, "nodeS"),
      gap: panel.h * L.SIG.GAP_RATIO
    };
    var gap = nodes.gap;
    var patchHalf = Math.max(4, gap * 0.06);
    function nodeColor(p) { return L.medianPatch(raster, p.x, p.y, patchHalf); }
    var colW = nodeColor(nodes.nodeW), colE = nodeColor(nodes.nodeE);
    var hueW = L.hsv(colW[0], colW[1], colW[2]).h, hueE = L.hsv(colE[0], colE[1], colE[2]).h;

    // Level text sits INSIDE each diamond (name line(s) then the level line, all
    // centered on the node): W/E render "Lv. N", N and S render a bare gold digit.
    // The line's exact y shifts with 1- vs 2-line names, so SELF-LOCATE it: gold-mask
    // the node box and take the bottom-most thin text band. The S face is itself gold
    // (gold-on-gold digit is unrecoverable by color) — rejectFill bails there and the
    // points checksum solves S arithmetically below.
    async function readLevel(p, isGoldFace) {
      var box = { x: p.x - gap * 0.5, y: p.y - gap * 0.35, w: gap * 1.0, h: gap * 0.72 };
      var line = L.findMaskedTextLine(raster, box, L.isGoldText, {
        rejectFill: 0.22, maxRowFill: 0.6,
        minH: Math.max(4, Math.round(gap * 0.05)), maxH: Math.round(gap * 0.22),
        minRowPx: 3,
        // the text is centered on the node — a diagonal sliver of the gold S-diamond
        // frame poking into a box corner is off-center and gets skipped
        accept: function (r) {
          var cx = r.x + r.w / 2;
          return Math.abs(cx - p.x) <= gap * 0.28 && r.w >= gap * 0.03 && r.w <= gap * 0.85;
        }
      });
      if (!line) return { level: null, conf: 0 };
      // expand: band fragmentation (a broken "2") must not clip glyph edges
      var grow = Math.round(line.h * 0.5);
      var lineX = { x: line.x - grow, y: line.y - grow, w: line.w + grow * 2, h: line.h + grow * 2 };
      var read = await maskedOcr(lineX, L.isGoldText, { whitelist: "Lv.12345 ", psm: 7 });
      var m = read.text.match(/([1-5])\s*$/) || read.text.match(/([1-5])/);
      if (!m) {
        // bare single digit (N/S nodes): retry as one character
        read = await maskedOcr(lineX, L.isGoldText, { whitelist: "12345", psm: 10 });
        m = read.text.match(/([1-5])/);
      }
      if (!m) {
        // small/blurry strokes (downscaled full-screen captures): dilate + bigger upscale
        var sub2 = L.crop(raster, lineX);
        var masked2 = dilateDark(L.chromaMask(sub2, L.isGoldText));
        read = await ocrText(upscale(masked2, Math.max(2, Math.min(5, Math.round(160 / Math.max(1, sub2.height))))), { whitelist: "Lv.12345 ", psm: 7 });
        m = read.text.match(/([1-5])\s*$/) || read.text.match(/([1-5])/);
      }
      var conf = m ? Math.min(0.95, read.conf + 0.25) : 0;
      // gold digit over the gold S face is structurally unreliable — never let it
      // outrank the checksum solve below
      if (isGoldFace) conf = Math.min(conf, 0.45);
      return { level: m ? parseInt(m[1], 10) : null, conf: conf };
    }
    var lvN = await readLevel(nodes.nodeN, false);
    var lvW = await readLevel(nodes.nodeW, false);
    var lvE = await readLevel(nodes.nodeE, false);
    var lvS = await readLevel(nodes.nodeS, true);

    // ---- the points checksum ("N Astrogem Points" = level sum) ----
    // Only a digit sitting directly before "As(trogem)" counts — masked reads on dim
    // captures can mangle the digit while keeping "Points" ('5 re Paints' for
    // "6 Astrogem Points"), so a bare leading-digit grab is NOT trustworthy.
    function extractPts(text) {
      var m = normText(text).match(/(\d{1,2})\s*[Aa]s/);
      if (!m) return null;
      var v = parseInt(m[1], 10);
      return v >= 4 && v <= 20 ? v : null;
    }
    var ptsRect = L.roiRect(panel, "points");
    var ptsSub = L.crop(raster, ptsRect);
    function logPtsRead(tag, r) {
      if (out._debug) (out._debug.reads = out._debug.reads || []).push({
        rect: { x: Math.round(ptsRect.x), y: Math.round(ptsRect.y), w: Math.round(ptsRect.w), h: Math.round(ptsRect.h) },
        wl: tag, psm: 7, text: String(r.text || "").replace(/\n/g, "\\n").slice(0, 70),
        conf: Math.round(r.conf * 100) / 100
      });
    }
    // retry ladder, strict extraction at every rung: (a) white mask, (b) white mask +
    // dilate (downscaled captures thin the strokes), (c) unmasked (dim captures defeat
    // the mask entirely; busier, but the digit-before-"As" regex filters the junk)
    var ptsRead = await maskedOcr(ptsRect, L.isWhiteText, { psm: 7 });
    var pts = extractPts(ptsRead.text);
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
    var ptsSoft = false;
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
    var LV = [lvN, lvW, lvE, lvS];
    if (pts != null) {
      var known = LV.filter(function (l) { return l.level != null; });
      var sum = known.reduce(function (s, l) { return s + l.level; }, 0);
      if (known.length === 4 && sum === pts) {
        LV.forEach(function (l) { l.conf = Math.max(l.conf, ptsSoft ? 0.85 : 0.92); });
      } else if (known.length === 3) {
        // solve the one unreadable node (typically S, the gold-on-gold face)
        var missing = LV.filter(function (l) { return l.level == null; })[0];
        var solved = pts - sum;
        if (solved >= 1 && solved <= 5) {
          missing.level = solved;
          missing.conf = Math.min(ptsSoft ? 0.65 : 0.9,
            0.55 + Math.min.apply(null, known.map(function (l) { return l.conf; })) * 0.4);
        }
      } else if (known.length === 4 && sum !== pts) {
        // mismatch: RE-SOLVE the weakest read from the checksum (the header points
        // line is a clean white-on-dark read; a single bad gold digit is the likely
        // culprit — typically S, whose gold-face read is capped at 0.45)
        var weakest = LV.slice().sort(function (p, q) { return p.conf - q.conf; })[0];
        var resolved = pts - (sum - weakest.level);
        if (resolved >= 1 && resolved <= 5) {
          weakest.level = resolved;
          // below the 0.8 UI threshold either way: still shows "confirm me"
          weakest.conf = ptsSoft ? 0.6 : 0.75;
        } else {
          weakest.conf = Math.min(weakest.conf, 0.3);
        }
      }
    }
    out.config.willpowerLevel = lvN.level; confidence.config.willpowerLevel = lvN.conf;
    out.config.effect1Level = lvW.level; confidence.config.effect1Level = lvW.conf;
    out.config.effect2Level = lvE.level; confidence.config.effect2Level = lvE.conf;
    out.config.orderLevel = lvS.level; confidence.config.orderLevel = lvS.conf;

    // ---- effect NAMES: W/E caption OCR (white serif over art — masked) ----
    async function readEffectName(p) {
      var rect = { x: p.x - gap * 0.55, y: p.y - gap * 0.16, w: gap * 1.1, h: gap * 0.30 };
      var read = await maskedOcr(rect, L.isWhiteText, { psm: 7 });
      return { text: normText(read.text).toLowerCase(), conf: read.conf };
    }
    var EFFECT_LEX = [
      ["Attack Power", /atk|attack/],
      ["Additional Damage", /additional|addit/],
      ["Boss Damage", /boss/],
      ["Brand Power", /brand/],
      ["Ally Damage Enh.", /ally\s*d|allyd/],
      ["Ally Attack Enh.", /ally\s*a|allya/]
    ];
    function lexEffect(t) {
      for (var i = 0; i < EFFECT_LEX.length; i++) if (EFFECT_LEX[i][1].test(t)) return EFFECT_LEX[i][0];
      return null;
    }
    var nmW = await readEffectName(nodes.nodeW);
    var nmE = await readEffectName(nodes.nodeE);
    out.config.effect1 = lexEffect(nmW.text);
    out.config.effect2 = lexEffect(nmE.text);
    confidence.config.effect1 = out.config.effect1 ? Math.min(0.92, nmW.conf + 0.3) : 0;
    confidence.config.effect2 = out.config.effect2 ? Math.min(0.92, nmE.conf + 0.3) : 0;

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

      if (/effect\s*chang|changed/.test(cap) && target && (target === "effect1" || target === "effect2")) {
        o = { type: "change_side_option", target: target };
        oconf += Math.min(0.9, capRead.conf + 0.3);
      } else if (/time|view|other|item/.test(cap) || (icls === "grey" && /\+\s*\d/.test(cap))) {
        var rrM = cap.match(/\+\s*([12])/);
        o = { type: "reroll_increase", change: rrM ? parseInt(rrM[1], 10) : 1 };
        oconf += rrM ? 0.9 : 0.6;
      } else if (/cost/.test(cap)) {
        var neg = /-\s*100|−/.test(cap);
        o = { type: "change_gold_cost", change: neg ? -100 : 100 };
        oconf += 0.75;
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
          var amtRead = await maskedOcr(
            { x: amtLine.x - agrow, y: amtLine.y - agrow, w: amtLine.w + agrow * 2, h: amtLine.h + agrow * 2 },
            L.isAmountText, { whitelist: "Lv.+12345 ", psm: 7 });
          // prefix-anchored FIRST — the ▲ hue can bleed into the chartreuse window and
          // OCR the triangle as a trailing digit ("Lv. 2 ▲" → "Lv. 24")
          var am = amtRead.text.match(/(?:lv\.?|\+)\s*([1-4])/i) || amtRead.text.match(/([1-4])/);
          if (am) amt = parseInt(am[1], 10);
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
            var c = L.hsv(rr, gg, bb); return (c.h < 20 || c.h >= 345) && c.s > 0.5 && c.v > 0.5;
          });
          var upSolid = aUp.frac > 0.012 && aUp.count >= 8;
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
        if (amt == null) {
          var amtM = cap.match(/(?:lv\.?\s*|\+\s*)([1-4])/) || cap.match(/([1-4])\s*$/);
          if (amtM) amt = parseInt(amtM[1], 10);
        }
        var hadAmt = amt != null;
        if (amt == null) amt = 1;
        var type = dirDown && !dirUp ? "lower_effect" : "raise_effect";
        o = { type: type, target: target, amount: amt };
        oconf += (hadAmt ? 0.55 : 0.25) + (dirUp || dirDown ? 0.3 : 0.05);
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
