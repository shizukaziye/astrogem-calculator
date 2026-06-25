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
  // The Pipeline tab bakes one DP solve per these 12 anchor grades; each maps 1:1
  // to a distinct rank (C- … S+), so the array IS a clean rank ladder. We mirror it
  // here so a gem's rank can be "bumped one rank up" by stepping to the next index.
  var GRADE_ROWS = [52, 57, 62, 66, 70, 73, 77, 80, 83, 87, 92, 97];
  // gpd tiers offered by the selector (must match gpdsInData() in pipeline.json).
  var GPD_TIERS = [500000, 1000000, 1500000, 2500000, 3500000, 5000000, 7500000, 10000000];
  var GPD_DEFAULT = 1500000;
  var grGpd = GPD_DEFAULT;           // currently-selected gpd for the infographic

  function gpdLabel(g) {
    if (g >= 1000000) { var m = (g / 1000000).toFixed(1).replace(/\.0$/, ""); return m + "M"; }
    return (g / 1000).toFixed(0) + "k";
  }

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

  // ORDER/CHAOS baseline from the 3rd-lowest-GRADE gem of that type, bumped one
  // rank up. <3 valid gems -> use the lowest available. Returns null if none.
  //   { srcGrade, srcRank, baseGrade, baseRank, count }
  function typeBaseline(gems, gemType) {
    var graded = (gems || []).filter(function (x) {
      return x.gemType === gemType && validateConfig(x).valid;
    }).map(function (x) { return grade(x); }).sort(function (a, b) { return a - b; });
    if (!graded.length) return null;
    var src = graded.length >= 3 ? graded[2] : graded[0];
    var baseGrade = bumpedBaselineGrade(src);
    return {
      srcGrade: src, srcRank: rankFromGrade(src),
      baseGrade: baseGrade, baseRank: rankFromGrade(baseGrade),
      count: graded.length
    };
  }

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

  // lostark.bible profile URL for a character (the loadout name links here).
  function bibleUrl(region, name) {
    var r = String(region).toUpperCase();
    if (r === "KR") return "https://lopec.kr/character/specPoint/" + encodeURIComponent(name || "");
    if (r === "EU") return "https://lostark.bible/character/EUC/" + encodeURIComponent(name || "");
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
// pull-mode top row: inputs on the LEFT, saved-character chips filling the RIGHT space.
'  #tab-grader .gr-pullrow{display:grid;grid-template-columns:minmax(320px,auto) 1fr;gap:18px 24px;align-items:start}' +
'  @media(max-width:760px){#tab-grader .gr-pullrow{grid-template-columns:1fr}}' +
'  #tab-grader .gr-pullrow .gr-pullleft{min-width:0}' +
'  #tab-grader .gr-pullrow .gr-pullright{min-width:0;border-left:1px solid var(--border);padding-left:24px}' +
'  @media(max-width:760px){#tab-grader .gr-pullrow .gr-pullright{border-left:none;padding-left:0;border-top:1px solid var(--border);padding-top:14px}}' +
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
// ---- gems-by-core: two sections (Order, Chaos), each a 3-column grid (one core per
//      column: Sun / Moon / Star), each column listing its 4 gems as compact rows. ----
'  #tab-grader .gr-section{margin-top:18px}' +
'  #tab-grader .gr-section > .sh{display:flex;align-items:baseline;gap:10px;margin:0 0 10px}' +
'  #tab-grader .gr-section > .sh .st{font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--accent)}' +
'  #tab-grader .gr-section > .sh .ssub{font-size:11.5px;color:var(--dim);font-variant-numeric:tabular-nums}' +
'  #tab-grader .gr-cores{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}' +
'  @media(max-width:820px){#tab-grader .gr-cores{grid-template-columns:1fr}}' +
'  #tab-grader .gr-corecol{border:1px solid var(--border);border-radius:10px;background:var(--panel2);overflow:hidden;display:flex;flex-direction:column}' +
'  #tab-grader .gr-corecol > .ch{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:8px 11px;border-bottom:1px solid var(--border);background:var(--panel)}' +
'  #tab-grader .gr-corecol > .ch .cn{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--text)}' +
'  #tab-grader .gr-corecol > .ch .cd{font-size:10.5px;color:var(--accent);font-variant-numeric:tabular-nums;font-weight:700}' +
'  #tab-grader .gr-gem{display:grid;grid-template-columns:38px 1fr;gap:10px;align-items:center;padding:7px 11px;border-bottom:1px solid var(--border)}' +
'  #tab-grader .gr-corecol .gr-gem:last-child{border-bottom:none}' +
'  #tab-grader .gr-gem .rkbox{text-align:center;line-height:1}' +
'  #tab-grader .gr-gem .rkbox .gd{font-size:10px;color:var(--dim);font-variant-numeric:tabular-nums;margin-top:2px}' +
'  #tab-grader .gr-gem .rkbox .rk{font-size:18px;font-weight:800;line-height:1}' +
'  #tab-grader .gr-gem .meta{font-size:11.5px;line-height:1.4;min-width:0}' +
'  #tab-grader .gr-gem .meta .top{font-weight:700;color:var(--text);display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}' +
'  #tab-grader .gr-gem .meta .top .dmg{color:var(--accent);font-variant-numeric:tabular-nums;font-weight:700;margin-left:auto}' +
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
'  #tab-grader .gr-weak .wk-dmg{font-size:12px;color:var(--accent);font-variant-numeric:tabular-nums;font-weight:700;white-space:nowrap}' +
'  #tab-grader .gr-weak .wk-empty{font-size:12px;color:var(--dim);padding:6px 0}' +
'  #tab-grader .gr-weak .wk-row[data-target]{cursor:pointer;border-radius:6px;transition:background .12s}' +
'  #tab-grader .gr-weak .wk-row[data-target]:hover{background:rgba(255,255,255,.05)}' +
'  #tab-grader .gr-gem.flash{animation:grFlash 1.4s ease-out}' +
'  @keyframes grFlash{0%,35%{box-shadow:0 0 0 2px var(--accent),0 0 16px -2px var(--accent)}100%{box-shadow:0 0 0 0 rgba(0,0,0,0)}}' +
'  #tab-grader .mbtn:disabled{opacity:.45;cursor:not-allowed}' +
'  #tab-grader .gr-cache{display:inline-block;margin-left:10px;font-size:10px;font-weight:700;text-transform:none;letter-spacing:.02em;color:var(--dim);background:var(--panel2);border:1px solid var(--border);border-radius:99px;padding:2px 9px;vertical-align:middle}' +
'  #tab-grader .gr-cache.fresh{color:var(--good)}' +
// ---- saved-characters quick-pick (pull mode, right-side column) ----
'  #tab-grader .gr-favs{display:flex;align-items:flex-start;gap:7px;flex-wrap:wrap;margin:0}' +
'  #tab-grader .gr-favs .lab{display:block;width:100%;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);font-weight:700;margin:0 0 4px}' +
'  #tab-grader .gr-favs .gr-favbtn{display:inline-flex;align-items:center;gap:6px;background:var(--panel2);border:1px solid var(--border);border-radius:99px;padding:4px 11px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;color:var(--text);line-height:1.3}' +
'  #tab-grader .gr-favs .gr-favbtn:hover{border-color:var(--accent);color:var(--accent)}' +
'  #tab-grader .gr-favs .gr-favbtn .rg{font-size:9.5px;font-weight:700;color:var(--dim);text-transform:uppercase;letter-spacing:.04em;background:var(--panel);border:1px solid var(--border);border-radius:4px;padding:0 5px;line-height:1.6}' +
'  #tab-grader .gr-favs .gr-favbtn .st{color:var(--high)}' +
'  #tab-grader .gr-favs .gr-favempty{font-size:11px;color:var(--dim);font-style:italic}' +
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
'  #tab-grader .gr-plan-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:10px}' +
'  @media(max-width:680px){#tab-grader .gr-plan-grid{grid-template-columns:1fr}}' +
'  #tab-grader .gr-plan-card{border:1px solid var(--border);border-radius:10px;background:var(--panel2);overflow:hidden}' +
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
'  #tab-grader .gr-plan-legend{margin-top:12px;font-size:11px;color:var(--dim);display:flex;gap:14px;flex-wrap:wrap;align-items:center}' +
'  #tab-grader .gr-plan-legend .vpill{font-size:10px;padding:1px 8px}' +
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

// --- pull mode (inputs left · saved-character chips fill the right) ---
'    <div class="gr-modebody" id="gr-body-pull">' +
'      <div class="gr-pullrow">' +
'        <div class="gr-pullleft">' +
'          <div class="ig">' +
'            <div class="fld"><label>Region</label><select id="gr-region">' + opts(REGIONS, "NA") + '</select></div>' +
'            <div class="fld" style="grid-column:span 2"><label>Character name</label><input id="gr-name" type="text" placeholder="e.g. Paroxysmal" autocomplete="off"></div>' +
'          </div>' +
'          <div class="barrow">' +
'            <button class="primary" id="gr-pull-go" type="button">Grade loadout</button>' +
'            <button class="mbtn" id="gr-pull-refresh" type="button" style="display:none">Re-pull</button>' +
'            <span class="gr-status" id="gr-pull-status"></span>' +
'          </div>' +
'          <div class="note" id="gr-pull-note"></div>' +
'        </div>' +
'        <div class="gr-pullright"><div class="gr-favs" id="gr-favs"></div></div>' +
'      </div>' +
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

  // Compact single-row gem card: rank/grade badge + cost + order/willpower + the two
  // abbreviated effects. %dmg shown is damage ABOVE the cp baseline (relDamage);
  // grade/rank are unchanged. Keeps id="gr-gem-N" so Weakest-3 can jump to + flash it.
  function gemCardHtml(cfg) {
    var v = validateConfig(cfg);
    var g, rank, dmg, cls;
    if (v.valid) { g = grade(cfg); rank = gemRank(cfg); dmg = relDamage(cfg); cls = rankClass(rank); }
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
      return { gem: x, g: grade(x), dmg: relDamage(x) };
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
    var cdmg = 0; list.forEach(function (x) { if (validateConfig(x).valid) cdmg += relDamage(x); });
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
      list.forEach(function (x) { if (validateConfig(x).valid) tot += relDamage(x); });
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
  // verdict -> {cls, label}. Recipe/steer (fuse) is appended separately.
  var VERDICT_META = {
    "fuse": { cls: "vp-fuse", label: "Fuse" },
    "cut & reset": { cls: "vp-reset", label: "Cut & reset" },
    "cut": { cls: "vp-cut", label: "Cut" },
    "throw": { cls: "vp-throw", label: "Throw" }
  };

  function fmtGoldShort(g) {
    if (g == null || !isFinite(g)) return "—";
    g = Math.round(g);
    if (Math.abs(g) >= 1000000) { var m = (g / 1000000).toFixed(1).replace(/\.0$/, ""); return m + "M"; }
    if (Math.abs(g) >= 1000) { var k = (g / 1000).toFixed(Math.abs(g) >= 100000 ? 0 : 1).replace(/\.0$/, ""); return k + "k"; }
    return String(g);
  }

  function verdictPill(entry) {
    var meta = VERDICT_META[entry.verdict] || VERDICT_META["throw"];
    var inner = meta.label;
    if (entry.verdict === "fuse") {
      // UNOPENED fusion: you ADD 2 Uncommons to the gem you have (no arrow, no
      // Legendary/Relic/Ancient — those are the finished-gem tiers, a different thing).
      // addCost = the cost of the 2 Uncommons you add (UC holds its own cost; a Rare
      // steers its 2 added Uncommons toward addCost).
      var add = (entry.addCost != null) ? entry.addCost : entry.cost;
      inner += ' <span class="rcp">+ 2&times; ' + esc(add) + '-cost Uncommon</span>';
    }
    return '<span class="vpill ' + meta.cls + '">' + inner + '</span>';
  }

  // One side's card (ORDER or CHAOS) for advice `adv` (null => no gems of this type).
  function planCardHtml(title, base, adv) {
    var head = '<div class="hd"><span class="t">' + esc(title) + '</span>';
    if (base) {
      head += '<span class="bl">baseline <b>' + esc(base.baseRank) + '</b> '
        + '<span style="opacity:.75">(from your 3rd-lowest ' + esc(base.srcRank) + ' gem)</span></span>';
    }
    head += '</div>';

    if (!base) {
      return '<div class="gr-plan-card">' + head + '<div class="empty">No ' + esc(title.toLowerCase()) + ' gems in this loadout.</div></div>';
    }
    if (!adv) {
      return '<div class="gr-plan-card">' + head + '<div class="empty">Pipeline data unavailable.</div></div>';
    }

    var rows = '<table class="gr-ptab"><thead><tr>'
      + '<th>Gem</th><th>What to do</th><th class="r">Open value</th></tr></thead><tbody>';
    for (var i = 0; i < adv.plan.length; i++) {
      var e = adv.plan[i];
      rows += '<tr>'
        + '<td><span class="rar">' + esc(RAR_LABEL[e.rarity] || e.rarity) + ' <span class="c">' + e.cost + '-cost</span></span></td>'
        + '<td>' + verdictPill(e) + '</td>'
        + '<td class="r ov">' + fmtGoldShort(e.openValue) + '</td>'
        + '</tr>';
    }
    rows += '</tbody></table>';

    var boxList = (adv.boxes && adv.boxes.list) || [];
    var boxesHtml = '<div class="gr-boxes"><span class="bl">Boxes worth buying</span>';
    if (boxList.length) {
      boxesHtml += boxList.map(function (b) { return '<span class="box">' + esc(b) + '</span>'; }).join(" ");
    } else {
      boxesHtml += '<span class="none">none at this baseline / gpd</span>';
    }
    boxesHtml += '</div>';

    return '<div class="gr-plan-card">' + head + rows + boxesHtml + '</div>';
  }

  // The whole infographic (title + gpd selector + two baseline cards + legend).
  // `bases` = { order, chaos } from typeBaseline(); pipeline data must be ready.
  function planSectionHtml(bases) {
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
    var ready = (typeof window.pipelineAdvice === "function") && !!window.__grPipelineReady;
    var ordAdv = (ready && bases.order) ? window.pipelineAdvice(bases.order.baseGrade, grGpd, rgn) : null;
    var chaAdv = (ready && bases.chaos) ? window.pipelineAdvice(bases.chaos.baseGrade, grGpd, rgn) : null;

    var body;
    if (!ready) {
      body = '<div class="placeholder" id="gr-plan-cards" style="margin-top:10px"><b>Loading pipeline economics…</b>Computing what to cut, fuse, reset, or throw.</div>';
    } else {
      body = '<div class="gr-plan-grid" id="gr-plan-cards">'
        + planCardHtml("Order", bases.order, ordAdv)
        + planCardHtml("Chaos", bases.chaos, chaAdv)
        + '</div>';
    }

    var legend = '<div class="gr-plan-legend">'
      + '<span class="vpill vp-reset">Cut &amp; reset</span><span>open value ≥ 20k — cut, and reset if it lands low</span>'
      + '<span class="vpill vp-cut">Cut</span><span>open value &gt; 0</span>'
      + '<span class="vpill vp-fuse">Fuse</span><span>a rarity upgrade beats cutting</span>'
      + '<span class="vpill vp-throw">Throw</span><span>not worth cutting</span>'
      + '</div>';

    var econLabel = (rgn === "kr") ? "KR economy" : "NRB";
    return '<div class="gr-plan">'
      + '<h2>What to do with your astrogems '
      + '<span class="pl-sub">' + econLabel + ' · per-rarity action plan at your loadout’s baselines</span></h2>'
      + '<div class="gr-gpd"><span class="lab">Gold per 1% damage</span>' + gpdBtns + '</div>'
      + body
      + legend
      + '</div>';
  }

  // Recompute just the two cards (gpd change / pipeline-ready) without re-rendering
  // the whole loadout. Reads the cached loadout for the current baselines.
  function refreshPlanCards() {
    var host = document.getElementById("gr-plan-cards");
    if (!host) return;
    var gems = (lastLoadout && lastLoadout.gems) || [];
    var bases = { order: typeBaseline(gems, "order"), chaos: typeBaseline(gems, "chaos") };
    var ready = (typeof window.pipelineAdvice === "function") && !!window.__grPipelineReady;
    if (!ready) return;   // still loading; the ready-callback re-renders the section
    var rgn = planRegion(lastLoadout && lastLoadout.region);  // KR vs global plan
    var ordAdv = bases.order ? window.pipelineAdvice(bases.order.baseGrade, grGpd, rgn) : null;
    var chaAdv = bases.chaos ? window.pipelineAdvice(bases.chaos.baseGrade, grGpd, rgn) : null;
    var html = planCardHtml("Order", bases.order, ordAdv) + planCardHtml("Chaos", bases.chaos, chaAdv);
    // host may be the placeholder (a non-grid div) before data arrived; normalize.
    if (!host.classList.contains("gr-plan-grid")) {
      host.className = "gr-plan-grid";
      host.removeAttribute("style");
    }
    host.innerHTML = html;
  }

  // gpd selector handler (wired via inline onclick in planSectionHtml).
  window.__grSetGpd = function (g) {
    grGpd = g;
    var btns = document.querySelectorAll("#tab-grader .gr-gpd .gpd-btn");
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle("active", Number(btns[i].getAttribute("data-gpd")) === g);
    refreshPlanCards();
  };

  function renderLoadout(data) {
    var out = $("gr-result");
    var gems = (data && data.gems) || [];
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

    // overall summary over the VALID gems. %dmg is damage ABOVE the cp baseline
    // (relDamage); grade/rank are unchanged.
    var valid = gems.filter(function (x) { return validateConfig(x).valid; });
    var sumGrade = 0, sumDmg = 0;
    valid.forEach(function (x) { sumGrade += grade(x); sumDmg += relDamage(x); });
    var avgGrade = valid.length ? sumGrade / valid.length : 0;
    var avgRank = rankFromGrade(avgGrade);

    // Big lostark.bible-style profile header: class icon + large bold name, with region
    // / class / item level as secondary chips. KR (data.class == null) -> item level only.
    var metaChips = '<span class="gr-chip">' + esc(data.region || "") + '</span>';
    if (data.class) metaChips += '<span class="gr-chip">' + esc(data.class) + '</span>';
    if (data.itemLevel != null) metaChips += '<span class="gr-chip">ilvl <b>' + esc(Number(data.itemLevel).toLocaleString()) + '</b></span>';

    var html = '' +
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

    // "what to do with your astrogems": per-rarity action plan + boxes at the
    // ORDER/CHAOS baselines (3rd-lowest gem, bumped one rank up). Numbers come from
    // window.pipelineAdvice; the section paints a "loading…" placeholder first and
    // fills once pipelineReady fires (so it works even if Pipeline was never opened).
    var bases = { order: typeBaseline(gems, "order"), chaos: typeBaseline(gems, "chaos") };
    html += planSectionHtml(bases);

    // Gems by core, laid out as two sections (ORDER then CHAOS). Each section is a
    // 3-column grid: one column per core (Sun / Moon / Star), each column listing that
    // core's gems as compact stacked rows. Cores are grouped by slot, preserving first-
    // appearance order; the section a core belongs to is its gems' gemType.
    html += gemsByCoreHtml(gems);

    out.innerHTML = html;
    // Weakest-3 rows scroll to + flash their gem card
    Array.prototype.forEach.call(out.querySelectorAll(".wk-row[data-target]"), function (row) {
      row.addEventListener("click", function () { focusGem(row.getAttribute("data-target")); });
    });

    // Favorite star: toggles this loadout's character (region+name from lastLoadout).
    var star = $("gr-fav-star");
    if (star && Favs) {
      var favRegion = data.region, favName = data.name;
      paintStar(star, favRegion, favName);
      star.addEventListener("click", function () {
        var note = $("gr-fav-note");
        // Block the 13th add: if we'd be ADDING and the store is full, warn instead.
        if (!Favs.has(favRegion, favName) && Favs.isFull()) {
          if (note) { note.textContent = "max 12 favorites"; note.style.display = ""; }
          return;
        }
        Favs.toggle(favRegion, favName);          // persists + notifies (re-renders fav row)
        paintStar(star, favRegion, favName);
        if (note) { note.textContent = ""; note.style.display = "none"; }
      });
    } else if (star) {
      star.style.display = "none"; // Favorites store unavailable
    }

    // Ensure pipeline data is loaded, then (re)fill the action-plan cards. Marks a
    // global ready flag so re-renders/gpd changes can compute synchronously.
    if (typeof window.pipelineReady === "function") {
      window.pipelineReady(function () {
        window.__grPipelineReady = true;
        refreshPlanCards();
      });
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
    var html = '<span class="lab">Saved</span>';
    html += favs.map(function (f, i) {
      return '<button type="button" class="gr-favbtn" data-fi="' + i + '" title="Load ' +
        esc(f.name) + ' (' + esc(f.region) + ')">' +
        '<span class="st">&#9733;</span>' + esc(f.name) +
        '<span class="rg">' + esc(f.region) + '</span></button>';
    }).join("");
    host.innerHTML = html;
    Array.prototype.forEach.call(host.querySelectorAll(".gr-favbtn"), function (btn) {
      btn.addEventListener("click", function () {
        var f = favs[parseInt(btn.getAttribute("data-fi"), 10)];
        if (!f) return;
        if ($("gr-region")) {
          var r = String(f.region).toUpperCase();
          if (REGIONS.indexOf(r) !== -1) $("gr-region").value = r;
        }
        if ($("gr-name")) $("gr-name").value = f.name;
        var go = $("gr-pull-go");
        if (go) go.click(); // triggers the pull exactly like a manual Grade
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
    if (!custom) renderFavRow(); // refresh the saved-characters quick-pick row
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

    // first paint: open in "Pull from lostark.bible" mode (the primary mode). Custom
    // mode is fully wired above (effect lists built), one toggle-click away.
    selectMode("pull");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
