/**
 * advisor.js — the "Advisor" tab: live, per-turn "Process / Reroll / Complete?"
 * advice for an in-progress astrogem cut.
 *
 * Flow:
 *   1. Setup (top, AdvisorSetup): search the cached roster / pick a favorite →
 *      auto-fills the axis (DPS/Support), the recommended gold-per-1%-damage tier
 *      (combat-power bands) and the S/A/B/C/D rank-ladder baseline. All manually
 *      overridable; works fully manual with no character too.
 *   2. Input (AdvisorWindow): an in-game-lookalike "Processing" window — click the
 *      diamonds/levels/outcome rows to transcribe your cut in a few taps, or drop /
 *      paste a screenshot to prefill it (low-confidence fields get a "confirm me"
 *      highlight per the ocr/engine.js confidence contract).
 *   3. "Get advice" runs the EXACT decision model (window.evaluateActionsDP — a
 *      Bellman DP; deterministic) on the current axis, with a Monte-Carlo fallback
 *      for the DPS axis only (nested.js has no support axis).
 *
 * Model API: window.evaluateActionsDP(state, baseline, gpd, numRuns, onProgress,
 *   { includeSim2, axis }) -> { bestAction, allActions:[...], currentValue, ... }.
 * Setup/window components: window.AdvisorSetup, window.AdvisorWindow (loaded just
 * before this file in the advisor lazy bundle).
 */
