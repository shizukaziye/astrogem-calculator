/**
 * leaderboard.js — the "Leaderboard" tab (the 4th tab, after Advisor): ranks every
 * character that has been pulled into the lostark.bible Worker's KV cache.
 *
 * On first activation it fetches the Worker's `?list=1` endpoint (every stored
 * character: { region, name, gems, pulledAt }). For each character it computes the
 * average grade — the mean of Astrogem.grade(gem) over that character's VALID gems —
 * sorts the characters descending by that average, and renders a ranked table:
 *
 *   rank #  ·  name + region  ·  avg grade as a colored rank badge  ·  gem count  ·  last-pulled age.
 *
 * Clicking a row switches to the Grader tab and renders that loadout via the public
 * hook window.graderShowLoadout(charData) (exposed by grader.js) — no re-fetch.
 *
 * Degrades gracefully: an empty list (no characters stored yet, or the Worker has no
 * KV) shows an empty-state message; an unconfigured Worker / network error shows a
 * note rather than throwing. Uses the SAME WORKER_URL as grader.js.
 *
 * Model API used (window.Astrogem, never modified): grade, rankFromGrade, rankColor,
 * validateConfig.
 */
(function () {
  "use strict";

  // Same deployed Worker as grader.js (kept in sync by hand). Empty string disables
  // the live fetch; the tab then shows the unconfigured note.
  var WORKER_URL = "https://astrogem-bible.shizukaziye.workers.dev";

  var A = (typeof window !== "undefined" && window.Astrogem) || null;
  function grade(cfg) { return A ? A.grade(cfg) : window.grade(cfg); }
  function rankFromGrade(g) { return A ? A.rankFromGrade(g) : window.rankFromGrade(g); }
  function rankColorOf(rank) {
    return (A && A.rankColor) ? A.rankColor(rank)
      : (typeof window.rankColor === "function" ? window.rankColor(rank) : { bg: "#6f747a", fg: "#fff" });
  }
  function validateConfig(cfg) {
    var fn = (A && A.validateConfig) || window.validateConfig;
    return fn ? fn(cfg) : { valid: true };
  }
  function relDamage(cfg) {
    var fn = (A && A.relDamage) || window.relDamage;
    return fn ? fn(cfg) : 0;
  }
  // ---- support-axis accessors (mirror the DPS ones above) ----
  function supportGrade(cfg) {
    var fn = (A && A.supportGrade) || window.supportGrade;
    return fn ? fn(cfg) : 0;
  }
  function supportRelValue(cfg) {
    var fn = (A && A.supportRelValue) || window.supportRelValue;
    return fn ? fn(cfg) : 0;
  }

  var Favs = (typeof window !== "undefined" && window.Favorites) || null;
  var allChars = [];   // the full ranked list (each tagged with _rank = overall #)
  var rawChars = [];   // every character as fetched (unfiltered, unsorted by mode)
  var regions = { NA: true, EU: true, KR: true };  // region filter chips (all on; click to toggle off)
  var MIN_GRADE = 65;  // hide anything ranked C+ or below — B- starts at grade 65
  var mode = "dps";    // "dps" | "support" — which leaderboard is shown
  var page = 1;        // 1-based current page of the main (paginated) table
  var PAGE_SIZE = 100; // max rows per page of the All-characters table

  // The four SUPPORT classes — Support mode keeps ALL characters of these classes
  // (even DPS-built ones), filtered by c.class, never by build.
  var SUPPORT_CLASSES = { "Bard": 1, "Paladin": 1, "Artist": 1, "Valkyrie": 1 };
  function isSupportClass(c) { return !!(c && c.class && SUPPORT_CLASSES[c.class]); }

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

  // Class-icon files live in assets/class-icons/<ClassName>.svg (extracted from
  // lostark.bible's class silhouettes — see assets note). Repo-relative paths so
  // GitHub Pages serves them. Keys are the English class names the Worker returns.
  // SVGs use fill="currentColor", so they inherit the cell's text color.
  var CLASS_ICON = {
    "Berserker": "Berserker.svg",
    "Destroyer": "Destroyer.svg",
    "Gunlancer": "Gunlancer.svg",
    "Paladin": "Paladin.svg",
    "Slayer": "Slayer.svg",
    "Valkyrie": "Valkyrie.svg",
    "Artist": "Artist.svg",
    "Arcanist": "Arcanist.svg",
    "Summoner": "Summoner.svg",
    "Bard": "Bard.svg",
    "Sorceress": "Sorceress.svg",
    "Wardancer": "Wardancer.svg",
    "Scrapper": "Scrapper.svg",
    "Soulfist": "Soulfist.svg",
    "Glaivier": "Glaivier.svg",
    "Striker": "Striker.svg",
    "Breaker": "Breaker.svg",
    "Deathblade": "Deathblade.svg",
    "Shadowhunter": "Shadowhunter.svg",
    "Reaper": "Reaper.svg",
    "Souleater": "Souleater.svg",
    "Sharpshooter": "Sharpshooter.svg",
    "Deadeye": "Deadeye.svg",
    "Artillerist": "Artillerist.svg",
    "Machinist": "Machinist.svg",
    "Gunslinger": "Gunslinger.svg",
    "Aeromancer": "Aeromancer.svg",
    "Wildsoul": "Wildsoul.svg",
    "Guardianknight": "Guardianknight.svg"
  };

  // Class ICON only (no name) — shown at the START of the Character cell, just before
  // the name link. Empty string when the character has no class (KR characters:
  // c.class === null) or we have no icon file for it, so the name shows alone.
  // Graceful: a missing icon file degrades away (onerror hides the <img>).
  function classIcon(className) {
    if (!className) return '';
    var file = CLASS_ICON[className];
    if (!file) return '';
    return '<img class="lb-class-icon" width="20" height="20" src="assets/class-icons/' + encodeURIComponent(file) +
      '" alt="" aria-hidden="true" loading="lazy" onerror="this.style.display=\'none\'">';
  }

  function rankBadge(rank) {
    var c = rankColorOf(rank);
    return '<span class="lb-badge" style="background:' + c.bg + ';color:' + c.fg + '">' + esc(rank) + '</span>';
  }

  // Compact relative age, matching grader.js's ageLabel.
  function ageLabel(pulledAt) {
    if (!pulledAt) return "—";
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

  // Average grade over a character's VALID gems (mean of A.grade). Returns null when
  // the character has no valid gems (so it sorts to the bottom / shows "—").
  function avgGradeOf(char) {
    var gems = (char && char.gems) || [];
    var sum = 0, n = 0;
    for (var i = 0; i < gems.length; i++) {
      if (validateConfig(gems[i]).valid) { sum += grade(gems[i]); n++; }
    }
    return n ? sum / n : null;
  }

  // Total damage % over a character's VALID gems — the SAME figure the Grader shows
  // (sum of relDamage, ~10% for a strong loadout). Null when there are no valid gems.
  function totalDmgOf(char) {
    var gems = (char && char.gems) || [];
    var sum = 0, n = 0;
    for (var i = 0; i < gems.length; i++) {
      if (validateConfig(gems[i]).valid) { sum += relDamage(gems[i]); n++; }
    }
    return n ? sum : null;
  }

  // SUPPORT analogue of avgGradeOf: mean of supportGrade over a character's VALID
  // gems. Null when no valid gems (sorts to the bottom / shows "—").
  function avgSupportGradeOf(char) {
    var gems = (char && char.gems) || [];
    var sum = 0, n = 0;
    for (var i = 0; i < gems.length; i++) {
      if (validateConfig(gems[i]).valid) { sum += supportGrade(gems[i]); n++; }
    }
    return n ? sum / n : null;
  }

  // SUPPORT analogue of totalDmgOf: Σ supportRelValue over a character's VALID gems
  // (the "Party dmg%" column). Null when no valid gems.
  function totalPartyDmgOf(char) {
    var gems = (char && char.gems) || [];
    var sum = 0, n = 0;
    for (var i = 0; i < gems.length; i++) {
      // ÷3: supportRelValue carries the ×3 party multiplier (grading/gold); the displayed
      // "Party dmg%" is the per-ally number, so divide by 3 here.
      if (validateConfig(gems[i]).valid) { sum += supportRelValue(gems[i]) / 3; n++; }
    }
    return n ? sum : null;
  }

  var STYLE =
'<style>' +
'  #tab-leaderboard .lb-status{font-size:12px;color:var(--dim);margin:2px 0 12px;min-height:16px}' +
'  #tab-leaderboard .lb-status.err{color:var(--bad)}' +
'  #tab-leaderboard .lb-actions{display:flex;gap:10px;align-items:center;margin-bottom:10px;flex-wrap:wrap}' +
'  #tab-leaderboard table{width:100%;table-layout:fixed}' +
'  #tab-leaderboard td,#tab-leaderboard th{overflow:hidden}' +
// Character cell: icon (fixed) + name (flexes & truncates) + region (fixed) on one
// row. The NAME ellipsis-truncates so a long name can never widen the fixed column.
'  #tab-leaderboard td.lb-char{white-space:nowrap}' +
'  #tab-leaderboard .lb-charwrap{display:flex;align-items:center;min-width:0}' +
'  #tab-leaderboard .lb-name{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
'  #tab-leaderboard tbody tr{cursor:pointer}' +
'  #tab-leaderboard tbody tr:hover{background:var(--panel2)}' +
'  #tab-leaderboard .lb-rank{font-variant-numeric:tabular-nums;color:var(--dim);font-weight:700;width:48px}' +
'  #tab-leaderboard .lb-name{font-weight:700;color:var(--text);text-decoration:none;border-bottom:1px dotted transparent}' +
'  #tab-leaderboard .lb-name:hover{color:var(--accent);border-bottom-color:var(--accent)}' +
'  #tab-leaderboard .lb-dmg{color:var(--axis,var(--accent));font-weight:700;font-variant-numeric:tabular-nums}' +
'  #tab-leaderboard .lb-region{color:var(--dim);font-weight:600;font-size:11px;margin-left:6px;flex:0 0 auto}' +
'  #tab-leaderboard .lb-grade{font-variant-numeric:tabular-nums;font-weight:700;color:var(--axis,var(--accent))}' +
'  #tab-leaderboard img.lb-class-icon{width:20px;height:20px;vertical-align:middle;margin-right:7px;object-fit:contain;opacity:.9;flex:0 0 auto;filter:brightness(0) invert(.82)}' +
// MOBILE: the fixed columns (≈442px) overflow a phone, squeezing the flexible Character
// column to ~0 so the NAME vanishes. Hide "Last pulled" + shrink the rest so the name fits.
'  @media(max-width:600px){' +
// Make room for the NAME on phones: drop Last-pulled + iLvl + the per-row region, shrink
// the rest, smaller icon, tighter padding. !important beats the <col> inline width=. The
// iLvl CELL stays (zeroed) — display:none on a MIDDLE cell shifts the others off their cols.
'    #tab-leaderboard .panel{padding-left:6px;padding-right:6px}' +
'    #tab-leaderboard .lc-age{width:0 !important}#tab-leaderboard .lb-age{display:none}' +
'    #tab-leaderboard .lc-ilvl{width:0 !important}#tab-leaderboard .lb-ilvl{padding-left:0 !important;padding-right:0 !important}' +
'    #tab-leaderboard .lb-region{display:none}' +
'    #tab-leaderboard img.lb-class-icon{width:16px;height:16px;margin-right:4px}' +
'    #tab-leaderboard .lc-star{width:26px !important}#tab-leaderboard .lc-rank{width:28px !important}#tab-leaderboard .lc-grade{width:54px !important}#tab-leaderboard .lc-dmg{width:40px !important}' +
'    #tab-leaderboard td,#tab-leaderboard th{padding-left:3px;padding-right:3px}' +
'  }' +
'  #tab-leaderboard .lb-ilvl{color:var(--text);font-weight:700;font-variant-numeric:tabular-nums}' +
'  #tab-leaderboard .lb-dash{color:var(--dim)}' +
'  #tab-leaderboard .lb-badge{display:inline-block;padding:2px 9px;border-radius:99px;font-weight:800;line-height:1.4;font-variant-numeric:tabular-nums;margin-left:8px;font-size:12px}' +
'  #tab-leaderboard .lb-age,#tab-leaderboard .lb-count{font-variant-numeric:tabular-nums;color:var(--dim)}' +
'  #tab-leaderboard .lb-hint{color:var(--dim);font-size:11px;margin-top:10px}' +
// ---- favorite star cell (both tables) ----
'  #tab-leaderboard th.lb-star,#tab-leaderboard td.lb-star{width:30px;text-align:center;padding-left:4px;padding-right:4px}' +
'  #tab-leaderboard .lb-starbtn{background:none;border:none;cursor:pointer;font-size:17px;line-height:1;padding:2px 3px;color:var(--none);font-family:inherit;transition:color .12s,transform .08s}' +
'  #tab-leaderboard .lb-starbtn:hover{transform:scale(1.18);color:var(--high)}' +
'  #tab-leaderboard .lb-starbtn.on{color:var(--high)}' +
// ---- "★ Favorites" section above the main table ----
'  #tab-leaderboard .lb-favsec{margin:2px 0 18px}' +
'  #tab-leaderboard .lb-favsec h3{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--high);margin:0 0 8px;font-weight:700;display:flex;align-items:center;gap:8px}' +
'  #tab-leaderboard .lb-favsec h3 .st{font-size:15px}' +
'  #tab-leaderboard .lb-favsec h3 .ct{color:var(--dim);font-weight:600;letter-spacing:.02em;font-size:11px;text-transform:none}' +
'  #tab-leaderboard .lb-favsec table{border:1px solid var(--border);border-radius:10px;overflow:hidden}' +
'  #tab-leaderboard .lb-mainhdr{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--axis,var(--accent));margin:0 0 8px;font-weight:700}' +
// ---- DPS / Support pill toggle ----
'  #tab-leaderboard .lb-modes{display:inline-flex;gap:0;border:1px solid var(--border);border-radius:99px;overflow:hidden}' +
'  #tab-leaderboard .lb-modebtn{background:none;border:none;cursor:pointer;color:var(--dim);font-family:inherit;font-weight:700;font-size:12px;padding:5px 16px;line-height:1.4;transition:background .12s,color .12s}' +
'  #tab-leaderboard .lb-modebtn:hover{color:var(--text)}' +
'  #tab-leaderboard .lb-modebtn.on{background:var(--axis);color:#0c0e12}' +
// DPS = GOLD, Support = GREEN: a mode-scoped --axis on avg grade, dmg, the header + the
// toggle. Generic blue --accent stays for the rest; rank badges keep their rankColor.
'  #tab-leaderboard.axis-dps{--axis:#e3b13a}' +
'  #tab-leaderboard.axis-support{--axis:#46c074}' +
'  #tab-leaderboard .lb-regs{display:inline-flex;gap:0;border:1px solid var(--border);border-radius:99px;overflow:hidden}' +
'  #tab-leaderboard .lb-regbtn{background:none;border:none;cursor:pointer;color:var(--dim);font-family:inherit;font-weight:700;font-size:12px;padding:5px 13px;line-height:1.4;transition:background .12s,color .12s}' +
'  #tab-leaderboard .lb-regbtn + .lb-regbtn{border-left:1px solid var(--border)}' +
'  #tab-leaderboard .lb-regbtn:hover:not(.on){color:var(--text)}' +
'  #tab-leaderboard .lb-regbtn.on{background:#4b5563;color:#fff}' +
// ---- pagination controls (shown only when >PAGE_SIZE characters) ----
'  #tab-leaderboard .lb-pager{display:flex;gap:10px;align-items:center;margin-top:14px;flex-wrap:wrap;color:var(--dim);font-size:12px}' +
'  #tab-leaderboard .lb-pager .lb-pagebtn{background:var(--panel2);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:inherit;font-weight:700;font-size:12px;padding:5px 12px;cursor:pointer}' +
'  #tab-leaderboard .lb-pager .lb-pagebtn:disabled{opacity:.4;cursor:default}' +
'  #tab-leaderboard .lb-pager .lb-pageinfo{font-variant-numeric:tabular-nums}' +
'  #tab-leaderboard .lb-pager .lb-jump{width:56px;background:var(--panel2);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:inherit;font-size:12px;padding:5px 6px;text-align:center}' +
'</style>';

  function shell() {
    return STYLE +
'<div class="panel">' +
'  <h2>Leaderboard</h2>' +
'  <div class="lb-actions">' +
'    <div class="lb-modes" role="group" aria-label="Leaderboard type">' +
'      <button class="lb-modebtn on" id="lb-mode-dps" type="button" aria-pressed="true">DPS</button>' +
'      <button class="lb-modebtn" id="lb-mode-support" type="button" aria-pressed="false">Support</button>' +
'    </div>' +
'    <div class="lb-regs" role="group" aria-label="Filter by region">' +
'      <button class="lb-regbtn on" id="lb-reg-NA" type="button" aria-pressed="true">NA</button>' +
'      <button class="lb-regbtn on" id="lb-reg-EU" type="button" aria-pressed="true">EU</button>' +
'      <button class="lb-regbtn on" id="lb-reg-KR" type="button" aria-pressed="true">KR</button>' +
'    </div>' +
'    <button class="mbtn" id="lb-refresh" type="button">Refresh</button>' +
'    <span class="lb-status" id="lb-status"></span>' +
'  </div>' +
'  <div id="lb-body"></div>' +
'</div>' +
'<details class="method">' +
'  <summary>How the leaderboard ranks characters</summary>' +
'  <p>Every character pulled in the Grader is cached server-side (a Cloudflare Worker + KV). This tab lists them all and ranks each by its <b>average grade</b> — the mean of every equipped gem’s 0–100 grade (the same grade the Grader shows). Click a row to open that loadout in the Grader.</p>' +
'  <p>The <b>DPS</b> / <b>Support</b> toggle switches the scoring axis. DPS ranks all characters by average DPS grade (Total dmg%). Support keeps only the four support classes — Bard, Paladin, Artist, Valkyrie (every one of them, even DPS-built) — and ranks them by average <b>support</b> grade, with a Party dmg% column.</p>' +
'  <p>At most 100 characters show per page; use Prev / Next or the jump box to page through the rest. Favorites are listed in full above the table.</p>' +
'  <p class="note">The list reflects whatever characters have been pulled so far; pull a new one in the Grader and it appears here after a refresh.</p>' +
'</details>';
  }

  function setStatus(msg, kind) {
    var el = $("lb-status");
    if (!el) return;
    el.textContent = msg || "";
    el.className = "lb-status" + (kind ? " " + kind : "");
  }

  function renderEmpty(msg) {
    var body = $("lb-body");
    if (body) body.innerHTML = '<div class="placeholder"><b>No characters yet</b>' + esc(msg) + '</div>';
  }

  // lostark.bible profile URL for a character (the name links here).
  function bibleUrl(region, name) {
    var r = String(region).toUpperCase();
    if (r === "KR") return "https://lopec.kr/character/specPoint/" + encodeURIComponent(name || "");
    if (r === "EU") return "https://lostark.bible/character/CE/" + encodeURIComponent(name || "");
    return "https://lostark.bible/character/" + encodeURIComponent(region || "") + "/" + encodeURIComponent(name || "");
  }

  // The star <button> cell for a character. `data-i` indexes into allChars so a
  // delegated handler can toggle it. Favorites are unlimited, so the star is always
  // clickable (no cap / disabled state).
  function starCell(c, i) {
    if (!Favs) return '';
    var on = Favs.has(c.region, c.name);
    return '<td class="lb-star">' +
      '<button type="button" class="lb-starbtn' + (on ? " on" : "") + '" data-star="' + i + '"' +
      ' title="' + (on ? "Remove from favorites" : "Add to favorites") + '"' +
      ' aria-pressed="' + (on ? "true" : "false") + '">' + (on ? "&#9733;" : "&#9734;") + '</button></td>';
  }

  // One <tr> for a character. `i` is its index in allChars; `rankNum` is the overall
  // rank to show (#) — for the Favorites table this is the character's ORIGINAL rank,
  // so a favorite that's #3 overall still reads "#3". The grade + dmg figures follow
  // the active mode (DPS: _avg / _dmg ; Support: _savg / _pdmg).
  function charRow(c, i, rankNum) {
    var support = mode === "support";
    var avg = support ? c._savg : c._avg;
    var dmg = support ? c._pdmg : c._dmg;
    var gradeTxt = avg == null ? "—" : avg.toFixed(1);
    var badge = avg == null ? "" : rankBadge(rankFromGrade(avg));
    var dmgTxt = dmg == null ? "—" : dmg.toFixed(2) + "%";
    return '<tr data-i="' + i + '">' +
      starCell(c, i) +
      '<td class="lb-rank">#' + rankNum + '</td>' +
      '<td class="lb-ilvl">' + (c.itemLevel ? Number(c.itemLevel).toLocaleString() : '<span class="lb-dash">—</span>') + '</td>' +
      '<td class="lb-char"><span class="lb-charwrap">' + classIcon(c.class) +
        '<a class="lb-name" href="' + bibleUrl(c.region, c.name) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="' + esc(c.name || "") + '">' + esc(c.name || "—") + '</a>' +
        '<span class="lb-region">' + esc(c.region || "") + '</span></span></td>' +
      '<td><span class="lb-grade">' + gradeTxt + '</span>' + badge + '</td>' +
      '<td class="lb-dmg">' + dmgTxt + '</td>' +
      '<td class="lb-age">' + esc(ageLabel(c.pulledAt)) + '</td>' +
      '</tr>';
  }

  // Shared <colgroup> reused by BOTH leaderboard tables. With table-layout:fixed,
  // these explicit widths make every column line up vertically between the Favorites
  // table and the All-characters table regardless of each table's own content. Only
  // the Character column is left flexible (no width), so it absorbs all leftover
  // space identically in both tables; everything else is pinned.
  function colGroup() {
    return '<colgroup>' +
      (Favs ? '<col class="lc-star" style="width:30px">' : '') +  // star
      '<col class="lc-rank" style="width:48px">' +                // Rank
      '<col class="lc-ilvl" style="width:64px">' +                // iLvl
      '<col class="lc-char">' +                                   // Character (flexible)
      '<col class="lc-grade" style="width:112px">' +              // Avg grade (number + badge)
      '<col class="lc-dmg" style="width:92px">' +                 // Total dmg%
      '<col class="lc-age" style="width:96px">' +                 // Last pulled
      '</colgroup>';
  }

  function headRow() {
    var dmgHdr = mode === "support" ? "Party dmg%" : "Total dmg%";
    return '<thead><tr>' +
      (Favs ? '<th class="lb-star" aria-label="Favorite"></th>' : '') +
      '<th>Rank</th><th class="lb-ilvl">iLvl</th><th>Character</th><th>Avg grade</th><th>' + dmgHdr + '</th><th class="lb-age">Last pulled</th>' +
      '</tr></thead>';
  }

  // The "★ Favorites" filtered view: ONLY the favorited characters, in overall-rank
  // order, each showing its ORIGINAL overall rank (_rank). Returns "" when none are
  // favorited (the section is hidden entirely).
  function favSectionHtml() {
    if (!Favs) return '';
    var rows = '';
    var n = 0;
    for (var i = 0; i < allChars.length; i++) {
      var c = allChars[i];
      if (Favs.has(c.region, c.name)) { rows += charRow(c, c._idx, c._rank); n++; }
    }
    if (!n) return ''; // no favorites -> hide the whole section
    return '<div class="lb-favsec" id="lb-favsec">' +
      '<h3><span class="st">&#9733;</span> Favorites <span class="ct">' + n + ' saved &middot; shown with their overall rank</span></h3>' +
      '<table>' + colGroup() + headRow() + '<tbody id="lb-fav-rows">' + rows + '</tbody></table>' +
      '</div>';
  }

  // Total number of pages for the current list (>=1).
  function pageCount() {
    return Math.max(1, Math.ceil(allChars.length / PAGE_SIZE));
  }

  // Clamp `page` into [1, pageCount()] (used after a re-filter shrinks the list).
  function clampPage() {
    var pc = pageCount();
    if (page < 1) page = 1;
    if (page > pc) page = pc;
  }

  // Pagination controls — only rendered when there are MORE than one page
  // (i.e. >PAGE_SIZE characters). Prev / Next + a jump-to-page input.
  function pagerHtml() {
    if (allChars.length <= PAGE_SIZE) return '';
    var pc = pageCount();
    var first = (page - 1) * PAGE_SIZE + 1;
    var last = Math.min(page * PAGE_SIZE, allChars.length);
    return '<div class="lb-pager">' +
      '<button type="button" class="lb-pagebtn" id="lb-prev"' + (page <= 1 ? ' disabled' : '') + '>&larr; Prev</button>' +
      '<button type="button" class="lb-pagebtn" id="lb-next"' + (page >= pc ? ' disabled' : '') + '>Next &rarr;</button>' +
      '<span class="lb-pageinfo">Page ' + page + ' of ' + pc + ' &middot; #' + first + '–#' + last + '</span>' +
      '<span>Jump to <input type="number" class="lb-jump" id="lb-jump" min="1" max="' + pc + '" value="' + page + '"></span>' +
      '</div>';
  }

  function mainTableHtml() {
    clampPage();
    var start = (page - 1) * PAGE_SIZE;
    var slice = allChars.slice(start, start + PAGE_SIZE);
    var rows = slice.map(function (c) { return charRow(c, c._idx, c._rank); }).join("");
    return (Favs ? '<div class="lb-mainhdr">All characters</div>' : '') +
      '<table>' + colGroup() + headRow() + '<tbody id="lb-rows">' + rows + '</tbody></table>' +
      pagerHtml() +
      '<div class="lb-hint">Click a character to open its loadout in the Grader' +
      (Favs ? '; tap the ★ to save it.' : '.') + '</div>';
  }

  // Delegated handler for a tbody: a star click toggles the favorite (and must NOT
  // open the loadout); any other click on the row opens it in the Grader.
  function wireTbody(tbody) {
    if (!tbody) return;
    tbody.addEventListener("click", function (e) {
      var starBtn = e.target.closest ? e.target.closest(".lb-starbtn") : null;
      if (starBtn) {
        e.stopPropagation(); // do NOT fall through to the row's show-loadout click
        if (starBtn.disabled) return;
        var si = parseInt(starBtn.getAttribute("data-star"), 10);
        var sc = allChars[si];
        if (sc && Favs) { Favs.toggle(sc.region, sc.name); } // notify -> repaint()
        return;
      }
      var tr = e.target.closest ? e.target.closest("tr[data-i]") : null;
      if (!tr) return;
      var idx = parseInt(tr.getAttribute("data-i"), 10);
      var ch = allChars[idx];
      if (ch && typeof window.graderShowLoadout === "function") {
        window.graderShowLoadout(ch);
      } else if (typeof window.selectTab === "function") {
        window.selectTab("grader");
      }
    });
  }

  // Sort comparator: by the active mode's avg grade, descending, nulls last.
  function byActiveGradeDesc(a, b) {
    var av = (mode === "support" ? a._savg : a._avg);
    var bv = (mode === "support" ? b._savg : b._avg);
    av = av == null ? -Infinity : av;
    bv = bv == null ? -Infinity : bv;
    return bv - av;
  }

  // Build the ranked list FROM rawChars for the active mode, then paint.
  //   DPS:     ALL characters, ranked by avg grade desc (Total dmg% column).
  //   Support: ONLY the four support CLASSES (by c.class, not build) — kept in full,
  //            ranked by avg supportGrade desc (Party dmg% column).
  // Tags each kept char with _rank (overall #, 1..N within this mode's list) and
  // _idx (its index in allChars, for the delegated click/star handlers).
  function rebuild() {
    var base = (mode === "support")
      ? rawChars.filter(isSupportClass)
      : rawChars.slice();
    // Region chips + hide anything ranked C+ or below (< B-) on the ACTIVE axis.
    var list = base.filter(function (c) {
      if (!regions[c.region]) return false;
      var avg = (mode === "support") ? c._savg : c._avg;
      return avg != null && avg >= MIN_GRADE;
    });
    list.sort(byActiveGradeDesc);
    for (var i = 0; i < list.length; i++) { list[i]._rank = i + 1; list[i]._idx = i; }
    allChars = list;
    clampPage();
    repaint();
  }

  // Full render entry point: stash the fetched list, reset to page 1, build for the
  // active mode. Called on load (DPS by default) and after a fresh fetch.
  function renderTable(chars) {
    rawChars = chars;
    // pre-compute both axes' per-character figures once (used by sort + columns).
    rawChars.forEach(function (c) {
      c._avg = avgGradeOf(c); c._dmg = totalDmgOf(c);
      c._savg = avgSupportGradeOf(c); c._pdmg = totalPartyDmgOf(c);
    });
    page = 1;
    rebuild();
  }

  function gotoPage(p) {
    page = p;
    clampPage();
    repaint();
  }

  function repaint() {
    var body = $("lb-body");
    if (!body) return;
    body.innerHTML = favSectionHtml() + mainTableHtml();
    wireTbody($("lb-fav-rows"));
    wireTbody($("lb-rows"));
    // Pager (present only when paginated).
    var prev = $("lb-prev"), next = $("lb-next"), jump = $("lb-jump");
    if (prev) prev.addEventListener("click", function () { gotoPage(page - 1); });
    if (next) next.addEventListener("click", function () { gotoPage(page + 1); });
    if (jump) {
      var go = function () {
        var v = parseInt(jump.value, 10);
        if (!isNaN(v)) gotoPage(v); else jump.value = page;
      };
      jump.addEventListener("change", go);
      jump.addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
    }
  }

  var loadedOnce = false;

  function load() {
    if (!WORKER_URL) {
      setStatus("", "");
      renderEmpty("The lostark.bible Worker isn’t configured. Set WORKER_URL in leaderboard.js (and deploy worker/astrogem-bible.js).");
      loadedOnce = true;
      return;
    }
    setStatus("Loading characters…", "");
    var url = WORKER_URL.replace(/\/+$/, "") + "/?list=1";
    fetch(url).then(function (resp) {
      return resp.json().then(function (data) { return { ok: resp.ok, data: data }; });
    }).then(function (r) {
      if (!r.ok) {
        setStatus((r.data && r.data.error) || "Worker returned an error.", "err");
        renderEmpty("Could not load the leaderboard.");
        return;
      }
      var chars = (r.data && r.data.characters) || [];
      if (!chars.length) {
        setStatus("", "");
        renderEmpty("No characters stored yet — pull one in the Grader.");
        return;
      }
      // The "N characters stored" line counts EVERY stored character (unfiltered);
      // renderTable computes both axes' figures and ranks for the active mode.
      setStatus(chars.length + " character" + (chars.length === 1 ? "" : "s") + " stored.", "");
      renderTable(chars);
    }).catch(function (e) {
      setStatus("Request failed: " + (e && e.message || e), "err");
      renderEmpty("Could not reach the Worker.");
    });
    loadedOnce = true;
  }

  function init() {
    var el = $("tab-leaderboard");
    if (!el) return;
    el.innerHTML = shell();
    el.classList.add("axis-dps");   // default DPS = red theme
    $("lb-refresh").addEventListener("click", load);

    // DPS / Support toggle: re-filter, re-rank, and reset to page 1. The Favorites
    // section follows the mode too (it reads from the rebuilt allChars).
    function setMode(m) {
      if (m === mode) return;
      mode = m;
      var dpsBtn = $("lb-mode-dps"), supBtn = $("lb-mode-support");
      if (dpsBtn) { dpsBtn.classList.toggle("on", m === "dps"); dpsBtn.setAttribute("aria-pressed", m === "dps" ? "true" : "false"); }
      if (supBtn) { supBtn.classList.toggle("on", m === "support"); supBtn.setAttribute("aria-pressed", m === "support" ? "true" : "false"); }
      el.classList.toggle("axis-dps", m !== "support"); el.classList.toggle("axis-support", m === "support");
      page = 1;
      if (rawChars.length) rebuild();
    }
    $("lb-mode-dps").addEventListener("click", function () { setMode("dps"); });
    $("lb-mode-support").addEventListener("click", function () { setMode("support"); });

    // Region chips: independently toggle NA / EU / KR (all on by default). Re-filter + page 1.
    ["NA", "EU", "KR"].forEach(function (rg) {
      var btn = $("lb-reg-" + rg);
      if (!btn) return;
      btn.addEventListener("click", function () {
        regions[rg] = !regions[rg];
        btn.classList.toggle("on", regions[rg]);
        btn.setAttribute("aria-pressed", regions[rg] ? "true" : "false");
        page = 1;
        if (rawChars.length) rebuild();
      });
    });

    // Re-render when favorites change anywhere (this tab or the Grader). Only repaint
    // if we've actually loaded the list (otherwise there's nothing to show yet).
    if (Favs) {
      Favs.onChange(function () { if (allChars.length) repaint(); });
    }

    // Lazy-load the first time the tab is activated (and refresh on each activation
    // only if it hasn't loaded yet — manual Refresh re-pulls thereafter).
    document.addEventListener("tabselected", function (e) {
      if (e && e.detail && e.detail.tab === "leaderboard" && !loadedOnce) load();
    });

    // If the page somehow opens with the leaderboard already active, load now.
    if (el.classList.contains("active")) load();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
