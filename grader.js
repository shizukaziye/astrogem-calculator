/**
 * grader.js — the "Grader" tab (the FIRST tab): grades FINISHED / equipped
 * astrogems. Unlike the Pipeline/Advisor tabs there is no cut-EV or fodder value —
 * the gem is already cut and slotted, so only its quality matters:
 *
 *   grade (0-100)  ·  letter rank (S/A/B/C/D/F with +/-)  ·  exact % damage.
 *
 * Two input modes:
 *   1. Custom — a live form (cost / type / willpower / order / 2 effects + levels,
 *      the effect dropdowns filtered to the cost's pool). Grades on every change.
 *   2. Pull from lostark.bible — region + character name -> a Cloudflare Worker
 *      (worker/astrogem-bible.js) fetches the page, extracts arkGridCores, and
 *      returns every equipped gem. We grade the WHOLE loadout: a per-gem list
 *      grouped by core, plus an overall summary. The Worker URL is a configurable
 *      placeholder (WORKER_URL below), exactly like the Workers-AI vision engine.
 *
 * Grading API (model/astrogem.js, attached to window — we CALL it, never modify it):
 *   window.Astrogem.grade(config)         -> 0-100
 *   window.Astrogem.gemRank(config)       -> letter rank (uses grade internally)
 *   window.Astrogem.rankFromGrade(grade)  -> letter rank from a grade
 *   window.Astrogem.damagePercent(config) -> exact % damage
 *   window.Astrogem.score(config)         -> approx % damage (additive in log space)
 *   window.Astrogem.availableEffects(cost) / .EFFECT_POOLS / .validateConfig
 * config: { baseCost, gemType, willpowerLevel, orderLevel,
 *           effect1, effect1Level, effect2, effect2Level }
 *
 * Styling reuses the dark-theme classes in styles.css; a small #tab-grader-scoped
 * <style> block adds the grader-specific bits (rank badge, gem cards, core groups).
 */
