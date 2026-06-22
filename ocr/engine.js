/**
 * ocr/engine.js — common OCR-engine interface, the constraintSnap repair pass,
 * and a tiny engine registry.
 *
 * Works both as a browser <script> (reads the Astrogem model globals, attaches its
 * exports to globalThis) and as a Node `require()` (CommonJS). The model core
 * (model/astrogem.js) must be loaded first in the browser; in Node we require it.
 *
 * ============================ CONTRACT ============================
 *
 * An engine is any object/instance exposing:
 *
 *   async parseScreenshot(imageElOrBlob) -> { config, state, outcomes:[4] }
 *
 *     config:  { baseCost, gemType, willpowerLevel, orderLevel,
 *                effect1, effect1Level, effect2, effect2Level }
 *     state:   { currentTurn, maxTurns, rerollsRemaining,
 *                processCost, processCostMultiplier, totalGoldSpent, rosterBound }
 *     outcomes:[o1,o2,o3,o4]   // applyOutcome-shaped (see below)
 *
 *   isAvailable() -> boolean   // can this engine run in the current environment?
 *   name, label                // identity for the engine selector UI
 *
 * Outcome objects use the shape model/nested.js#applyOutcome consumes:
 *   { type:'raise_effect'|'lower_effect', target:'willpower'|'order'|'effect1'|'effect2', amount:1..4 }
 *   { type:'change_side_option', target:'effect1'|'effect2' }
 *   { type:'change_gold_cost', change:+100|-100 }
 *   { type:'reroll_increase', change:1|2 }
 *   { type:'do_nothing' }
 *
 * `constraintSnap(parsed)` is the SHARED accuracy lever: it clamps/repairs every
 * field so downstream code (window.evaluateActions) always receives a legal game
 * state, no matter how noisy the read was. Each concrete engine should pass its raw
 * parse through this before returning.
 * =================================================================
 */
