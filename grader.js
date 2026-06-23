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
  // Damage ABOVE the 4.25/4.25 cp baseline (the loadout figure; may be negative).
  // Falls back to raw damagePercent only if the model is too old to expose relDamage.
  function relDamage(cfg) {
    var fn = (A && A.relDamage) || window.relDamage;
    return fn ? fn(cfg) : damagePercent(cfg);
  }
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

  // Grade-tier colored pill for a rank string (shared Astrogem.rankColor palette).
  function rankColorOf(rank) {
    return (A && A.rankColor) ? A.rankColor(rank)
      : (typeof window.rankColor === "function" ? window.rankColor(rank) : { bg: "#6f747a", fg: "#fff" });
  }
  function rankBadge(rank, extra) {
    var c = rankColorOf(rank);
    return '<span class="rank-badge' + (extra ? " " + extra : "") +
      '" style="background:' + c.bg + ';color:' + c.fg + '">' + esc(rank) + '</span>';
  }

  // Compact relative age, e.g. "just now" / "2d ago" / "3h ago". (Shared format used
  // by the Leaderboard tab too — see ageLabel there.)
  function ageLabel(pulledAt) {
    if (!pulledAt) return "";
    var ms = Date.now() - pulledAt;
    if (ms < 0) ms = 0;
    var mins = Math.floor(ms / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    var days = Math.floor(hrs / 24);
    return days + "d ago";
  }

  // "Cached · pulled 2d ago" vs "Freshly pulled" pill for a pulled loadout, from the
  // Worker response's cached / pulledAt fields.
  function cacheNoteHtml(data) {
    if (!data || data.cached == null) return "";
    var txt = data.cached
      ? ("Cached &middot; pulled " + esc(ageLabel(data.pulledAt)))
      : "Freshly pulled";
    return ' <span class="gr-cache' + (data.cached ? "" : " fresh") + '">' + txt + '</span>';
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
'  #tab-grader .rank-badge{display:inline-block;padding:2px 9px;border-radius:99px;font-weight:800;line-height:1.4;font-variant-numeric:tabular-nums}' +
'  #tab-grader .gr-badge .rank-badge{font-size:26px;padding:4px 12px;letter-spacing:-.02em}' +
'  #tab-grader .gr-gem .rkbox .rank-badge{font-size:15px;padding:2px 8px}' +
'  #tab-grader .gr-sum .stat .rank-badge{font-size:18px}' +
'  #tab-grader .gr-weak{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:4px 0 18px}' +
'  @media(max-width:680px){#tab-grader .gr-weak{grid-template-columns:1fr}}' +
'  #tab-grader .gr-weak .wk-col{border:1px solid var(--border);border-radius:10px;padding:12px 14px;background:var(--panel2)}' +
'  #tab-grader .gr-weak h4{font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:var(--high);margin:0 0 10px;font-weight:700}' +
'  #tab-grader .gr-weak .wk-row{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)}' +
'  #tab-grader .gr-weak .wk-row:last-child{border-bottom:none}' +
'  #tab-grader .gr-weak .wk-slot{font-size:12.5px;color:var(--text);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
'  #tab-grader .gr-weak .wk-dmg{font-size:12px;color:var(--accent);font-variant-numeric:tabular-nums;font-weight:700;white-space:nowrap}' +
'  #tab-grader .gr-weak .wk-empty{font-size:12px;color:var(--dim);padding:6px 0}' +
'  #tab-grader .mbtn:disabled{opacity:.45;cursor:not-allowed}' +
'  #tab-grader .gr-cache{display:inline-block;margin-left:10px;font-size:10px;font-weight:700;text-transform:none;letter-spacing:.02em;color:var(--dim);background:var(--panel2);border:1px solid var(--border);border-radius:99px;padding:2px 9px;vertical-align:middle}' +
'  #tab-grader .gr-cache.fresh{color:var(--good)}' +
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
'        <button class="mbtn" id="gr-pull-refresh" type="button" style="display:none">Re-pull from lostark.bible</button>' +
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
'  <p class="note">In a pulled loadout the <b>% damage</b> shown per gem (and the total) is damage <i>above the cp baseline</i> — a willpower-4.25 / order-4.25 / dead-effect gem at that cost, the same zero-point the Pipeline tab uses — so the figures are lower (and can go negative for a support gem) than a gem’s raw multiplier. Grade and rank are unchanged.</p>' +
'  <p class="note">Pulling a character fetches the loadout from lostark.bible through a small Cloudflare Worker (the site blocks direct browser requests) and caches it for 7 days; “Re-pull” forces a fresh fetch. Effect ids and each gem’s cost/type are decoded from the page’s embedded grid data. Always eyeball a gem or two against the in-game display.</p>' +
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
'    <div class="gr-badge ' + cls + '">' + rankBadge(rank) +
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
    // %dmg shown is damage ABOVE the cp baseline (relDamage); grade/rank unchanged.
    if (v.valid) { g = grade(cfg); rank = gemRank(cfg); dmg = relDamage(cfg); cls = rankClass(rank); }
    var rkHtml = v.valid
      ? rankBadge(rank) + '<div class="gd">' + g.toFixed(0) + '</div>'
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

  // "Weakest 3" upgrade-priority groups: the 3 lowest-grade valid gems of one gemType.
  // Each entry: slot/label, grade as a colored badge, %damage. Sorted worst-first.
  function weakestColHtml(title, gems, gemType) {
    var list = gems.filter(function (x) {
      return x.gemType === gemType && validateConfig(x).valid;
    }).map(function (x) {
      return { gem: x, g: grade(x), dmg: relDamage(x) };
    }).sort(function (a, b) { return a.g - b.g; }).slice(0, 3);

    var rows;
    if (!list.length) {
      rows = '<div class="wk-empty">No ' + esc(gemType) + ' gems.</div>';
    } else {
      rows = list.map(function (e) {
        var slot = e.gem.slot || ("Core " + (e.gem.coreBase || "?"));
        return '<div class="wk-row">' +
          rankBadge(rankFromGrade(e.g)) +
          '<span class="wk-slot">' + esc(slot) + '</span>' +
          '<span class="wk-dmg">' + e.dmg.toFixed(3) + '%</span>' +
          '</div>';
      }).join("");
    }
    return '<div class="wk-col"><h4>' + esc(title) + '</h4>' + rows + '</div>';
  }
  function weakestSectionHtml(gems) {
    return '<div class="gr-weak">' +
      weakestColHtml("Weakest 3 — Order", gems, "order") +
      weakestColHtml("Weakest 3 — Chaos", gems, "chaos") +
      '</div>';
  }

  function renderLoadout(data) {
    var out = $("gr-result");
    var gems = (data && data.gems) || [];
    if (!gems.length) {
      out.innerHTML = '<div class="panel"><div class="gr-status err">No gems found for this character.</div></div>';
      return;
    }

    // overall summary over the VALID gems. %dmg is damage ABOVE the cp baseline
    // (relDamage); grade/rank are unchanged.
    var valid = gems.filter(function (x) { return validateConfig(x).valid; });
    var sumGrade = 0, sumDmg = 0;
    valid.forEach(function (x) { sumGrade += grade(x); sumDmg += relDamage(x); });
    var avgGrade = valid.length ? sumGrade / valid.length : 0;
    var avgRank = rankFromGrade(avgGrade);

    var html = '' +
'<div class="panel">' +
'  <h2>Loadout &mdash; ' + esc(data.name || "") + ' <span class="note" style="text-transform:none">(' + esc(data.region || "") + ')</span>' +
     cacheNoteHtml(data) + '</h2>' +
'  <div class="gr-sum">' +
'    <div class="stat"><span class="k">Gems</span><span class="v">' + gems.length + '</span></div>' +
'    <div class="stat"><span class="k">Avg grade</span><span class="v ' + rankClass(avgRank) + '">' + avgGrade.toFixed(1) + '</span></div>' +
'    <div class="stat"><span class="k">Avg rank</span><span class="v">' + rankBadge(avgRank) + '</span></div>' +
'    <div class="stat"><span class="k">Total % dmg</span><span class="v" style="color:var(--accent)">' + sumDmg.toFixed(2) + '%</span></div>' +
'  </div>';
    if (data.warnings && data.warnings.length) {
      html += '<div class="gr-warn">' + data.warnings.length + ' parser warning(s): ' + esc(data.warnings.slice(0, 4).join("; ")) + (data.warnings.length > 4 ? "…" : "") + '</div>';
    }
    html += '</div>';

    // upgrade priorities: weakest 3 Order + weakest 3 Chaos, side by side, at the top
    html += weakestSectionHtml(gems);

    // group by core slot, preserving order of first appearance
    var order = [], groups = {};
    gems.forEach(function (x) {
      var key = x.slot || ("Core " + (x.coreBase || "?"));
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(x);
    });
    order.forEach(function (key) {
      var list = groups[key];
      var cdmg = 0; list.forEach(function (x) { if (validateConfig(x).valid) cdmg += relDamage(x); });
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

  function runPull(refresh) {
    if (!WORKER_URL) {
      setPullStatus("", "");
      $("gr-result").innerHTML = '<div class="panel"><div class="gr-status err">The lostark.bible Worker isn’t configured. Deploy worker/astrogem-bible.js and set WORKER_URL at the top of grader.js.</div></div>';
      return;
    }
    var region = $("gr-region").value;
    var name = ($("gr-name").value || "").trim();
    if (!name) { setPullStatus("Enter a character name.", "err"); return; }

    setPullStatus((refresh ? "Re-pulling " : "Fetching ") + name + " (" + region + ")…", "working");
    $("gr-pull-go").disabled = true;
    var refreshBtn = $("gr-pull-refresh");
    if (refreshBtn) refreshBtn.disabled = true;

    var url = WORKER_URL.replace(/\/+$/, "") +
      "/?region=" + encodeURIComponent(region) + "&name=" + encodeURIComponent(name) +
      (refresh ? "&refresh=1" : "");
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
      if (refreshBtn) refreshBtn.style.display = "";
      renderLoadout(r.data);
    }).catch(function (e) {
      setPullStatus("Request failed: " + (e && e.message || e), "err");
    }).then(function () {
      $("gr-pull-go").disabled = false;
      if (refreshBtn) refreshBtn.disabled = false;
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

    // pull mode (wrap so the click Event isn't passed as the refresh flag)
    $("gr-pull-go").addEventListener("click", function () { runPull(false); });
    $("gr-pull-refresh").addEventListener("click", function () { runPull(true); });
    $("gr-name").addEventListener("keydown", function (e) { if (e.key === "Enter" && WORKER_URL) runPull(false); });

    // Public hook for the Leaderboard tab: switch to the Grader tab (pull mode) and
    // render a previously stored loadout WITHOUT re-fetching. charData is a Worker
    // record ({ region, name, gems, pulledAt, cached? }). The Re-pull button is shown
    // so the user can force a fresh pull of that same character.
    window.graderShowLoadout = function (charData) {
      if (!charData) return;
      if (typeof window.selectTab === "function") window.selectTab("grader");
      selectMode("pull");
      if (charData.region && $("gr-region")) {
        var r = String(charData.region).toUpperCase();
        if (REGIONS.indexOf(r) !== -1) $("gr-region").value = r;
      }
      if (charData.name && $("gr-name")) $("gr-name").value = charData.name;
      lastLoadout = charData;
      // Listed characters are cached records; reflect that unless told otherwise.
      if (charData.cached == null && charData.pulledAt != null) charData.cached = true;
      var refreshBtn = $("gr-pull-refresh");
      if (refreshBtn && WORKER_URL) refreshBtn.style.display = "";
      setPullStatus("Showing stored loadout for " + (charData.name || "") + ".", "");
      renderLoadout(charData);
    };

    // first paint
    renderCustom();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
