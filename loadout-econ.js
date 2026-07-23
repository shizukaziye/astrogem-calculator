/**
 * loadout-econ.js — shared "what does this loadout recommend?" machinery.
 *
 * Extracted from grader.js (2026-07-16) so the Advisor tab can reuse the
 * recommended-gpd / rank-ladder-baseline / axis logic without duplicating it.
 * grader.js consumes this module through thin same-name wrappers that close over
 * its own UI state (grMode, grBaseShift), so every grader call site is unchanged.
 * leaderboard.js still carries its own decodeSnapshotV2 copy (it is lazy-loaded
 * and independent) — migrating it here is a separate cleanup.
 *
 * Everything is PARAMETERIZED (axis / shift passed in) — this module holds no UI
 * state. Node-safe like ocr/engine.js: require()able for tests; in the browser it
 * attaches window.LoadoutEcon. fieldSnapshot()/fetchCharacter() are browser-only
 * (they need fetch + the deployed worker).
 *
 * Exports:
 *   WORKER_URL, GRADE_ROWS, GPD_TIERS, GPD_DEFAULT
 *   gpdLabel(g)                      -> "1.5M" / "500k"
 *   cpToGpd(cp)                      -> gpd tier from combat-power bands | null
 *   accessoriesImpliedGpd(acc, axis) -> 5M/2.5M/500k | null   (axis "dps"|"support")
 *   gemsImpliedFloor(levels)         -> 5M/1.5M | null        (classic-gem floor)
 *   defaultModeFor({class, gems})    -> "dps"|"support"       (assumes the support
 *                                       axis exists — callers gate availability)
 *   bumpedBaselineGrade(gemGrade)    -> GRADE_ROWS grade one rank above
 *   gradeRowIdx(g)                   -> index into GRADE_ROWS (exact else nearest)
 *   typeBaseline(gems, type, axis)   -> {srcGrade, srcRank, baseGrade, baseRank, count} | null
 *   blanketBaseline(gems, opts)      -> the ONE loadout baseline ({axis, shift} in opts)
 *   fieldSnapshot()                  -> Promise<[{region,name,class,gems}]|null> (session-cached)
 *   fetchCharacter(region, name, o)  -> Promise<{ok, status, data}> (o.refresh => &refresh=1)
 */
