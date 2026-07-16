/**
 * advisor.js — the "Advisor" tab: live, per-turn "Process / Reroll / Complete?"
 * advice for an in-progress astrogem cut.
 *
 * Flow:
 *   1. Drop / paste / upload a Processing screenshot (optional).
 *   2. Pick an engine (Tesseract default, offline; Workers AI shown but disabled
 *      until ocr/workersai-engine.js#WORKER_URL is set).
 *   3. The engine -> { config, state, outcomes:[4] } (already constraint-snapped).
 *   4. Prefill a FULLY EDITABLE form: gem config + cutting state + the 4 outcomes
 *      as quick-confirm dropdowns (type / target / amount). The form is fully usable
 *      for MANUAL entry with no screenshot at all.
 *   5. "Get advice" builds the state and runs window.evaluateActions in-browser
 *      (quick/standard/deep presets control numRuns + inner runs) with a progress
 *      indicator, then renders the recommended action + per-option cards showing
 *      P(above baseline) and +/- EV gold.
 *
 * Uses the dark-theme classes in styles.css; a small scoped <style> block adds the
 * few advisor-specific bits (drop zone, outcome grid, action cards) without editing
 * styles.css.
 *
 * Model API (attached to window by model/nested.js + model/astrogem.js):
 *   window.evaluateActions(state, baseline, goldPerDamage, numRuns, onProgress, opts)
 *     -> { bestAction, allActions:[{name,value,expectedScore,expectedCost,
 *          aboveBaselineOdds,description}], expectedValues, expectedScores,
 *          currentValue, includeSim2 }
 *   window.availableEffects(baseCost), window.RARITY, window.validateConfig, window.score
 */
