/**
 * pipeline.js — "Pipeline" tab (STUB).
 *
 * Renders a placeholder into #tab-pipeline for now. A later UI agent will build
 * this out.
 *
 * ============================ TODO (for the UI agent) ============================
 * The Pipeline tab is the BATCH / strategy view: "for a given market (goldPerDamage)
 * and baseline, what is a random gem in each tier worth, and what's the EV of
 * cutting an uncommon/rare/epic from scratch?".
 *
 * Plan:
 *  - Load a data file `data/pipeline.json` (preset scenarios / grids the agent
 *    will define — e.g. baselines, gold-per-damage tiers, rarities to show).
 *    Use `fetch('data/pipeline.json')` (served over http; the page is opened via
 *    a local static server, see README / `npm run serve`).
 *  - Read user inputs (baseCost, baseline, goldPerDamage, rarity) from a sticky
 *    collapsible `.inputs` panel (styles already in styles.css: .inputs/.ig/.fld,
 *    toggle buttons `.mbtn`, primary button `button.primary`).
 *  - Call the model-core globals (attached to window by model/astrogem.js):
 *      window.tierExpectedValue(baseCost, baseline, goldPerDamage)
 *        -> { legendary, relic, ancient }   (joint fixed-point EV per tier)
 *      window.goldValue(score, baseline, goldPerDamage)
 *        -> direct sale value of a single gem
 *      window.fusionValueForTier(tier, baseCost, baseline, goldPerDamage)
 *        -> fodder value of fusing 3 of a tier
 *      window.scoreDistributionForTier(baseCost, tier)  (Map<score,prob>)
 *        -> for charts / "odds of clearing baseline"
 *  - Render results as tables (`.num` right-aligned, tier color classes
 *    .legendary/.relic/.ancient) and a methodology <details> block mirroring the
 *    real formulas (SCORE_PER_PERCENT_DAMAGE = 30.96, fusion 99/1, 73/25/2,
 *    35/40/25, fixed-point E[L],E[R],E[A]).
 *  - Follow the lifecycle pattern from the calculator-webapp skill:
 *    DEFAULTS -> setDefaultsToInputs -> readParams -> recalc -> renderX.
 * ===============================================================================
 */
(function () {
  "use strict";
  function render() {
    var el = document.getElementById("tab-pipeline");
    if (!el) return;
    el.innerHTML =
      '<div class="placeholder">' +
      '<b>Pipeline tab — coming soon</b>' +
      'Batch expected-value view (tier EV, fusion fodder, cut-from-scratch EV).' +
      '<div class="note">Will read data/pipeline.json and call window.tierExpectedValue / window.goldValue.</div>' +
      '</div>';
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }
})();