(function (root) {
  "use strict";
  var IS_NODE = typeof module !== "undefined" && module.exports;
  var A = IS_NODE ? require("./model/astrogem.js") : ((root && root.Astrogem) || root || {});

  var WORKER_URL = "https://astrogem-bible.shizukaziye.workers.dev";

  // ---- model handles (same fallback semantics grader.js used) ----
  function grade(cfg) { return A.grade(cfg); }
  function supportGrade(cfg) { return A.supportGrade ? A.supportGrade(cfg) : A.grade(cfg); }
  function rankFromGrade(g) { return A.rankFromGrade(g); }
  function validateConfig(cfg) { return A.validateConfig ? A.validateConfig(cfg) : { valid: true }; }
  // Axis-aware gem grade (the grader's gGrade, parameterized).
  function gradeOf(cfg, axis) { return axis === "support" ? supportGrade(cfg) : grade(cfg); }

  // ---- the rank ladder + gpd tiers (must match the pipeline bake's anchors) ----
  // The Pipeline tab bakes one DP solve per these 12 anchor grades; each maps 1:1 to a
  // distinct rank (C- … S+), so the array IS a clean rank ladder.
  var GRADE_ROWS = [40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95];
  var GPD_TIERS = [500000, 1000000, 1500000, 2500000, 3500000, 5000000, 7500000, 10000000];
  var GPD_DEFAULT = 1500000;

  function gpdLabel(g) {
    if (g >= 1000000) { var m = (g / 1000000).toFixed(1).replace(/\.0$/, ""); return m + "M"; }
    return (g / 1000).toFixed(0) + "k";
  }

  // Combat-power → gpd tier bands (7.5M and 10M are deliberately manual-only).
  function cpToGpd(cp) {
    if (cp == null || !isFinite(cp) || cp <= 0) return null;
    if (cp < 3500) return 500000;
    if (cp < 4500) return 1000000;
    if (cp < 5500) return 1500000;
    if (cp < 6500) return 2500000;
    if (cp < 7500) return 3500000;
    return 5000000;
  }

  // ---- accessory / classic-gem consistency signals ----
  // Primary accessory lines → low/mid/high roll values (×100, matching the worker's
  // accessory line values), from lost-ark-accessories METHODOLOGY §2 (DPS) and §3
  // (support). AXIS-AWARE: on the support axis a loadout is judged by its support
  // primaries (Stigma / Gauge / Ally buffs / Weapon%).
  var ACC_TIERS_DPS = {
    "Outgoing Damage %": [55, 120, 200],
    "Additional Damage %": [95, 160, 260],
    "Attack Power %": [40, 95, 155],
    "Weapon Attack Power %": [80, 180, 300],
    "Crit Rate %": [40, 95, 155],
    "Crit Damage %": [110, 240, 400]
  };
  var ACC_TIERS_SUPPORT = {
    "Stigma %": [215, 480, 800],
    "Gauge Gain %": [160, 360, 600],
    "Ally Dmg Buff %": [200, 450, 750],
    "Ally Atk Buff %": [135, 300, 500],
    "Weapon Attack Power %": [80, 180, 300]
  };
  function accLineTier(name, value, table) {   // -> 0 low / 1 mid / 2 high, or null (not a primary)
    var t = table[name];
    if (!t || value == null) return null;
    for (var i = 2; i >= 0; i--) if (value >= t[i] - 1) return i;   // -1: float-drift guard
    return 0;
  }
  // Per accessory: the MIN of its primary tiers (high/low ≈ 500k, high/high ≈ 5M, mixes
  // in between). A single primary counts as (primary + nothing) = budget — EXCEPT support
  // earrings, whose pool has ONE primary by design (Weapon Attack Power %). Aggregate =
  // median over the five; needs ≥3 classifiable accessories, else no signal.
  function accessoriesImpliedGpd(accessories, axis) {
    if (!accessories || !accessories.length) return null;
    var support = axis === "support";
    var table = support ? ACC_TIERS_SUPPORT : ACC_TIERS_DPS;
    var per = [];
    for (var i = 0; i < accessories.length; i++) {
      var slot = accessories[i].slot || "";
      var lines = accessories[i].lines || [];
      var tiers = [];
      for (var j = 0; j < lines.length; j++) {
        var t = accLineTier(lines[j].name, lines[j].value, table);
        if (t != null) tiers.push(t);
      }
      if (!tiers.length) continue;                       // no primary on this axis — unclassifiable
      var singleIsFull = support && (slot === "ear1" || slot === "ear2");
      per.push((tiers.length >= 2 || singleIsFull) ? Math.min.apply(null, tiers) : 0);
    }
    if (per.length < 3) return null;
    per.sort(function (a, b) { return a - b; });
    var med = per[Math.floor(per.length / 2)];
    return med >= 2 ? 5000000 : med >= 1 ? 2500000 : 500000;
  }

  // Classic-gem floor: full lv10s → at least 5M, full lv9s → at least 1.5M. Requires a
  // fully parsed set (≥8 gems, no nulls) so a partial parse can't fake a floor.
  function gemsImpliedFloor(levels) {
    if (!levels || levels.length < 8) return null;
    var min = Infinity;
    for (var i = 0; i < levels.length; i++) {
      if (levels[i] == null || !isFinite(levels[i])) return null;
      if (levels[i] < min) min = levels[i];
    }
    if (min >= 10) return 5000000;
    if (min >= 9) return 1500000;
    return null;
  }

  // ---- default grading axis for a loadout ----
  // Support classes that CAN play support (gate for the support-default auto-detect).
  var SUPPORT_CLASSES = { Bard: 1, Paladin: 1, Artist: 1, Valkyrie: 1 };
  var SUPPORT_EFFECTS = { "Ally Attack Enh.": 1, "Brand Power": 1, "Ally Damage Enh.": 1 };
  var DPS_EFFECTS = { "Attack Power": 1, "Additional Damage": 1, "Boss Damage": 1 };

  // A loadout is "support-dominant" if, summed across every gem, the levels on support
  // effects CLEARLY outweigh the DPS-effect levels (>= 2x). A real support runs almost no
  // DPS gems (observed ~3.6-3.9x), while a hybrid / DPS-built valkyrie sits near parity
  // (~1.3x), so a 2x gate separates them and keeps mixed builds defaulting to DPS.
  function supportDominant(gems) {
    var sup = 0, dps = 0;
    (gems || []).forEach(function (x) {
      [["effect1", "effect1Level"], ["effect2", "effect2Level"]].forEach(function (p) {
        var name = x[p[0]], lv = x[p[1]] || 0;
        if (SUPPORT_EFFECTS[name]) sup += lv;
        else if (DPS_EFFECTS[name]) dps += lv;
      });
    });
    return sup > 0 && sup >= dps * 2;
  }

  // The DEFAULT grading axis for a loadout: support iff a support class AND a
  // support-dominant gem set. NOTE: assumes the support axis exists in the model —
  // callers that must tolerate an old model gate on availability themselves (the
  // grader wrapper does; the advisor checks window.supportGradeToScore).
  function defaultModeFor(data) {
    var cls = data && data.class;
    var gems = (data && data.gems) || [];
    if (cls && SUPPORT_CLASSES[cls] && supportDominant(gems)) return "support";
    return "dps";
  }

  // ---- the rank ladder mechanics ----
  // rank string -> index in GRADE_ROWS (cached). Built by ranking each anchor grade.
  var RANK_TO_IDX = null;
  function rankToIdx() {
    if (RANK_TO_IDX) return RANK_TO_IDX;
    RANK_TO_IDX = {};
    for (var i = 0; i < GRADE_ROWS.length; i++) RANK_TO_IDX[rankFromGrade(GRADE_ROWS[i])] = i;
    return RANK_TO_IDX;
  }

  // The baseline GRADE_ROWS grade for a gem grade, bumped ONE rank up: find the
  // anchor index for the gem's rank, step +1 (clamped to the top), return that
  // anchor grade. Falls back to the gem's own anchor if its rank isn't on the ladder.
  function bumpedBaselineGrade(gemGrade) {
    var map = rankToIdx();
    var rank = rankFromGrade(gemGrade);
    var idx = map[rank];
    if (idx == null) {
      // off-ladder: snap to the nearest anchor grade by value, then bump.
      var best = 0, bd = Infinity;
      for (var i = 0; i < GRADE_ROWS.length; i++) {
        var d = Math.abs(GRADE_ROWS[i] - gemGrade);
        if (d < bd) { bd = d; best = i; }
      }
      idx = best;
    }
    var up = Math.min(idx + 1, GRADE_ROWS.length - 1);
    return GRADE_ROWS[up];
  }

  // GRADE_ROWS index of an anchor grade (exact match, else nearest by value).
  function gradeRowIdx(g) {
    var i = GRADE_ROWS.indexOf(g);
    if (i !== -1) return i;
    var best = 0, bd = Infinity;
    for (var k = 0; k < GRADE_ROWS.length; k++) {
      var d = Math.abs(GRADE_ROWS[k] - g);
      if (d < bd) { bd = d; best = k; }
    }
    return best;
  }

  // ORDER/CHAOS baseline from the 3rd-lowest-GRADE gem of that type, bumped one
  // rank up. <3 valid gems -> use the lowest available. Returns null if none.
  // AXIS-AWARE: on the support axis the baseline comes from support grades.
  //   { srcGrade, srcRank, baseGrade, baseRank, count }
  function typeBaseline(gems, gemType, axis) {
    var graded = (gems || []).filter(function (x) {
      return x.gemType === gemType && validateConfig(x).valid;
    }).map(function (x) { return gradeOf(x, axis); }).sort(function (a, b) { return a - b; });
    if (!graded.length) return null;
    var src = graded.length >= 3 ? graded[2] : graded[0];
    var baseGrade = bumpedBaselineGrade(src);
    return {
      srcGrade: src, srcRank: rankFromGrade(src),
      baseGrade: baseGrade, baseRank: rankFromGrade(baseGrade),
      count: graded.length
    };
  }

  // ONE blanket baseline for the whole loadout (NOT per Order/Chaos). Take the 3rd-lowest
  // -grade gem of EACH type (typeBaseline.srcGrade), keep the STRONGER (higher-grade) of
  // the two, bump it one rank up — then apply the manual ◀▶ shift (opts.shift), clamped
  // to GRADE_ROWS. Returns null only if the loadout has no valid gems at all.
  //   { srcGrade, srcRank, srcType, baseIdx, baseGrade, baseRank,
  //     shift, atMin, atMax, order, chaos }
  function blanketBaseline(gems, opts) {
    opts = opts || {};
    var axis = opts.axis === "support" ? "support" : "dps";
    var shift = opts.shift | 0;
    var bo = typeBaseline(gems, "order", axis);
    var bc = typeBaseline(gems, "chaos", axis);
    if (!bo && !bc) return null;
    // stronger SOURCE gem across the two types (ties -> order, arbitrary but stable)
    var src, srcType;
    if (bo && (!bc || bo.srcGrade >= bc.srcGrade)) { src = bo.srcGrade; srcType = "order"; }
    else { src = bc.srcGrade; srcType = "chaos"; }
    var bumped = bumpedBaselineGrade(src);               // one rank above the stronger source
    var idx = gradeRowIdx(bumped);
    var shifted = Math.max(0, Math.min(GRADE_ROWS.length - 1, idx + shift));
    var baseGrade = GRADE_ROWS[shifted];
    return {
      srcGrade: src, srcRank: rankFromGrade(src), srcType: srcType,
      baseIdx: shifted, baseGrade: baseGrade, baseRank: rankFromGrade(baseGrade),
      shift: shift, atMin: shifted <= 0, atMax: shifted >= GRADE_ROWS.length - 1,
      order: bo, chaos: bc
    };
  }

  // ---- worker access (browser-only) ----
  function gateToken() {
    var g = (typeof window !== "undefined") && window.astrogemGate;
    return (g && g.token && g.token()) || "";
  }

  // The cached-roster snapshot (?list=1&fmt=2), decoded to [{region, name, class, gems}].
  // Session-cached; a failed fetch clears the cache so the next call retries. Kept in
  // lockstep with decodeSnapshotV2 in leaderboard.js.
  var FR_SLOT = { 1: "Order Sun", 2: "Order Moon", 3: "Order Star", 4: "Chaos Sun", 5: "Chaos Moon", 6: "Chaos Star" };
  function decodeFieldSnapshot(data) {
    if (!data || data.v !== 2) return (data && data.characters) || [];
    var classes = data.classes || [], effects = data.effects || [];
    function eff(i) { return (typeof i === "number" && i > 0) ? (effects[i - 1] || null) : null; }
    return (data.characters || []).map(function (a) {
      return { region: a[0], name: a[1], class: (a[3] != null && a[3] >= 0) ? classes[a[3]] : null,
        gems: (a[5] || []).map(function (t) {
          var core = t[0] | 0;
          return { slot: core ? FR_SLOT[core] : null, coreBase: core ? 10000 + core : null,
            baseCost: t[1], gemType: t[2] ? "chaos" : "order", willpowerLevel: t[3], orderLevel: t[4],
            effect1: eff(t[5]), effect1Level: t[6], effect2: eff(t[7]), effect2Level: t[8] };
        }) };
    });
  }
  var fieldSnapPromise = null;
  function fieldSnapshot() {
    if (typeof fetch === "undefined") return Promise.resolve(null);
    if (!fieldSnapPromise && WORKER_URL) {
      var k = gateToken();
      fieldSnapPromise = fetch(WORKER_URL.replace(/\/+$/, "") + "/?list=1&fmt=2" + (k ? "&k=" + encodeURIComponent(k) : ""))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(decodeFieldSnapshot)
        .catch(function () { fieldSnapPromise = null; return null; });
    }
    return fieldSnapPromise || Promise.resolve(null);
  }

  // One character pull (cached records return instantly and carry combatPower /
  // accessories / classicGemLevels since the 2026-07 worker update). Resolves
  // { ok, status, data } — the same shape grader.js's runPull consumed inline.
  function fetchCharacter(region, name, opts) {
    if (typeof fetch === "undefined") return Promise.reject(new Error("fetchCharacter is browser-only"));
    var k = gateToken();
    // &s= is the signed-in user's lostark.bible session: the Worker swaps it for their OAuth token
    // so the upstream page fetch is made on their behalf. Empty when signed out.
    var s = (typeof window !== "undefined" && window.bibleAuth) ? window.bibleAuth.param() : "";
    var url = WORKER_URL.replace(/\/+$/, "") +
      "/?region=" + encodeURIComponent(region) + "&name=" + encodeURIComponent(name) +
      "&queue=1&pos=1" +
      (opts && opts.refresh ? "&refresh=1" : "") +
      (k ? "&k=" + encodeURIComponent(k) : "") + s;
    return fetch(url).then(function (resp) {
      return resp.json().then(function (data) { return { ok: resp.ok, status: resp.status, data: data }; });
    });
  }

  // ---- exports ----
  var API = {
    WORKER_URL: WORKER_URL,
    GRADE_ROWS: GRADE_ROWS,
    GPD_TIERS: GPD_TIERS,
    GPD_DEFAULT: GPD_DEFAULT,
    gpdLabel: gpdLabel,
    cpToGpd: cpToGpd,
    accessoriesImpliedGpd: accessoriesImpliedGpd,
    gemsImpliedFloor: gemsImpliedFloor,
    defaultModeFor: defaultModeFor,
    supportDominant: supportDominant,
    bumpedBaselineGrade: bumpedBaselineGrade,
    gradeRowIdx: gradeRowIdx,
    typeBaseline: typeBaseline,
    blanketBaseline: blanketBaseline,
    fieldSnapshot: fieldSnapshot,
    fetchCharacter: fetchCharacter
  };

  if (IS_NODE) module.exports = API;
  else root.LoadoutEcon = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
