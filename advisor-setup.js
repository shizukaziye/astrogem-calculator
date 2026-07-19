/**
 * advisor-setup.js — the Advisor's top "who / market" section.
 *
 *   1 · Character (optional): search the cached roster (LoadoutEcon.fieldSnapshot)
 *       or tap a favorite (window.Favorites) → the section auto-fills:
 *         - axis (DPS/Support) via LoadoutEcon.defaultModeFor
 *         - baseline rank via LoadoutEcon.blanketBaseline over the character's gems
 *         - gold-per-1%-damage via combat power (LoadoutEcon.cpToGpd) from a
 *           per-character fetch (instant for cached records)
 *   2 · Market assumptions: axis toggle · the 8 gpd tier chips · the S/A/B/C/D
 *       rank-ladder baseline with ◀ ▶ (replaces the old raw %-damage input).
 *
 * Everything stays manually overridable; with no character selected the defaults are
 * gpd 1.5M, baseline B+ (grade 65 — gradeToScore(65) ≈ 1.0103, matching the advisor's
 * historical 1.0 default), axis DPS.
 *
 * API (window.AdvisorSetup):
 *   init(hostEl, { onChange })   render + wire; onChange fires after every mutation
 *   getMarket() -> {
 *     axis: "dps"|"support", gpd, baselineIdx, baselineGrade, baselineRank,
 *     baselineScore,                    // (sg2s|g2s)(baselineGrade) — ready for the DP
 *     character: {region,name,class,combatPower}|null,
 *     provenance: { gpdAuto, gpdNote, baseNote, shift }
 *   }
 */
