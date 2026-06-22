/**
 * advisor.js — "Advisor" tab (STUB).
 *
 * Renders a placeholder into #tab-advisor for now. A later UI agent will build
 * this out.
 *
 * ============================ TODO (for the UI agent) ============================
 * The Advisor tab is the LIVE, per-turn decision view: the player is mid-cut and
 * wants to know "should I Process, Reroll, or Complete right now?".
 *
 * Plan:
 *  - INPUT via OCR: let the user paste / drop a screenshot of the cutting UI.
 *    Use the OCR engine contract in ocr/engine.js:
 *      const engine = new OcrEngine();             // (ocr/engine.js, currently a stub)
 *      const parsed = await engine.parseScreenshot(imageElementOrBlob);
 *        -> { config, state, outcomes:[4] }
 *      const snapped = engine.constraintSnap(parsed);  // clamp to valid values
 *    The agent will wire a real OCR backend (e.g. tesseract.js) behind that
 *    interface; until then, also provide manual inputs as a fallback (sticky
 *    `.inputs` panel — styles in styles.css).
 *  - Build the live `state` object (shape mirrors nested.js):
 *      { config, currentTurn, maxTurns, rerollsRemaining, processCost,
 *        processCostMultiplier, totalGoldSpent, rosterBound, outcomes:[4], history:[] }
 *  - Call the nested Monte Carlo evaluator (attached to window by nested.js):
 *      window.evaluateActions(state, baseline, goldPerDamage, numRuns, onProgress, options)
 *        -> { bestAction, allActions:[{name,value,aboveBaselineOdds,expectedScore,
 *             expectedCost,...}], expectedValues, currentValue }
 *    Run it off the main thread or chunked (numRuns is the MC sample count) and
 *    surface a progress bar via onProgress(completed,total).
 *  - Render the ranked actions (Process / Reroll / Complete) with net value,
 *    expected score, and above-baseline odds; highlight `bestAction`.
 *  - Methodology <details>: explain nested MC, the 25%-each-of-4-unique-outcomes
 *    process model, reroll cost (last reroll 3800), and fusion-fodder valuation.
 * ===============================================================================
 */
(function () {
  "use strict";
  function render() {
    var el = document.getElementById("tab-advisor");
    if (!el) return;
    el.innerHTML =
      '<div class="placeholder">' +
      '<b>Advisor tab — coming soon</b>' +
      'Live per-turn advice: Process vs Reroll vs Complete, ranked by expected gold.' +
      '<div class="note">Will use an OCR engine (ocr/engine.js) + window.evaluateActions.</div>' +
      '</div>';
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }
})();