(function () {
  "use strict";

  // Fixed Monte-Carlo fallback effort (the old quick/standard/deep selector is gone —
  // the exact DP ignores it; the MC only runs as a DPS-axis fallback).
  var MC_RUNS = 1000, MC_INNER = 150;

  var lastObjectUrl = null;

  // ---------------- DOM helpers ----------------
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) if (attrs.hasOwnProperty(k)) e.setAttribute(k, attrs[k]);
    if (html != null) e.innerHTML = html;
    return e;
  }

  // ---------------- markup ----------------
  function tabMarkup() {
    return '' +
'<style>' +
'  #tab-advisor .av-drop{border:2px dashed var(--border);border-radius:10px;padding:10px 14px;text-align:center;color:var(--dim);cursor:pointer;transition:border-color .15s,background .15s;background:var(--panel2);font-size:13px}' +
'  #tab-advisor .av-drop.drag{border-color:var(--accent);background:rgba(102,199,255,.08);color:var(--text)}' +
'  #tab-advisor .av-drop b{color:var(--text)}' +
'  #tab-advisor .av-preview{max-width:100%;max-height:200px;border-radius:8px;border:1px solid var(--border);margin-top:8px;display:none}' +
'  #tab-advisor .av-status{font-size:12px;color:var(--dim);margin-top:6px;min-height:16px}' +
'  #tab-advisor .av-status.working{color:var(--accent)}' +
'  #tab-advisor .av-status.err{color:var(--bad)}' +
'  #tab-advisor .av-engines{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}' +
'  #tab-advisor .mbtn:disabled{opacity:.45;cursor:not-allowed}' +
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
'  #tab-advisor .av-warn{font-size:12px;color:#e8b84a;margin-top:6px}' +
'  #tab-advisor .inputs{position:static}' +
'</style>' +
'<div class="av-wip">⚠ DO NOT USE — WORK IN PROGRESS</div>' +
'<div class="inputs" id="av-inputs">' +
'  <div class="ihdr"><span>Advisor — live cut advice</span><span class="tgl" id="av-caret-wrap" onclick="window.__avToggleInputs()"><span id="av-caret">▾</span></span></div>' +
'  <div id="av-inputs-body">' +
'    <div id="av-setup"></div>' +
'    <div class="subh">3 · Your cut</div>' +
'    <div class="av-drop" id="av-drop">' +
'      <b>Drop, paste, or click</b> — a Processing screenshot prefills the window below. Or just tap the fields.' +
'      <input type="file" id="av-file" accept="image/*" style="display:none">' +
'    </div>' +
'    <img id="av-preview" class="av-preview" alt="screenshot preview">' +
'    <div class="av-engines" id="av-engines"></div>' +
'    <div class="av-status" id="av-status"></div>' +
'    <div id="av-window" style="margin-top:12px"></div>' +
'    <div class="barrow" style="margin-top:12px">' +
'      <button class="mbtn" id="av-sim2" data-on="1">Consider Complete: on</button>' +
'      <button class="mbtn" id="av-bound" data-on="0">Roster bound: no</button>' +
'      <button class="primary" id="av-go">Get advice</button>' +
'      <span class="note" id="av-go-note"></span>' +
'    </div>' +
'    <div id="av-warns"></div>' +
'    <div class="av-bar" id="av-bar"><i id="av-bar-i"></i></div>' +
'  </div>' +
'</div>' +
'<div class="panel" id="av-result" style="display:none">' +
'  <h2>Recommended action</h2>' +
'  <p class="av-best" id="av-best-line"></p>' +
'  <div class="av-cards" id="av-cards"></div>' +
'  <div class="note" id="av-result-note"></div>' +
'</div>' +
'<details class="method">' +
'  <summary>How the advice is computed</summary>' +
'  <p>Each option is scored by an <b>exact decision model</b> (a Bellman dynamic program): the model computes, in closed form, the <i>optimal</i> expected outcome of every line of play to the end of the cut &mdash; assuming you keep playing optimally afterward. The number reported per option is <b>net expected gold</b> = expected final gem value &minus; the processing/reroll gold you&rsquo;d still spend from here on.</p>' +
'  <ul>' +
'    <li><b>Process</b> applies one of the 4 on-screen outcomes (25% each, from the outcomes you confirmed), then plays on optimally.</li>' +
'    <li><b>Reroll</b> redraws the 4 outcomes; only the <i>last</i> reroll costs 3,800g (the on-screen counter shows the free ones; the window translates).</li>' +
'    <li><b>Complete</b> stops now and keeps the current gem (Turn&nbsp;1 = dismantle, value 0).</li>' +
'    <li><b>P(above baseline)</b> is the probability the final gem clears your baseline under optimal play. A below-baseline gem is valued as fusion fodder, not zero.</li>' +
'  </ul>' +
'  <p class="note">The baseline is the S/A/B/C/D rank ladder the Grader uses (12 anchor grades); picking a character sets it one rank above your stronger 3rd-lowest gem, and sets the gold-per-1%-damage tier from combat power. On the Support axis gems are valued by party contribution (supportValue) against support-scale baselines; support advice has no Monte-Carlo fallback &mdash; if the exact model fails you get an error, never a silently mis-ranked answer.</p>' +
'</details>';
  }

  // ---------------- engine selector ----------------
  var selectedEngine = "tesseract";
  function renderEngines() {
    var wrap = $("av-engines");
    var list = (window.ocrListEngines ? window.ocrListEngines() : []);
    if (list.length === 0) { wrap.innerHTML = '<span class="note">No OCR engines registered.</span>'; return; }
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
        btn.addEventListener("click", function () { selectedEngine = eng.name; renderEngines(); });
      }
      wrap.appendChild(btn);
    });
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
      window.AdvisorWindow.setParsed(parsed);
      var n = window.AdvisorWindow.unconfirmedCount();
      setStatus(n
        ? "Parsed — " + n + " field" + (n > 1 ? "s" : "") + " highlighted below need a look."
        : "Parsed. Double-check the window, then Get advice.", "");
    }).catch(function (err) {
      console.error(err);
      setStatus("Could not read the screenshot: " + (err && err.message || err) + " — fill the window manually.", "err");
    });
  }

  // ---------------- run advice ----------------
  function runAdvice() {
    var hasDP = typeof window.evaluateActionsDP === "function";
    var hasMC = typeof window.evaluateActions === "function";
    if (!hasDP && !hasMC) { setStatus("Model not loaded.", "err"); return; }

    var m = window.AdvisorSetup.getMarket();
    var state = window.AdvisorWindow.getState();
    state.rosterBound = $("av-bound").dataset.on === "1";
    if (typeof window.validateConfig === "function") {
      var v = window.validateConfig(state.config);
      if (!v.valid) { setStatus("Invalid gem: " + v.error, "err"); return; }
    }
    var includeSim2 = $("av-sim2").dataset.on === "1";

    // soft warnings (never block)
    var warns = [];
    var unset = state.outcomes.filter(function (o) { return o.type === "do_nothing"; }).length;
    if (unset) warns.push(unset + " outcome" + (unset > 1 ? "s are" : " is") + " unset — advice treats them as “no change”.");
    var unconf = window.AdvisorWindow.unconfirmedCount();
    if (unconf) warns.push(unconf + " parsed field" + (unconf > 1 ? "s" : "") + " unconfirmed (highlighted in the window).");
    $("av-warns").innerHTML = warns.map(function (w) { return '<div class="av-warn">⚠ ' + w + '</div>'; }).join("");

    try { window.NESTED_INNER_RUNS = MC_INNER; } catch (e) {}
    var bar = $("av-bar"), barI = $("av-bar-i");
    bar.style.display = "block"; barI.style.width = "0%";
    $("av-go").disabled = true;
    setStatus(hasDP ? "Solving the exact decision model…" : "Simulating…", "working");
    function onProgress(done, total) { barI.style.width = (total ? Math.round((done / total) * 100) : 0) + "%"; }

    setTimeout(function () {
      var engineUsed = null;
      try {
        var result;
        var opts = { includeSim2: includeSim2, axis: m.axis };
        if (hasDP) {
          try {
            result = window.evaluateActionsDP(state, m.baselineScore, m.gpd, MC_RUNS, onProgress, opts);
            engineUsed = "dp";
          } catch (dpErr) {
            console.error("DP failed:", dpErr);
            if (m.axis === "support" || !hasMC) {
              setStatus("The exact model failed" + (m.axis === "support" ? " — support-axis advice has no Monte-Carlo fallback" : "") + ": " + (dpErr && dpErr.message || dpErr), "err");
              $("av-go").disabled = false; bar.style.display = "none";
              return;
            }
            setStatus("Exact model errored; falling back to Monte Carlo…", "working");
            result = window.evaluateActions(state, m.baselineScore, m.gpd, MC_RUNS, onProgress, { includeSim2: includeSim2 });
            engineUsed = "mc";
          }
        } else {
          if (m.axis === "support") { setStatus("Support-axis advice needs the exact model (not loaded).", "err"); $("av-go").disabled = false; bar.style.display = "none"; return; }
          result = window.evaluateActions(state, m.baselineScore, m.gpd, MC_RUNS, onProgress, { includeSim2: includeSim2 });
          engineUsed = "mc";
        }
        barI.style.width = "100%";
        renderResult(result, state, m, includeSim2, engineUsed);
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
    return sign + Math.abs(Math.round(v)).toLocaleString() + "g";
  }
  function rankBadge(rank) {
    var c = (window.Astrogem && window.Astrogem.rankColor) ? window.Astrogem.rankColor(rank) : { bg: "#6f747a", fg: "#fff" };
    return '<span class="rank-badge" style="background:' + c.bg + ';color:' + c.fg + '">' + rank + '</span>';
  }

  function renderResult(result, state, market, includeSim2, engineUsed) {
    var sup = market.axis === "support";
    var best = result.allActions[0];
    var byName = {};
    result.allActions.forEach(function (a) { byName[a.name] = a; });

    var gGradeFn = sup ? (window.supportGrade || window.grade) : window.grade;
    var gRankFn = sup ? (window.supportRank || window.gemRank) : window.gemRank;
    var gemGrade = (typeof gGradeFn === "function") ? gGradeFn(state.config) : null;
    var gemRk = (typeof gRankFn === "function") ? gRankFn(state.config) : null;
    $("av-best-line").innerHTML = "Best: <b>" + best.name + "</b> &nbsp;·&nbsp; "
      + "net " + fmtGold(best.value) + " EV"
      + (gemGrade != null ? ' &nbsp;·&nbsp; gem ' + (gemRk ? rankBadge(gemRk) + ' · ' : "") + gemGrade.toFixed(1) + '/100' : "");

    // Heuristic one-liner (a plain-English SUMMARY of this query's DP numbers, NOT
    // the decision source). It states the margin by which the best beats the runner-up.
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

    var scoreLabel = sup ? "party value (support axis)" : "% dmg";
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
        ? '<div>Exp. final gem: <span class="ev">' + a.expectedScore.toFixed(sup ? 3 : 2) + " " + scoreLabel + "</span></div>"
        : "";
      var c = el("div", { class: "av-card" + (isBest ? " best" : "") });
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
    var gpdLabel = (window.LoadoutEcon && window.LoadoutEcon.gpdLabel) ? window.LoadoutEcon.gpdLabel(market.gpd) : market.gpd;
    $("av-result-note").innerHTML =
      (engineUsed === "mc" ? MC_RUNS.toLocaleString() + " × " + MC_INNER + " Monte-Carlo runs" : "Exact decision model (Bellman DP)") +
      " · baseline " + rankBadge(market.baselineRank) +
      " <span style='opacity:.7'>(" + market.baselineScore.toFixed(4) + ")</span>" +
      " · " + gpdLabel + " per 1%" +
      (sup ? " · <b>Support axis</b>" : "") +
      " · current gem value ≈ " + curVal +
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

    window.AdvisorSetup.init($("av-setup"), { onChange: function () {} });
    window.AdvisorWindow.init($("av-window"), { onChange: function () {} });
    renderEngines();

    // simple on/off toggles
    [["av-sim2", "Consider Complete: ", ["off", "on"]], ["av-bound", "Roster bound: ", ["no", "yes (free)"]]].forEach(function (t) {
      var b = $(t[0]);
      b.addEventListener("click", function () {
        b.dataset.on = b.dataset.on === "1" ? "0" : "1";
        b.textContent = t[1] + t[2][+b.dataset.on];
        b.classList.toggle("active", b.dataset.on === "1");
      });
      b.classList.toggle("active", b.dataset.on === "1");
    });

    // drop zone + file + paste (the lookalike frame accepts drops too)
    var dz = $("av-drop");
    dz.addEventListener("click", function () { $("av-file").click(); });
    dz.addEventListener("dragover", function (e) { e.preventDefault(); dz.classList.add("drag"); });
    dz.addEventListener("dragleave", function () { dz.classList.remove("drag"); });
    dz.addEventListener("drop", function (e) {
      e.preventDefault(); dz.classList.remove("drag");
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) onImageFile(f);
    });
    var frame = $("av-window");
    frame.addEventListener("dragover", function (e) { e.preventDefault(); });
    frame.addEventListener("drop", function (e) {
      e.preventDefault();
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