(function (root) {
  "use strict";

  var Econ = root.LoadoutEcon;
  var A = root.Astrogem || root;

  // ---- state (module-singleton: the advisor has one setup section) ----
  var host = null, onChangeCb = null;
  var axis = "dps";
  // Advisor default: 10M gold per 1% damage (Shizu 2026-07-19 — endgame pricing;
  // the chip row still offers every tier, and combat-power auto-set overrides).
  // The choice isn't persisted, so the default IS the working value most sessions.
  var gpd = 10000000;
  var gpdAuto = false;             // true while the chip was set from combat power
  var baseIdx = 5;                 // GRADE_ROWS index; 5 = grade 65 = B+ (≈ the old 1.0 default)
  var baseShift = 0;               // manual ◀ ▶ offset vs the character-derived index
  var charSel = null;              // { region, name, class, gems, combatPower?, itemLevel? }
  var charStatus = "";             // status note under the selected-character line
  var searchRows = null;           // decoded snapshot (lazy)
  var searchOpen = false;
  var debounceT = null;

  function supportAxisAvailable() { return typeof root.supportGradeToScore === "function" || (A && typeof A.supportGradeToScore === "function"); }
  function g2s(grade) { return (A.gradeToScore || root.gradeToScore)(grade); }
  function sg2s(grade) { return (A.supportGradeToScore || root.supportGradeToScore)(grade); }
  function rankOf(grade) { return (A.rankFromGrade || root.rankFromGrade)(grade); }
  function rankColor(rank) { return (A.rankColor || root.Astrogem.rankColor)(rank); }
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

  function baselineGrade() { return Econ.GRADE_ROWS[baseIdx]; }
  function baselineScore() { return axis === "support" ? sg2s(baselineGrade()) : g2s(baselineGrade()); }

  // The character-derived baseline index (before the manual shift), or null.
  function charBaseIdx() {
    if (!charSel || !charSel.gems || !charSel.gems.length) return null;
    var b = Econ.blanketBaseline(charSel.gems, { axis: axis, shift: 0 });
    return b ? b.baseIdx : null;
  }
  function charBaseInfo() {
    if (!charSel || !charSel.gems || !charSel.gems.length) return null;
    return Econ.blanketBaseline(charSel.gems, { axis: axis, shift: 0 });
  }

  // Recompute baseIdx from the character (if any) + the manual shift.
  function applyBaseline() {
    var ci = charBaseIdx();
    var idx = (ci != null ? ci : 5) + baseShift;
    baseIdx = Math.max(0, Math.min(Econ.GRADE_ROWS.length - 1, idx));
  }

  function emit() { if (onChangeCb) try { onChangeCb(getMarket()); } catch (e) {} }

  function getMarket() {
    var info = charBaseInfo();
    var baseNote;
    if (info) {
      baseNote = "one rank above your stronger 3rd-lowest gem (" +
        (info.srcType === "chaos" ? "Chaos " : "Order ") + info.srcRank + ")" +
        (baseShift ? " (" + (baseShift > 0 ? "+" : "") + baseShift + " rank)" : "");
    } else {
      baseNote = "default — pick a character to auto-set" +
        (baseShift ? " (" + (baseShift > 0 ? "+" : "") + baseShift + " rank)" : "");
    }
    return {
      axis: axis,
      gpd: gpd,
      baselineIdx: baseIdx,
      baselineGrade: baselineGrade(),
      baselineRank: rankOf(baselineGrade()),
      baselineScore: baselineScore(),
      character: charSel ? { region: charSel.region, name: charSel.name, class: charSel.class || null, combatPower: charSel.combatPower != null ? charSel.combatPower : null } : null,
      provenance: { gpdAuto: gpdAuto, gpdNote: gpdNoteText(), baseNote: baseNote, shift: baseShift }
    };
  }

  // ---- gpd provenance (same composition as the Grader's note) ----
  function gpdNoteText() {
    if (!charSel) return "";
    var parts = [];
    var cpG = Econ.cpToGpd(charSel.combatPower);
    if (cpG && gpdAuto) {
      parts.push("auto-set " + Econ.gpdLabel(cpG) + " from combat power " + Number(charSel.combatPower).toLocaleString("en-US"));
      var accG = Econ.accessoriesImpliedGpd(charSel.accessories, axis);
      if (accG && Math.abs(Econ.GPD_TIERS.indexOf(accG) - Econ.GPD_TIERS.indexOf(cpG)) >= 2) {
        parts.push("⚠ accessories look closer to " + Econ.gpdLabel(accG));
      }
      var floorG = Econ.gemsImpliedFloor(charSel.classicGemLevels);
      if (floorG && floorG > cpG) parts.push("⚠ gems suggest at least " + Econ.gpdLabel(floorG));
    } else if (charSel._fetched && charSel.combatPower == null) {
      parts.push("no combat power in this record — set the tier manually");
    }
    return parts.join(" · ");
  }

  // ---- character selection flow ----
  function selectCharacter(row) {
    charSel = { region: row.region, name: row.name, class: row.class || null, gems: row.gems || [] };
    charStatus = "";
    baseShift = 0;
    // Instant: axis + baseline from the snapshot gems.
    axis = supportAxisAvailable() ? Econ.defaultModeFor({ class: row.class, gems: row.gems }) : "dps";
    applyBaseline();
    render(); emit();
    // Async enrich: the per-character record (combat power etc.). Cached = instant.
    charStatus = "fetching record…";
    renderStatus();
    Econ.fetchCharacter(row.region, row.name).then(function (r) {
      if (!charSel || charSel.name !== row.name || charSel.region !== row.region) return; // superseded
      var d = (r && r.data) || {};
      charSel._fetched = true;
      if (Array.isArray(d.gems) && d.gems.length) {
        charSel.gems = d.gems;                                  // authoritative over the snapshot
        charSel.class = d.class || charSel.class;
        charSel.itemLevel = d.itemLevel;
        charSel.combatPower = d.combatPower != null ? d.combatPower : null;
        charSel.accessories = d.accessories || null;
        charSel.classicGemLevels = d.classicGemLevels || null;
        axis = supportAxisAvailable() ? Econ.defaultModeFor({ class: charSel.class, gems: charSel.gems }) : "dps";
        var cpG = Econ.cpToGpd(charSel.combatPower);
        if (cpG) { gpd = cpG; gpdAuto = true; }
        applyBaseline();
        charStatus = "";
      } else if (d.queued) {
        charStatus = "not cached yet — queued (position " + (d.position || "?") + "). Values stay manual until fetched.";
      } else {
        charStatus = (d.error ? String(d.error).slice(0, 90) : "no record — using manual values.");
      }
      render(); emit();
    }).catch(function () {
      if (!charSel) return;
      charSel._fetched = true;
      charStatus = "couldn't reach the worker — set the tier and baseline manually.";
      render(); emit();
    });
  }

  function clearCharacter() {
    charSel = null; charStatus = ""; baseShift = 0; gpdAuto = false;
    axis = "dps"; gpd = Econ.GPD_DEFAULT;
    applyBaseline();
    render(); emit();
  }

  // ---- markup ----
  function css() {
    return '<style>' +
      '#av-setup .avs-searchwrap{position:relative;flex:1;min-width:220px}' +
      '#av-setup .avs-search{width:100%;background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 30px 8px 10px;font:14px inherit}' +
      '#av-setup .avs-clear{position:absolute;right:6px;top:50%;transform:translateY(-50%);background:none;border:0;color:var(--dim);cursor:pointer;font-size:15px;padding:2px 5px}' +
      '#av-setup .avs-results{position:absolute;z-index:40;left:0;right:0;top:calc(100% + 4px);background:var(--panel2);border:1px solid var(--border);border-radius:8px;max-height:290px;overflow:auto;box-shadow:0 8px 22px rgba(0,0,0,.45)}' +
      '#av-setup .avs-row{display:flex;gap:8px;align-items:center;width:100%;text-align:left;background:none;border:0;border-bottom:1px solid var(--border);color:var(--text);padding:7px 10px;cursor:pointer;font:13px inherit}' +
      '#av-setup .avs-row:hover{background:rgba(102,199,255,.08)}' +
      '#av-setup .avs-row .rg{font-size:10px;font-weight:700;letter-spacing:.05em;background:var(--panel);border:1px solid var(--border);border-radius:5px;padding:1px 5px;color:var(--dim)}' +
      '#av-setup .avs-row .cl{color:var(--dim);font-size:12px}' +
      '#av-setup .avs-row .il{margin-left:auto;color:var(--dim);font-size:11px;font-variant-numeric:tabular-nums}' +
      '#av-setup .avs-more{padding:6px 10px;color:var(--dim);font-size:11px}' +
      '#av-setup .avs-favs{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}' +
      '#av-setup .avs-fav{display:inline-flex;gap:6px;align-items:center;background:var(--panel2);border:1px solid var(--border);border-radius:99px;padding:4px 11px;color:var(--text);cursor:pointer;font:12px inherit}' +
      '#av-setup .avs-fav:hover{border-color:var(--accent)}' +
      '#av-setup .avs-fav .st{color:var(--high)}' +
      '#av-setup .avs-fav .rg{color:var(--dim);font-size:10px}' +
      '#av-setup .avs-sel{margin-top:8px;font-size:13px}' +
      '#av-setup .avs-sel .nm{font-weight:700}' +
      '#av-setup .avs-sel .meta{color:var(--dim)}' +
      '#av-setup .avs-status{color:var(--dim);font-size:12px;margin-top:3px;min-height:14px}' +
      '#av-setup .avs-rowline{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0}' +
      // slimmer gpd chips so all 8 tiers (incl. 10M) hold one row at usual widths
      '#av-setup .avs-gpd{padding:6px 10px}' +
      '#av-setup .avs-rowline .lab{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);font-weight:700;min-width:120px}' +
      '#av-setup .avs-note{font-size:11px;color:var(--dim);margin:2px 0 6px 0}' +
      '#av-setup .avs-note .warn{color:#e8b84a;font-weight:600}' +
      '#av-setup .rank-badge{display:inline-block;padding:2px 10px;border-radius:99px;font-weight:800;font-size:14px;font-variant-numeric:tabular-nums}' +
      '#av-setup .avs-arrow{background:var(--panel2);border:1px solid var(--border);border-radius:7px;color:var(--text);cursor:pointer;padding:3px 9px;font-size:12px}' +
      '#av-setup .avs-arrow:disabled{opacity:.35;cursor:default}' +
      '</style>';
  }

  function rankBadge(rank) {
    var c = rankColor(rank);
    return '<span class="rank-badge" style="background:' + c.bg + ';color:' + c.fg + '">' + esc(rank) + '</span>';
  }

  function render() {
    if (!host) return;
    var canSupport = supportAxisAvailable();
    var selHtml = "";
    if (charSel) {
      selHtml = '<div class="avs-sel">★ <span class="nm">' + esc(charSel.name) + '</span> ' +
        '<span class="meta">(' + esc(charSel.region) + (charSel.class ? " · " + esc(charSel.class) : "") +
        (charSel.itemLevel != null ? " · ilvl " + Number(charSel.itemLevel).toLocaleString() : "") +
        (charSel.combatPower != null ? " · CP " + Number(charSel.combatPower).toLocaleString("en-US") : "") + ')</span></div>';
    }
    var gpdChips = Econ.GPD_TIERS.map(function (g) {
      return '<button type="button" class="mbtn avs-gpd' + (g === gpd ? " active" : "") + '" data-gpd="' + g + '">' + Econ.gpdLabel(g) + '</button>';
    }).join("");
    var gnote = gpdNoteText();
    var m = getMarket();

    host.innerHTML = css() +
      '<div class="subh">Character (optional)</div>' +
      '<div class="avs-rowline">' +
      '  <span class="avs-searchwrap">' +
      '    <input id="avs-search" class="avs-search" type="search" placeholder="Search ' + (searchRows ? searchRows.length.toLocaleString() : "9,500+") + ' graded characters…" autocomplete="off">' +
      (charSel ? '<button type="button" id="avs-clear" class="avs-clear" title="Clear character">×</button>' : "") +
      '    <div id="avs-results" class="avs-results" style="display:none"></div>' +
      '  </span>' +
      '</div>' +
      '<div id="avs-favs" class="avs-favs"></div>' +
      selHtml +
      '<div id="avs-status" class="avs-status">' + esc(charStatus) + '</div>' +
      '<div class="subh">Market assumptions</div>' +
      (canSupport
        ? '<div class="avs-rowline"><span class="lab">Axis</span>' +
          '<button type="button" class="mbtn avs-axis' + (axis === "dps" ? " active" : "") + '" data-axis="dps">DPS</button>' +
          '<button type="button" class="mbtn avs-axis' + (axis === "support" ? " active" : "") + '" data-axis="support">Support</button>' +
          '</div>'
        : "") +
      '<div class="avs-rowline"><span class="lab">Gold / 1% DMG</span>' + gpdChips + '</div>' +
      (gnote ? '<div class="avs-note">' + gnote.replace(/⚠ [^·]+/g, function (w) { return '<span class="warn">' + esc(w.trim()) + '</span>'; }) + '</div>' : "") +
      '<div class="avs-rowline"><span class="lab">Baseline</span>' +
      '  <button type="button" id="avs-base-dn" class="avs-arrow"' + (baseIdx <= 0 ? " disabled" : "") + '>&#9664;</button>' +
      rankBadge(m.baselineRank) +
      '  <button type="button" id="avs-base-up" class="avs-arrow"' + (baseIdx >= Econ.GRADE_ROWS.length - 1 ? " disabled" : "") + '>&#9654;</button>' +
      '  <span class="avs-note" style="margin:0">' + esc(m.provenance.baseNote) + '</span>' +
      '</div>';

    renderFavs();
    wire();
  }

  function renderStatus() {
    var el = host && host.querySelector("#avs-status");
    if (el) el.textContent = charStatus;
  }

  function renderFavs() {
    var el = host.querySelector("#avs-favs");
    if (!el) return;
    var Favs = root.Favorites;
    var list = (Favs && Favs.list()) || [];
    if (!list.length) { el.innerHTML = ""; return; }
    el.innerHTML = list.map(function (f, i) {
      return '<button type="button" class="avs-fav" data-fi="' + i + '"><span class="st">★</span>' +
        '<span>' + esc(f.name) + '</span><span class="rg">' + esc(f.region) + '</span></button>';
    }).join("");
  }

  // ---- search ----
  function ensureRows() {
    if (searchRows || !Econ) return Promise.resolve(searchRows);
    return Econ.fieldSnapshot().then(function (rows) {
      searchRows = rows || [];
      var inp = host && host.querySelector("#avs-search");
      if (inp && searchRows.length) inp.placeholder = "Search " + searchRows.length.toLocaleString() + " graded characters…";
      if (inp && !searchRows.length) inp.placeholder = "Character list unavailable — favorites & manual entry still work";
      return searchRows;
    });
  }

  function runSearch(q) {
    var box = host.querySelector("#avs-results");
    if (!box) return;
    q = (q || "").trim().toLowerCase();
    if (!q || !searchRows || !searchRows.length) { box.style.display = "none"; searchOpen = false; return; }
    var hits = [];
    for (var i = 0; i < searchRows.length && hits.length < 200; i++) {
      var c = searchRows[i];
      if ((c.name || "").toLowerCase().indexOf(q) !== -1) hits.push(c);
    }
    var top = hits.slice(0, 12);
    box.innerHTML = top.map(function (c, i) {
      return '<button type="button" class="avs-row" data-ri="' + i + '">' +
        '<span>' + esc(c.name) + '</span><span class="rg">' + esc(c.region) + '</span>' +
        (c.class ? '<span class="cl">' + esc(c.class) + '</span>' : "") +
        '</button>';
    }).join("") + (hits.length > 12 ? '<div class="avs-more">…and ' + (hits.length - 12) + ' more — keep typing</div>' : "") +
      (top.length === 0 ? '<div class="avs-more">no matches</div>' : "");
    box.style.display = "block";
    searchOpen = true;
    box._hits = top;
  }

  // ---- event wiring (onclick assignment on the persistent host — no stacking) ----
  function wire() {
    var inp = host.querySelector("#avs-search");
    if (inp) {
      inp.onfocus = function () { ensureRows(); };
      inp.oninput = function () {
        clearTimeout(debounceT);
        var v = inp.value;
        debounceT = setTimeout(function () { ensureRows().then(function () { runSearch(v); }); }, 200);
      };
    }
    host.onclick = function (ev) {
      var t = ev.target;
      var row = t.closest ? t.closest(".avs-row") : null;
      if (row) {
        var box = host.querySelector("#avs-results");
        var hit = box && box._hits && box._hits[parseInt(row.getAttribute("data-ri"), 10)];
        if (hit) { box.style.display = "none"; searchOpen = false; selectCharacter(hit); }
        return;
      }
      var fav = t.closest ? t.closest(".avs-fav") : null;
      if (fav) {
        var list = (root.Favorites && root.Favorites.list()) || [];
        var f = list[parseInt(fav.getAttribute("data-fi"), 10)];
        // Favorites may be absent from the snapshot — fetch-only selection still works.
        if (f) selectCharacter({ region: f.region, name: f.name, class: null, gems: [] });
        return;
      }
      if (t.id === "avs-clear") { clearCharacter(); return; }
      if (t.classList && t.classList.contains("avs-gpd")) {
        gpd = parseInt(t.getAttribute("data-gpd"), 10);
        gpdAuto = false;                       // manual click clears the auto flag
        render(); emit(); return;
      }
      if (t.classList && t.classList.contains("avs-axis")) {
        var ax = t.getAttribute("data-axis");
        if (ax !== axis) { axis = ax === "support" ? "support" : "dps"; applyBaseline(); render(); emit(); }
        return;
      }
      if (t.id === "avs-base-dn" || t.id === "avs-base-up") {
        var d = t.id === "avs-base-up" ? 1 : -1;
        var ci = charBaseIdx();
        var cur = baseIdx;
        var want = Math.max(0, Math.min(Econ.GRADE_ROWS.length - 1, cur + d));
        baseShift += (want - cur);
        if (ci == null) baseShift = want - 5;  // manual mode: shift is relative to the B+ default
        applyBaseline();
        render(); emit(); return;
      }
      // click elsewhere closes the dropdown
      if (searchOpen && !(t.closest && t.closest(".avs-searchwrap"))) {
        var b = host.querySelector("#avs-results");
        if (b) b.style.display = "none";
        searchOpen = false;
      }
    };
  }

  // ---- public API ----
  var API = {
    init: function (hostEl, opts) {
      host = hostEl;
      onChangeCb = (opts && opts.onChange) || null;
      if (root.Favorites && root.Favorites.onChange) root.Favorites.onChange(function () { renderFavs(); });
      applyBaseline();
      render();
      emit();
    },
    getMarket: getMarket
  };
  root.AdvisorSetup = API;
})(typeof window !== "undefined" ? window : this);
