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
  // Support shows the per-ALLY party-damage %: supportRelValue has the ×3 (3 DPS in the
  // party) baked in for grading/gold, so divide by 3 for the human-facing display number.
  function gRel(cfg) { return isSupport() ? supportRelValue(cfg) / 3 : relDamage(cfg); }

  // Support classes that CAN play support (gate for the support-default auto-detect).
  var SUPPORT_CLASSES = { Bard: 1, Paladin: 1, Artist: 1, Valkyrie: 1 };
  var SUPPORT_EFFECTS = { "Ally Attack Enh.": 1, "Brand Power": 1, "Ally Damage Enh.": 1 };
  var DPS_EFFECTS = { "Attack Power": 1, "Additional Damage": 1, "Boss Damage": 1 };

  // A loadout is "support-dominant" if, summed across every gem, the levels on support
  // effects CLEARLY outweigh the DPS-effect levels (>= 2x). A real support runs almost no
  // DPS gems (observed ~3.6-3.9x), while a hybrid / DPS-built valkyrie sits near parity
  // (~1.3x), so a 2x gate separates them and keeps mixed builds defaulting to DPS.
  function supportDominant(gems) {
    var sup = 0, dps = 0;
    (gems || []).forEach(function (x) {
      [["effect1", "effect1Level"], ["effect2", "effect2Level"]].forEach(function (p) {
        var name = x[p[0]], lv = x[p[1]] || 0;
        if (SUPPORT_EFFECTS[name]) sup += lv;
        else if (DPS_EFFECTS[name]) dps += lv;
      });
    });
    return sup > 0 && sup >= dps * 2;
  }

  // The DEFAULT grading mode for a freshly-pulled loadout: Support iff a support class
  // AND a support-dominant gem set (and the support axis exists); otherwise DPS.
  function defaultModeFor(data) {
    if (!supportAxisAvailable()) return "dps";
    var cls = data && data.class;
    var gems = (data && data.gems) || [];
    if (cls && SUPPORT_CLASSES[cls] && supportDominant(gems)) return "support";
    return "dps";
  }

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
  // The Pipeline tab bakes one DP solve per these 12 anchor grades; each maps 1:1
  // to a distinct rank (C- … S+), so the array IS a clean rank ladder. We mirror it
  // here so a gem's rank can be "bumped one rank up" by stepping to the next index.
  var GRADE_ROWS = [52, 57, 62, 66, 70, 73, 77, 80, 83, 87, 92, 97];
  // gpd tiers offered by the selector (must match gpdsInData() in pipeline.json).
  var GPD_TIERS = [500000, 1000000, 1500000, 2500000, 3500000, 5000000, 7500000, 10000000];
  var GPD_DEFAULT = 1500000;
  var grGpd = GPD_DEFAULT;           // currently-selected gpd for the infographic
  // Manual ±rank nudge applied to the ONE blanket baseline via the ◀ ▶ arrows. Reset to
  // 0 on every fresh loadout render; clamped so the final baseline index stays in range.
  var grBaseShift = 0;

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

  // GRADE_ROWS index of an anchor grade (exact match, else nearest by value).
  function gradeRowIdx(g) {
    var i = GRADE_ROWS.indexOf(g);
    if (i !== -1) return i;
    var best = 0, bd = Infinity;
    for (var k = 0; k < GRADE_ROWS.length; k++) {
      var d = Math.abs(GRADE_ROWS[k] - g);
      if (d < bd) { bd = d; best = k; }
    }
    return best;
  }

  // ONE blanket baseline for the whole loadout (NOT per Order/Chaos). Take the 3rd-lowest
  // -grade gem of EACH type (typeBaseline.srcGrade), keep the STRONGER (higher-grade) of
  // the two, bump it one rank up — then apply the manual ◀▶ shift (grBaseShift), clamped
  // to GRADE_ROWS. Returns null only if the loadout has no valid gems at all.
  //   { srcGrade, srcRank, srcType, baseIdx, baseGrade, baseRank,
  //     shift, atMin, atMax, order, chaos }
  function blanketBaseline(gems) {
    var bo = typeBaseline(gems, "order");
    var bc = typeBaseline(gems, "chaos");
    if (!bo && !bc) return null;
    // stronger SOURCE gem across the two types (ties -> order, arbitrary but stable)
    var src, srcType;
    if (bo && (!bc || bo.srcGrade >= bc.srcGrade)) { src = bo.srcGrade; srcType = "order"; }
    else { src = bc.srcGrade; srcType = "chaos"; }
    var bumped = bumpedBaselineGrade(src);               // one rank above the stronger source
    var idx = gradeRowIdx(bumped);
    var shifted = Math.max(0, Math.min(GRADE_ROWS.length - 1, idx + grBaseShift));
    var baseGrade = GRADE_ROWS[shifted];
    return {
      srcGrade: src, srcRank: rankFromGrade(src), srcType: srcType,
      baseIdx: shifted, baseGrade: baseGrade, baseRank: rankFromGrade(baseGrade),
      shift: grBaseShift, atMin: shifted <= 0, atMax: shifted >= GRADE_ROWS.length - 1,
      order: bo, chaos: bc
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
'  #tab-grader.axis-dps{--axis:#f3a59c}' +
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

    var boxList = (adv.boxes && adv.boxes.list) || [];
    var boxesHtml = '<div class="gr-boxes"><span class="bl">Boxes worth buying</span>';
    if (boxList.length) {
      boxesHtml += boxList.map(function (b) { return '<span class="box">' + esc(b) + '</span>'; }).join(" ");
    } else {
      boxesHtml += '<span class="none">none at this baseline / gpd</span>';
    }
    boxesHtml += '</div>';

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
    var ready = (typeof window.pipelineAdvice === "function") && !!window.__grPipelineReady;
    var adv = (ready && base) ? window.pipelineAdvice(base.baseGrade, grGpd, rgn) : null;

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

    var econLabel = (rgn === "kr") ? "KR economy" : "NRB";
    return '<div class="gr-plan">'
      + '<h2>What to do with your astrogems '
      + '<span class="pl-sub">' + econLabel + ' · per-effect-pair action plan at your loadout’s baseline</span></h2>'
      + '<div class="gr-baseline-host" id="gr-baseline-host">' + baselineHeadHtml(base) + '</div>'
      + '<div class="gr-gpd"><span class="lab">Gold per 1% damage</span>' + gpdBtns + '</div>'
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
    var ready = (typeof window.pipelineAdvice === "function") && !!window.__grPipelineReady;
    if (!ready || !base) return;   // still loading / no gems; ready-callback re-renders
    var rgn = planRegion(lastLoadout && lastLoadout.region);  // KR vs global plan
    var adv = window.pipelineAdvice(base.baseGrade, grGpd, rgn);
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

  function renderLoadout(data) {
    applyAxisTheme();
    var out = $("gr-result");
    var gems = activeGems(data);
    grBaseShift = 0;   // fresh loadout: drop any manual ◀▶ baseline nudge from the last one
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
    var sumGrade = 0, sumDmg = 0;
    valid.forEach(function (x) { sumGrade += gGrade(x); sumDmg += gRel(x); });
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
'    <div class="stat"><span class="k">' + totalLabel + '</span><span class="v" style="color:var(--axis,var(--accent))">' + sumDmg.toFixed(2) + '%</span></div>' +
'  </div>';
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
    // (so it works even if Pipeline was never opened).
    // Support mode: the cut/fuse plan is DPS cut-EV math, so it's hidden entirely (and
    // window.pipelineAdvice is NOT called) — a short note stands in its place instead.
    if (sup) {
      html += '<div class="gr-plan-note">Cut / fuse planning is DPS-only for now.</div>';
    } else {
      html += planSectionHtml(blanketBaseline(gems));
    }

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

    // Ensure pipeline data is loaded, then (re)fill the action-plan cards. Marks a
    // global ready flag so re-renders/gpd changes can compute synchronously. Skipped in
    // support mode — the cut/fuse infographic isn't shown there (DPS-only).
    if (!sup && typeof window.pipelineReady === "function") {
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

    setPullStatus((refresh ? "Re-pulling " : "Fetching ") + name + " (" + region + ")…", "working");
    $("gr-pull-go").disabled = true;
    var refreshBtn = $("gr-pull-refresh");
    if (refreshBtn) refreshBtn.disabled = true;

    var k = (window.astrogemGate && window.astrogemGate.token && window.astrogemGate.token()) || "";
    var url = WORKER_URL.replace(/\/+$/, "") +
      "/?region=" + encodeURIComponent(region) + "&name=" + encodeURIComponent(name) +
      (refresh ? "&refresh=1" : "") +
      (k ? "&k=" + encodeURIComponent(k) : "");
    var pendingCountdownMs = 0;
    fetch(url).then(function (resp) {
      return resp.json().then(function (data) { return { ok: resp.ok, data: data }; });
    }).then(function (r) {
      var d = r.data || {};
      if (!r.ok || (d.error && !d.gems)) {
        var msg = d.error || "Worker returned an error.";
        setPullStatus(msg, "err");
        $("gr-result").innerHTML = '<div class="panel"><div class="gr-status err">' + esc(msg) + '</div></div>';
        if (d.rateLimited && d.retryAfterMs) pendingCountdownMs = d.retryAfterMs; // throttled -> pace the button
        if (d.hourlyLimit) setFreeStatus(0);
        if (d.premium) { pendingCountdownMs = d.nextMs || 5000; setFreeStatus(null, true); }
        else if (d.free) { pendingCountdownMs = d.nextMs || 60000; setFreeStatus(d.remaining); } // slot consumed even on a fetch error
        return;
      }
      lastLoadout = r.data;
      grPreset = "raid"; // a fresh pull always starts on the raid preset
      grMode = defaultModeFor(r.data); // auto-default DPS/Support for this fresh loadout
      setPullStatus("Graded " + ((r.data.gems || []).length) + " gems.", "");
      if (refreshBtn) refreshBtn.style.display = "";
      renderLoadout(r.data);
      if (d.premium) { pendingCountdownMs = d.nextMs || 5000; setFreeStatus(null, true); } // password: ~5s pacing
      else if (d.free) { pendingCountdownMs = d.nextMs || 60000; setFreeStatus(d.remaining); } // free tier: 1/min + X/10
    }).catch(function (e) {
      setPullStatus("Request failed: " + (e && e.message || e), "err");
    }).then(function () {
      if (pendingCountdownMs > 0) startCountdown(pendingCountdownMs);
      else { $("gr-pull-go").disabled = false; if (refreshBtn) refreshBtn.disabled = false; }
    });
  }

  // ---------------- free-tier pacing + status ----------------
  // After a free (non-password) pull, disable the pull buttons for `ms` and tick down a
  // countdown on the button label, so a free user is paced to the Worker's 1-per-10s rate.
  var grCountdownTimer = null;
  function startCountdown(ms) {
    var go = $("gr-pull-go"), rb = $("gr-pull-refresh");
    if (!go) return;
    if (grCountdownTimer) { clearInterval(grCountdownTimer); grCountdownTimer = null; }
    var until = Date.now() + ms;
    go.disabled = true; if (rb) rb.disabled = true;
    function tick() {
      var left = Math.ceil((until - Date.now()) / 1000);
      if (left <= 0) {
        clearInterval(grCountdownTimer); grCountdownTimer = null;
        go.disabled = false; if (rb) rb.disabled = false;
        go.textContent = "Grade loadout";
        return;
      }
      go.textContent = "Wait " + left + "s…";
    }
    tick();
    grCountdownTimer = setInterval(tick, 250);
  }

  // The "X/5 free pulls left today" note under the pull buttons (hidden for password-holders,
  // who are unlimited). Pass a number to update the remembered count; call with none to re-render.
  var grFreeRemaining = null;
  function setFreeStatus(remaining, premium) {
    if (typeof remaining === "number") grFreeRemaining = remaining;
    var el = $("gr-free-note");
    if (!el) return;
    if (premium || (window.astrogemGate && window.astrogemGate.isUnlocked())) {
      el.innerHTML = '<span class="gr-prem">&#10003; Password access · paced 1 pull / 5s</span>';
      return;
    }
    var left = (grFreeRemaining == null) ? 10 : grFreeRemaining;
    var head = (left <= 0)
      ? '<span class="gr-cap">Free hourly limit reached (10/hour).</span> Try again shortly'
      : '<b>' + left + '</b> of 10 free pulls left this hour · 1 per minute';
    el.innerHTML = head + ' · <a class="gr-unlock" onclick="window.__grUnlock()">Have the password? Unlock for faster access &rarr;</a>';
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
      grPreset = "raid"; // a fresh loadout always starts on the raid preset
      grMode = defaultModeFor(charData); // auto-default DPS/Support for this loadout
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
