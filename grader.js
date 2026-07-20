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
 *      placeholder (WORKER_URL below).
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
  var WORKER_URL = (typeof window !== "undefined" && window.LoadoutEcon && window.LoadoutEcon.WORKER_URL)
    || "https://astrogem-bible.shizukaziye.workers.dev";   // single source of truth: loadout-econ.js

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
  // ---- SUPPORT scoring handles (parallel to grade / gemRank / relDamage above).
  // The model attaches these to window.Astrogem; fall back to the DPS axis only if the
  // model is too old to expose the support axis (keeps the toggle from throwing).
  function supportGrade(cfg) {
    var fn = (A && A.supportGrade) || window.supportGrade;
    return fn ? fn(cfg) : grade(cfg);
  }
  function supportRank(cfg) {
    var fn = (A && A.supportRank) || window.supportRank;
    return fn ? fn(cfg) : gemRank(cfg);
  }
  // Support value ABOVE the neutral-support baseline (parallel to relDamage; may be negative).
  function supportRelValue(cfg) {
    var fn = (A && A.supportRelValue) || window.supportRelValue;
    return fn ? fn(cfg) : relDamage(cfg);
  }
  // Is the SUPPORT axis actually available? (Drives whether the toggle is shown at all.)
  function supportAxisAvailable() {
    return !!((A && A.supportGrade) || window.supportGrade);
  }

  // ---- DPS / Support grading mode for the WHOLE pulled loadout. DPS is the default and
  // behaves EXACTLY as before; Support regrades every gem on the support axis. Custom
  // mode is unaffected (it always grades DPS). The mode is mode-aware accessors below;
  // every loadout-rendering helper calls gGrade/gRank/gRel instead of grade/gemRank/relDamage.
  var grMode = "dps"; // "dps" | "support"
  var grPreset = "raid"; // "raid" | "chaos" — which Ark Grid loadout is being graded
  function isSupport() { return grMode === "support"; }
  // Apply the DPS(red)/Support(blue) theme by toggling a mode class on #tab-grader,
  // which flips the scoped --accent (see CSS). Rank badges keep their rankColor.
  function applyAxisTheme() {
    var t = document.getElementById("tab-grader");
    if (!t) return;
    t.classList.toggle("axis-dps", grMode !== "support");
    t.classList.toggle("axis-support", grMode === "support");
  }
  function gGrade(cfg) { return isSupport() ? supportGrade(cfg) : grade(cfg); }
  function gRank(cfg) { return isSupport() ? supportRank(cfg) : gemRank(cfg); }
  // Per-gem % damage ABOVE the neutral baseline gem (order 4.25, no effects) — these SUM
  // to the loadout/leaderboard total. Measuring above the baseline keeps the total in the
  // familiar ~10% range instead of the raw ~26% (each gem otherwise carries a ~0.68% order
  // floor). Willpower is NOT damage here (it lives in the grade). DPS subtracts the order
  // 4.25 floor; support subtracts the per-CORE order 4.25 floor, shown ÷3 (per-ally).
  function gRel(cfg) {
    if (isSupport()) {
      var ov = (A && A.supportOrderValueForCore) ? A.supportOrderValueForCore(A.coreKeyOf ? A.coreKeyOf(cfg) : cfg.coreBase) : null;
      if (A && A.supportDamage && ov != null) return (A.supportDamage(cfg, ov) - 4.25 * ov) / 3;
      return supportRelValue(cfg) / 3;
    }
    if (A && A.gemDamage && A.orderScore) return A.gemDamage(cfg) - A.orderScore(4.25);
    return relDamage(cfg);
  }

  // ---- shared loadout-econ module (extracted 2026-07-16 — see loadout-econ.js). ----
  // The wrappers below keep the ORIGINAL private names and signatures and close over
  // grader UI state (grMode, grBaseShift), so every call site in this file is
  // unchanged. loadout-econ.js is eager-loaded right before this file.
  var Econ = (typeof window !== "undefined" && window.LoadoutEcon) || null;
  var GRADE_ROWS = Econ.GRADE_ROWS;
  var GPD_TIERS = Econ.GPD_TIERS;
  var GPD_DEFAULT = Econ.GPD_DEFAULT;
  var gpdLabel = Econ.gpdLabel;
  var cpToGpd = Econ.cpToGpd;
  var gemsImpliedFloor = Econ.gemsImpliedFloor;
  function accessoriesImpliedGpd(acc) { return Econ.accessoriesImpliedGpd(acc, grMode); }
  // Support iff a support class AND support-dominant gems (and the axis exists —
  // the availability gate stays HERE so an old model can never flip the toggle on).
  function defaultModeFor(data) { return supportAxisAvailable() ? Econ.defaultModeFor(data) : "dps"; }
  function typeBaseline(gems, gemType) { return Econ.typeBaseline(gems, gemType, grMode); }
  function blanketBaseline(gems) { return Econ.blanketBaseline(gems, { axis: grMode, shift: grBaseShift }); }
  function getFieldSnapshot() { return Econ.fieldSnapshot(); }

  // Which loadout's gems to grade: the chaos-dungeon preset when toggled on (and present),
  // otherwise the raid preset. data.chaosGems only exists when the character has a distinct
  // chaos-dungeon Ark Grid loadout (the worker returns both presets).
  function activeGems(data) {
    if (grPreset === "chaos" && data && data.chaosGems && data.chaosGems.length) return data.chaosGems;
    return (data && data.gems) || [];
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

  var REGIONS = ["NA", "EU", "KR"];

  // The site a region's loadout is pulled from (the Worker routes KR -> lopec.kr, the
  // rest -> lostark.bible). Drives the dynamic Re-pull button label + the source note.
  function sourceSite(region) {
    return String(region).toUpperCase() === "KR" ? "lopec.kr" : "lostark.bible";
  }

  // Pipeline-tab region key for a loadout region: KR characters get the KR economy
  // (no roster-bound gems, tradable-epic floor), everyone else the global plan.
  function planRegion(region) {
    return String(region).toUpperCase() === "KR" ? "kr" : "global";
  }

  // Short, readable effect names for the compact per-gem rows (full names are long and
  // blow out a one-line layout). Anything unmapped falls through unchanged.
  var EFFECT_ABBR = {
    "Attack Power": "ATK Power",
    "Additional Damage": "Additional Dmg",
    "Boss Damage": "Boss Dmg",
    "Ally Attack Enh.": "Ally Atk",
    "Ally Damage Enh.": "Ally Dmg",
    "Brand Power": "Brand"
  };
  function abbrEffect(name) {
    if (name == null) return "?";
    return EFFECT_ABBR[name] || name;
  }

  var lastLoadout = null; // cache of the most recent pulled loadout (for re-render)

  // ---- "what to do with your astrogems" infographic config ----
  // GRADE_ROWS / GPD_TIERS / GPD_DEFAULT now come from loadout-econ.js (see wrappers above).
  var grGpd = GPD_DEFAULT;           // currently-selected gpd for the infographic
  var grGpdAutoKey = null;           // loadout key the gpd was last auto-set for (see renderLoadout)
  var grAutoRepulled = {};           // "region:name" -> 1 once auto-re-pulled for combat power (session-only)
  // Roster toggle for the plan: "nrb" | "rb". ALWAYS defaults to non-roster-bound on
  // page load — session-only, deliberately NOT persisted. KR loadouts have no
  // roster-bound gems, so the toggle is hidden (and the plan forced NRB) for KR.
  var grRoster = "nrb";
  // Manual ±rank nudge applied to the ONE blanket baseline via the ◀ ▶ arrows. Reset to
  // 0 on every fresh loadout render; clamped so the final baseline index stays in range.
  var grBaseShift = 0;

  // gpdLabel / cpToGpd / accessoriesImpliedGpd / gemsImpliedFloor live in
  // loadout-econ.js now (see the wrapper block above).

  // The provenance/consistency line under the gpd selector. Combat power always picks
  // the default; accessories warn when ≥2 ladder steps away, gems when their floor
  // exceeds the CP band.
  function gpdNoteHtml() {
    var lo = lastLoadout || {};
    var cpG = cpToGpd(lo.combatPower);
    var parts = [];
    if (cpG) {
      parts.push("auto-set " + gpdLabel(cpG) + " from combat power " + Number(lo.combatPower).toLocaleString("en-US"));
      var accG = accessoriesImpliedGpd(lo.accessories);
      if (accG && Math.abs(GPD_TIERS.indexOf(accG) - GPD_TIERS.indexOf(cpG)) >= 2) {
        parts.push('<span class="gr-gpd-warn">⚠ accessories look closer to ' + gpdLabel(accG) + "</span>");
      }
      var floorG = gemsImpliedFloor(lo.classicGemLevels);
      if (floorG && floorG > cpG) {
        parts.push('<span class="gr-gpd-warn">⚠ gems suggest at least ' + gpdLabel(floorG) + "</span>");
      }
    } else if (lo.source === "lostark.bible" && lo.gems) {
      parts.push("no combat power in this record — using the default tier");
    }
    return parts.length ? '<div class="note gr-gpd-note">' + parts.join(" · ") + "</div>" : "";
  }

  // A CACHED record without combatPower predates the Worker's economy fields — re-pull
  // it automatically (once per character per session) so the gpd tier can auto-set,
  // instead of asking the user to click Re-pull. Fresh pulls that STILL lack
  // combatPower (Worker not redeployed / parse failure) are cached:false, so they can
  // never re-trigger this — no loop. Returns true when a re-pull was kicked off.
  function maybeAutoRepullForCp(record) {
    if (!record || record.cached !== true || record.combatPower != null) return false;
    if (record.source !== "lostark.bible") return false;           // KR / custom never have it
    if (!Array.isArray(record.gems) || !record.gems.length) return false;
    var key = ((record.region || "") + ":" + (record.name || "")).toLowerCase();
    if (grAutoRepulled[key]) return false;
    grAutoRepulled[key] = 1;
    setPullStatus("Cached record has no combat power — re-pulling " + (record.name || "") + "…", "working");
    setTimeout(function () { runPull(true); }, 0);   // deferred: let the current pull chain finish
    return true;
  }

  // bumpedBaselineGrade / typeBaseline / gradeRowIdx / blanketBaseline live in
  // loadout-econ.js now (axis/shift parameterized; see the wrapper block above).

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
    var txt = data.source === "import" ? "Imported"
      : data.cached ? ("Cached &middot; pulled " + esc(ageLabel(data.pulledAt)))
      : "Freshly pulled";
    return ' <span class="gr-cache' + (data.cached ? "" : " fresh") + '">' + txt + '</span>';
  }

  // lostark.bible profile URL for a character (the loadout name links here).
  function bibleUrl(region, name) {
    var r = String(region).toUpperCase();
    if (r === "KR") return "https://lopec.kr/character/specPoint/" + encodeURIComponent(name || "");
    if (r === "EU") return "https://lostark.bible/character/CE/" + encodeURIComponent(name || "");
    return "https://lostark.bible/character/" + encodeURIComponent(region || "") + "/" + encodeURIComponent(name || "");
  }

  // Class ICON for the loadout header. The class name maps 1:1 to a file in
  // assets/class-icons/<ClassName>.svg (the same files the Leaderboard uses); we render
  // it ourselves from that convention rather than depending on leaderboard.js. The
  // brightness/invert tints the dark glyph to match the theme; onerror hides a missing
  // file. KR loadouts (className == null) get no icon (item level only).
  function classIconHtml(className) {
    if (!className) return "";
    return '<img class="gr-classicon" src="assets/class-icons/' + encodeURIComponent(className) +
      '.svg" alt="" aria-hidden="true" loading="lazy" onerror="this.style.display=\'none\'">';
  }

  // ---------------- markup ----------------
  function tabMarkup() {
    return '' +
'<style>' +
// Controls scroll normally — override styles.css .inputs sticky (fix: no frozen bar).
'  #tab-grader #gr-inputs{position:static;top:auto;z-index:auto}' +
'  #tab-grader .gr-modes{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:4px}' +
'  #tab-grader .gr-modebody{margin-top:12px}' +
'  #tab-grader .gr-status{font-size:12px;color:var(--dim);margin-top:8px;min-height:16px}' +
'  #tab-grader .gr-status.working{color:var(--accent)}' +
'  #tab-grader .gr-status.err{color:var(--bad)}' +
// DPS = GOLD, Support = GREEN — a mode-scoped --axis var applied ONLY to the key figures
// (avg grade, totals, per-gem dmg, order/chaos + grading text, the toggle). Everything
// else keeps the generic blue --accent; rank badges use fixed rankColor (untouched).
'  #tab-grader.axis-dps{--axis:#e18ac0}' +
'  #tab-grader.axis-support{--axis:#66c7ff}' +
// pull mode: saved-character chips sit at the TOP (right under the mode toggle); the
// region + name controls go on ONE short row below — no dead space, no side column.
'  #tab-grader .gr-pullgrid{display:grid;grid-template-columns:auto 1fr;gap:14px 32px;align-items:start}' +
'  @media(max-width:560px){#tab-grader .gr-pullgrid{grid-template-columns:1fr}}' +
'  #tab-grader .gr-pullleft{min-width:0}' +
'  #tab-grader .gr-pullright{min-width:0}' +
'  #tab-grader .gr-pullctl{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;margin:0 0 10px}' +
'  #tab-grader .gr-pullctl .fld{margin:0}' +
'  #tab-grader .gr-pullctl .fld-region{flex:0 0 auto;width:84px}' +
'  #tab-grader .gr-pullctl .fld-name{flex:0 0 auto;width:200px}' +
'  #tab-grader .gr-pullctl .fld select,#tab-grader .gr-pullctl .fld input{width:100%}' +
'  #tab-grader .gr-pullbtns{display:flex;gap:10px;flex-wrap:wrap;align-items:center}' +
'  #tab-grader .gr-freenote{font-size:12px;color:var(--dim);margin-top:6px;line-height:1.5}' +
'  #tab-grader .gr-freenote b{color:var(--text)}' +
'  #tab-grader .gr-freenote .gr-cap{color:#e0683c;font-weight:600}' +
'  #tab-grader .gr-freenote .gr-prem{color:#5cb87a;font-weight:600}' +
'  #tab-grader .gr-queued{display:flex;align-items:center;gap:14px;padding:6px 2px}' +
'  #tab-grader .gr-queued-icon{font-size:30px;line-height:1}' +
'  #tab-grader .gr-queued-main{font-size:14px}' +
'  #tab-grader .gr-queued-pos{font-size:13px;font-weight:600;color:var(--axis,var(--accent));margin-top:5px}' +
'  #tab-grader .gr-queued-sub{font-size:12px;color:var(--dim);margin-top:4px}' +
'  #tab-grader #gr-queued-timer{color:var(--axis,var(--accent))}' +
'  #tab-grader #gr-refresh-banner:empty{display:none}' +
'  #tab-grader .gr-refresh-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 12px;padding:9px 13px;border-radius:9px;background:rgba(127,127,127,0.10);border:1px solid var(--axis,var(--accent));font-size:13px}' +
'  #tab-grader .gr-unavail{margin:0 0 14px;padding:12px 15px;border-radius:10px;background:rgba(232,181,74,0.10);border:1px solid rgba(232,181,74,0.5);font-size:13px;line-height:1.5}' +
'  #tab-grader .gr-unavail b{color:#e8b54a}' +
'  #tab-grader .gr-refresh-bar b{color:var(--axis,var(--accent))}' +
'  #tab-grader .gr-rb-dim{color:var(--dim)}' +
'  #tab-grader .gr-rb-spin{display:inline-block;animation:gr-rb-spin 1.1s linear infinite}' +
'  @keyframes gr-rb-spin{to{transform:rotate(360deg)}}' +
'  #tab-grader .gr-freenote .gr-unlock{color:var(--axis,var(--accent));cursor:pointer;white-space:nowrap}' +
'  #tab-grader .gr-freenote .gr-unlock:hover{text-decoration:underline}' +
'  @media(max-width:520px){#tab-grader .gr-pullctl .fld-name{flex:1 1 160px;width:auto}}' +
// DPS / Support grading toggle (two pills) — sits above the loadout, near the header.
'  #tab-grader .gr-axis{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 12px}' +
'  #tab-grader .gr-axis .lab{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);font-weight:700}' +
'  #tab-grader .gr-axis .gr-axispills{display:inline-flex;gap:0;border:1px solid var(--border);border-radius:99px;overflow:hidden;background:var(--panel2)}' +
'  #tab-grader .gr-axis .gr-axispill{background:none;border:none;cursor:pointer;font-family:inherit;font-size:12.5px;font-weight:700;color:var(--dim);padding:6px 18px;line-height:1.3;transition:background .12s,color .12s}' +
'  #tab-grader .gr-axis .gr-axispill:not(:last-child){border-right:1px solid var(--border)}' +
'  #tab-grader .gr-axis .gr-axispill:hover:not(.active){color:var(--text)}' +
'  #tab-grader .gr-axis .gr-axispill.active{background:var(--axis);color:#fff}' +
'  #tab-grader .gr-axis .gr-axisnote{font-size:11px;color:var(--dim)}' +
// support-mode replacement for the (DPS-only) cut/fuse infographic.
'  #tab-grader .gr-plan-note{margin-top:18px;padding:14px 16px;border:1px dashed var(--border);border-radius:10px;background:var(--panel2);font-size:12.5px;color:var(--dim)}' +
// big lostark.bible-style profile header on the loadout panel.
'  #tab-grader .gr-prof{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin:0 0 4px}' +
'  #tab-grader .gr-prof .gr-star{align-self:center}' +
'  #tab-grader .gr-prof .gr-classicon{width:46px;height:46px;object-fit:contain;flex:0 0 auto;filter:brightness(0) invert(.82);opacity:.92}' +
'  #tab-grader .gr-prof .gr-id{display:flex;flex-direction:column;gap:3px;min-width:0}' +
'  #tab-grader .gr-prof .gr-name{font-size:30px;font-weight:800;letter-spacing:-.015em;line-height:1.05;color:var(--text)}' +
'  #tab-grader .gr-prof .gr-name a{color:inherit;text-decoration:none;border-bottom:1px dotted transparent;transition:border-color .12s,color .12s}' +
'  #tab-grader .gr-prof .gr-name a:hover{color:var(--accent);border-bottom-color:var(--accent)}' +
'  #tab-grader .gr-prof .gr-meta{display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:12.5px;color:var(--dim)}' +
'  #tab-grader .gr-prof .gr-meta .gr-chip{display:inline-flex;align-items:baseline;gap:5px;background:var(--panel);border:1px solid var(--border);border-radius:99px;padding:2px 10px;font-weight:600}' +
'  #tab-grader .gr-prof .gr-meta .gr-chip b{color:var(--text);font-weight:700;font-variant-numeric:tabular-nums}' +
'  #tab-grader .gr-headline{display:flex;align-items:center;gap:16px;flex-wrap:wrap}' +
'  #tab-grader .gr-badge{display:inline-flex;align-items:baseline;gap:8px;border:1px solid var(--border);border-radius:12px;padding:10px 16px;background:var(--panel2)}' +
'  #tab-grader .gr-badge .rk{font-size:30px;font-weight:800;letter-spacing:-.02em;line-height:1}' +
'  #tab-grader .gr-badge .gd{font-size:13px;color:var(--dim)}' +
'  #tab-grader .gr-badge .gd b{color:var(--text);font-size:18px;font-variant-numeric:tabular-nums}' +
'  #tab-grader .gr-dmg{font-size:13px;color:var(--dim)}' +
'  #tab-grader .gr-dmg b{font-size:20px;color:var(--axis,var(--accent));font-variant-numeric:tabular-nums}' +
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
// ---- gems-by-core: two sections (Order, Chaos), each a 3-column grid (one core per
//      column: Sun / Moon / Star), each column listing its 4 gems as compact rows. ----
'  #tab-grader .gr-section{margin-top:18px}' +
'  #tab-grader .gr-section > .sh{display:flex;align-items:baseline;gap:10px;margin:0 0 10px}' +
'  #tab-grader .gr-section > .sh .st{font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--axis,var(--accent))}' +
'  #tab-grader .gr-section > .sh .ssub{font-size:11.5px;color:var(--dim);font-variant-numeric:tabular-nums}' +
'  #tab-grader .gr-cores{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}' +
'  @media(max-width:820px){#tab-grader .gr-cores{grid-template-columns:1fr}}' +
'  #tab-grader .gr-corecol{border:1px solid var(--border);border-radius:10px;background:var(--panel2);overflow:hidden;display:flex;flex-direction:column}' +
'  #tab-grader .gr-corecol > .ch{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:8px 11px;border-bottom:1px solid var(--border);background:var(--panel)}' +
'  #tab-grader .gr-corecol > .ch .cn{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--text)}' +
'  #tab-grader .gr-corecol > .ch .cd{font-size:10.5px;color:var(--axis,var(--accent));font-variant-numeric:tabular-nums;font-weight:700}' +
'  #tab-grader .gr-gem{display:grid;grid-template-columns:38px 1fr;gap:10px;align-items:center;padding:7px 11px;border-bottom:1px solid var(--border)}' +
'  #tab-grader .gr-corecol .gr-gem:last-child{border-bottom:none}' +
'  #tab-grader .gr-gem .rkbox{text-align:center;line-height:1}' +
'  #tab-grader .gr-gem .rkbox .gd{font-size:10px;color:var(--dim);font-variant-numeric:tabular-nums;margin-top:2px}' +
'  #tab-grader .gr-gem .rkbox .rk{font-size:18px;font-weight:800;line-height:1}' +
'  #tab-grader .gr-gem .meta{font-size:11.5px;line-height:1.4;min-width:0}' +
'  #tab-grader .gr-gem .meta .top{font-weight:700;color:var(--text);display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}' +
'  #tab-grader .gr-gem .meta .top .dmg{color:var(--axis,var(--accent));font-variant-numeric:tabular-nums;font-weight:700;margin-left:auto}' +
'  #tab-grader .gr-gem .meta .sub{color:var(--dim);font-variant-numeric:tabular-nums}' +
'  #tab-grader .gr-gem .meta .eff{color:var(--dim);overflow:hidden;text-overflow:ellipsis}' +
'  #tab-grader .gr-gem .meta .eff b{color:var(--text);font-weight:600}' +
'  #tab-grader .gr-gem .meta .bad{color:var(--bad)}' +
'  #tab-grader .gr-sum{display:flex;gap:20px;flex-wrap:wrap;align-items:center}' +
'  #tab-grader h2 .bible-link{color:inherit;text-decoration:none;border-bottom:1px dotted var(--dim)}' +
'  #tab-grader h2 .bible-link:hover{color:var(--accent);border-bottom-color:var(--accent)}' +
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
'  #tab-grader .gr-weak .wk-dmg{font-size:12px;color:var(--axis,var(--accent));font-variant-numeric:tabular-nums;font-weight:700;white-space:nowrap}' +
'  #tab-grader .gr-weak .wk-empty{font-size:12px;color:var(--dim);padding:6px 0}' +
'  #tab-grader .gr-weak .wk-row[data-target]{cursor:pointer;border-radius:6px;transition:background .12s}' +
'  #tab-grader .gr-weak .wk-row[data-target]:hover{background:rgba(255,255,255,.05)}' +
'  #tab-grader .gr-gem.flash{animation:grFlash 1.4s ease-out}' +
'  @keyframes grFlash{0%,35%{box-shadow:0 0 0 2px var(--accent),0 0 16px -2px var(--accent)}100%{box-shadow:0 0 0 0 rgba(0,0,0,0)}}' +
'  #tab-grader .mbtn:disabled{opacity:.45;cursor:not-allowed}' +
'  #tab-grader .gr-cache{display:inline-block;margin-left:10px;font-size:10px;font-weight:700;text-transform:none;letter-spacing:.02em;color:var(--dim);background:var(--panel2);border:1px solid var(--border);border-radius:99px;padding:2px 9px;vertical-align:middle}' +
'  #tab-grader .gr-cache.fresh{color:var(--good)}' +
// ---- saved-characters quick-pick (pull mode, right-side column) ----
'  #tab-grader .gr-favs{margin:0}' +
'  #tab-grader .gr-favs .lab{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);font-weight:700;margin:0 0 8px}' +
'  #tab-grader .gr-favs .lab .lab-star{color:var(--high);margin-right:3px}' +
'  #tab-grader .gr-favs .gr-favlist{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px}' +
'  #tab-grader .gr-favs .gr-favbtn{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;text-align:left;background:var(--panel2);border:1px solid var(--border);border-radius:8px;padding:7px 12px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;color:var(--text);line-height:1.3;transition:border-color .12s,background .12s,color .12s}' +
'  #tab-grader .gr-favs .gr-favbtn:hover{border-color:var(--accent);background:var(--panel);color:var(--accent)}' +
'  #tab-grader .gr-favs .gr-favbtn .nm{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
'  #tab-grader .gr-favs .gr-favbtn .rg{font-size:9.5px;font-weight:700;color:var(--dim);text-transform:uppercase;letter-spacing:.04em;flex:0 0 auto;transition:color .12s,opacity .12s}' +
'  #tab-grader .gr-favs .gr-favbtn:hover .rg{color:var(--accent);opacity:.6}' +
'  #tab-grader .gr-favs .gr-favrow{display:flex;align-items:stretch;gap:5px}' +
'  #tab-grader .gr-favs .gr-favrow .gr-favbtn{flex:1 1 auto;min-width:0}' +
'  #tab-grader .gr-favs .gr-favstar{flex:0 0 auto;background:none;border:none;color:var(--high);cursor:pointer;font-size:15px;line-height:1;padding:2px 5px;font-family:inherit;transition:transform .08s,color .12s}' +
'  #tab-grader .gr-favs .gr-favstar:hover{transform:scale(1.15);color:#fff}' +
'  #tab-grader .gr-favs .gr-favempty{display:block;font-size:11px;color:var(--dim);font-style:italic;margin-top:2px}' +
// ---- star toggle on the loadout header ----
'  #tab-grader .gr-star{background:none;border:none;cursor:pointer;font-size:24px;line-height:1;padding:0 2px;color:var(--none);font-family:inherit;vertical-align:middle;transition:color .12s,transform .08s}' +
'  #tab-grader .gr-star:hover{transform:scale(1.12)}' +
'  #tab-grader .gr-star.on{color:var(--high)}' +
'  #tab-grader .gr-star-note{font-size:11px;color:var(--high);margin-left:8px;vertical-align:middle}' +
// ---- "what to do with your astrogems" infographic ----
'  #tab-grader .gr-plan{margin-top:18px}' +
'  #tab-grader .gr-plan > h2{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:4px}' +
'  #tab-grader .gr-plan .pl-sub{font-size:12px;color:var(--dim);font-weight:400;text-transform:none;letter-spacing:0}' +
'  #tab-grader .gr-gpd{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:10px 0 4px}' +
'  #tab-grader .gr-gpd .lab{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);font-weight:700}' +
'  #tab-grader .gr-gpd .gpd-btn{min-width:46px;text-align:center;cursor:pointer}' +
'  #tab-grader .gr-gpd-note{font-size:11px;color:var(--dim);margin:2px 0 4px}' +
'  #tab-grader .gr-gpd-note .gr-gpd-warn{color:#e8b84a;font-weight:600}' +
'  #tab-grader .gr-plan-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:10px}' +
'  @media(max-width:680px){#tab-grader .gr-plan-grid{grid-template-columns:1fr}}' +
'  #tab-grader .gr-plan-card{border:1px solid var(--border);border-radius:10px;background:var(--panel2);overflow:hidden;overflow-x:auto}' +
'  #tab-grader .gr-plan-card > .hd{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border);background:var(--panel)}' +
'  #tab-grader .gr-plan-card > .hd .t{font-size:13px;font-weight:800;letter-spacing:.02em}' +
'  #tab-grader .gr-plan-card > .hd .bl{font-size:11px;color:var(--dim);font-weight:600}' +
'  #tab-grader .gr-plan-card > .hd .bl b{color:var(--text)}' +
'  #tab-grader .gr-plan-card .empty{padding:14px;font-size:12px;color:var(--dim)}' +
'  #tab-grader table.gr-ptab{width:100%;border-collapse:collapse;font-size:12px}' +
'  #tab-grader table.gr-ptab th{font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--dim);font-weight:700;text-align:left;padding:6px 10px;border-bottom:1px solid var(--border)}' +
'  #tab-grader table.gr-ptab th.r,#tab-grader table.gr-ptab td.r{text-align:right}' +
'  #tab-grader table.gr-ptab td{padding:5px 10px;border-bottom:1px solid var(--border);vertical-align:middle}' +
'  #tab-grader table.gr-ptab tr:last-child td{border-bottom:none}' +
'  #tab-grader table.gr-ptab .rar{font-weight:700;color:var(--text);white-space:nowrap}' +
'  #tab-grader table.gr-ptab .rar .c{color:var(--dim);font-weight:600;font-variant-numeric:tabular-nums}' +
'  #tab-grader table.gr-ptab .ov{font-variant-numeric:tabular-nums;color:var(--dim)}' +
'  #tab-grader table.gr-ptab th.bh,#tab-grader table.gr-ptab td.bktd{text-align:center}' +
'  #tab-grader table.gr-ptab td.fusetd{text-align:center}' +
'  #tab-grader .vpill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:11px;font-weight:800;line-height:1.4;white-space:nowrap}' +
'  #tab-grader .vpill .rcp{font-weight:600;opacity:.85;font-variant-numeric:tabular-nums}' +
'  #tab-grader .vp-reset{background:#1f6b3e;color:#d6ffe6}' +
'  #tab-grader .vp-cut{background:#4a5520;color:#eee6a8}' +
'  #tab-grader .vp-fuse{background:#3a2a66;color:#cdb4ff}' +
'  #tab-grader .vp-throw{background:#4a1c1c;color:#ef9a9a}' +
'  #tab-grader .gr-boxes{padding:10px 14px;border-top:1px solid var(--border);font-size:12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}' +
'  #tab-grader .gr-boxes .bl{font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--dim);font-weight:700;margin-right:2px}' +
'  #tab-grader .gr-boxes .box{display:inline-block;padding:2px 9px;border-radius:99px;font-size:11px;font-weight:700;background:var(--panel);border:1px solid var(--border);color:var(--text)}' +
'  #tab-grader .gr-boxes .none{color:var(--dim);font-style:italic}' +
'  #tab-grader .gr-proc{margin-top:12px}' +
'  #tab-grader .gr-proc .proc-h{padding:10px 14px;border-bottom:1px solid var(--border);background:var(--panel);font-size:12px;font-weight:800;letter-spacing:.02em;color:var(--text)}' +
'  #tab-grader table.gr-ptab td.odds{font-size:10.5px;color:var(--dim);font-variant-numeric:tabular-nums;white-space:nowrap}' +
'  #tab-grader .gr-plan-legend{margin-top:12px;font-size:11px;color:var(--dim);display:flex;gap:14px;flex-wrap:wrap;align-items:center}' +
'  #tab-grader .gr-plan-legend .vpill{font-size:10px;padding:1px 8px}' +
// ---- single blanket baseline header + ◀▶ nudge ----
'  #tab-grader .gr-baseline{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin:10px 0 2px}' +
'  #tab-grader .gr-baseline .lab{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);font-weight:700}' +
'  #tab-grader .gr-baseline .gr-base-rk{font-size:18px;padding:3px 12px}' +
'  #tab-grader .gr-baseline .gr-base-from{font-size:11.5px;color:var(--dim)}' +
'  #tab-grader .gr-baseline .gr-base-from .dim{color:var(--text);font-weight:600}' +
'  #tab-grader .gr-baseline .gr-base-shift{color:var(--high);font-weight:700}' +
'  #tab-grader .gr-basearrow{background:var(--panel2);border:1px solid var(--border);color:var(--text);border-radius:8px;width:30px;height:28px;cursor:pointer;font-size:12px;line-height:1;font-family:inherit;display:inline-flex;align-items:center;justify-content:center;transition:border-color .12s,color .12s,background .12s}' +
'  #tab-grader .gr-basearrow:hover:not(:disabled){border-color:var(--accent);color:var(--accent);background:var(--panel)}' +
'  #tab-grader .gr-basearrow:disabled{opacity:.35;cursor:not-allowed}' +
// per-effect-pair (2D/Op/Sub/No) action cells, shown only where the 4 buckets disagree
'  #tab-grader table.gr-ptab .th-sub{font-weight:600;text-transform:none;letter-spacing:0;color:var(--dim);opacity:.8}' +
'  #tab-grader .bktgrid{display:grid;grid-template-columns:repeat(4,auto);gap:5px 10px;justify-content:start}' +
'  @media(max-width:560px){#tab-grader .bktgrid{grid-template-columns:repeat(2,auto)}}' +
'  #tab-grader .bktgrid .bkt{display:inline-flex;align-items:center;gap:5px}' +
'  #tab-grader .bktgrid .bkt .bk{font-size:9.5px;font-weight:800;color:var(--dim);width:24px;text-align:right;flex:0 0 auto}' +
'  #tab-grader .bktgrid .vpill{font-size:10px;padding:1px 8px}' +
'</style>' +

// ---- INPUT panel ----
'<div class="inputs" id="gr-inputs">' +
'  <div class="ihdr"><span>Grader — score a finished gem</span><span class="tgl" onclick="window.__grToggleInputs()"><span id="gr-caret">&#9662;</span></span></div>' +
'  <div id="gr-inputs-body">' +
'    <div class="gr-modes">' +
'      <button class="mbtn active" id="gr-mode-pull" type="button">Pull from lostark.bible</button>' +
'      <button class="mbtn" id="gr-mode-custom" type="button">Custom input</button>' +
'    </div>' +

// --- custom mode ---
'    <div class="gr-modebody" id="gr-body-custom" style="display:none">' +
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

// --- pull mode: compact controls LEFT, saved characters as a vertical list RIGHT ---
'    <div class="gr-modebody" id="gr-body-pull">' +
'      <div class="gr-pullgrid">' +
'        <div class="gr-pullleft">' +
'          <div class="gr-pullctl">' +
'            <div class="fld fld-region"><label>Region</label><select id="gr-region">' + opts(REGIONS, "NA") + '</select></div>' +
'            <div class="fld fld-name"><label>Character name</label><input id="gr-name" type="text" placeholder="e.g. Paroxysmal" autocomplete="off"></div>' +
'          </div>' +
'          <div class="gr-pullbtns">' +
'            <button class="primary" id="gr-pull-go" type="button">Grade loadout</button>' +
'            <button class="mbtn" id="gr-pull-refresh" type="button" style="display:none">Re-pull</button>' +
'          </div>' +
'          <div class="barrow" style="margin-top:8px"><span class="gr-status" id="gr-pull-status"></span></div>' +
'          <div class="gr-freenote" id="gr-free-note"></div>' +
'          <div class="note" id="gr-pull-note"></div>' +
'        </div>' +
'        <div class="gr-pullright"><div class="gr-favs" id="gr-favs"></div></div>' +
'      </div>' +
'    </div>' +
'  </div>' +
'</div>' +

// ---- LOOKUPS UNAVAILABLE NOTICE (shown when the worker reports the queue is paused) ----
'<div id="gr-unavailable" class="gr-unavail" style="display:none"></div>' +

// ---- RESULTS ----
'<div id="gr-refresh-banner"></div>' +
'<section id="gr-result"></section>' +

// ---- methodology ----
'<details class="method">' +
'  <summary>How a gem is graded</summary>' +
'  <p>A finished, equipped gem is judged on <b>quality alone</b> &mdash; no cut expected-value or fusion-fodder value here (those only matter while you’re still deciding whether to cut or scrap a gem; that’s the Pipeline tab).</p>' +
'  <p><b>Damage is multiplicative.</b> In Lost Ark, +10% and +10% give &times;1.21, not +20%. So each line is scored <code>D = 100&middot;ln(multiplier)</code> &mdash; that makes multiplicative gains <i>add up</i> in log space, and D reads as &asymp; % damage. A gem’s damage is the sum of its lines’ D, and the headline %dmg is the exact <code>(e^(&Sigma;D/100) &minus; 1)&times;100</code>.</p>' +
'  <p><b>What each line is worth.</b> Only damage lines count for a DPS grade &mdash; <b>Attack Power, Additional Damage, Boss Damage</b> and <b>Order/Chaos</b> points; Brand / Ally lines are support-only and score 0. The per-level values aren’t arbitrary &mdash; each is the marginal multiplier of one more level on a full grid, given how much of that stat you already have from gear:</p>' +
'  <ul>' +
'    <li><b>Order/Chaos &asymp; 0.160</b> per point &mdash; the strongest line.</li>' +
'    <li><b>Boss Damage &asymp; 0.081</b> /level (you start at 0% boss from gear, so it’s the least diluted).</li>' +
'    <li><b>Additional Damage &asymp; 0.059</b> /level &middot; <b>Attack Power &asymp; 0.032</b> /level.</li>' +
'  </ul>' +
'  <p><b>Willpower is efficiency, not damage.</b> It <i>reduces</i> the gem’s cost (<code>effective cost = base cost &minus; willpower level</code>), and a cheaper gem of the same damage is strictly better. It enters as a multiplier on the damage, calibrated so a <b>perfect gem of every base cost ties at grade 100</b> (a perfect 8 / 9 / 10 with willpower 5 sits at effective cost 3 / 4 / 5, and the multiplier makes those three equal). The multiplier punishes low willpower hard.</p>' +
'  <p><b>Grade &amp; rank.</b> The grade is that willpower-adjusted value, normalized 0&ndash;100 over <i>every</i> possible gem: <b>100</b> = a perfect gem (any cost), <b>0</b> = the worst legal gem. The rank bands it &mdash; <b>S&nbsp;85 / A&nbsp;70 / B&nbsp;55 / C&nbsp;40 / D&nbsp;20 / F&nbsp;0</b> &mdash; each split into &minus;/&nbsp;/+ thirds (55&ndash;60 = B&minus;, 60&ndash;65 = B, 65&ndash;70 = B+).</p>' +
'  <p><b>The loadout total (“% total dmg”)</b> answers a different question: the real damage your <i>whole 6-core grid</i> adds over having no grid. Effect levels pool into stat buckets that multiply over your gear (so two of the same stat give <b>diminishing returns</b>), and order/chaos is counted <i>per core</i> above a ~17-point floor, the six cores multiplying. Because of that, the per-gem numbers <b>don’t sum to the total &mdash; by design</b>: a gem is rated standalone, the total accounts for the whole grid.</p>' +
'  <p><b>Support.</b> Flip <b>Grade as &rarr; Support</b> for support classes &mdash; a parallel axis where Ally Attack / Brand / Ally Damage are the &ldquo;damage&rdquo; lines and order points are worth different amounts per core (Brand on Chaos Moon is the strongest). The total shows &divide;3 as per-ally party %.</p>' +
'  <p class="note">Pulling a character fetches the loadout from lostark.bible (cached 7 days; &ldquo;Re-pull&rdquo; forces fresh). Effect ids and each gem’s cost/type are decoded from the page’s grid data &mdash; check a gem or two against the in-game display.</p>' +
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
'  <div class="note" style="margin-top:10px">' + cfg.baseCost + '-cost ' + esc(cfg.gemType) +
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

  // DPS / Support grading toggle, shown above the loadout header. Only rendered when the
  // support axis exists. The active pill reflects grMode; clicking the other flips it and
  // re-renders the cached loadout live (auto-detect default already applied on pull).
  function axisToggleHtml() {
    if (!supportAxisAvailable()) return "";
    function pill(mode, label) {
      return '<button type="button" class="gr-axispill gr-axispill-' + mode + (grMode === mode ? " active" : "") +
        '" data-axis="' + mode + '">' + label + '</button>';
    }
    var note = isSupport()
      ? "Grading party-damage value (support)"
      : "Grading personal damage (DPS)";
    return '<div class="gr-axis">' +
      '<span class="lab">Grade as</span>' +
      '<span class="gr-axispills">' + pill("dps", "DPS") + pill("support", "Support") + '</span>' +
      '<span class="gr-axisnote">' + note + '</span>' +
      '</div>';
  }

  // Flip the grading mode and re-render the cached loadout in place (live).
  function setGrMode(mode) {
    mode = (mode === "support") ? "support" : "dps";
    if (mode === grMode) return;
    grMode = mode;
    applyAxisTheme();
    if (lastLoadout) renderLoadout(lastLoadout);
  }

  // Raid / Chaos-dungeon preset toggle, shown above the loadout header next to the axis
  // toggle. Only rendered when the character has a distinct chaos preset (data.chaosGems).
  // The active pill reflects grPreset; clicking the other regrades that preset's gems.
  function presetToggleHtml(data) {
    if (!(data && data.chaosGems && data.chaosGems.length)) return "";
    function pill(p, label) {
      return '<button type="button" class="gr-axispill gr-presetpill' + (grPreset === p ? " active" : "") +
        '" data-preset="' + p + '">' + label + '</button>';
    }
    var note = (grPreset === "chaos") ? "Grading the chaos-dungeon preset" : "Grading the raid preset";
    return '<div class="gr-axis gr-presetrow">' +
      '<span class="lab">Preset</span>' +
      '<span class="gr-axispills">' + pill("raid", "Raid") + pill("chaos", "Chaos") + '</span>' +
      '<span class="gr-axisnote">' + note + '</span>' +
      '</div>';
  }

  // Flip the graded preset (raid <-> chaos), re-auto-detect DPS/Support for that preset's
  // build (a support's chaos loadout is often DPS-built), and re-render the cached loadout.
  function setGrPreset(preset) {
    preset = (preset === "chaos") ? "chaos" : "raid";
    if (preset === grPreset || !lastLoadout) return;
    grPreset = preset;
    grMode = defaultModeFor({ class: lastLoadout.class, gems: activeGems(lastLoadout) });
    renderLoadout(lastLoadout);
  }

  // Compact single-row gem card: rank/grade badge + cost + order/willpower + the two
  // abbreviated effects. %dmg shown is damage ABOVE the cp baseline (relDamage);
  // grade/rank are unchanged. Keeps id="gr-gem-N" so Weakest-3 can jump to + flash it.
  function gemCardHtml(cfg) {
    var v = validateConfig(cfg);
    var g, rank, dmg, cls;
    if (v.valid) { g = gGrade(cfg); rank = gRank(cfg); dmg = gRel(cfg); cls = rankClass(rank); }
    var rkHtml = v.valid
      ? rankBadge(rank) + '<div class="gd">' + g.toFixed(0) + '</div>'
      : '<div class="rk">?</div>';
    var idAttr = (cfg._gidx != null) ? ' id="gr-gem-' + cfg._gidx + '"' : '';
    var topRight = v.valid
      ? '<span class="dmg">' + dmg.toFixed(3) + '%</span>'
      : '<span class="dmg bad">' + esc(v.error || "invalid") + '</span>';
    return '' +
'<div class="gr-gem"' + idAttr + '>' +
'  <div class="rkbox ' + (cls || "") + '">' + rkHtml + '</div>' +
'  <div class="meta">' +
'    <div class="top">' + cfg.baseCost + '-cost' +
       ' <span class="sub">WP ' + (cfg.willpowerLevel != null ? cfg.willpowerLevel : "?") +
       ' &middot; Ord ' + (cfg.orderLevel != null ? cfg.orderLevel : "?") + '</span>' + topRight + '</div>' +
'    <div class="eff"><b>' + esc(abbrEffect(cfg.effect1)) + '</b> ' + (cfg.effect1Level != null ? cfg.effect1Level : "?") +
       ' &middot; <b>' + esc(abbrEffect(cfg.effect2)) + '</b> ' + (cfg.effect2Level != null ? cfg.effect2Level : "?") + '</div>' +
'  </div>' +
'</div>';
  }

  // "Weakest 3" upgrade-priority groups: the 3 lowest-grade valid gems of one gemType.
  // Each entry: slot/label, grade as a colored badge, %damage. Sorted worst-first.
  function weakestColHtml(title, gems, gemType) {
    var list = gems.filter(function (x) {
      return x.gemType === gemType && validateConfig(x).valid;
    }).map(function (x) {
      return { gem: x, g: gGrade(x), dmg: gRel(x) };
    }).sort(function (a, b) { return a.g - b.g; }).slice(0, 3);

    var rows;
    if (!list.length) {
      rows = '<div class="wk-empty">No ' + esc(gemType) + ' gems.</div>';
    } else {
      rows = list.map(function (e) {
        var slot = e.gem.slot || ("Core " + (e.gem.coreBase || "?"));
        var tgt = (e.gem._gidx != null) ? ' data-target="gr-gem-' + e.gem._gidx + '"' : '';
        return '<div class="wk-row"' + tgt + ' title="Jump to this gem">' +
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

  // Short display name for a core column header: strip the leading "Order "/"Chaos "
  // (the section already says which), leaving e.g. "Sun" / "Moon" / "Star".
  function coreShortName(slot) {
    return String(slot || "").replace(/^\s*(order|chaos)\s+/i, "").trim() || slot || "Core";
  }

  // One core column: header (core name + its % dmg) + its gems as compact rows.
  function coreColHtml(slot, list) {
    var cdmg = 0; list.forEach(function (x) { if (validateConfig(x).valid) cdmg += gRel(x); });
    return '<div class="gr-corecol">' +
      '<div class="ch"><span class="cn">' + esc(coreShortName(slot)) + '</span>' +
      '<span class="cd">' + cdmg.toFixed(2) + '%</span></div>' +
      list.map(gemCardHtml).join("") +
      '</div>';
  }

  // One section (Order or Chaos): a 3-column grid of that type's cores. `slots` is the
  // ordered list of core keys for this type; `groups` maps key -> gems.
  function sectionHtml(title, slots, groups) {
    if (!slots.length) return "";
    var tot = 0, n = 0;
    var cols = slots.map(function (key) {
      var list = groups[key];
      list.forEach(function (x) { if (validateConfig(x).valid) tot += gRel(x); });
      n += list.length;
      return coreColHtml(key, list);
    }).join("");
    return '<div class="gr-section">' +
      '<div class="sh"><span class="st">' + esc(title) + '</span>' +
      '<span class="ssub">' + slots.length + ' cores &middot; ' + n + ' gems &middot; ' + tot.toFixed(2) + '% dmg</span></div>' +
      '<div class="gr-cores">' + cols + '</div>' +
      '</div>';
  }

  // Build the two core sections (ORDER then CHAOS). Cores are grouped by slot, preserving
  // first-appearance order; a core's section is decided by the majority gemType of its
  // gems (so a gem mis-tagged inside an otherwise-order core doesn't split the column).
  function gemsByCoreHtml(gems) {
    var order = [], groups = {};
    gems.forEach(function (x) {
      var key = x.slot || ("Core " + (x.coreBase || "?"));
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(x);
    });
    function coreType(list) {
      var o = 0, c = 0;
      list.forEach(function (x) { if (x.gemType === "order") o++; else if (x.gemType === "chaos") c++; });
      // tie-break on the slot name so well-named cores ("Order Sun") always sort right
      if (o === c) return /chaos/i.test(list[0] && list[0].slot || "") ? "chaos" : "order";
      return o >= c ? "order" : "chaos";
    }
    var orderSlots = [], chaosSlots = [];
    order.forEach(function (key) {
      (coreType(groups[key]) === "chaos" ? chaosSlots : orderSlots).push(key);
    });
    return sectionHtml("Order", orderSlots, groups) + sectionHtml("Chaos", chaosSlots, groups);
  }

  // ---------------- "what to do with your astrogems" infographic ----------------
  // Per-rarity/cost action plan + vendor boxes, pulled from window.pipelineAdvice,
  // for the ORDER and CHAOS baselines at the selected gpd. Recomputes on gpd change.

  var RAR_LABEL = { uncommon: "Uncommon", rare: "Rare", epic: "Epic" };
  // verdict -> {cls, label}. "throw" is now "dismantle". Fuse recipe is appended separately.
  var VERDICT_META = {
    "fuse": { cls: "vp-fuse", label: "Fuse" },
    "cut & reset": { cls: "vp-reset", label: "Cut & reset" },
    "cut": { cls: "vp-cut", label: "Cut" },
    "dismantle": { cls: "vp-throw", label: "Dismantle" }
  };
  // Compact bucket-cell variant (just the verb — used in the 4-up per-bucket layout).
  var VERDICT_SHORT = { "cut & reset": "Cut+reset", "cut": "Cut", "dismantle": "Dismantle", "fuse": "Fuse" };

  function fmtGoldShort(g) {
    if (g == null || !isFinite(g)) return "—";
    g = Math.round(g);
    if (Math.abs(g) >= 1000000) { var m = (g / 1000000).toFixed(1).replace(/\.0$/, ""); return m + "M"; }
    if (Math.abs(g) >= 1000) { var k = (g / 1000).toFixed(Math.abs(g) >= 100000 ? 0 : 1).replace(/\.0$/, ""); return k + "k"; }
    return String(g);
  }

  // Full verdict pill for a block roll-up (fuse appends its recipe "+ 2× N-cost Uncommon").
  function verdictPill(entry) {
    var meta = VERDICT_META[entry.verdict] || VERDICT_META["dismantle"];
    var inner = meta.label;
    if (entry.verdict === "fuse") {
      // UNOPENED fusion: you ADD 2 Uncommons to the gem you have (no arrow, no
      // Legendary/Relic/Ancient — those are the finished-gem tiers, a different thing).
      var add = (entry.addCost != null) ? entry.addCost : entry.cost;
      inner += ' <span class="rcp">+ 2&times; ' + esc(add) + '-cost Uncommon</span>';
    }
    return '<span class="vpill ' + meta.cls + '">' + inner + '</span>';
  }

  // The action cells for ONE (rarity × cost) plan entry. Fuse is the EXCEPTION: a single
  // pill (+ recipe) spanning the four bucket columns. Otherwise ALWAYS the four per-
  // effect-pair cells (2D / Op / Sub / No), one verdict pill each — they live in real
  // table columns so they line up across every row.
  function bucketCell(b) {
    var meta = VERDICT_META[b.verdict] || VERDICT_META["dismantle"];
    var short = VERDICT_SHORT[b.verdict] || meta.label;
    return '<td class="bktd" title="' + esc(b.label + ': ' + short + ' · ' + fmtGoldShort(b.cut)) + '">'
      + '<span class="vpill ' + meta.cls + '">' + short + '</span></td>';
  }
  function planActionCells(e) {
    if (e.blockFuse) return '<td class="fusetd" colspan="4">' + verdictPill(e) + '</td>';
    return e.buckets.map(bucketCell).join("");
  }

  // The single blanket-baseline recommendation table: 9 rows (rarity × cost), each with
  // the per-bucket action plan + the open value. `adv` from window.pipelineAdvice.
  function planTableHtml(adv) {
    if (!adv) return '<div class="gr-plan-card"><div class="empty">Pipeline data unavailable.</div></div>';
    var rows = '<table class="gr-ptab"><thead><tr>'
      + '<th>Gem</th><th class="bh">2D</th><th class="bh">Op</th><th class="bh">Sub</th><th class="bh">No</th>'
      + '<th class="r">Open value</th></tr></thead><tbody>';
    for (var i = 0; i < adv.plan.length; i++) {
      var e = adv.plan[i];
      rows += '<tr>'
        + '<td><span class="rar">' + esc(RAR_LABEL[e.rarity] || e.rarity) + ' <span class="c">' + e.cost + '-cost</span></span></td>'
        + planActionCells(e)
        + '<td class="r ov">' + fmtGoldShort(e.openValue) + '</td>'
        + '</tr>';
    }
    rows += '</tbody></table>';

    var boxesHtml;
    if (adv.roster === "rb") {
      // RB gems are free to cut — no box / pre-cut fuse economy applies.
      boxesHtml = '<div class="gr-boxes"><span class="none">Roster-bound gems are free to cut — no box or pre-cut fuse economy.</span></div>';
    } else {
      var boxList = (adv.boxes && adv.boxes.list) || [];
      boxesHtml = '<div class="gr-boxes"><span class="bl">Boxes worth buying</span>';
      if (boxList.length) {
        boxesHtml += boxList.map(function (b) { return '<span class="box">' + esc(b) + '</span>'; }).join(" ");
      } else {
        boxesHtml += '<span class="none">none at this baseline / gpd</span>';
      }
      boxesHtml += '</div>';
    }

    return '<div class="gr-plan-card">' + rows + boxesHtml + '</div>';
  }

  // Processed (finished) gems — fusion guide. Per fodder tier: the recipe to fuse it,
  // the output-tier odds, and the mix-weighted expected output value at each cost.
  // Data from adv.processed (window.pipelineAdvice).
  function oddsStr(mix) {
    var defs = [["legendary", "Leg"], ["relic", "Relic"], ["ancient", "Anc"]], parts = [];
    for (var i = 0; i < defs.length; i++) {
      var v = mix[defs[i][0]] || 0;
      if (v > 0.005) parts.push(Math.round(v * 100) + "% " + defs[i][1]);
    }
    return parts.join(" · ");
  }
  function processedTableHtml(adv) {
    if (!adv || !adv.processed || !adv.processed.length) return "";
    var rows = '<table class="gr-ptab"><thead><tr>'
      + '<th>Fuse</th><th>Output odds</th>'
      + '<th class="r">8-cost</th><th class="r">9-cost</th><th class="r">10-cost</th>'
      + '</tr></thead><tbody>';
    for (var i = 0; i < adv.processed.length; i++) {
      var p = adv.processed[i];
      rows += '<tr><td><span class="rar">' + esc(p.recipe) + '</span></td>'
        + '<td class="odds">' + esc(oddsStr(p.mix)) + '</td>'
        + '<td class="r ov">' + fmtGoldShort(p.evByCost[8]) + '</td>'
        + '<td class="r ov">' + fmtGoldShort(p.evByCost[9]) + '</td>'
        + '<td class="r ov">' + fmtGoldShort(p.evByCost[10]) + '</td></tr>';
    }
    rows += '</tbody></table>';
    return '<div class="gr-plan-card gr-proc"><div class="proc-h">Processed (finished) gems — fuse fodder up a tier</div>' + rows + '</div>';
  }

  // Baseline header: the ONE baseline rank, what it came from, and the ◀ ▶ nudge arrows.
  function baselineHeadHtml(base) {
    if (!base) return '';
    var src = base.srcType === "chaos" ? "Chaos" : "Order";
    var left = '<button type="button" class="gr-basearrow" id="gr-base-dn"' + (base.atMin ? ' disabled' : '')
      + ' title="Lower the baseline one rank" aria-label="Lower baseline">&#9664;</button>';
    var right = '<button type="button" class="gr-basearrow" id="gr-base-up"' + (base.atMax ? ' disabled' : '')
      + ' title="Raise the baseline one rank" aria-label="Raise baseline">&#9654;</button>';
    var shiftNote = base.shift ? ' <span class="gr-base-shift">(' + (base.shift > 0 ? '+' : '') + base.shift + ' rank)</span>' : '';
    return '<div class="gr-baseline">'
      + '<span class="lab">Baseline</span>'
      + left
      + rankBadge(base.baseRank, "gr-base-rk")
      + right
      + '<span class="gr-base-from">one rank above your stronger 3rd-lowest gem '
      + '<span class="dim">(' + src + ' ' + esc(base.srcRank) + ')</span>' + shiftNote + '</span>'
      + '</div>';
  }

  // The plan needs the CURRENT AXIS's baked grid (DPS or Support). Sync readiness check;
  // when the grid isn't cached yet, kick off its fetch — the callback re-fills the cards.
  function planAxisReady() {
    if (typeof window.pipelineAdvice !== "function") return false;
    var loaded = (typeof window.pipelineAxisLoaded === "function")
      ? window.pipelineAxisLoaded(grMode)
      : !!window.__grPipelineReady;   // stale-cached pipeline.js: DPS-only flag
    if (!loaded && typeof window.pipelineReady === "function") {
      window.pipelineReady(function () { window.__grPipelineReady = true; refreshPlanCards(); }, grMode);
    }
    return loaded;
  }

  // The whole infographic (title + gpd selector + single baseline + one plan table + legend).
  // `base` = blanketBaseline(gems); pipeline data must be ready.
  function planSectionHtml(base) {
    var gpdBtns = "";
    for (var i = 0; i < GPD_TIERS.length; i++) {
      var g = GPD_TIERS[i];
      gpdBtns += '<span class="mbtn gpd-btn ' + (g === grGpd ? "active" : "") + '" data-gpd="' + g
        + '" onclick="window.__grSetGpd(' + g + ')">' + gpdLabel(g) + '</span>';
    }

    // KR loadouts get the KR plan (no roster-bound gems, tradable-epic floor); global
    // loadouts the global plan. Pass the LOADED CHARACTER's region, not the Pipeline
    // tab's toggle, so the infographic matches the character on screen.
    var rgn = planRegion(lastLoadout && lastLoadout.region);
    var ready = planAxisReady();
    var adv = (ready && base) ? window.pipelineAdvice(base.baseGrade, grGpd, rgn, grRoster, grMode) : null;

    var body;
    if (!base) {
      body = '<div class="gr-plan-card" id="gr-plan-cards"><div class="empty">No gems in this loadout.</div></div>';
    } else if (!ready) {
      body = '<div class="placeholder" id="gr-plan-cards" style="margin-top:10px"><b>Loading pipeline economics…</b>Computing what to cut, fuse, reset, or dismantle.</div>';
    } else {
      body = '<div id="gr-plan-cards">' + planTableHtml(adv) + processedTableHtml(adv) + '</div>';
    }

    var legend = '<div class="gr-plan-legend">'
      + '<span class="vpill vp-reset">Cut &amp; reset</span><span>cut-EV ≥ 20k — cut, and reset if it lands low</span>'
      + '<span class="vpill vp-cut">Cut</span><span>cut-EV &gt; 0</span>'
      + '<span class="vpill vp-fuse">Fuse</span><span>a rarity upgrade beats cutting (whole gem)</span>'
      + '<span class="vpill vp-throw">Dismantle</span><span>not worth cutting</span>'
      + '</div>';

    var econLabel = (isSupport() ? "Support · " : "")
      + ((rgn === "kr") ? "KR economy" : (grRoster === "rb" ? "RB" : "NRB"));
    // Roster toggle — global only (KR has no roster-bound gems). Defaults to
    // non-roster-bound on every page load; the choice is session-only (not persisted).
    var rosterRow = "";
    if (rgn !== "kr") {
      rosterRow = '<div class="gr-gpd gr-roster"><span class="lab">Binding</span>'
        + '<span class="mbtn roster-btn ' + (grRoster === "nrb" ? "active" : "") + '" data-roster="nrb" onclick="window.__grSetRoster(\'nrb\')">Non-roster-bound</span>'
        + '<span class="mbtn roster-btn ' + (grRoster === "rb" ? "active" : "") + '" data-roster="rb" onclick="window.__grSetRoster(\'rb\')">Roster-bound</span>'
        + '</div>';
    }
    return '<div class="gr-plan">'
      + '<h2>What to do with your astrogems '
      + '<span class="pl-sub"><span id="gr-econ-label">' + econLabel + '</span> · per-effect-pair action plan at your loadout’s baseline</span></h2>'
      + '<div class="gr-baseline-host" id="gr-baseline-host">' + baselineHeadHtml(base) + '</div>'
      + '<div class="gr-gpd"><span class="lab">Gold per 1% damage</span>' + gpdBtns + '</div>'
      + gpdNoteHtml()
      + rosterRow
      + body
      + legend
      + '</div>';
  }

  // Recompute just the plan table + baseline header (gpd change / arrow nudge /
  // pipeline-ready) without re-rendering the whole loadout. Reads the cached loadout.
  function refreshPlanCards() {
    var host = document.getElementById("gr-plan-cards");
    if (!host) return;
    var gems = (lastLoadout && lastLoadout.gems) || [];
    var base = blanketBaseline(gems);
    var headHost = document.getElementById("gr-baseline-host");
    if (headHost) headHost.innerHTML = baselineHeadHtml(base);
    var ready = planAxisReady();
    if (!ready || !base) return;   // still loading / no gems; ready-callback re-renders
    var rgn = planRegion(lastLoadout && lastLoadout.region);  // KR vs global plan
    var adv = window.pipelineAdvice(base.baseGrade, grGpd, rgn, grRoster, grMode);
    // host may be the placeholder (with inline style) before data arrived; normalize.
    host.removeAttribute("style");
    host.className = "";
    host.innerHTML = planTableHtml(adv) + processedTableHtml(adv);
  }

  // gpd selector handler (wired via inline onclick in planSectionHtml).
  window.__grSetGpd = function (g) {
    grGpd = g;
    var btns = document.querySelectorAll("#tab-grader .gr-gpd .gpd-btn");
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle("active", Number(btns[i].getAttribute("data-gpd")) === g);
    refreshPlanCards();
  };

  // Roster toggle handler (wired via inline onclick in planSectionHtml). Session-only:
  // the plan always opens as non-roster-bound; nothing is written to localStorage.
  window.__grSetRoster = function (r) {
    grRoster = (r === "rb") ? "rb" : "nrb";
    var btns = document.querySelectorAll("#tab-grader .gr-roster .roster-btn");
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle("active", btns[i].getAttribute("data-roster") === grRoster);
    var lbl = document.getElementById("gr-econ-label");
    if (lbl) lbl.textContent = (isSupport() ? "Support · " : "") + ((grRoster === "rb") ? "RB" : "NRB");
    refreshPlanCards();
  };

  // ◀ ▶ baseline nudge: shift the blanket baseline ±1 rank (clamped to GRADE_ROWS) and
  // re-render the plan live. Wired via event delegation in renderLoadout.
  window.__grNudgeBaseline = function (delta) {
    var gems = (lastLoadout && lastLoadout.gems) || [];
    var base = blanketBaseline(gems);
    if (!base) return;
    // clamp the *resulting* index, then store the shift that produced it
    var want = base.baseIdx + delta;
    var clamped = Math.max(0, Math.min(GRADE_ROWS.length - 1, want));
    grBaseShift += (clamped - base.baseIdx);
    refreshPlanCards();
  };

  // ---- "where does this loadout sit?" — rank vs every cached character ----
  // Fetched once per session (compact fmt=2 snapshot; same endpoint the leaderboard uses)
  // and reused across re-grades and axis flips. Decoder kept in lockstep with
  // decodeSnapshotV2 in leaderboard.js (duplicated because the leaderboard is lazy-loaded).
  // getFieldSnapshot now delegates to LoadoutEcon.fieldSnapshot() (see the wrapper
  // block near the top) — the decode + session cache moved to loadout-econ.js.
  function fillFieldRank(data, sup, rankDmg) {
    if (rankDmg == null || !(A && A.gridDamage && A.validateConfig)) return;
    getFieldSnapshot().then(function (chars) {
      var el = $("gr-fieldrank"); // re-query: the pane may have re-rendered while fetching
      if (!chars || !chars.length || !el) return;
      var axis = sup ? "support" : "dps";
      var better = 0, total = 0, classBetter = 0, classTotal = 0;
      for (var i = 0; i < chars.length; i++) {
        var g = (chars[i].gems || []).filter(function (x) { return A.validateConfig(x).valid; });
        if (!g.length) continue;
        var d = A.gridDamage(g, axis);
        total++;
        if (d > rankDmg) better++;
        if (data.class && chars[i].class === data.class) { classTotal++; if (d > rankDmg) classBetter++; }
      }
      if (!total) return;
      var bits = [];
      if (data.class && classTotal >= 5) {
        var pct = Math.max(1, Math.ceil(100 * (classBetter + 1) / (classTotal + 1)));
        bits.push("Top " + pct + "% of " + esc(data.class) + "s (#" + (classBetter + 1) + " of " + classTotal + ")");
      }
      bits.push("#" + (better + 1) + " of " + total.toLocaleString() + " tracked characters" + (sup ? " (support axis)" : ""));
      el.textContent = bits.join(" · ");
    }).catch(function () {});
  }

  function renderLoadout(data) {
    applyAxisTheme();
    var out = $("gr-result");
    var gems = activeGems(data);
    grBaseShift = 0;   // fresh loadout: drop any manual ◀▶ baseline nudge from the last one
    // Auto-select the gpd tier from combat power — once per pulled record, so axis /
    // preset flips re-render without clobbering a manual gpd click. A Re-pull bumps
    // pulledAt, so fresh data (which may have just gained combatPower) re-applies.
    var autoKey = (data.region || "") + ":" + (data.name || "") + ":" + (data.pulledAt || 0);
    if (autoKey !== grGpdAutoKey) {
      grGpdAutoKey = autoKey;
      grGpd = cpToGpd(data.combatPower) || GPD_DEFAULT;
    }
    // tag each gem with a stable index so the Weakest-3 rows can jump to its card
    gems.forEach(function (x, i) { x._gidx = i; });
    if (!gems.length) {
      out.innerHTML = '<div class="panel"><div class="gr-status err">No gems found for this character.</div></div>';
      return;
    }

    // Keep the region select + Re-pull label/source note aligned with THIS loadout's
    // region (so "Re-pull from lopec.kr" shows for KR and the re-pull targets lopec).
    if (data.region && $("gr-region")) {
      var rr = String(data.region).toUpperCase();
      if (REGIONS.indexOf(rr) !== -1) $("gr-region").value = rr;
    }
    syncSourceUI(data.region);

    // overall summary over the VALID gems. In DPS mode %dmg is damage ABOVE the cp
    // baseline (relDamage) and grade/rank are the DPS axis; in Support mode every figure
    // switches to the support axis (party-damage value above a neutral support gem).
    var sup = isSupport();
    var valid = gems.filter(function (x) { return validateConfig(x).valid; });
    var sumGrade = 0;
    valid.forEach(function (x) { sumGrade += gGrade(x); });
    // loadout TOTAL = the true lvl-0 grid damage (diminishing returns + the per-core order
    // floor), NOT Σ per-gem — per-gem figures are standalone and won't sum to it exactly.
    var gridOk = !!(A && A.gridDamage);
    var sumDmg = gridOk
      ? (sup ? A.gridDamage(valid, "support") / 3 : A.gridDamage(valid, "dps"))
      : valid.reduce(function (s, x) { return s + gRel(x); }, 0); // legacy-model fallback: a per-gem SUM, not the true grid total — flagged in the UI below
    var rankDmg = gridOk ? (sup ? sumDmg * 3 : sumDmg) : null;    // RAW gridDamage for rank-vs-field (same scale the comparison loop uses)
    var avgGrade = valid.length ? sumGrade / valid.length : 0;
    var avgRank = rankFromGrade(avgGrade);
    var totalLabel = sup ? "Total % party dmg" : "Total % dmg";

    // Big lostark.bible-style profile header: class icon + large bold name, with region
    // / class / item level as secondary chips. KR (data.class == null) -> item level only.
    var metaChips = '<span class="gr-chip">' + esc(data.region || "") + '</span>';
    if (data.class) metaChips += '<span class="gr-chip">' + esc(data.class) + '</span>';
    if (data.itemLevel != null) metaChips += '<span class="gr-chip">ilvl <b>' + esc(Number(data.itemLevel).toLocaleString()) + '</b></span>';

    var html = '' +
axisToggleHtml() +
presetToggleHtml(data) +
'<div class="panel">' +
'  <div class="gr-prof">' +
'    <button type="button" class="gr-star" id="gr-fav-star"></button>' +
     classIconHtml(data.class) +
'    <div class="gr-id">' +
'      <div class="gr-name"><a class="bible-link" href="' + bibleUrl(data.region, data.name) + '" target="_blank" rel="noopener">' + esc(data.name || "") + '</a>' +
       cacheNoteHtml(data) + '<span class="gr-star-note" id="gr-fav-note" style="display:none"></span></div>' +
'      <div class="gr-meta">' + metaChips + '</div>' +
'    </div>' +
'  </div>' +
'  <div class="gr-sum">' +
'    <div class="stat"><span class="k">Avg grade</span><span class="v" style="color:var(--axis,var(--accent))">' + avgGrade.toFixed(1) + '</span></div>' +
'    <div class="stat"><span class="k">Avg rank</span><span class="v">' + rankBadge(avgRank) + '</span></div>' +
'    <div class="stat"><span class="k">' + totalLabel + (gridOk ? '' : ' <span title="Grid-total model unavailable — showing the per-gem sum, which overstates the true total. Hard-refresh to load the latest model.">⚠ estimate</span>') + '</span><span class="v" style="color:var(--axis,var(--accent))">' + sumDmg.toFixed(2) + '%</span></div>' +
'  </div>' +
'  <div class="gr-fieldrank" id="gr-fieldrank" style="margin-top:6px;font-size:12px;opacity:.75"></div>';
    if (data.warnings && data.warnings.length) {
      html += '<div class="gr-warn">' + data.warnings.length + ' parser warning(s): ' + esc(data.warnings.slice(0, 4).join("; ")) + (data.warnings.length > 4 ? "…" : "") + '</div>';
    }
    html += '</div>';

    // upgrade priorities: weakest 3 Order + weakest 3 Chaos, side by side, at the top
    html += weakestSectionHtml(gems);

    // "what to do with your astrogems": ONE blanket-baseline action plan (per effect
    // pair) + boxes. Baseline = one rank above the stronger of the two types' 3rd-lowest
    // gems, nudgeable ±1 rank with ◀▶. Numbers come from window.pipelineAdvice; the
    // section paints a "loading…" placeholder first and fills once pipelineReady fires
    // (so it works even if Pipeline was never opened). AXIS-AWARE: Support mode reads
    // the SUPPORT bake (support cut-EVs + support-grade baseline) via grMode.
    html += planSectionHtml(blanketBaseline(gems));

    // Gems by core, laid out as two sections (ORDER then CHAOS). Each section is a
    // 3-column grid: one column per core (Sun / Moon / Star), each column listing that
    // core's gems as compact stacked rows. Cores are grouped by slot, preserving first-
    // appearance order; the section a core belongs to is its gems' gemType.
    html += gemsByCoreHtml(gems);

    out.innerHTML = html;

    // DPS / Support toggle: flip the grading axis and re-render live. (Bound here since
    // the toggle markup is re-emitted on every loadout render.)
    Array.prototype.forEach.call(out.querySelectorAll(".gr-axispill"), function (btn) {
      btn.addEventListener("click", function () {
        if (btn.hasAttribute("data-preset")) setGrPreset(btn.getAttribute("data-preset"));
        else setGrMode(btn.getAttribute("data-axis"));
      });
    });

    fillFieldRank(data, sup, rankDmg); // async: fills #gr-fieldrank once the field snapshot arrives

    // Weakest-3 rows scroll to + flash their gem card
    Array.prototype.forEach.call(out.querySelectorAll(".wk-row[data-target]"), function (row) {
      row.addEventListener("click", function () { focusGem(row.getAttribute("data-target")); });
    });

    // Baseline ◀ ▶ arrows: delegated on `out` so they survive the baseline-host re-render
    // that refreshPlanCards does on each nudge. (Bound once per loadout render.)
    // ASSIGN (not addEventListener): renderLoadout re-runs on every DPS/Support toggle,
    // and #gr-result persists, so addEventListener would STACK handlers -> one arrow
    // click fires N times -> the baseline jumps by N ranks. onclick replaces -> exactly 1.
    out.onclick = function (e) {
      var t = e.target.closest ? e.target.closest(".gr-basearrow") : null;
      if (!t || t.disabled) return;
      window.__grNudgeBaseline(t.id === "gr-base-up" ? +1 : -1);
    };

    // Favorite star: toggles this loadout's character (region+name from lastLoadout).
    var star = $("gr-fav-star");
    if (star && Favs) {
      var favRegion = data.region, favName = data.name;
      paintStar(star, favRegion, favName);
      star.addEventListener("click", function () {
        // Favorites are unlimited — just toggle (persists + notifies, re-renders fav row).
        Favs.toggle(favRegion, favName);
        paintStar(star, favRegion, favName);
      });
    } else if (star) {
      star.style.display = "none"; // Favorites store unavailable
    }

    // Ensure the CURRENT AXIS's pipeline grid is loaded, then (re)fill the action-plan
    // cards. Each axis's bake loads lazily on first need (DPS: pipeline.json,
    // Support: pipeline-support.json); flipping the axis re-runs this via renderLoadout.
    if (typeof window.pipelineReady === "function") {
      window.pipelineReady(function () {
        window.__grPipelineReady = true;
        refreshPlanCards();
      }, grMode);
    }
  }

  // scroll a loadout gem card into view and flash it (restartable on repeat clicks)
  function focusGem(id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
    setTimeout(function () { el.classList.remove("flash"); }, 1400);
  }

  function setPullStatus(msg, kind) {
    var el = $("gr-pull-status");
    el.textContent = msg || "";
    el.className = "gr-status" + (kind ? " " + kind : "");
  }

  // Make the Re-pull button + the source note reflect the site a region pulls from
  // (KR -> lopec.kr, otherwise lostark.bible). The Worker already routes KR to lopec;
  // this just keeps the labels honest. Called on render + whenever the region changes.
  function syncSourceUI(region) {
    if (!WORKER_URL) return;
    var site = sourceSite(region);
    var refreshBtn = $("gr-pull-refresh");
    if (refreshBtn) {
      refreshBtn.textContent = "Re-pull from " + site;
      refreshBtn.title = "Force a fresh pull from " + site;
    }
    var note = $("gr-pull-note");
    if (note) note.textContent = "Fetched live from " + site + " via your Worker.";
  }

  // ---------------- saved-characters quick-pick ----------------
  var Favs = (typeof window !== "undefined" && window.Favorites) || null;

  // Render the row of quick-pick buttons (one per saved character) in pull mode.
  // Clicking a button loads that character; empty -> a faint hint. Re-run on
  // Favorites.onChange and whenever pull mode is (re)entered.
  function renderFavRow() {
    var host = $("gr-favs");
    if (!host) return; // only present in pull mode markup
    var favs = Favs ? Favs.list() : [];
    if (!favs.length) {
      host.innerHTML = '<span class="gr-favempty">No saved characters yet — grade one and tap its ★.</span>';
      return;
    }
    // Each saved character is a row: a ★ to UNSAVE (frees the old "★ Saved" header space)
    // + the name button to LOAD it.
    host.innerHTML = '<div class="gr-favlist">' + favs.map(function (f, i) {
      return '<div class="gr-favrow" data-fi="' + i + '">' +
        '<button type="button" class="gr-favstar" title="Unsave ' + esc(f.name) + '" aria-label="Unsave ' + esc(f.name) + '">&#9733;</button>' +
        '<button type="button" class="gr-favbtn" title="Load ' + esc(f.name) + ' (' + esc(f.region) + ')">' +
        '<span class="nm">' + esc(f.name) + '</span>' +
        '<span class="rg">' + esc(f.region) + '</span></button>' +
        '</div>';
    }).join("") + '</div>';
    Array.prototype.forEach.call(host.querySelectorAll(".gr-favrow"), function (rowEl) {
      var f = favs[parseInt(rowEl.getAttribute("data-fi"), 10)];
      if (!f) return;
      rowEl.querySelector(".gr-favbtn").addEventListener("click", function () {
        if ($("gr-region")) {
          var r = String(f.region).toUpperCase();
          if (REGIONS.indexOf(r) !== -1) $("gr-region").value = r;
        }
        if ($("gr-name")) $("gr-name").value = f.name;
        var go = $("gr-pull-go");
        if (go) go.click(); // triggers the pull exactly like a manual Grade
      });
      rowEl.querySelector(".gr-favstar").addEventListener("click", function () {
        if (Favs) Favs.remove(f.region, f.name); // Favorites.onChange re-renders this row + the loadout star
      });
    });
  }

  // Update the loadout-header star to reflect the current favorited state.
  function paintStar(btn, region, name) {
    var on = Favs ? Favs.has(region, name) : false;
    btn.classList.toggle("on", on);
    btn.innerHTML = on ? "&#9733;" : "&#9734;"; // ★ / ☆
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.title = on ? "Remove from saved characters" : "Save this character";
  }

  function runPull(refresh) {
    // Pull is open to everyone: password-holders (token, see below) are unlimited; everyone
    // else gets the Worker's free daily allowance, paced by the countdown started on success.
    if (!WORKER_URL) {
      setPullStatus("", "");
      $("gr-result").innerHTML = '<div class="panel"><div class="gr-status err">The lostark.bible Worker isn’t configured. Deploy worker/astrogem-bible.js and set WORKER_URL at the top of grader.js.</div></div>';
      return;
    }
    var region = $("gr-region").value;
    var name = ($("gr-name").value || "").trim();
    if (!name) { setPullStatus("Enter a character name.", "err"); return; }
    try { localStorage.setItem("ag_gr_last", JSON.stringify({ region: region, name: name })); } catch (e) {} // prefill next visit
    // For a refresh of the CURRENTLY-shown character, remember its pulledAt so the queue poll waits
    // for genuinely NEWER data instead of re-rendering the same stale cache the refresh is replacing.
    // Refreshing the character that's CURRENTLY shown (cached)? Keep its loadout on screen with a
    // queue banner over it, instead of blanking it for the "queued" panel.
    var refreshingCached = !!(refresh && lastLoadout && Array.isArray(lastLoadout.gems) && lastLoadout.gems.length &&
                 lastLoadout.region === region &&
                 String(lastLoadout.name || "").toLowerCase() === name.toLowerCase());

    setPullStatus((refresh ? "Re-pulling " : "Fetching ") + name + " (" + region + ")…", "working");
    $("gr-pull-go").disabled = true;
    var refreshBtn = $("gr-pull-refresh");
    if (refreshBtn) refreshBtn.disabled = true;

    stopPoll(); clearRefreshBanner(); // cancel any in-flight queue poll + clear a prior refresh banner
    Econ.fetchCharacter(region, name, { refresh: refresh }).then(function (r) {
      var d = r.data || {};
      if (d.unavailable) { setUnavailable(true, d.error); setPullStatus(d.error || "Lookups are temporarily unavailable.", "err"); return; }
      // The cached loadout to SHOW (if any): from this response (Grade loadout on a cached char),
      // or the one already on screen (manual Refresh, answered with a queued response). Flow: cached
      // data renders whenever we have it; a queue banner/panel layers on whenever it's queued.
      var gems = Array.isArray(d.gems) && d.gems.length;
      var cachedShow = gems ? r.data : (refreshingCached ? lastLoadout : null);
      var sinceTs = cachedShow ? (cachedShow.pulledAt || 0) : 0;
      if (cachedShow) {
        lastLoadout = cachedShow; grPreset = "raid"; grMode = defaultModeFor(cachedShow);
        if (refreshBtn) refreshBtn.style.display = "";
        renderLoadout(cachedShow);
      }
      if (d.queued) {
        if (cachedShow) {
          setPullStatus((d.stale ? "Cached (stale) — refreshing " : "Cached — refreshing ") + name + "…", "");
          showRefreshBanner(region, name, d);
        } else {
          setPullStatus("Queued — fetching " + name + "…", "");
          showQueued(region, name, d);
        }
        startQueueWatch(region, name, sinceTs, !!cachedShow, d);
        return;
      }
      if (cachedShow) {
        // Cached record lacking combatPower? Kick off the re-pull automatically.
        if (!maybeAutoRepullForCp(cachedShow)) setPullStatus("Graded " + cachedShow.gems.length + " gems.", "");
        return;
      }
      // Anything else: an error / rate-limit / busy / monthly-budget message.
      var msg = d.error || "Worker returned an error.";
      setPullStatus(msg, "err");
      $("gr-result").innerHTML = '<div class="panel"><div class="gr-status err">' + esc(msg) + '</div></div>';
      if (d.degraded) setFreeStatus(true);
    }).catch(function (e) {
      setPullStatus("Request failed: " + (e && e.message || e), "err");
    }).then(function () {
      $("gr-pull-go").disabled = false;
      if (refreshBtn) refreshBtn.disabled = false;
    });
  }

  // ---------------- queue: show "queued", poll until the drain caches it ----------------
  var grPollTimer = null, grPaintTimer = null, grWatching = false;
  function stopPoll() {
    grWatching = false;                                       // also stops the long-poll's reconnect loop
    if (grPollTimer) { clearTimeout(grPollTimer); grPollTimer = null; }
    if (grPaintTimer) { clearInterval(grPaintTimer); grPaintTimer = null; }
  }
  function fmtEta(sec) {
    if (sec == null) return "";
    if (sec < 60) return "~" + Math.max(1, Math.round(sec)) + "s";
    var m = Math.floor(sec / 60), s = Math.round(sec % 60);
    return "~" + m + "m" + (s ? (" " + s + "s") : "");
  }
  // "Position 3 of 12 · ~50s" from a status object {position, total, drainPerMin}. ETA derives from
  // the drain rate (default 6/min = 1 every 10s), so the local countdown and the server agree.
  function queueLine(d) {
    if (!d || !(d.position > 0)) return "";
    var perMin = d.drainPerMin || 6;
    var head = d.position <= 1 ? "Next up" : ("Position " + d.position + " of " + Math.max(d.total || d.position, d.position));
    return head + " · " + fmtEta(Math.ceil(d.position / perMin * 60));
  }
  function clearRefreshBanner() { var b = $("gr-refresh-banner"); if (b) b.innerHTML = ""; }
  // Refresh of a CACHED character: a thin bar ABOVE the (still-shown) cached loadout carrying the
  // live queue position/ETA, so the user sees the cached grades AND the refresh progress at once.
  function showRefreshBanner(region, name, d) {
    var b = $("gr-refresh-banner"); if (!b) return;
    var ql = queueLine(d);
    b.innerHTML =
      '<div class="gr-refresh-bar"><span class="gr-rb-spin">🔄</span><span>' +
      '<b>Refreshing ' + esc((d && d.name) || name) + '</b>' +
      (ql ? ' — <span id="gr-rb-pos">' + ql + '</span>' : '') +
      ' <span class="gr-rb-dim">· cached grades shown below · <span id="gr-rb-timer">checking…</span></span>' +
      '</span></div>';
  }
  function showQueued(region, name, d) {
    var disp = (d && d.name) || name;
    var tier = (d && d.tier === "premium") ? "priority queue" : "queue";
    $("gr-result").innerHTML =
      '<div class="panel"><div class="gr-queued">' +
      '<div class="gr-queued-icon">⏳</div>' +
      '<div class="gr-queued-main"><b>' + esc(disp) + '</b> is in the ' + tier + '.' +
      '<div class="gr-queued-pos" id="gr-queued-pos">' + queueLine(d) + '</div>' +
      '<div class="gr-queued-sub">Fetching it now — this updates automatically when it’s ready. <span id="gr-queued-timer">checking…</span></div></div>' +
      '</div></div>';
  }
  // Queue watch: a LOCAL position countdown (drops ~1 per 60/perMin seconds — the drain rate, no
  // server cost) PLUS a server RE-SYNC of the true position every 30s WHILE QUEUED (the re-sync also
  // detects completion, then stops — it never polls when you're not waiting). `st` = the worker's
  // initial {position,total,etaMinutes,drainPerMin}; `cachedRefresh` routes UI to the banner vs panel.
  function startQueueWatch(region, name, since, cachedRefresh, st) {
    stopPoll();
    grWatching = true;
    since = since || 0;
    var perMin = (st && st.drainPerMin) || 6;
    var pos = (st && st.position > 0) ? st.position : null;   // last server-known position
    var total = (st && st.total) || null;
    var syncAt = Date.now();                                  // when `pos` was last server-synced
    var started = Date.now(), MAX_MS = 10 * 60 * 1000;
    function tick(html) { var t = $(cachedRefresh ? "gr-rb-timer" : "gr-queued-timer"); if (t) t.innerHTML = html; }
    function curPos() {                                       // local countdown since the last sync
      if (pos == null) return null;
      return Math.max(1, pos - Math.floor((Date.now() - syncAt) / 1000 / (60 / perMin)));
    }
    function paint() {
      var p = curPos();
      var el = $(cachedRefresh ? "gr-rb-pos" : "gr-queued-pos");
      if (el) el.innerHTML = (p == null) ? "checking…" : queueLine({ position: p, total: total, drainPerMin: perMin });
    }
    grPaintTimer = setInterval(paint, 1000);                  // 1) free local display tick

    function scheduleSync() {                                 // 2) server re-sync — flat 30s while queued
      grPollTimer = setTimeout(doSync, 30000);
    }
    function doSync() {
      if (Date.now() - started > MAX_MS) {
        stopPoll();
        tick(cachedRefresh ? "still refreshing — try again later." : "still queued — check back later, or search again.");
        return;
      }
      Econ.fetchCharacter(region, name).then(function (r) {
        var d = r.data || {};
        var hasGems = Array.isArray(d.gems) && d.gems.length;
        // Done only once the cache is genuinely NEWER than what we're replacing (a stale-cache hit
        // returns the same pulledAt until the drain re-fetches it).
        if ((d.cached || hasGems) && (d.pulledAt || 0) > since) { finishWatch(d); return; }
        if (d.queued && d.position > 0) {                      // re-sync true position, reset countdown
          pos = d.position; total = d.total || total; if (d.drainPerMin) perMin = d.drainPerMin; syncAt = Date.now();
        } else if (!d.queued && !hasGems && (!r.ok || d.error)) { endWatch(d.error); return; }
        paint();
        scheduleSync();
      }).catch(function () { scheduleSync(); /* transient — keep watching */ });
    }
    function finishWatch(d) {                                 // refresh done -> render the fresh loadout
      stopPoll(); clearRefreshBanner();
      lastLoadout = d; grPreset = "raid"; grMode = defaultModeFor(d);
      var rb = $("gr-pull-refresh"); if (rb) rb.style.display = "";
      setPullStatus("Graded " + ((d.gems || []).length) + " gems.", "");
      renderLoadout(d);
    }
    function endWatch(msg) {                                  // lookup ended (not found / 422 no gems / error) -> show why, stop
      stopPoll(); clearRefreshBanner();
      setPullStatus(msg || "Lookup ended.", "err");
      if (!cachedRefresh) $("gr-result").innerHTML = '<div class="panel"><div class="gr-status err">' + esc(msg || "Lookup ended.") + '</div></div>';
    }
    // 3) Long-poll: the worker returns the INSTANT the drain re-caches this char (a real push), so the
    //    refresh banner clears within seconds instead of waiting for the 30s position tick.
    function waitLoop() {
      if (!grWatching) return;
      var k = (window.astrogemGate && window.astrogemGate.token && window.astrogemGate.token()) || "";
      var url = WORKER_URL.replace(/\/+$/, "") + "/?region=" + encodeURIComponent(region) + "&name=" + encodeURIComponent(name) + "&queue=1&wait=1&since=" + since + (k ? "&k=" + encodeURIComponent(k) : "");
      fetch(url).then(function (resp) { return resp.json(); }).then(function (d) {
        if (!grWatching) return;
        if (d && d.done && Array.isArray(d.gems)) finishWatch(d);   // drain completed -> refresh now
        else if (d && d.notFound) endWatch(d.error);                // dropped (404/422) -> stop + show why
        else waitLoop();                                            // timed out -> reconnect
      }).catch(function () { if (grWatching) setTimeout(waitLoop, 3000); }); // transient -> retry
    }
    paint();
    scheduleSync();
    waitLoop();
  }

  // The note under the pull buttons. Cached lookups are free & unlimited; NEW characters are paced to
  // ~1 lookup / 5s per IP for everyone (no hourly cap). The password only adds queue priority + access
  // while the site is degraded. Call setFreeStatus(true) for the "site busy" state; setFreeStatus() re-renders.
  function setFreeStatus(degraded) {
    var el = $("gr-free-note");
    if (!el) return;
    if (degraded) {
      el.innerHTML = '<span class="gr-cap">The site is very busy — new-character lookups are paused. Cached characters still work.</span>';
      return;
    }
    if (window.astrogemGate && window.astrogemGate.isUnlocked()) {
      el.innerHTML = '<span class="gr-prem">&#10003; Password access · priority queue + access while the site is busy</span>';
      return;
    }
    el.innerHTML = 'Cached characters are free &amp; instant · new characters: <b>~1 lookup / 5s</b> · <a class="gr-unlock" onclick="window.__grUnlock()">Have the password? Unlock for priority &rarr;</a>';
  }
  window.__grUnlock = function () {
    if (window.astrogemGate) window.astrogemGate.ensureUnlocked().then(function () { setFreeStatus(); });
  };

  // ---------------- mode switching ----------------
  function selectMode(mode) {
    var custom = mode === "custom";
    $("gr-mode-custom").classList.toggle("active", custom);
    $("gr-mode-pull").classList.toggle("active", !custom);
    $("gr-body-custom").style.display = custom ? "" : "none";
    $("gr-body-pull").style.display = custom ? "none" : "";
    if (!custom) { renderFavRow(); setFreeStatus(); } // saved-chars quick-pick + free-tier note
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

  // ---- "Lookups temporarily unavailable" notice (worker-reported queue pause) ----
  function setUnavailable(on, msg) {
    var el = $("gr-unavailable"); if (!el) return;
    if (on) {
      el.innerHTML = '<b>&#9888;&#65039; ' + esc(msg || "Character lookups are temporarily unavailable") + '</b>';
      el.style.display = "";
    } else { el.style.display = "none"; }
  }
  function checkLookupStatus() {
    if (!WORKER_URL) return;
    fetch(WORKER_URL.replace(/\/+$/, "") + "/?status=1").then(function (r) { return r.json(); }).then(function (j) {
      setUnavailable(!!(j && j.paused), j && j.message);
    }).catch(function () { /* network blip — leave the notice as-is */ });
  }

  // ---- IMPORT a lostark.bible / lopec.kr loadout WITHOUT the Worker (drop / paste / bookmarklet) ----
  // lostark.bible blocks our Worker and sends no CORS, so the user brings the page SOURCE over and we
  // parse it client-side via window.BibleImport, then render through the normal renderLoadout path.
  function importFromText(text, hint, where) {
    if (!window.BibleImport) return false;
    var lo = null;
    try { lo = window.BibleImport.parse(text, hint); } catch (e) { lo = null; }
    if (!lo || !lo.gems || !lo.gems.length) {
      if (where === "drop" || where === "paste") {
        var looksBible = /lostark\.bible|arkGridCores|use_13_\d/.test(text || "");
        setPullStatus(looksBible
          ? "That lostark.bible page is missing the gem data — browsers strip it when you Save Page. Paste the page's View-Source (⌘-U / Ctrl-U) instead — that carries everything."
          : "That didn't look like a lostark.bible character page. Open your character there, then paste its View-Source, or drag a saved page.", "err");
      }
      return false;
    }
    var charData = {
      region: lo.region, name: lo.name,
      gems: lo.gems, chaosGems: lo.chaosGems,
      itemLevel: lo.itemLevel, class: lo.class, warnings: lo.warnings,
      pulledAt: Date.now(), cached: false, source: "import"
    };
    window.graderShowLoadout(charData);
    var rb = $("gr-pull-refresh"); if (rb) rb.style.display = "none"; // re-pull would hit the blocked Worker
    setPullStatus("Imported " + (lo.name || "loadout") + (lo.region ? " (" + lo.region + ")" : "") + " from " + (lo.source || "lostark.bible") + " — graded locally, no server.", "ok");
    return true;
  }

  // Wire drop (onto the loadout square + pull controls), global paste (page-source only), and the
  // bookmarklet's #import= landing, then render the small import helper under the controls.
  function setupImport() {
    if (!window.BibleImport) return;
    var MARK = /arkGridCores:\[|use_13_\d+\.png/;
    function onDragOver(ev) { if (ev.dataTransfer) { ev.preventDefault(); ev.dataTransfer.dropEffect = "copy"; } }
    function onDrop(ev) {
      var dt = ev.dataTransfer; if (!dt) return;
      ev.preventDefault();
      var file = dt.files && dt.files[0];
      if (file) { var fr = new FileReader(); fr.onload = function () { importFromText(String(fr.result || ""), null, "drop"); }; fr.readAsText(file); return; }
      importFromText(dt.getData("text/plain") || dt.getData("text/html") || dt.getData("text/uri-list") || "", null, "drop");
    }
    ["gr-result", "gr-body-pull"].forEach(function (id) {
      var el = $(id); if (!el) return;
      el.addEventListener("dragover", onDragOver);
      el.addEventListener("drop", onDrop);
    });
    // Global paste, but ONLY for a page-source paste (the marker) so ordinary pastes are untouched.
    document.addEventListener("paste", function (ev) {
      var t = $("tab-grader"); if (!t || t.offsetParent === null) return; // grader tab not visible
      var cd = ev.clipboardData || window.clipboardData;
      var text = cd ? cd.getData("text") : "";
      if (text && MARK.test(text)) { ev.preventDefault(); importFromText(text, null, "paste"); }
    });
    // Bookmarklet landing: #import=<encoded {src,region,name}>.
    function consumeHash() {
      var m = (location.hash || "").match(/[#&]import=([^&]+)/);
      if (!m) return;
      var payload = null;
      try { payload = JSON.parse(decodeURIComponent(m[1])); } catch (e) {}
      try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { location.hash = ""; }
      if (payload && payload.src) importFromText(payload.src, { region: payload.region, name: payload.name }, "hash");
    }
    consumeHash();
    window.addEventListener("hashchange", consumeHash);
  }

  function init() {
    var elTab = $("tab-grader");
    if (!elTab) return;
    elTab.innerHTML = tabMarkup();

    // Prefill the last-pulled character (saved on every pull) so a return visit is one click.
    try {
      var last = JSON.parse(localStorage.getItem("ag_gr_last") || "null");
      if (last && last.name && $("gr-name") && !$("gr-name").value) {
        $("gr-name").value = last.name;
        if (REGIONS.indexOf(last.region) !== -1) $("gr-region").value = last.region;
      }
    } catch (e) {}

    // pull-mode availability note (source-aware: lostark.bible / lopec.kr by region)
    var note = $("gr-pull-note");
    if (!WORKER_URL) {
      note.innerHTML = 'Set <code>WORKER_URL</code> at the top of <code>grader.js</code> after deploying <code>worker/astrogem-bible.js</code> (see <code>worker/README-bible.md</code>). Custom input works without it.';
      $("gr-pull-go").disabled = true;
    } else {
      syncSourceUI($("gr-region") ? $("gr-region").value : "NA");
    }

    // region change -> update the Re-pull label + source note to match the site
    if ($("gr-region")) $("gr-region").addEventListener("change", function () { syncSourceUI(this.value); });

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

    // Keep the quick-pick row and the loadout star in sync when favorites change
    // anywhere (here OR on the Leaderboard tab).
    if (Favs) {
      Favs.onChange(function () {
        renderFavRow();
        var star = $("gr-fav-star");
        if (star && lastLoadout) paintStar(star, lastLoadout.region, lastLoadout.name);
      });
    }

    // pull mode (wrap so the click Event isn't passed as the refresh flag)
    $("gr-pull-go").addEventListener("click", function () { runPull(false); });
    $("gr-pull-refresh").addEventListener("click", function () { runPull(true); });
    $("gr-name").addEventListener("keydown", function (e) { if (e.key === "Enter" && WORKER_URL) runPull(false); });

    checkLookupStatus();                            // show the "lookups unavailable" notice if the queue is paused
    // Re-check only when the user opens or returns to the tab — NOT on a 60s interval. Idle/background
    // tabs no longer poll, which removes ~all the steady /?status=1 traffic; the banner still refreshes
    // the moment someone looks at the page. (focus + visibility can both fire on return — an extra tiny read is fine.)
    window.addEventListener("focus", checkLookupStatus);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) checkLookupStatus(); });

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
      grPreset = "raid"; // a fresh loadout always starts on the raid preset
      grMode = defaultModeFor(charData); // auto-default DPS/Support for this loadout
      // Listed characters are cached records; reflect that unless told otherwise.
      if (charData.cached == null && charData.pulledAt != null) charData.cached = true;
      var refreshBtn = $("gr-pull-refresh");
      if (refreshBtn && WORKER_URL) refreshBtn.style.display = "";
      setPullStatus("Showing stored loadout for " + (charData.name || "") + ".", "");
      renderLoadout(charData);
      maybeAutoRepullForCp(charData);   // stored records may predate combatPower — self-heal
    };

    // first paint: open in "Pull from lostark.bible" mode (the primary mode). Custom
    // mode is fully wired above (effect lists built), one toggle-click away.
    selectMode("pull");

    setupImport(); // drag / paste / bookmarklet import of a lostark.bible loadout (graderShowLoadout is defined above)
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