(function (root) {
  "use strict";

  var A = (typeof module !== "undefined" && module.exports)
    ? require("../model/astrogem.js")
    : (root.Astrogem || root);

  // ---- canonical constants (read from the model core; fall back if absent) ----
  var EFFECT_POOLS = A.EFFECT_POOLS || {
    8:  ["Additional Damage", "Attack Power", "Brand Power", "Ally Damage Enh."],
    9:  ["Boss Damage", "Attack Power", "Ally Damage Enh.", "Ally Attack Enh."],
    10: ["Boss Damage", "Additional Damage", "Brand Power", "Ally Attack Enh."]
  };
  var RARITY = A.RARITY || {
    uncommon: { maxTurns: 5, maxRerolls: 1 },
    rare:     { maxTurns: 7, maxRerolls: 2 },
    epic:     { maxTurns: 9, maxRerolls: 3 }
  };
  var COSTS = A.COSTS || { processBase: 900, finalReroll: 3800, fusion: 500 };
  var VALID_BASE_COSTS = [8, 9, 10];

  // -------------------- small helpers --------------------

  function clampInt(v, lo, hi, dflt) {
    var n = parseInt(v, 10);
    if (isNaN(n)) n = (dflt != null ? dflt : lo);
    return Math.max(lo, Math.min(hi, n));
  }

  function clampLevel(v, dflt) {
    return clampInt(v, 1, 5, dflt != null ? dflt : 1);
  }

  // Map any base cost read to the nearest legal one (8/9/10). 11 -> 10, 7 -> 8, etc.
  function snapBaseCost(bc) {
    var n = parseInt(bc, 10);
    if (VALID_BASE_COSTS.indexOf(n) !== -1) return n;
    if (isNaN(n)) return 10; // default for DPS gems
    var best = VALID_BASE_COSTS[0], bestD = Infinity;
    for (var i = 0; i < VALID_BASE_COSTS.length; i++) {
      var d = Math.abs(VALID_BASE_COSTS[i] - n);
      if (d < bestD) { bestD = d; best = VALID_BASE_COSTS[i]; }
    }
    return best;
  }

  // Normalize an OCR-ish effect string to the canonical pool name (case/space/punct
  // tolerant, plus the usual misreads). Returns null when nothing plausible matches.
  var EFFECT_ALIASES = {
    "attack power": "Attack Power", "atk power": "Attack Power", "atk. power": "Attack Power",
    "alk power": "Attack Power", "alk. power": "Attack Power", "atkpower": "Attack Power",
    "additional damage": "Additional Damage", "add damage": "Additional Damage",
    "add. damage": "Additional Damage", "additionaldamage": "Additional Damage",
    "boss damage": "Boss Damage", "boss dmg": "Boss Damage", "bossdamage": "Boss Damage",
    "brand power": "Brand Power", "brandpower": "Brand Power",
    "ally damage enh.": "Ally Damage Enh.", "ally damage enh": "Ally Damage Enh.",
    "ally damage": "Ally Damage Enh.", "ally dmg enh": "Ally Damage Enh.",
    "ally dmg": "Ally Damage Enh.", "allydamageenh": "Ally Damage Enh.",
    "ally attack enh.": "Ally Attack Enh.", "ally attack enh": "Ally Attack Enh.",
    "ally attack": "Ally Attack Enh.", "ally atk": "Ally Attack Enh.",
    "allyattackenh": "Ally Attack Enh."
  };
  var ALL_EFFECT_NAMES = ["Attack Power", "Additional Damage", "Boss Damage",
    "Brand Power", "Ally Damage Enh.", "Ally Attack Enh."];

  function canonicalEffectName(raw) {
    if (!raw) return null;
    // Already canonical?
    if (ALL_EFFECT_NAMES.indexOf(raw) !== -1) return raw;
    var k = String(raw).toLowerCase().replace(/\s+/g, " ").trim();
    if (EFFECT_ALIASES[k]) return EFFECT_ALIASES[k];
    // alias by longest substring match
    var keys = Object.keys(EFFECT_ALIASES).sort(function (a, b) { return b.length - a.length; });
    for (var i = 0; i < keys.length; i++) {
      if (k.indexOf(keys[i]) !== -1) return EFFECT_ALIASES[keys[i]];
    }
    return null;
  }

  // Snap one effect to a base cost's pool. If `raw` resolves to a name that's in the
  // pool, keep it; otherwise pick the first pool entry not equal to `avoid`.
  function snapEffectToPool(raw, baseCost, avoid) {
    var pool = EFFECT_POOLS[baseCost] || [];
    if (pool.length === 0) return raw || null;
    var canon = canonicalEffectName(raw);
    if (canon && pool.indexOf(canon) !== -1 && canon !== avoid) return canon;
    // canonical name exists but isn't in this pool, or collides with `avoid`:
    // fall through to first available pool member.
    for (var i = 0; i < pool.length; i++) {
      if (pool[i] !== avoid) return pool[i];
    }
    return pool[0];
  }

  function rarityFromMaxTurns(maxTurns) {
    if (maxTurns === 5) return "uncommon";
    if (maxTurns === 7) return "rare";
    if (maxTurns === 9) return "epic";
    return null;
  }

  // Map a (possibly garbage) rarity string OR maxTurns to a legal rarity key.
  function snapRarity(rarity, maxTurns) {
    if (rarity && RARITY[rarity]) return rarity;
    var byTurns = rarityFromMaxTurns(maxTurns);
    if (byTurns) return byTurns;
    var r = String(rarity || "").toLowerCase();
    if (/epic|purple/.test(r)) return "epic";
    if (/uncommon|green/.test(r)) return "uncommon";
    if (/rare|blue/.test(r)) return "rare";
    return "epic"; // most cuttable DPS gems people screenshot are epic (9 turns)
  }

  // ----- outcome snapping -----

  var OUTCOME_TARGETS = ["willpower", "order", "effect1", "effect2"];

  // Repair a single outcome object into a legal applyOutcome-shaped object.
  function snapOutcome(o, config) {
    if (!o || typeof o !== "object") return { type: "do_nothing", description: "—" };
    var t = o.type;

    if (t === "raise_effect" || t === "lower_effect") {
      var target = OUTCOME_TARGETS.indexOf(o.target) !== -1 ? o.target : "willpower";
      var amount = clampInt(o.amount, 1, 4, 1); // game deltas are +/-1..4
      var nm = target === "willpower" ? "Willpower"
        : target === "order" ? (config && config.gemType === "chaos" ? "Chaos" : "Order")
        : target === "effect1" ? (config ? config.effect1 : "Effect 1")
        : (config ? config.effect2 : "Effect 2");
      var sign = t === "raise_effect" ? "+" : "-";
      return { type: t, target: target, amount: amount, effectName: nm,
        description: nm + " " + sign + amount };
    }

    if (t === "change_side_option") {
      var tgt = (o.target === "effect1" || o.target === "effect2") ? o.target : "effect1";
      var cur = config ? (tgt === "effect1" ? config.effect1 : config.effect2) : "";
      return { type: "change_side_option", target: tgt, currentEffect: cur,
        description: "Change " + (cur || tgt) };
    }

    if (t === "change_gold_cost") {
      // The game only ever shows +100% / -100% cost outcomes.
      var ch = parseInt(o.change, 10);
      if (ch > 0) ch = 100; else if (ch < 0) ch = -100; else ch = -100;
      return { type: "change_gold_cost", change: ch,
        description: "Cost " + (ch > 0 ? "+" : "") + ch + "%" };
    }

    if (t === "reroll_increase") {
      var rc = clampInt(o.change, 1, 2, 1); // reroll outcomes are +1 / +2
      return { type: "reroll_increase", change: rc, description: "Reroll +" + rc };
    }

    return { type: "do_nothing", description: "—" };
  }

  // -------------------- the main repair pass --------------------

  /**
   * constraintSnap(parsed) -> a fully-legal { config, state, outcomes:[4] }.
   *
   * Tolerant of partial / missing / impossible reads:
   *   - baseCost snapped to {8,9,10}
   *   - effects canonicalized + snapped into EFFECT_POOLS[baseCost], effect1 != effect2
   *   - every level clamped to 1..5
   *   - rarity in {uncommon,rare,epic}; maxTurns/rerolls derived from rarity
   *   - currentTurn in 1..maxTurns; turn 1 implies full rerolls
   *   - rerollsRemaining in 0..maxRerolls
   *   - processCostMultiplier in [-100,100], snapped to a 100-step the game uses,
   *     processCost made consistent with 900*(1+mult/100)
   *   - outcomes array padded/trimmed to exactly 4 and each repaired
   *
   * Does not mutate the input; returns a fresh object.
   */
  function constraintSnap(parsed) {
    parsed = parsed || {};
    var cIn = parsed.config || {};
    var sIn = parsed.state || {};

    // ---- config ----
    var baseCost = snapBaseCost(cIn.baseCost);
    var gemType = (cIn.gemType === "chaos") ? "chaos" : "order";

    var willpowerLevel = clampLevel(cIn.willpowerLevel, 1);
    var orderLevel = clampLevel(cIn.orderLevel, 1);
    var effect1Level = clampLevel(cIn.effect1Level, 1);
    var effect2Level = clampLevel(cIn.effect2Level, 1);

    var effect1 = snapEffectToPool(cIn.effect1, baseCost, null);
    var effect2 = snapEffectToPool(cIn.effect2, baseCost, effect1);
    if (effect1 === effect2) {
      // force-distinct from the pool
      var pool = EFFECT_POOLS[baseCost] || [];
      for (var i = 0; i < pool.length; i++) {
        if (pool[i] !== effect1) { effect2 = pool[i]; break; }
      }
    }

    var config = {
      baseCost: baseCost,
      gemType: gemType,
      willpowerLevel: willpowerLevel,
      orderLevel: orderLevel,
      effect1: effect1,
      effect1Level: effect1Level,
      effect2: effect2,
      effect2Level: effect2Level
    };

    // ---- rarity / turns / rerolls ----
    var rarity = snapRarity(parsed.rarity || sIn.rarity, sIn.maxTurns);
    var rr = RARITY[rarity] || RARITY.epic;
    var maxTurns = rr.maxTurns;
    var maxRerolls = rr.maxRerolls;

    // currentTurn: prefer explicit; else derive from turnsRemaining if present.
    var currentTurn;
    if (sIn.currentTurn != null) {
      currentTurn = clampInt(sIn.currentTurn, 1, maxTurns, 1);
    } else if (sIn.turnsRemaining != null) {
      var tr = clampInt(sIn.turnsRemaining, 1, maxTurns, maxTurns);
      currentTurn = maxTurns - tr + 1;
    } else {
      currentTurn = 1;
    }
    currentTurn = Math.max(1, Math.min(maxTurns, currentTurn));

    var rerollsRemaining;
    if (currentTurn === 1) {
      // turn 1 always shows the full free-reroll allotment
      rerollsRemaining = maxRerolls;
    } else {
      rerollsRemaining = clampInt(sIn.rerollsRemaining, 0, maxRerolls, maxRerolls);
    }

    // ---- process cost / multiplier ----
    // The game's cost outcomes step by 100% and the multiplier is bounded [-100,100].
    var mult;
    if (sIn.processCostMultiplier != null) {
      mult = clampInt(sIn.processCostMultiplier, -100, 100, 0);
    } else if (sIn.processCost != null) {
      mult = Math.round((clampInt(sIn.processCost, 1, 99999, COSTS.processBase) / COSTS.processBase - 1) * 100);
      mult = Math.max(-100, Math.min(100, mult));
    } else {
      mult = 0;
    }
    // Snap to the discrete steps the game actually uses (…,-100,0,100). The only
    // reachable multipliers are -100, 0, +100 (each cost outcome is ±100%).
    mult = mult <= -50 ? -100 : (mult >= 50 ? 100 : 0);
    var processCost = Math.max(1, Math.round(COSTS.processBase * (1 + mult / 100)));

    var state = {
      currentTurn: currentTurn,
      maxTurns: maxTurns,
      rerollsRemaining: rerollsRemaining,
      processCost: processCost,
      processCostMultiplier: mult,
      totalGoldSpent: Math.max(0, parseInt(sIn.totalGoldSpent, 10) || 0),
      rosterBound: !!sIn.rosterBound
    };

    // ---- outcomes ----
    var rawOutcomes = Array.isArray(parsed.outcomes) ? parsed.outcomes.slice(0, 4) : [];
    var outcomes = [];
    for (var j = 0; j < 4; j++) {
      outcomes.push(snapOutcome(rawOutcomes[j], config));
    }

    return { config: config, state: state, outcomes: outcomes, rarity: rarity };
  }

  // -------------------- engine registry --------------------

  // Engines self-register here (by stable `name`) when their script loads. The
  // Advisor picks one by name; constraintSnap is exposed on every engine via the
  // BaseEngine prototype so engines never have to reimplement it.
  var _registry = {};

  function registerEngine(engine) {
    if (engine && engine.name) _registry[engine.name] = engine;
    return engine;
  }
  function getEngine(name) { return _registry[name] || null; }
  function listEngines() {
    return Object.keys(_registry).map(function (k) { return _registry[k]; });
  }

  // -------------------- BaseEngine --------------------

  // Concrete engines extend this; they only need to implement parseScreenshot()
  // (returning a raw {config,state,outcomes}) and may override isAvailable().
  function BaseEngine() {}
  BaseEngine.prototype.name = "base";
  BaseEngine.prototype.label = "Base (unimplemented)";
  BaseEngine.prototype.isAvailable = function () { return false; };
  BaseEngine.prototype.parseScreenshot = function () {
    return Promise.reject(new Error("BaseEngine.parseScreenshot is abstract."));
  };
  // Shared repair pass — engines call this.constraintSnap(raw) before returning.
  BaseEngine.prototype.constraintSnap = function (parsed) { return constraintSnap(parsed); };

  // Back-compat shim: the original stub exported an `OcrEngine` class. Keep the name
  // pointing at BaseEngine so anything referencing `new OcrEngine()` still works and
  // now gets a real constraintSnap.
  var OcrEngine = BaseEngine;

  // -------------------- exports (dual) --------------------

  var API = {
    constraintSnap: constraintSnap,
    snapOutcome: snapOutcome,
    snapBaseCost: snapBaseCost,
    snapEffectToPool: snapEffectToPool,
    canonicalEffectName: canonicalEffectName,
    snapRarity: snapRarity,
    rarityFromMaxTurns: rarityFromMaxTurns,
    BaseEngine: BaseEngine,
    OcrEngine: OcrEngine,
    registerEngine: registerEngine,
    getEngine: getEngine,
    listEngines: listEngines,
    EFFECT_POOLS: EFFECT_POOLS,
    RARITY: RARITY,
    COSTS: COSTS
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = API;
  } else {
    root.OcrEngineAPI = API;
    root.OcrEngine = OcrEngine;
    root.BaseEngine = BaseEngine;
    root.ocrConstraintSnap = constraintSnap;
    root.ocrRegisterEngine = registerEngine;
    root.ocrGetEngine = getEngine;
    root.ocrListEngines = listEngines;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
