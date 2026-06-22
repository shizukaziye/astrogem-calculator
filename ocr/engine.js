/**
 * ocr/engine.js — OCR engine interface contract (STUB).
 *
 * Defines the shape the Advisor tab expects from a screenshot parser. No real OCR
 * backend is wired yet; a later agent will implement parseScreenshot() (e.g. with
 * tesseract.js) behind this contract so the rest of the app doesn't change.
 *
 * ============================ CONTRACT ============================
 *
 * class OcrEngine {
 *   async parseScreenshot(imageElementOrBlob) -> {
 *     config:  {                       // the gem being cut
 *       baseCost, gemType,
 *       willpowerLevel, orderLevel,
 *       effect1, effect1Level,
 *       effect2, effect2Level
 *     },
 *     state:   {                       // cutting progress
 *       currentTurn, maxTurns,
 *       rerollsRemaining,
 *       processCost, processCostMultiplier,
 *       totalGoldSpent, rosterBound
 *     },
 *     outcomes: [o1, o2, o3, o4]       // the 4 on-screen outcomes for this turn
 *   }
 *
 *   constraintSnap(parsed) -> parsed   // clamp every field to a VALID value:
 *     - levels clamped to 1..5
 *     - baseCost in {8,9,10}; effects snapped to that cost's pool (EFFECT_POOLS)
 *     - effect1 !== effect2
 *     - currentTurn in 1..maxTurns; maxTurns/rerolls consistent with rarity
 *     - processCostMultiplier in [-100, +100]
 *     - outcomes array padded/trimmed to length 4
 * }
 *
 * The engine should be tolerant of OCR noise: constraintSnap is where best-guess
 * corrections happen (e.g. nearest-valid effect name, clamp out-of-range levels),
 * so downstream code (nested.js evaluateActions) always receives a legal state.
 * =================================================================
 */
(function (root) {
  "use strict";

  // Placeholder engine. Methods reject / throw until a real backend is wired so
  // callers fail loudly rather than acting on empty data.
  function OcrEngine() {}

  OcrEngine.prototype.parseScreenshot = function (/* imageElementOrBlob */) {
    return Promise.reject(new Error("OcrEngine.parseScreenshot not implemented yet (stub)."));
  };

  // Identity passthrough for now; a real impl clamps to valid values per the
  // contract above. Kept side-effect-free.
  OcrEngine.prototype.constraintSnap = function (parsed) {
    return parsed;
  };

  // Export an empty default for now (the stub class), dual browser/Node.
  var API = { OcrEngine: OcrEngine };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = API;
  } else {
    root.OcrEngine = OcrEngine;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