(function () {
  "use strict";

  // ---- model-core handles (with safe fallbacks for the constants) ----
  var RARITY = (typeof window !== "undefined" && window.RARITY) || {
    uncommon: { maxTurns: 5, maxRerolls: 1 },
    rare:     { maxTurns: 7, maxRerolls: 2 },
    epic:     { maxTurns: 9, maxRerolls: 3 }
  };
  function availableEffects(bc) {
    if (typeof window.availableEffects === "function") return window.availableEffects(bc);
    var P = (window.EFFECT_POOLS) || {};
    return (P[bc] || []).slice();
  }

  var SPEED_PRESETS = {
    quick:    { numRuns: 350,  inner: 80,  label: "Quick" },
    standard: { numRuns: 1000, inner: 150, label: "Standard" },
    deep:     { numRuns: 3500, inner: 280, label: "Deep" }
  };

  var OUTCOME_TYPES = [
    { v: "raise_effect", t: "Raise (+)" },
    { v: "lower_effect", t: "Lower (-)" },
    { v: "change_side_option", t: "Change side option" },
    { v: "change_gold_cost", t: "Cost +/- 100%" },
    { v: "reroll_increase", t: "Reroll +" },
    { v: "do_nothing", t: "Do nothing" }
  ];
  var OUTCOME_TARGETS = [
    { v: "willpower", t: "Willpower" },
    { v: "order", t: "Order" },
    { v: "effect1", t: "Effect 1" },
    { v: "effect2", t: "Effect 2" }
  ];

  var lastObjectUrl = null;

  // ---------------- DOM helpers ----------------
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) if (attrs.hasOwnProperty(k)) e.setAttribute(k, attrs[k]);
    if (html != null) e.innerHTML = html;
    return e;
  }
  function opts(list, sel) {
    return list.map(function (o) {
      var v = typeof o === "object" ? o.v : o;
      var t = typeof o === "object" ? o.t : o;
      return '<option value="' + String(v).replace(/"/g, "&quot;") + '"' +
        (String(v) === String(sel) ? " selected" : "") + ">" + t + "</option>";
    }).join("");
  }

  // ---------------- markup ----------------
  function tabMarkup() {
    return '' +
'<style>' +
'  #tab-advisor .av-drop{border:2px dashed var(--border);border-radius:10px;padding:22px 16px;text-align:center;color:var(--dim);cursor:pointer;transition:border-color .15s,background .15s;background:var(--panel2)}' +
'  #tab-advisor .av-drop.drag{border-color:var(--accent);background:rgba(102,199,255,.08);color:var(--text)}' +
'  #tab-advisor .av-drop b{color:var(--text)}' +
'  #tab-advisor .av-preview{max-width:100%;max-height:240px;border-radius:8px;border:1px solid var(--border);margin-top:10px;display:none}' +
'  #tab-advisor .av-status{font-size:12px;color:var(--dim);margin-top:8px;min-height:16px}' +
'  #tab-advisor .av-status.working{color:var(--accent)}' +
'  #tab-advisor .av-status.err{color:var(--bad)}' +
'  #tab-advisor .av-engines{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}' +
'  #tab-advisor .av-eng{position:relative}' +
'  #tab-advisor .mbtn:disabled{opacity:.45;cursor:not-allowed}' +
'  #tab-advisor .av-outcomes{display:grid;grid-template-columns:1fr 1fr;gap:8px}' +
'  @media(max-width:640px){#tab-advisor .av-outcomes{grid-template-columns:1fr}}' +
'  #tab-advisor .av-out{border:1px solid var(--border);border-radius:8px;padding:8px 10px;background:var(--panel2)}' +
'  #tab-advisor .av-out .oh{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--accent);font-weight:700;margin-bottom:6px}' +
'  #tab-advisor .av-out .orow{display:grid;grid-template-columns:1fr auto;gap:6px;align-items:end}' +
'  #tab-advisor .av-out select,#tab-advisor .av-out input{background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:4px 6px;font:13px inherit;width:100%}' +
'  #tab-advisor .av-out .amt{width:58px}' +
'  #tab-advisor .av-cards{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:12px}' +
'  @media(max-width:640px){#tab-advisor .av-cards{grid-template-columns:1fr}}' +
'  #tab-advisor .av-card{border:1px solid var(--border);border-radius:10px;padding:12px 14px;background:var(--panel2)}' +
'  #tab-advisor .av-card.best{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent) inset}' +
'  #tab-advisor .av-card .cn{font-size:15px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:8px}' +
'  #tab-advisor .av-card .pill{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;background:var(--accent);color:#06121f;border-radius:99px;padding:2px 7px}' +
'  #tab-advisor .av-card .cm{font-size:12px;color:var(--dim);margin-top:8px;line-height:1.7}' +
'  #tab-advisor .av-card .ev{font-variant-numeric:tabular-nums;font-weight:700}' +
'  #tab-advisor .av-best{font-size:13px;margin:2px 0 0;color:var(--dim)}' +
'  #tab-advisor .av-best b{color:var(--accent);font-size:18px}' +
'  #tab-advisor .rank-badge{display:inline-block;padding:1px 9px;border-radius:99px;font-size:15px;font-weight:800;line-height:1.5;vertical-align:middle;font-variant-numeric:tabular-nums}' +
'  #tab-advisor .av-bar{height:6px;border-radius:3px;background:var(--border);overflow:hidden;margin-top:8px;display:none}' +
'  #tab-advisor .av-bar > i{display:block;height:100%;width:0;background:var(--accent);transition:width .1s}' +
'  #tab-advisor .av-wip{background:rgba(217,83,79,.14);border:1px solid #d9534f;color:#ff9b97;border-radius:8px;padding:11px 14px;font-weight:800;letter-spacing:.05em;text-align:center;margin-bottom:14px}' +
'</style>' +
'<div class="av-wip">⚠ DO NOT USE — WORK IN PROGRESS</div>' +
// ---- INPUT: screenshot + engine ----
'<div class="inputs" id="av-inputs">' +
'  <div class="ihdr"><span>Advisor — live cut advice</span><span class="tgl" id="av-caret-wrap" onclick="window.__avToggleInputs()"><span id="av-caret">▾</span></span></div>' +
'  <div id="av-inputs-body">' +
'    <div class="subh">1 · Screenshot (optional)</div>' +
'    <div class="av-drop" id="av-drop">' +
'      <b>Drop, paste, or click to upload</b><br>a Lost Ark Processing screenshot, or just fill the form below manually.' +
'      <input type="file" id="av-file" accept="image/*" style="display:none">' +
'    </div>' +
'    <img id="av-preview" class="av-preview" alt="screenshot preview">' +
'    <div class="av-engines" id="av-engines"></div>' +
'    <div class="av-status" id="av-status"></div>' +

'    <div class="subh">2 · Gem configuration</div>' +
'    <div class="ig">' +
'      <div class="fld"><label>Base cost</label><select id="av-baseCost">' + opts([8, 9, 10], 10) + '</select></div>' +
'      <div class="fld"><label>Gem type</label><select id="av-gemType">' + opts([{ v: "order", t: "Order" }, { v: "chaos", t: "Chaos" }], "order") + '</select></div>' +
'      <div class="fld"><label>Willpower Lv</label><select id="av-wp">' + opts([1, 2, 3, 4, 5], 1) + '</select></div>' +
'      <div class="fld"><label>Order Lv</label><select id="av-ord">' + opts([1, 2, 3, 4, 5], 1) + '</select></div>' +
'      <div class="fld"><label>Effect 1</label><select id="av-e1"></select></div>' +
'      <div class="fld"><label>Effect 1 Lv</label><select id="av-e1l">' + opts([1, 2, 3, 4, 5], 1) + '</select></div>' +
'      <div class="fld"><label>Effect 2</label><select id="av-e2"></select></div>' +
'      <div class="fld"><label>Effect 2 Lv</label><select id="av-e2l">' + opts([1, 2, 3, 4, 5], 1) + '</select></div>' +
'    </div>' +

'    <div class="subh">3 · Cutting state</div>' +
'    <div class="ig">' +
'      <div class="fld"><label>Rarity</label><select id="av-rarity">' + opts([{ v: "uncommon", t: "Uncommon (5)" }, { v: "rare", t: "Rare (7)" }, { v: "epic", t: "Epic (9)" }], "epic") + '</select></div>' +
'      <div class="fld"><label>Current turn</label><select id="av-turn"></select></div>' +
'      <div class="fld"><label>Rerolls left</label><select id="av-rerolls"></select></div>' +
'      <div class="fld"><label>Process cost (g)</label><input id="av-cost" type="number" min="100" step="100" value="900"></div>' +
'      <div class="fld"><label>Gold spent</label><input id="av-spent" type="number" min="0" step="100" value="0"></div>' +
'      <div class="fld"><label>Roster bound</label><select id="av-bound">' + opts([{ v: "no", t: "No" }, { v: "yes", t: "Yes (free)" }], "no") + '</select></div>' +
'    </div>' +

'    <div class="subh">4 · The 4 on-screen outcomes <span style="color:var(--dim);text-transform:none;letter-spacing:0;font-weight:400">— confirm these; readers miss them most</span></div>' +
'    <div class="av-outcomes" id="av-outcomes"></div>' +

'    <div class="subh">5 · Market &amp; depth</div>' +
'    <div class="ig">' +
'      <div class="fld"><label>Baseline (sellable % dmg)</label><input id="av-baseline" type="number" step="0.05" value="1.0"></div>' +
'      <div class="fld"><label>Gold per 1% dmg</label><input id="av-gpd" type="number" step="10000" value="1500000"></div>' +
'      <div class="fld"><label>Depth</label><select id="av-speed">' + opts([{ v: "quick", t: "Quick (fast)" }, { v: "standard", t: "Standard" }, { v: "deep", t: "Deep (slow)" }], "standard") + '</select></div>' +
'      <div class="fld"><label>Consider Complete?</label><select id="av-sim2">' + opts([{ v: "yes", t: "Yes (rank it too)" }, { v: "no", t: "No (Process vs Reroll)" }], "yes") + '</select></div>' +
'    </div>' +

'    <div class="barrow">' +
'      <button class="primary" id="av-go">Get advice</button>' +
'      <span class="note" id="av-go-note"></span>' +
'    </div>' +
'    <div class="av-bar" id="av-bar"><i id="av-bar-i"></i></div>' +
'  </div>' +
'</div>' +

// ---- OUTPUT ----
'<div class="panel" id="av-result" style="display:none">' +
'  <h2>Recommended action</h2>' +
'  <p class="av-best" id="av-best-line"></p>' +
'  <div class="av-cards" id="av-cards"></div>' +
'  <div class="note" id="av-result-note"></div>' +
'</div>' +

// ---- methodology ----
'<details class="method">' +
'  <summary>How the advice is computed</summary>' +
'  <p>Each option is scored by an <b>exact decision model</b> (a Bellman dynamic program): the model computes, in closed form, the <i>optimal</i> expected outcome of every line of play to the end of the cut &mdash; assuming you keep playing optimally afterward. The number reported per option is <b>net expected gold</b> = expected final gem value &minus; the processing/reroll gold you&rsquo;d still spend from here on. (If the exact model can&rsquo;t run, the tool falls back to a Monte-Carlo estimate.)</p>' +
'  <ul>' +
'    <li><b>Process</b> applies one of the 4 on-screen outcomes (25% each, from the outcomes you confirmed), then plays on optimally. Its value uses the <i>actual</i> 4 outcomes &mdash; no guessing.</li>' +
'    <li><b>Reroll</b> redraws the 4 outcomes; the <i>last</i> reroll costs 3,800g, earlier ones are free. Its value is the optimal continuation after a fresh draw.</li>' +
'    <li><b>Complete</b> stops now and keeps the current gem (Turn&nbsp;1 = dismantle, value 0). With "Consider Complete? = No" it is shown but never chosen.</li>' +
'    <li><b>P(above baseline)</b> is the probability the final gem clears your sellable baseline if you follow the optimal policy from here. A below-baseline gem is valued as fusion fodder, not zero.</li>' +
'    <li>The exact model is deterministic, so Depth (quick/standard/deep) only affects the Monte-Carlo fallback.</li>' +
'  </ul>' +
'  <p class="note">A gem\'s score IS its % damage (each line D = 100&middot;ln(multiplier), additive; a perfect gem &asymp; 1.3&ndash;1.4%). Gold = (score &minus; baseline) &times; your "gold per 1% dmg"; baseline is the % damage of your weakest equipped gem. The 4-outcome draw inside the model is treated as 4 independent draws (a tiny approximation, cross-checked against Monte-Carlo to within ~2%). The screenshot reader is best-effort &mdash; always eyeball the prefilled fields, especially the 4 outcomes, before trusting the numbers.</p>' +
'</details>';
  }

  // ---------------- outcome rows ----------------
  function outcomeRowMarkup(i) {
    return '' +
'<div class="av-out" id="av-o' + i + '">' +
'  <div class="oh">Outcome ' + (i + 1) + '</div>' +
'  <div class="orow">' +
'    <select id="av-o' + i + '-type">' + opts(OUTCOME_TYPES, "do_nothing") + '</select>' +
'  </div>' +
'  <div class="orow" id="av-o' + i + '-detail" style="margin-top:6px">' +
'    <select id="av-o' + i + '-target" data-need="raise_effect,lower_effect,change_side_option">' + opts(OUTCOME_TARGETS, "willpower") + '</select>' +
'    <input class="amt" id="av-o' + i + '-amt" type="number" min="1" max="4" value="1" data-need="raise_effect,lower_effect">' +
'    <select id="av-o' + i + '-chg" data-need="change_gold_cost,reroll_increase">' +
       '<option value="100">+100%</option><option value="-100" selected>-100%</option>' +
       '<option value="1">+1</option><option value="2">+2</option>' +
'    </select>' +
'  </div>' +
'</div>';
  }

  function syncOutcomeRow(i) {
    var t = $("av-o" + i + "-type").value;
    var detail = $("av-o" + i + "-detail");
    var anyShown = false;
    detail.querySelectorAll("[data-need]").forEach(function (node) {
      var need = node.getAttribute("data-need").split(",");
      var show = need.indexOf(t) !== -1;
      // change_gold_cost vs reroll_increase share the #chg select but want different option sets
      node.style.display = show ? "" : "none";
      if (show) anyShown = true;
    });
    // adjust the shared change select's visible options by type
    var chg = $("av-o" + i + "-chg");
    if (chg && chg.style.display !== "none") {
      var isCost = (t === "change_gold_cost");
      chg.querySelectorAll("option").forEach(function (o) {
        var v = parseInt(o.value, 10);
        var costOpt = (v === 100 || v === -100);
        o.style.display = (isCost ? costOpt : !costOpt) ? "" : "none";
      });
      // ensure a valid selection for the active type
      if (isCost && parseInt(chg.value, 10) !== 100 && parseInt(chg.value, 10) !== -100) chg.value = "-100";
      if (!isCost && parseInt(chg.value, 10) !== 1 && parseInt(chg.value, 10) !== 2) chg.value = "1";
    }
    detail.style.display = anyShown ? "" : "none";
  }

  // ---------------- effect selects ----------------
  function refillEffects(preferE1, preferE2) {
    var bc = parseInt($("av-baseCost").value, 10) || 10;
    var list = availableEffects(bc);
    ["av-e1", "av-e2"].forEach(function (id, idx) {
      var sel = $(id);
      var prev = (idx === 0 ? preferE1 : preferE2) || sel.value;
      sel.innerHTML = list.map(function (e) {
        return '<option value="' + e.replace(/"/g, "&quot;") + '">' + e + "</option>";
      }).join("");
      if (list.indexOf(prev) !== -1) sel.value = prev;
    });
    if ($("av-e1").value === $("av-e2").value && list.length > 1) {
      var alt = list.filter(function (e) { return e !== $("av-e1").value; })[0];
      if (alt) $("av-e2").value = alt;
    }
  }

  // ---------------- rarity-dependent turn / reroll selects ----------------
  function refillTurnReroll(preferTurn, preferRerolls) {
    var rarity = $("av-rarity").value;
    var r = RARITY[rarity] || RARITY.epic;
    var turnSel = $("av-turn");
    var turns = [];
    for (var t = 1; t <= r.maxTurns; t++) turns.push(t);
    turnSel.innerHTML = turns.map(function (t) {
      return '<option value="' + t + '">Turn ' + t + " / " + r.maxTurns + "</option>";
    }).join("");
    if (preferTurn != null && preferTurn >= 1 && preferTurn <= r.maxTurns) turnSel.value = String(preferTurn);

    var rrSel = $("av-rerolls");
    var rrs = [];
    for (var k = 0; k <= r.maxRerolls; k++) rrs.push(k);
    rrSel.innerHTML = rrs.map(function (k) { return '<option value="' + k + '">' + k + " left</option>"; }).join("");
    var curTurn = parseInt(turnSel.value, 10) || 1;
    if (curTurn === 1) {
      rrSel.value = String(r.maxRerolls);
      rrSel.disabled = true; // turn 1 = full free rerolls
    } else {
      rrSel.disabled = false;
      if (preferRerolls != null) rrSel.value = String(Math.min(r.maxRerolls, Math.max(0, preferRerolls)));
    }
  }

  // ---------------- prefill from a parsed (constraint-snapped) result ----------------
  function applyParsed(parsed) {
    var c = parsed.config, s = parsed.state;
    $("av-baseCost").value = String(c.baseCost);
    $("av-gemType").value = c.gemType || "order";
    refillEffects(c.effect1, c.effect2);
    if (c.effect1) $("av-e1").value = c.effect1;
    if (c.effect2) $("av-e2").value = c.effect2;
    $("av-wp").value = String(c.willpowerLevel);
    $("av-ord").value = String(c.orderLevel);
    $("av-e1l").value = String(c.effect1Level);
    $("av-e2l").value = String(c.effect2Level);

    var rarity = parsed.rarity || (s.maxTurns === 5 ? "uncommon" : s.maxTurns === 7 ? "rare" : "epic");
    $("av-rarity").value = rarity;
    refillTurnReroll(s.currentTurn, s.rerollsRemaining);
    $("av-cost").value = String(s.processCost || 900);
    $("av-spent").value = String(s.totalGoldSpent || 0);
    $("av-bound").value = s.rosterBound ? "yes" : "no";

    var outs = parsed.outcomes || [];
    for (var i = 0; i < 4; i++) {
      var o = outs[i] || { type: "do_nothing" };
      $("av-o" + i + "-type").value = o.type || "do_nothing";
      syncOutcomeRow(i);
      if (o.type === "raise_effect" || o.type === "lower_effect") {
        $("av-o" + i + "-target").value = o.target || "willpower";
        $("av-o" + i + "-amt").value = String(o.amount || 1);
      } else if (o.type === "change_side_option") {
        $("av-o" + i + "-target").value = o.target || "effect1";
      } else if (o.type === "change_gold_cost") {
        $("av-o" + i + "-chg").value = String((o.change || 0) > 0 ? 100 : -100);
      } else if (o.type === "reroll_increase") {
        $("av-o" + i + "-chg").value = String(o.change || 1);
      }
      syncOutcomeRow(i);
    }
  }

  // ---------------- read the form into a model `state` ----------------
  function readStateFromForm() {
    var rarity = $("av-rarity").value;
    var r = RARITY[rarity] || RARITY.epic;
    var baseCost = parseInt($("av-baseCost").value, 10) || 10;
    var list = availableEffects(baseCost);
    var e1 = $("av-e1").value, e2 = $("av-e2").value;
    if (list.indexOf(e1) === -1) e1 = list[0];
    if (list.indexOf(e2) === -1) e2 = list.filter(function (e) { return e !== e1; })[0] || list[0];

    var config = {
      baseCost: baseCost,
      gemType: $("av-gemType").value,
      willpowerLevel: parseInt($("av-wp").value, 10) || 1,
      orderLevel: parseInt($("av-ord").value, 10) || 1,
      effect1: e1, effect1Level: parseInt($("av-e1l").value, 10) || 1,
      effect2: e2, effect2Level: parseInt($("av-e2l").value, 10) || 1
    };
    var currentTurn = Math.max(1, Math.min(r.maxTurns, parseInt($("av-turn").value, 10) || 1));
    var rerolls = currentTurn === 1 ? r.maxRerolls
      : Math.max(0, Math.min(r.maxRerolls, parseInt($("av-rerolls").value, 10) || 0));
    var processCost = Math.max(100, parseInt($("av-cost").value, 10) || 900);
    var mult = Math.round((processCost / 900 - 1) * 100);

    return {
      config: config,
      currentTurn: currentTurn,
      maxTurns: r.maxTurns,
      rerollsRemaining: rerolls,
      processCost: processCost,
      processCostMultiplier: Math.max(-100, Math.min(100, mult)),
      totalGoldSpent: Math.max(0, parseInt($("av-spent").value, 10) || 0),
      rosterBound: $("av-bound").value === "yes",
      outcomes: readOutcomesFromForm(config),
      history: []
    };
  }

  function readOutcomesFromForm(config) {
    var outs = [];
    for (var i = 0; i < 4; i++) {
      var t = $("av-o" + i + "-type").value;
      var o = { type: t };
      if (t === "raise_effect" || t === "lower_effect") {
        o.target = $("av-o" + i + "-target").value;
        o.amount = Math.max(1, Math.min(4, parseInt($("av-o" + i + "-amt").value, 10) || 1));
        o.effectName = o.target === "willpower" ? "Willpower"
          : o.target === "order" ? (config.gemType === "chaos" ? "Chaos" : "Order")
          : o.target === "effect1" ? config.effect1 : config.effect2;
        o.description = o.effectName + (t === "raise_effect" ? " +" : " -") + o.amount;
      } else if (t === "change_side_option") {
        o.target = $("av-o" + i + "-target").value;
        if (o.target !== "effect1" && o.target !== "effect2") o.target = "effect1";
        o.description = "Change " + (o.target === "effect1" ? config.effect1 : config.effect2);
      } else if (t === "change_gold_cost") {
        o.change = parseInt($("av-o" + i + "-chg").value, 10) > 0 ? 100 : -100;
        o.description = "Cost " + (o.change > 0 ? "+" : "") + o.change + "%";
      } else if (t === "reroll_increase") {
        o.change = Math.max(1, Math.min(2, parseInt($("av-o" + i + "-chg").value, 10) || 1));
        o.description = "Reroll +" + o.change;
      } else {
        o.description = "—";
      }
      outs.push(o);
    }
    return outs;
  }

  // ---------------- engine selector ----------------
  var selectedEngine = "tesseract";
  function renderEngines() {
    var wrap = $("av-engines");
    var list = (window.ocrListEngines ? window.ocrListEngines() : []);
    if (list.length === 0) { wrap.innerHTML = '<span class="note">No OCR engines registered.</span>'; return; }
    // Tesseract first
    list.sort(function (a, b) { return a.name === "tesseract" ? -1 : b.name === "tesseract" ? 1 : 0; });
    wrap.innerHTML = "";
    var label = el("span", { class: "note", style: "align-self:center;margin-right:4px" }, "Engine:");
    wrap.appendChild(label);
    list.forEach(function (eng) {
      var avail = false;
      try { avail = eng.isAvailable(); } catch (e) { avail = false; }
      var btn = el("button", { class: "mbtn av-eng" + (eng.name === selectedEngine ? " active" : "") }, eng.label || eng.name);
      btn.dataset.engine = eng.name;
      if (!avail) {
        btn.disabled = true;
        btn.title = (typeof eng.unavailableReason === "function" && eng.unavailableReason()) || "Unavailable in this environment.";
      } else {
        btn.addEventListener("click", function () {
          selectedEngine = eng.name;
          renderEngines();
        });
      }
      wrap.appendChild(btn);
    });
    // if the selected engine is unavailable, fall back to the first available one
    var sel = window.ocrGetEngine ? window.ocrGetEngine(selectedEngine) : null;
    var selOk = sel && (function () { try { return sel.isAvailable(); } catch (e) { return false; } })();
    if (!selOk) {
      var firstAvail = list.filter(function (e) { try { return e.isAvailable(); } catch (er) { return false; } })[0];
      if (firstAvail && firstAvail.name !== selectedEngine) { selectedEngine = firstAvail.name; renderEngines(); }
    }
  }

  // ---------------- status ----------------
  function setStatus(msg, kind) {
    var s = $("av-status");
    s.textContent = msg || "";
    s.className = "av-status" + (kind ? " " + kind : "");
  }

  // ---------------- screenshot handling ----------------
  function onImageFile(file) {
    if (!file || !/^image\//.test(file.type)) { setStatus("Not an image file.", "err"); return; }
    var url = URL.createObjectURL(file);
    if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
    lastObjectUrl = url;
    var img = $("av-preview");
    img.src = url;
    img.style.display = "block";

    var eng = window.ocrGetEngine ? window.ocrGetEngine(selectedEngine) : null;
    if (!eng) { setStatus("Engine not found: " + selectedEngine, "err"); return; }
    var ok = false; try { ok = eng.isAvailable(); } catch (e) { ok = false; }
    if (!ok) {
      setStatus((eng.label || eng.name) + " is unavailable. " +
        ((typeof eng.unavailableReason === "function" && eng.unavailableReason()) || ""), "err");
      return;
    }

    setStatus("Reading screenshot with " + (eng.label || eng.name) + "…", "working");
    eng.parseScreenshot(file).then(function (parsed) {
      applyParsed(parsed);
      setStatus("Parsed. Verify the fields (especially the 4 outcomes), then Get advice.", "");
    }).catch(function (err) {
      console.error(err);
      setStatus("Could not read the screenshot: " + (err && err.message || err) + " — fill the form manually.", "err");
    });
  }

  // ---------------- run advice ----------------
  function runAdvice() {
    var hasDP = typeof window.evaluateActionsDP === "function";
    var hasMC = typeof window.evaluateActions === "function";
    if (!hasDP && !hasMC) {
      setStatus("Model not loaded (neither evaluateActionsDP nor evaluateActions present).", "err");
      return;
    }
    var state = readStateFromForm();
    if (typeof window.validateConfig === "function") {
      var v = window.validateConfig(state.config);
      if (!v.valid) { setStatus("Invalid gem: " + v.error, "err"); return; }
    }
    var baseline = parseFloat($("av-baseline").value);
    if (!isFinite(baseline) || baseline < 0) baseline = 1.0;
    var gpd = parseFloat($("av-gpd").value) || 1500000;
    var preset = SPEED_PRESETS[$("av-speed").value] || SPEED_PRESETS.standard;
    var includeSim2 = $("av-sim2").value === "yes";

    // nested.js (the MC fallback) reads inner-run count from global.NESTED_INNER_RUNS;
    // expose it so depth still has an effect if we fall back.
    try { window.NESTED_INNER_RUNS = preset.inner; } catch (e) {}

    var bar = $("av-bar"), barI = $("av-bar-i");
    bar.style.display = "block"; barI.style.width = "0%";
    $("av-go").disabled = true;
    setStatus(hasDP ? "Solving the exact decision model…" : ("Simulating " + preset.numRuns.toLocaleString() + " runs (" + preset.label + ")…"), "working");

    function onProgress(done, total) {
      var pct = total ? Math.round((done / total) * 100) : 0;
      barI.style.width = pct + "%";
    }

    // Defer so the UI can paint the "working" state before the (synchronous) solve.
    setTimeout(function () {
      var engineUsed = null;
      try {
        var result;
        if (hasDP) {
          try {
            result = window.evaluateActionsDP(state, baseline, gpd, preset.numRuns, onProgress, { includeSim2: includeSim2 });
            engineUsed = "dp";
          } catch (dpErr) {
            console.error("DP failed, falling back to Monte Carlo:", dpErr);
            if (!hasMC) throw dpErr;
            setStatus("Exact model errored; falling back to Monte Carlo…", "working");
            result = window.evaluateActions(state, baseline, gpd, preset.numRuns, onProgress, { includeSim2: includeSim2 });
            engineUsed = "mc";
          }
        } else {
          result = window.evaluateActions(state, baseline, gpd, preset.numRuns, onProgress, { includeSim2: includeSim2 });
          engineUsed = "mc";
        }
        barI.style.width = "100%";
        renderResult(result, state, preset, includeSim2, engineUsed);
        setStatus("Done.", "");
      } catch (err) {
        console.error(err);
        setStatus("Solver error: " + (err && err.message || err), "err");
      } finally {
        $("av-go").disabled = false;
        setTimeout(function () { bar.style.display = "none"; }, 400);
      }
    }, 30);
  }

  // ---------------- render result ----------------
  function fmtGold(v) {
    if (!isFinite(v)) return "—";
    var sign = v >= 0 ? "+" : "−";
    var n = Math.abs(Math.round(v));
    return sign + n.toLocaleString() + "g";
  }

  // Grade-tier colored pill for a rank string (shared Astrogem.rankColor palette).
  function rankBadge(rank) {
    var c = (window.Astrogem && window.Astrogem.rankColor) ? window.Astrogem.rankColor(rank) : { bg: "#6f747a", fg: "#fff" };
    return '<span class="rank-badge" style="background:' + c.bg + ';color:' + c.fg + '">' + rank + '</span>';
  }

  function renderResult(result, state, preset, includeSim2, engineUsed) {
    var best = result.allActions[0];
    var byName = {};
    result.allActions.forEach(function (a) { byName[a.name] = a; });

    var gemGrade = (typeof window.grade === "function") ? window.grade(state.config) : null;
    var gemRk = (typeof window.gemRank === "function") ? window.gemRank(state.config) : null;
    $("av-best-line").innerHTML = "Best: <b>" + best.name + "</b> &nbsp;·&nbsp; "
      + "net " + fmtGold(best.value) + " EV"
      + (gemGrade != null ? ' &nbsp;·&nbsp; gem ' + (gemRk ? rankBadge(gemRk) + ' · ' : "") + gemGrade + '/100' : "");

    // Heuristic one-liner (a plain-English SUMMARY of this query's DP numbers, NOT
    // the decision source — the recommendation above is the exact DP's). It states
    // the margin by which the best action beats the runner-up.
    (function () {
      var ranked = result.allActions.filter(function (a) { return isFinite(a.value); });
      var line = "";
      if (ranked.length >= 2) {
        var margin = ranked[0].value - ranked[1].value;
        line = "Rule of thumb: " + ranked[0].name + " beats " + ranked[1].name +
          " by " + fmtGold(margin).replace(/^[+]/, "") + " EV here — " +
          (best.name === "Reroll"
            ? "reroll while a fresh board is worth more than processing this one."
            : best.name === "Process"
              ? "keep processing while the board's expected gain outweighs the per-turn gold cost."
              : "stop — neither processing nor rerolling pays for itself from here.");
      }
      var note = $("av-best-line");
      var existing = document.getElementById("av-heur");
      if (existing) existing.remove();
      if (line) {
        var h = el("div", { id: "av-heur", class: "note", style: "margin-top:4px;font-style:italic" }, line);
        note.parentNode.insertBefore(h, note.nextSibling);
      }
    })();

    var cards = $("av-cards");
    cards.innerHTML = "";
    ["Process", "Reroll", "Complete"].forEach(function (name) {
      var a = byName[name];
      if (!a) return;
      var isBest = (a.name === best.name);
      var disabled = !isFinite(a.value);
      var odds = (a.aboveBaselineOdds != null ? (a.aboveBaselineOdds * 100).toFixed(1) : "—");
      var evClass = a.value >= 0 ? "good" : "bad";
      var costLine = isFinite(a.expectedCost) && a.expectedCost > 0
        ? '<div>Avg. spend from here: <span class="ev">' + Math.round(a.expectedCost).toLocaleString() + "g</span></div>"
        : "";
      var scoreLine = isFinite(a.expectedScore)
        ? '<div>Exp. final gem: <span class="ev">' + a.expectedScore.toFixed(2) + "% dmg</span></div>"
        : "";
      var c = el("div", { class: "av-card" + (isBest ? " best" : "") + (disabled ? "" : "") });
      c.innerHTML =
        '<div class="cn">' + name + (isBest ? ' <span class="pill">Recommended</span>' : "") + "</div>" +
        '<div class="cm">' +
          (disabled
            ? '<div style="color:var(--dim)">Not applicable' + (name === "Complete" && includeSim2 === false ? " (not ranked)" : (name === "Reroll" ? " (no rerolls left)" : (name === "Complete" ? " (turn 1 — process once first)" : ""))) + "</div>"
            : '<div>P(above baseline): <span class="ev">' + odds + '%</span></div>' +
              '<div>Net EV: <span class="ev ' + evClass + '">' + fmtGold(a.value) + "</span></div>" +
              scoreLine + costLine) +
        "</div>";
      cards.appendChild(c);
    });

    var curVal = isFinite(result.currentValue) ? Math.round(result.currentValue).toLocaleString() + "g" : "—";
    var engineNote = engineUsed === "mc"
      ? (preset.numRuns.toLocaleString() + " outer × " + preset.inner + " inner Monte-Carlo runs")
      : "Exact decision model (Bellman DP)";
    $("av-result-note").textContent =
      engineNote + " · current gem value ≈ " + curVal +
      (includeSim2 ? "" : " · Complete shown but not ranked");
    $("av-result").style.display = "block";
  }

  // ---------------- collapse toggle ----------------
  window.__avToggleInputs = function () {
    var body = $("av-inputs-body");
    var caret = $("av-caret");
    var hidden = body.style.display === "none";
    body.style.display = hidden ? "" : "none";
    caret.textContent = hidden ? "▾" : "▸";
  };

  // ---------------- init ----------------
  function init() {
    var elTab = $("tab-advisor");
    if (!elTab) return;
    elTab.innerHTML = tabMarkup();

    // build outcome rows
    var oWrap = $("av-outcomes");
    for (var i = 0; i < 4; i++) oWrap.insertAdjacentHTML("beforeend", outcomeRowMarkup(i));

    refillEffects();
    refillTurnReroll(1, null);
    renderEngines();
    for (var j = 0; j < 4; j++) syncOutcomeRow(j);

    // wire effect/base-cost/rarity/turn changes
    $("av-baseCost").addEventListener("change", function () { refillEffects(); });
    $("av-rarity").addEventListener("change", function () { refillTurnReroll(1, null); });
    $("av-turn").addEventListener("change", function () {
      // re-evaluate reroll lock when turn changes
      refillTurnReroll(parseInt($("av-turn").value, 10), parseInt($("av-rerolls").value, 10));
    });
    for (var k = 0; k < 4; k++) {
      (function (idx) {
        $("av-o" + idx + "-type").addEventListener("change", function () { syncOutcomeRow(idx); });
      })(k);
    }

    // drop zone + file + paste
    var dz = $("av-drop");
    dz.addEventListener("click", function () { $("av-file").click(); });
    dz.addEventListener("dragover", function (e) { e.preventDefault(); dz.classList.add("drag"); });
    dz.addEventListener("dragleave", function () { dz.classList.remove("drag"); });
    dz.addEventListener("drop", function (e) {
      e.preventDefault(); dz.classList.remove("drag");
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) onImageFile(f);
    });
    $("av-file").addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) onImageFile(f);
    });
    document.addEventListener("paste", function (e) {
      // only when the advisor tab is visible
      if (!elTab.classList.contains("active")) return;
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (var n = 0; n < items.length; n++) {
        if (items[n].type && items[n].type.indexOf("image/") === 0) {
          var f = items[n].getAsFile();
          if (f) { e.preventDefault(); onImageFile(f); break; }
        }
      }
    });

    $("av-go").addEventListener("click", runAdvice);

    window.addEventListener("beforeunload", function () {
      var t = window.ocrGetEngine && window.ocrGetEngine("tesseract");
      if (t && typeof t.disposeWorker === "function") t.disposeWorker();
      if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
