/**
 * ocr/tesseract-engine.js — client-side screenshot reader using Tesseract.js.
 *
 * DEFAULT Advisor engine: runs entirely in the browser, no accounts, works offline
 * (once the Tesseract CDN script + language model are cached). Reads the Lost Ark
 * "Processing" modal by cropping it into a few normalized regions (title / stat
 * diamonds / outcome list / footer), OCR-ing each at high contrast, then parsing
 * the text with a lexicon tuned to the common misreads. Everything is finally run
 * through the shared constraintSnap so the Advisor always gets a legal state.
 *
 * This is a tidied port of the reference pipeline in ark-grid-solver:
 *   astrogem-regions.js (ROIs + lexicon) and scan-screen.js
 *   (parseAstrogemText / parseCuttingStateText / parseOutcomesFromText).
 *
 * Browser-only (needs <canvas> + the global `Tesseract`). In Node it registers but
 * reports isAvailable() === false. Depends on ocr/engine.js being loaded first.
 */
(function (root) {
  "use strict";

  var ENGINE_API = (typeof module !== "undefined" && module.exports)
    ? require("./engine.js")
    : root.OcrEngineAPI;

  var BaseEngine = ENGINE_API.BaseEngine;
  var EFFECT_POOLS = ENGINE_API.EFFECT_POOLS;

  var IS_BROWSER = typeof document !== "undefined" && typeof window !== "undefined";

  // ---------------- normalized regions (0..1 of width/height) ----------------
  // Tuned on the fixed-layout Processing modal; scale to any capture resolution.
  var ROIS = {
    title:    { nx: 0.06, ny: 0.14, nw: 0.88, nh: 0.14 },
    diamonds: { nx: 0.02, ny: 0.36, nw: 0.96, nh: 0.22 },
    outcomes: { nx: 0.00, ny: 0.56, nw: 0.90, nh: 0.24 },
    footer:   { nx: 0.04, ny: 0.80, nw: 0.92, nh: 0.18 }
  };

  // ---------------- text normalization / lexicon ----------------

  function normalizeOcrText(str) {
    return String(str || "")
      .replace(/\bstabunty\b/gi, "stability")
      .replace(/\bstablity\b/gi, "stability")
      .replace(/\balk\.?\s*power\b/gi, "atk. power")
      .replace(/\bly\.?\s*(\d)/gi, "lv. $1")
      .replace(/\bolder\s*punts\b/gi, "order points")
      .replace(/\bastrog[éeèë]m/gi, "astrogem")
      .replace(/[^\w\s]*\s*haos\s+astrogem/gi, "chaos astrogem")
      .replace(/\bcorrdsion\b/gi, "corrosion")
      .replace(/\bcormsion\b/gi, "corrosion")
      .replace(/\bcorosion\b/gi, "corrosion")
      .replace(/\bcorrosian\b/gi, "corrosion")
      .replace(/\bcarrosion\b/gi, "corrosion")
      .replace(/\bchade\s*paints\b/gi, "chaos points")
      .replace(/\bchade\s*points\b/gi, "chaos points")
      .replace(/\bally\s*dmg\b/gi, "ally damage")
      .replace(/one of the following is random\s*y\s*applied/gi, "one of the following is randomly applied")
      .replace(/random\s+y\s+applied/gi, "randomly applied")
      .replace(/ordezgpoints/gi, "order points")
      .replace(/orde[a-z]{2,10}points/gi, "order points")
      .replace(/etficie\w*/gi, "efficiency")
      .replace(/\s+illpower\b/gi, " willpower")
      .replace(/\bwillpowers\b/gi, "willpower");
  }

  // Split "current gem" (top) from the "one of the following" outcome list (bottom).
  function splitStateAndOutcomes(raw) {
    var norm = String(raw).replace(/\r\n/g, "\n");
    var markers = [
      /one of the following is randomly applied/i,
      /one of the following/i,
      /randomly applied/i,
      /following is randomly/i
    ];
    var cut = -1;
    for (var i = 0; i < markers.length; i++) {
      var m = norm.match(markers[i]);
      if (m && m.index != null) { cut = m.index; break; }
    }
    if (cut === -1) {
      var idx = norm.toLowerCase().indexOf("randomly");
      if (idx !== -1) cut = idx;
    }
    if (cut === -1) return { stateText: norm, outcomeText: norm };
    return { stateText: norm.slice(0, cut).trim(), outcomeText: norm.slice(cut).trim() };
  }

  var GEM_NAME_COST = {
    stability: 8, corrosion: 8, solidity: 9, distortion: 9, immutability: 10, destruction: 10
  };

  function canonicalGemSuffix(word) {
    if (!word) return "";
    var w = String(word).toLowerCase().replace(/[^a-z]/g, "");
    if (/^stab/.test(w)) return "stability";
    if (/^corr|^cor[mo]/.test(w)) return "corrosion";
    if (/^solid/.test(w)) return "solidity";
    if (/^dist/.test(w)) return "distortion";
    if (/^imm/.test(w)) return "immutability";
    if (/^dest/.test(w)) return "destruction";
    return w;
  }

  // effect-name lexicon (longest keys first so "ally damage enh" beats "ally damage")
  var EFFECT_MAP = {
    "boss damage": "Boss Damage", "boss dmg": "Boss Damage",
    "additional damage": "Additional Damage", "add. damage": "Additional Damage",
    "add damage": "Additional Damage",
    "attack power": "Attack Power", "atk power": "Attack Power",
    "atk. power": "Attack Power", "alk power": "Attack Power", "alk. power": "Attack Power",
    "brand power": "Brand Power",
    "ally damage enh.": "Ally Damage Enh.", "ally damage enh": "Ally Damage Enh.",
    "ally dmg enh": "Ally Damage Enh.", "ally damage": "Ally Damage Enh.",
    "ally attack enh.": "Ally Attack Enh.", "ally attack enh": "Ally Attack Enh.",
    "ally attack": "Ally Attack Enh."
  };
  var EFFECT_KEYS_LONGEST = Object.keys(EFFECT_MAP).sort(function (a, b) { return b.length - a.length; });

  // ---------------- canvas crop + preprocess ----------------

  function cropToCanvas(img, roi) {
    var w = img.naturalWidth || img.width;
    var h = img.naturalHeight || img.height;
    if (!w || !h) throw new Error("Image has no dimensions");
    var sx = Math.floor(roi.nx * w);
    var sy = Math.floor(roi.ny * h);
    var sw = Math.max(1, Math.floor(roi.nw * w));
    var sh = Math.max(1, Math.floor(roi.nh * h));
    var scale = Math.min(3, Math.max(2, 2000 / sw));
    var canvas = document.createElement("canvas");
    canvas.width = Math.floor(sw * scale);
    canvas.height = Math.floor(sh * scale);
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    var id = ctx.getImageData(0, 0, canvas.width, canvas.height);
    var d = id.data;
    for (var i = 0; i < d.length; i += 4) {
      var y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      var v = (y - 128) * 1.3 + 128;
      v = Math.max(0, Math.min(255, v));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(id, 0, 0);
    return canvas;
  }

  // Full-frame fallback preprocess (upscale + grayscale + contrast).
  function preprocessFull(source) {
    var w = source.naturalWidth || source.width || 0;
    var h = source.naturalHeight || source.height || 0;
    if (!w || !h) return source;
    var targetW = Math.min(2560, Math.max(1920, w));
    var scale = targetW / w;
    var targetH = Math.round(h * scale);
    var canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return source;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, targetW, targetH);
    var id = ctx.getImageData(0, 0, targetW, targetH);
    var d = id.data;
    for (var i = 0; i < d.length; i += 4) {
      var y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      y = Math.max(0, Math.min(255, (y - 128) * 1.35 + 128));
      d[i] = d[i + 1] = d[i + 2] = y;
    }
    ctx.putImageData(id, 0, 0);
    return canvas;
  }

  // ---------------- parsing ----------------

  function parseLevel(str) {
    var m = String(str).match(/\b([1-5])\b/);
    return m ? parseInt(m[1], 10) : null;
  }

  // Parse the gem config (everything except outcomes) from the stitched region text.
  function parseConfig(stitched) {
    var norm = normalizeOcrText(stitched);
    var split = splitStateAndOutcomes(norm);
    var stateText = split.stateText;
    var text = stateText.toLowerCase();
    var fullLower = norm.toLowerCase();
    var lines = stateText.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);

    var result = {
      baseCost: null, gemType: "order",
      willpowerLevel: null, orderLevel: null,
      effect1: null, effect1Level: null, effect2: null, effect2Level: null,
      rarity: null
    };

    // base cost from gem name suffix
    var gemNameMatch = text.match(/(?:order|chaos)\s*astrogem\s*:\s*([a-z]+)/i)
      || text.match(/astrogem\s*:\s*([a-z]+)/i);
    if (gemNameMatch) {
      var canon = canonicalGemSuffix(gemNameMatch[1]);
      if (GEM_NAME_COST[canon] !== undefined) result.baseCost = GEM_NAME_COST[canon];
    }
    if (!result.baseCost) {
      if (/\bcorrosion\b|\bstability\b/i.test(stateText)) result.baseCost = 8;
      else if (/\bsolidity\b|\bdistortion\b/i.test(stateText)) result.baseCost = 9;
      else if (/\bimmutability\b|\bdestruction\b/i.test(stateText)) result.baseCost = 10;
    }
    if (!result.baseCost) {
      var costMatch = text.match(/\b(8|9|10)\s*cost\b/i);
      if (costMatch) result.baseCost = parseInt(costMatch[1], 10);
    }

    // gem type
    if (/chaos|chade\s*p/i.test(text)) result.gemType = "chaos";

    // willpower — require "efficiency" so unrelated digits don't read as a level
    if (/willpower\s*efficien/i.test(text)) {
      var wpMatch = text.match(/willpower\s*efficien[a-z]*\s*([1-5])\b/i);
      if (wpMatch) result.willpowerLevel = parseInt(wpMatch[1], 10);
    }
    if (!result.willpowerLevel) {
      for (var li = 0; li < lines.length; li++) {
        if (/astrogem\s*points/i.test(lines[li])) continue;
        if (/willpower\s*efficien/i.test(lines[li])) {
          var lv = parseLevel(lines[li]);
          if (lv) { result.willpowerLevel = lv; break; }
        }
      }
    }

    // order / chaos points
    var compact = stateText.replace(/\s+/g, " ").toLowerCase();
    if (result.gemType === "chaos") {
      var cm = compact.match(/\b(?:chaos|chade)\s*points?\s*(?:lv\.?\s*)?([1-5])\b/i);
      if (cm) result.orderLevel = parseInt(cm[1], 10);
    } else {
      var om = compact.match(/\border\s*points?\s*(?:lv\.?\s*)?([1-5])\b/i)
        || compact.match(/orde[a-z]{0,12}points[^0-9]{0,20}(?:lv\.?\s*)?([1-5])\b/i);
      if (om) result.orderLevel = parseInt(om[1], 10);
    }

    // rarity from the Process (x/N) footer, anywhere in the text
    var procR = fullLower.match(/process\s*\(\s*\d+\s*\/\s*(5|7|9)\s*\)/i);
    if (procR) {
      var mt = parseInt(procR[1], 10);
      result.rarity = mt === 5 ? "uncommon" : mt === 7 ? "rare" : "epic";
    } else if (/epic|purple/i.test(text)) result.rarity = "epic";
    else if (/uncommon|green/i.test(text)) result.rarity = "uncommon";
    else if (/\brare\b|blue/i.test(text)) result.rarity = "rare";

    // effects: longest phrase first, dedup, keep first two distinct
    var found = [];
    for (var ki = 0; ki < EFFECT_KEYS_LONGEST.length; ki++) {
      var key = EFFECT_KEYS_LONGEST[ki];
      var searchStart = 0;
      while (searchStart < text.length) {
        var idx = text.indexOf(key, searchStart);
        if (idx === -1) break;
        var fromKey = text.substring(idx, Math.min(text.length, idx + key.length + 44));
        if (/astrogem\s*points|processing\s*cost|balance/i.test(fromKey)) {
          searchStart = idx + key.length; continue;
        }
        var lvMatch = fromKey.match(/(?:lv|ly)\.?\s*([1-5])\b|level\s*([1-5])\b/i);
        var lvl = lvMatch ? parseInt(lvMatch[1] || lvMatch[2], 10) : 1;
        found.push({ name: EFFECT_MAP[key], level: lvl, index: idx });
        searchStart = idx + key.length;
      }
    }
    found.sort(function (a, b) { return a.index - b.index; });
    var distinct = [];
    for (var fi = 0; fi < found.length; fi++) {
      var dup = false;
      for (var di = 0; di < distinct.length; di++) {
        if (distinct[di].name === found[fi].name) { dup = true; break; }
      }
      if (!dup) distinct.push(found[fi]);
      if (distinct.length >= 2) break;
    }
    if (distinct.length >= 1) { result.effect1 = distinct[0].name; result.effect1Level = distinct[0].level; }
    if (distinct.length >= 2) { result.effect2 = distinct[1].name; result.effect2Level = distinct[1].level; }

    return result;
  }

  // Parse turns / rerolls / process cost from the footer text.
  function parseCuttingState(stitched) {
    var text = normalizeOcrText(stitched).toLowerCase();
    var result = { turnsRemaining: null, maxTurns: null, rerollsRemaining: null,
      processCost: null, processCostMultiplier: null };

    var procTurn = text.match(/process\s*\(\s*(\d+)\s*\/\s*(\d+)\s*\)/i);
    if (procTurn) {
      var rem = parseInt(procTurn[1], 10), mx = parseInt(procTurn[2], 10);
      if (rem >= 0 && rem <= 9 && mx >= 5 && mx <= 9 && rem <= mx) {
        result.turnsRemaining = rem; result.maxTurns = mx;
      }
    }
    if (result.turnsRemaining == null) {
      var tm = text.match(/(\d+)\s*\/\s*(\d+)/);
      if (tm) {
        var a = parseInt(tm[1], 10), b = parseInt(tm[2], 10);
        if (a >= 0 && a <= 9 && b >= 5 && b <= 9 && a <= b) { result.turnsRemaining = a; result.maxTurns = b; }
      }
    }

    // free-reroll counter like 1/1, 2/2 (avoid the Process x/N which is >= 5)
    var fracs = text.match(/(\d+)\s*\/\s*(\d+)/g) || [];
    for (var i = 0; i < fracs.length; i++) {
      var m = fracs[i].match(/(\d+)\s*\/\s*(\d+)/);
      if (!m) continue;
      var ra = parseInt(m[1], 10), rb = parseInt(m[2], 10);
      if (ra >= 5 || rb >= 5) continue;
      if (ra >= 0 && ra <= 3 && rb >= 1 && rb <= 3) { result.rerollsRemaining = ra; break; }
    }
    if (result.rerollsRemaining == null) {
      var rr = text.match(/reroll[s]?\s*[:\s]*(\d+)|(\d+)\s*reroll/i);
      if (rr) result.rerollsRemaining = parseInt(rr[1] || rr[2], 10);
    }

    var procLine = text.match(/processing\s*cost\s*[:\s]*([\d,]{2,6})/i);
    if (procLine) {
      var c = parseInt(procLine[1].replace(/,/g, ""), 10);
      if (c >= 100 && c <= 99999) result.processCost = Math.min(c, 9999);
    }
    if (result.processCost == null) {
      var cm = text.match(/cost\s*[:\s]*([\d,]{2,6})/i);
      if (cm) {
        var c2 = parseInt(cm[1].replace(/,/g, ""), 10);
        if (c2 >= 100 && c2 <= 99999) result.processCost = Math.min(c2, 9999);
      }
    }
    if (result.processCost != null) {
      result.processCostMultiplier = Math.round((result.processCost / 900 - 1) * 100);
    }
    return result;
  }

  // Parse the 4 on-screen outcomes from the outcome region. Returns applyOutcome-
  // shaped objects (constraintSnap finalizes targets/amounts/effect names).
  function parseOutcomes(stitched, config) {
    var norm = normalizeOcrText(stitched);
    var split = splitStateAndOutcomes(norm);
    var text = split.outcomeText.length >= 8 ? split.outcomeText : norm;
    var lines = text.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(function (l) { return l.length > 1; });

    var outcomes = [];
    var seen = {};

    function effTargetByName(name) {
      if (config.effect1 && config.effect1 === name) return "effect1";
      if (config.effect2 && config.effect2 === name) return "effect2";
      return "effect1";
    }

    function tryParse(str) {
      var s = str.toLowerCase();

      // effect change ("X effect changed")
      var changeM = s.match(/(boss damage|additional damage|attack power|atk\.? power|brand power|ally damage enh\.?|ally attack enh\.?)\s*effect\s*changed/i)
        || s.match(/effect\s*changed[^a-z]{0,30}(boss damage|additional damage|attack power|brand power|ally damage|ally attack)/i);
      if (changeM || /effect\s*changed/i.test(s)) {
        var nm = changeM ? (EFFECT_MAP[changeM[1].replace(/\./g, ".").toLowerCase()] || config.effect1) : config.effect1;
        var tgt = effTargetByName(nm);
        return { type: "change_side_option", target: tgt, _k: "chg-" + tgt };
      }

      // willpower +/- n
      var wp = s.match(/willpower\s*(?:efficiency)?\s*([+-]?\d+)/i);
      if (wp) {
        var d = parseInt(wp[1], 10);
        if (!isNaN(d) && d !== 0) {
          return { type: d > 0 ? "raise_effect" : "lower_effect", target: "willpower",
            amount: Math.abs(d), _k: "wp-" + d };
        }
      }
      // order / chaos points +/- n
      var ord = s.match(/(?:order|chaos|chade|older)\s*(?:points?|punts)\s*([+-]?\d+)/i);
      if (ord) {
        var od = parseInt(ord[1], 10);
        if (!isNaN(od) && od !== 0) {
          return { type: od > 0 ? "raise_effect" : "lower_effect", target: "order",
            amount: Math.abs(od), _k: "ord-" + od };
        }
      }

      // "<effect> Lv. N" (displayed resulting level) — treat as a raise of that effect
      for (var ki = 0; ki < EFFECT_KEYS_LONGEST.length; ki++) {
        var key = EFFECT_KEYS_LONGEST[ki];
        var re = new RegExp(key.replace(/\./g, "\\.").replace(/\s+/g, "\\s*") + "\\s*(?:lv|ly)\\.?\\s*([1-5])\\b", "i");
        var lm = s.match(re);
        if (lm) {
          var name = EFFECT_MAP[key];
          return { type: "raise_effect", target: effTargetByName(name), amount: 1, _k: "efflv-" + name };
        }
      }
      // "<effect> +/- n"
      for (var kj = 0; kj < EFFECT_KEYS_LONGEST.length; kj++) {
        var key2 = EFFECT_KEYS_LONGEST[kj];
        if (s.indexOf(key2) === -1) continue;
        var dm = s.match(new RegExp(key2.replace(/\./g, "\\.").replace(/\s+/g, "\\s*") + "\\s*([+-]?\\d+)", "i"));
        if (dm) {
          var dd = parseInt(dm[1], 10);
          if (isNaN(dd) || dd === 0) continue;
          var nm2 = EFFECT_MAP[key2];
          return { type: dd > 0 ? "raise_effect" : "lower_effect", target: effTargetByName(nm2),
            amount: Math.abs(dd), _k: "eff-" + nm2 + "-" + dd };
        }
      }

      // cost +/- 100%
      var costM = s.match(/(?:processing\s*)?cost\s*([+-])\s*(\d+)\s*%?/i);
      if (costM) {
        var ch = (costM[1] === "+" ? 1 : -1) * (parseInt(costM[2], 10) || 100);
        return { type: "change_gold_cost", change: ch, _k: "cost-" + ch };
      }
      // reroll + n
      var rrM = s.match(/reroll\s*[+]\s*(\d+)/i);
      if (rrM) {
        var rv = parseInt(rrM[1], 10) || 1;
        return { type: "reroll_increase", change: rv, _k: "rr-" + rv };
      }
      // do nothing
      if (/do\s*nothing|maintain/i.test(s) || s === "—" || s === "-") {
        return { type: "do_nothing", _k: "noop" };
      }
      return null;
    }

    function push(o) {
      if (!o) return;
      var k = o._k || (o.type + "|" + (o.target || "") + "|" + (o.amount || "") + "|" + (o.change || ""));
      if (seen[k]) return;
      seen[k] = true;
      delete o._k;
      outcomes.push(o);
    }

    for (var i = 0; i < lines.length && outcomes.length < 4; i++) push(tryParse(lines[i]));

    // second pass: scan inline phrases for anything the line split missed
    var phrases = [
      /willpower\s*(?:efficiency)?\s*[+-]?\d+/gi,
      /(?:order|chaos|older)\s*(?:points?|punts)\s*[+-]?\d+/gi,
      /(?:boss|additional|attack|atk\.?|brand)\s*(?:damage|power)\s*(?:lv|ly)\.?\s*\d/gi,
      /(?:boss|additional|attack|brand)\s*(?:damage|power)\s*[+-]?\d+/gi,
      /(?:processing\s*)?cost\s*[+-]\s*\d+\s*%?/gi,
      /reroll\s*[+]\s*\d+/gi,
      /effect\s*changed/gi
    ];
    for (var pi = 0; pi < phrases.length && outcomes.length < 4; pi++) {
      var ms = text.match(phrases[pi]) || [];
      for (var mi = 0; mi < ms.length && outcomes.length < 4; mi++) push(tryParse(ms[mi]));
    }

    while (outcomes.length < 4) outcomes.push({ type: "do_nothing" });
    return outcomes.slice(0, 4);
  }

  // ---------------- Tesseract worker (reused) ----------------

  var _workerPromise = null;
  function getWorker() {
    if (!_workerPromise) {
      _workerPromise = (function () {
        if (typeof Tesseract === "undefined") {
          return Promise.reject(new Error("Tesseract.js not loaded (CDN script missing)."));
        }
        return Tesseract.createWorker("eng", 1, { logger: function () {} }).then(function (worker) {
          return worker.setParameters({ tessedit_pageseg_mode: "6" })
            .catch(function () {})  // PSM optional on some builds
            .then(function () { return worker; });
        });
      })();
    }
    return _workerPromise;
  }

  function recognize(canvasOrImg) {
    return getWorker().then(function (worker) {
      return worker.recognize(canvasOrImg).then(function (r) {
        return String((r && r.data && r.data.text) || "").trim();
      });
    });
  }

  function disposeWorker() {
    if (_workerPromise) {
      var p = _workerPromise;
      _workerPromise = null;
      p.then(function (w) { try { w.terminate(); } catch (e) {} }).catch(function () {});
    }
  }

  // Ensure an <img> is decoded; accept a Blob/File or an HTMLImageElement.
  function toImageElement(input) {
    if (!IS_BROWSER) return Promise.reject(new Error("Tesseract engine is browser-only."));
    if (input instanceof HTMLImageElement) {
      if (input.naturalWidth) return Promise.resolve(input);
      return input.decode().then(function () { return input; }).catch(function () {
        return new Promise(function (res, rej) {
          input.onload = function () { res(input); };
          input.onerror = function () { rej(new Error("Image failed to load")); };
        });
      });
    }
    if (input instanceof HTMLCanvasElement) return Promise.resolve(input);
    // Blob / File
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(input);
      var img = new Image();
      img.onload = function () { res(img); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error("Image failed to load")); };
      img.src = url;
    });
  }

  // ---------------- the engine ----------------

  function TesseractEngine() {}
  TesseractEngine.prototype = Object.create(BaseEngine.prototype);
  TesseractEngine.prototype.constructor = TesseractEngine;
  TesseractEngine.prototype.name = "tesseract";
  TesseractEngine.prototype.label = "Tesseract.js (offline, default)";
  TesseractEngine.prototype.isAvailable = function () {
    return IS_BROWSER && typeof Tesseract !== "undefined";
  };
  TesseractEngine.prototype.disposeWorker = disposeWorker;

  // Read the screenshot regionally; fall back to a full-frame OCR if cropping fails.
  TesseractEngine.prototype.parseScreenshot = function (input) {
    var self = this;
    return toImageElement(input).then(function (img) {
      // For a canvas input we can only do a full-frame pass.
      var isImg = (typeof HTMLImageElement !== "undefined") && (img instanceof HTMLImageElement);
      if (!isImg) {
        return recognize(preprocessFull(img)).then(function (txt) {
          return self.constraintSnap(buildRaw(txt, txt, txt));
        });
      }
      // Regional crops.
      var keys = ["title", "diamonds", "outcomes", "footer"];
      var seq = Promise.resolve();
      var parts = {};
      keys.forEach(function (k) {
        seq = seq.then(function () {
          var canvas = cropToCanvas(img, ROIS[k]);
          return recognize(canvas).then(function (t) { parts[k] = t || ""; });
        });
      });
      return seq.then(function () {
        var stitched = [parts.title, parts.diamonds, parts.outcomes, parts.footer].join("\n\n");
        var raw = buildRaw(stitched, stitched, parts.outcomes || stitched, parts);
        return self.constraintSnap(raw);
      }).catch(function () {
        // Regional path blew up — fall back to full frame.
        return recognize(preprocessFull(img)).then(function (txt) {
          return self.constraintSnap(buildRaw(txt, txt, txt));
        });
      });
    });
  };

  // Assemble a raw {config,state,outcomes,rarity,_debug} object from OCR text.
  function buildRaw(configText, stateText, outcomeText, parts) {
    var cfg = parseConfig(configText);
    var cut = parseCuttingState(stateText);
    // For outcome parsing we need known effect names — use whatever config we got,
    // snapped enough that effect targets resolve.
    var snappedCfgForOutcomes = {
      baseCost: cfg.baseCost || 10,
      gemType: cfg.gemType,
      effect1: cfg.effect1, effect2: cfg.effect2
    };
    var outcomes = parseOutcomes(outcomeText, snappedCfgForOutcomes);
    return {
      config: {
        baseCost: cfg.baseCost, gemType: cfg.gemType,
        willpowerLevel: cfg.willpowerLevel, orderLevel: cfg.orderLevel,
        effect1: cfg.effect1, effect1Level: cfg.effect1Level,
        effect2: cfg.effect2, effect2Level: cfg.effect2Level
      },
      state: {
        currentTurn: null, maxTurns: cut.maxTurns,
        turnsRemaining: cut.turnsRemaining,
        rerollsRemaining: cut.rerollsRemaining,
        processCost: cut.processCost, processCostMultiplier: cut.processCostMultiplier,
        totalGoldSpent: 0, rosterBound: false
      },
      rarity: cfg.rarity,
      outcomes: outcomes,
      _debug: { parts: parts || null, configText: configText.slice(0, 1200) }
    };
  }

  // ---------------- register + export ----------------

  var instance = new TesseractEngine();
  if (ENGINE_API.registerEngine) ENGINE_API.registerEngine(instance);

  var EXPORT = {
    TesseractEngine: TesseractEngine,
    instance: instance,
    // exported for the eval harness / unit testing in Node
    parseConfig: parseConfig,
    parseCuttingState: parseCuttingState,
    parseOutcomes: parseOutcomes,
    normalizeOcrText: normalizeOcrText
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = EXPORT;
  } else {
    root.TesseractEngine = TesseractEngine;
    root.tesseractEngine = instance;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