(function () {
  "use strict";

  // ===========================================================================
  // PASTE YOUR DEPLOYED lostark.bible WORKER URL HERE
  //   (e.g. "https://astrogem-bible.<your-subdomain>.workers.dev").
  // Leave as "" to keep the "Pull from character" mode disabled; Custom mode needs
  // no setup. Deploy: cd worker && wrangler deploy --config wrangler.bible.toml
  // ===========================================================================
  var WORKER_URL = "https://astrogem-bible.shizukaziye.workers.dev";

  // ---- model-core handles (with safe fallbacks for the constants) ----
  var A = (typeof window !== "undefined" && window.Astrogem) || null;
  function grade(cfg) { return A ? A.grade(cfg) : window.grade(cfg); }
  function gemRank(cfg) { return A ? A.gemRank(cfg) : window.gemRank(cfg); }
  function rankFromGrade(g) { return A ? A.rankFromGrade(g) : window.rankFromGrade(g); }
  function damagePercent(cfg) { return A ? A.damagePercent(cfg) : window.damagePercent(cfg); }
  function validateConfig(cfg) {
    var fn = (A && A.validateConfig) || window.validateConfig;
    return fn ? fn(cfg) : { valid: true };
  }
  function availableEffects(bc) {
    var fn = (A && A.availableEffects) || window.availableEffects;
    if (fn) return fn(bc);
    var P = (A && A.EFFECT_POOLS) || window.EFFECT_POOLS || {};
    return (P[bc] || []).slice();
  }

  var REGIONS = ["NA", "EUC", "EUW", "SA", "KR"];

  var lastLoadout = null; // cache of the most recent pulled loadout (for re-render)

  // ---------------- DOM helpers ----------------
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function opts(list, sel) {
    return list.map(function (o) {
      var v = typeof o === "object" ? o.v : o;
      var t = typeof o === "object" ? o.t : o;
      return '<option value="' + esc(v) + '"' + (String(v) === String(sel) ? " selected" : "") + ">" + esc(t) + "</option>";
    }).join("");
  }

  // Map a letter-rank's leading letter -> a theme color class. (S/A green-ish high,
  // down to F red.) Reuses the existing palette tokens.
  function rankClass(rank) {
    var L = (rank || "")[0];
    return ({ S: "gr-s", A: "gr-a", B: "gr-b", C: "gr-c", D: "gr-d", F: "gr-f" })[L] || "gr-c";
  }

  // ---------------- markup ----------------
  function tabMarkup() {
    return '' +
'<style>' +
'  #tab-grader .gr-modes{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:4px}' +
'  #tab-grader .gr-modebody{margin-top:12px}' +
'  #tab-grader .gr-status{font-size:12px;color:var(--dim);margin-top:8px;min-height:16px}' +
'  #tab-grader .gr-status.working{color:var(--accent)}' +
'  #tab-grader .gr-status.err{color:var(--bad)}' +
'  #tab-grader .gr-headline{display:flex;align-items:center;gap:16px;flex-wrap:wrap}' +
'  #tab-grader .gr-badge{display:inline-flex;align-items:baseline;gap:8px;border:1px solid var(--border);border-radius:12px;padding:10px 16px;background:var(--panel2)}' +
'  #tab-grader .gr-badge .rk{font-size:30px;font-weight:800;letter-spacing:-.02em;line-height:1}' +
'  #tab-grader .gr-badge .gd{font-size:13px;color:var(--dim)}' +
'  #tab-grader .gr-badge .gd b{color:var(--text);font-size:18px;font-variant-numeric:tabular-nums}' +
'  #tab-grader .gr-dmg{font-size:13px;color:var(--dim)}' +
'  #tab-grader .gr-dmg b{font-size:20px;color:var(--accent);font-variant-numeric:tabular-nums}' +
'  #tab-grader .gr-bar{height:8px;border-radius:4px;background:var(--border);overflow:hidden;margin-top:10px}' +
'  #tab-grader .gr-bar > i{display:block;height:100%;width:0;transition:width .2s}' +
'  #tab-grader .gr-s .rk,#tab-grader .gr-s{color:var(--good)}' +
'  #tab-grader .gr-a .rk,#tab-grader .gr-a{color:var(--accent)}' +
'  #tab-grader .gr-b .rk,#tab-grader .gr-b{color:var(--low)}' +
'  #tab-grader .gr-c .rk,#tab-grader .gr-c{color:var(--high)}' +
'  #tab-grader .gr-d .rk,#tab-grader .gr-d{color:var(--mid)}' +
'  #tab-grader .gr-f .rk,#tab-grader .gr-f{color:var(--bad)}' +
'  #tab-grader .gr-bar i.gr-s{background:var(--good)}#tab-grader .gr-bar i.gr-a{background:var(--accent)}' +
'  #tab-grader .gr-bar i.gr-b{background:var(--low)}#tab-grader .gr-bar i.gr-c{background:var(--high)}' +
'  #tab-grader .gr-bar i.gr-d{background:var(--mid)}#tab-grader .gr-bar i.gr-f{background:var(--bad)}' +
'  #tab-grader .gr-core{margin-top:16px}' +
'  #tab-grader .gr-core h3{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--accent);margin:0 0 8px;font-weight:700;display:flex;gap:8px;align-items:baseline}' +
'  #tab-grader .gr-core h3 .ct{color:var(--dim);font-weight:600;letter-spacing:.02em;text-transform:none}' +
'  #tab-grader .gr-gems{display:grid;grid-template-columns:1fr 1fr;gap:10px}' +
'  @media(max-width:680px){#tab-grader .gr-gems{grid-template-columns:1fr}}' +
'  #tab-grader .gr-gem{border:1px solid var(--border);border-radius:10px;padding:10px 12px;background:var(--panel2);display:grid;grid-template-columns:54px 1fr;gap:12px;align-items:center}' +
'  #tab-grader .gr-gem .rkbox{text-align:center}' +
'  #tab-grader .gr-gem .rkbox .rk{font-size:22px;font-weight:800;line-height:1}' +
'  #tab-grader .gr-gem .rkbox .gd{font-size:11px;color:var(--dim);font-variant-numeric:tabular-nums}' +
'  #tab-grader .gr-gem .meta{font-size:12px;line-height:1.5}' +
'  #tab-grader .gr-gem .meta .top{font-weight:700;color:var(--text)}' +
'  #tab-grader .gr-gem .meta .eff{color:var(--dim)}' +
'  #tab-grader .gr-gem .meta .dmg{color:var(--accent);font-variant-numeric:tabular-nums;font-weight:700}' +
'  #tab-grader .gr-sum{display:flex;gap:20px;flex-wrap:wrap;align-items:center}' +
'  #tab-grader .gr-sum .stat{display:flex;flex-direction:column}' +
'  #tab-grader .gr-sum .stat .k{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim)}' +
'  #tab-grader .gr-sum .stat .v{font-size:22px;font-weight:800;font-variant-numeric:tabular-nums}' +
'  #tab-grader .gr-warn{color:var(--high);font-size:12px;margin-top:8px}' +
'  #tab-grader .mbtn:disabled{opacity:.45;cursor:not-allowed}' +
'</style>' +

// ---- INPUT panel ----
'<div class="inputs" id="gr-inputs">' +
'  <div class="ihdr"><span>Grader — score a finished gem</span><span class="tgl" onclick="window.__grToggleInputs()"><span id="gr-caret">&#9662;</span></span></div>' +
'  <div id="gr-inputs-body">' +
'    <div class="gr-modes">' +
'      <button class="mbtn active" id="gr-mode-custom" type="button">Custom input</button>' +
'      <button class="mbtn" id="gr-mode-pull" type="button">Pull from lostark.bible</button>' +
'    </div>' +

// --- custom mode ---
'    <div class="gr-modebody" id="gr-body-custom">' +
'      <div class="ig">' +
'        <div class="fld"><label>Base cost</label><select id="gr-cost">' + opts([8, 9, 10], 10) + '</select></div>' +
'        <div class="fld"><label>Gem type</label><select id="gr-type">' + opts([{ v: "order", t: "Order" }, { v: "chaos", t: "Chaos" }], "order") + '</select></div>' +
'        <div class="fld"><label>Willpower Lv</label><select id="gr-wp">' + opts([1, 2, 3, 4, 5], 5) + '</select></div>' +
'        <div class="fld"><label>Order Lv</label><select id="gr-ord">' + opts([1, 2, 3, 4, 5], 5) + '</select></div>' +
'        <div class="fld"><label>Effect 1</label><select id="gr-e1"></select></div>' +
'        <div class="fld"><label>Effect 1 Lv</label><select id="gr-e1l">' + opts([1, 2, 3, 4, 5], 5) + '</select></div>' +
'        <div class="fld"><label>Effect 2</label><select id="gr-e2"></select></div>' +
'        <div class="fld"><label>Effect 2 Lv</label><select id="gr-e2l">' + opts([1, 2, 3, 4, 5], 5) + '</select></div>' +
'      </div>' +
'      <div class="note">Willpower cost = base cost &minus; willpower level (lower is better). Effect 1 and Effect 2 must differ; the dropdowns are filtered to this cost’s pool.</div>' +
'    </div>' +

// --- pull mode ---
'    <div class="gr-modebody" id="gr-body-pull" style="display:none">' +
'      <div class="ig">' +
'        <div class="fld"><label>Region</label><select id="gr-region">' + opts(REGIONS, "NA") + '</select></div>' +
'        <div class="fld" style="grid-column:span 2"><label>Character name</label><input id="gr-name" type="text" placeholder="e.g. Paroxysmal" autocomplete="off"></div>' +
'      </div>' +
'      <div class="barrow">' +
'        <button class="primary" id="gr-pull-go" type="button">Grade loadout</button>' +
'        <span class="gr-status" id="gr-pull-status"></span>' +
'      </div>' +
'      <div class="note" id="gr-pull-note"></div>' +
'    </div>' +
'  </div>' +
'</div>' +

// ---- RESULTS ----
'<section id="gr-result"></section>' +

// ---- methodology ----
'<details class="method">' +
'  <summary>How a gem is graded</summary>' +
'  <p>A finished, equipped gem is judged on quality alone &mdash; there is no cut expected-value or fusion-fodder value here (those only matter while you’re still deciding whether to cut or scrap a gem).</p>' +
'  <ul>' +
'    <li><b>% damage</b> is the gem’s real multiplicative damage gain. Each line is scored <code>D = 100&middot;ln(multiplier)</code> (so the lines add up in log space); the reported figure is the exact combined <code>(multiplier &minus; 1) &times; 100</code>. Only the damage lines count &mdash; Attack Power, Additional Damage, Boss Damage, plus the Order points; Willpower helps or hurts by its <i>cost</i> (base cost &minus; willpower level), and Brand / Ally lines score 0 for personal damage.</li>' +
'    <li><b>Grade (0&ndash;100)</b> is min&ndash;max normalized over every possible gem: 0 = the worst gem (including the willpower penalty), 100 = a perfect 10-cost (Boss 5 + Additional Damage 5, Order 5, Willpower 5).</li>' +
'    <li><b>Rank</b> bands the grade: S&nbsp;85 / A&nbsp;75 / B&nbsp;65 / C&nbsp;50 / D&nbsp;25 / F&nbsp;0, each split into &minus;/&nbsp;/+ thirds.</li>' +
'  </ul>' +
'  <p class="note">Pulling a character fetches the loadout from lostark.bible through a small Cloudflare Worker (the site blocks direct browser requests). Effect ids and each gem’s cost/type are decoded from the page’s embedded grid data. Always eyeball a gem or two against the in-game display.</p>' +
'</details>';
  }

  // ---------------- custom mode ----------------
  function refillCustomEffects(preferE1, preferE2) {
    var bc = parseInt($("gr-cost").value, 10) || 10;
    var list = availableEffects(bc);
    [["gr-e1", preferE1], ["gr-e2", preferE2]].forEach(function (pair) {
      var sel = $(pair[0]);
      var prev = pair[1] || sel.value;
      sel.innerHTML = list.map(function (e) { return '<option value="' + esc(e) + '">' + esc(e) + "</option>"; }).join("");
      if (list.indexOf(prev) !== -1) sel.value = prev;
    });
    // keep effect1 != effect2
    if ($("gr-e1").value === $("gr-e2").value && list.length > 1) {
      var alt = list.filter(function (e) { return e !== $("gr-e1").value; })[0];
      if (alt) $("gr-e2").value = alt;
    }
  }

  function readCustomConfig() {
    return {
      baseCost: parseInt($("gr-cost").value, 10),
      gemType: $("gr-type").value,
      willpowerLevel: parseInt($("gr-wp").value, 10),
      orderLevel: parseInt($("gr-ord").value, 10),
      effect1: $("gr-e1").value,
      effect1Level: parseInt($("gr-e1l").value, 10),
      effect2: $("gr-e2").value,
      effect2Level: parseInt($("gr-e2l").value, 10)
    };
  }

  // Build the big single-gem headline (badge + % damage + bar).
  function gemHeadlineHtml(cfg) {
    var g = grade(cfg), rank = gemRank(cfg), dmg = damagePercent(cfg);
    var cls = rankClass(rank);
    return '' +
'<div class="panel">' +
'  <h2>Grade</h2>' +
'  <div class="gr-headline">' +
'    <div class="gr-badge ' + cls + '"><span class="rk">' + esc(rank) + '</span>' +
'      <span class="gd">grade <b>' + g.toFixed(1) + '</b> / 100</span></div>' +
'    <div class="gr-dmg">% damage<br><b>' + dmg.toFixed(3) + '%</b></div>' +
'  </div>' +
'  <div class="gr-bar"><i class="' + cls + '" style="width:' + Math.max(2, g).toFixed(1) + '%"></i></div>' +
'  <div class="note" style="margin-top:10px">c' + cfg.baseCost + ' ' + esc(cfg.gemType) +
     ' &middot; willpower ' + cfg.willpowerLevel + ' (cost ' + (cfg.baseCost - cfg.willpowerLevel) + ')' +
     ' &middot; order ' + cfg.orderLevel +
     ' &middot; ' + esc(cfg.effect1) + ' ' + cfg.effect1Level +
     ' / ' + esc(cfg.effect2) + ' ' + cfg.effect2Level + '</div>' +
'</div>';
  }

  function renderCustom() {
    refillCustomEffects();
    var cfg = readCustomConfig();
    var out = $("gr-result");
    var v = validateConfig(cfg);
    if (!v.valid) {
      out.innerHTML = '<div class="panel"><div class="gr-status err">' + esc(v.error || "Invalid gem.") + '</div></div>';
      return;
    }
    out.innerHTML = gemHeadlineHtml(cfg);
  }

  // ---------------- pull mode ----------------
  function effLabel(name, lvl) {
    return esc(name) + ' <span class="mono">' + (lvl != null ? lvl : "?") + '</span>';
  }

  function gemCardHtml(cfg) {
    var v = validateConfig(cfg);
    var g, rank, dmg, cls;
    if (v.valid) { g = grade(cfg); rank = gemRank(cfg); dmg = damagePercent(cfg); cls = rankClass(rank); }
    var rkHtml = v.valid
      ? '<div class="rk">' + esc(rank) + '</div><div class="gd">' + g.toFixed(0) + '</div>'
      : '<div class="rk">?</div>';
    var dmgHtml = v.valid ? '<span class="dmg">' + dmg.toFixed(3) + '%</span>' : '<span class="bad">' + esc(v.error || "invalid") + '</span>';
    return '' +
'<div class="gr-gem">' +
'  <div class="rkbox ' + (cls || "") + '">' + rkHtml + '</div>' +
'  <div class="meta">' +
'    <div class="top">c' + cfg.baseCost + ' ' + esc(cfg.gemType) + ' &middot; ' + dmgHtml + '</div>' +
'    <div class="eff">WP ' + (cfg.willpowerLevel != null ? cfg.willpowerLevel : "?") +
       ' &middot; Order ' + (cfg.orderLevel != null ? cfg.orderLevel : "?") + '</div>' +
'    <div class="eff">' + effLabel(cfg.effect1, cfg.effect1Level) + ' &nbsp;/&nbsp; ' + effLabel(cfg.effect2, cfg.effect2Level) + '</div>' +
'  </div>' +
'</div>';
  }

  function renderLoadout(data) {
    var out = $("gr-result");
    var gems = (data && data.gems) || [];
    if (!gems.length) {
      out.innerHTML = '<div class="panel"><div class="gr-status err">No gems found for this character.</div></div>';
      return;
    }

    // overall summary over the VALID gems
    var valid = gems.filter(function (x) { return validateConfig(x).valid; });
    var sumGrade = 0, sumDmg = 0;
    valid.forEach(function (x) { sumGrade += grade(x); sumDmg += damagePercent(x); });
    var avgGrade = valid.length ? sumGrade / valid.length : 0;
    var avgRank = rankFromGrade(avgGrade);

    var html = '' +
'<div class="panel">' +
'  <h2>Loadout &mdash; ' + esc(data.name || "") + ' <span class="note" style="text-transform:none">(' + esc(data.region || "") + ')</span></h2>' +
'  <div class="gr-sum">' +
'    <div class="stat"><span class="k">Gems</span><span class="v">' + gems.length + '</span></div>' +
'    <div class="stat"><span class="k">Avg grade</span><span class="v ' + rankClass(avgRank) + '">' + avgGrade.toFixed(1) + '</span></div>' +
'    <div class="stat"><span class="k">Avg rank</span><span class="v ' + rankClass(avgRank) + '">' + esc(avgRank) + '</span></div>' +
'    <div class="stat"><span class="k">Total % dmg</span><span class="v" style="color:var(--accent)">' + sumDmg.toFixed(2) + '%</span></div>' +
'  </div>';
    if (data.warnings && data.warnings.length) {
      html += '<div class="gr-warn">' + data.warnings.length + ' parser warning(s): ' + esc(data.warnings.slice(0, 4).join("; ")) + (data.warnings.length > 4 ? "…" : "") + '</div>';
    }
    html += '</div>';

    // group by core slot, preserving order of first appearance
    var order = [], groups = {};
    gems.forEach(function (x) {
      var key = x.slot || ("Core " + (x.coreBase || "?"));
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(x);
    });
    order.forEach(function (key) {
      var list = groups[key];
      var cdmg = 0; list.forEach(function (x) { if (validateConfig(x).valid) cdmg += damagePercent(x); });
      html += '<div class="gr-core"><h3>' + esc(key) + ' <span class="ct">' + list.length + ' gems &middot; ' + cdmg.toFixed(2) + '% dmg</span></h3>' +
        '<div class="gr-gems">' + list.map(gemCardHtml).join("") + '</div></div>';
    });

    out.innerHTML = html;
  }

  function setPullStatus(msg, kind) {
    var el = $("gr-pull-status");
    el.textContent = msg || "";
    el.className = "gr-status" + (kind ? " " + kind : "");
  }

  function runPull() {
    if (!WORKER_URL) {
      setPullStatus("", "");
      $("gr-result").innerHTML = '<div class="panel"><div class="gr-status err">The lostark.bible Worker isn’t configured. Deploy worker/astrogem-bible.js and set WORKER_URL at the top of grader.js.</div></div>';
      return;
    }
    var region = $("gr-region").value;
    var name = ($("gr-name").value || "").trim();
    if (!name) { setPullStatus("Enter a character name.", "err"); return; }

    setPullStatus("Fetching " + name + " (" + region + ")…", "working");
    $("gr-pull-go").disabled = true;

    var url = WORKER_URL.replace(/\/+$/, "") +
      "/?region=" + encodeURIComponent(region) + "&name=" + encodeURIComponent(name);
    fetch(url).then(function (resp) {
      return resp.json().then(function (data) { return { ok: resp.ok, data: data }; });
    }).then(function (r) {
      if (!r.ok || (r.data && r.data.error && !r.data.gems)) {
        var msg = (r.data && r.data.error) || ("Worker returned an error.");
        setPullStatus(msg, "err");
        $("gr-result").innerHTML = '<div class="panel"><div class="gr-status err">' + esc(msg) + '</div></div>';
        return;
      }
      lastLoadout = r.data;
      setPullStatus("Graded " + ((r.data.gems || []).length) + " gems.", "");
      renderLoadout(r.data);
    }).catch(function (e) {
      setPullStatus("Request failed: " + (e && e.message || e), "err");
    }).then(function () {
      $("gr-pull-go").disabled = false;
    });
  }

  // ---------------- mode switching ----------------
  function selectMode(mode) {
    var custom = mode === "custom";
    $("gr-mode-custom").classList.toggle("active", custom);
    $("gr-mode-pull").classList.toggle("active", !custom);
    $("gr-body-custom").style.display = custom ? "" : "none";
    $("gr-body-pull").style.display = custom ? "none" : "";
    if (custom) {
      renderCustom();
    } else if (lastLoadout) {
      renderLoadout(lastLoadout);
    } else {
      $("gr-result").innerHTML = '<div class="placeholder"><b>Grade a whole loadout</b>Pick a region, enter a character name, and grade every equipped gem at once.</div>';
    }
  }

  // ---------------- init ----------------
  window.__grToggleInputs = function () {
    var body = $("gr-inputs-body");
    var caret = $("gr-caret");
    var hidden = body.style.display === "none";
    body.style.display = hidden ? "" : "none";
    caret.innerHTML = hidden ? "&#9662;" : "&#9656;";
  };

  function init() {
    var elTab = $("tab-grader");
    if (!elTab) return;
    elTab.innerHTML = tabMarkup();

    // pull-mode availability note
    var note = $("gr-pull-note");
    if (!WORKER_URL) {
      note.innerHTML = 'Set <code>WORKER_URL</code> at the top of <code>grader.js</code> after deploying <code>worker/astrogem-bible.js</code> (see <code>worker/README-bible.md</code>). Custom input works without it.';
      $("gr-pull-go").disabled = true;
    } else {
      note.textContent = "Fetched live from lostark.bible via your Worker.";
    }

    // custom mode: build effect lists, grade on every change
    refillCustomEffects("Boss Damage", "Additional Damage");
    var liveIds = ["gr-cost", "gr-type", "gr-wp", "gr-ord", "gr-e1", "gr-e1l", "gr-e2", "gr-e2l"];
    liveIds.forEach(function (id) {
      $(id).addEventListener("change", function () {
        if (id === "gr-cost") refillCustomEffects(); // re-filter pools, keep what carries over
        renderCustom();
      });
    });

    // mode buttons
    $("gr-mode-custom").addEventListener("click", function () { selectMode("custom"); });
    $("gr-mode-pull").addEventListener("click", function () { selectMode("pull"); });

    // pull mode
    $("gr-pull-go").addEventListener("click", runPull);
    $("gr-name").addEventListener("keydown", function (e) { if (e.key === "Enter" && WORKER_URL) runPull(); });

    // first paint
    renderCustom();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
