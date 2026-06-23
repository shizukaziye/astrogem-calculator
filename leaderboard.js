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

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

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

  var STYLE =
'<style>' +
'  #tab-leaderboard .lb-status{font-size:12px;color:var(--dim);margin:2px 0 12px;min-height:16px}' +
'  #tab-leaderboard .lb-status.err{color:var(--bad)}' +
'  #tab-leaderboard .lb-actions{display:flex;gap:10px;align-items:center;margin-bottom:10px;flex-wrap:wrap}' +
'  #tab-leaderboard table{width:100%}' +
'  #tab-leaderboard tbody tr{cursor:pointer}' +
'  #tab-leaderboard tbody tr:hover{background:var(--panel2)}' +
'  #tab-leaderboard .lb-rank{font-variant-numeric:tabular-nums;color:var(--dim);font-weight:700;width:48px}' +
'  #tab-leaderboard .lb-name{font-weight:700;color:var(--text);text-decoration:none;border-bottom:1px dotted transparent}' +
'  #tab-leaderboard .lb-name:hover{color:var(--accent);border-bottom-color:var(--accent)}' +
'  #tab-leaderboard .lb-region{color:var(--dim);font-weight:600;font-size:11px;margin-left:6px}' +
'  #tab-leaderboard .lb-grade{font-variant-numeric:tabular-nums;font-weight:700}' +
'  #tab-leaderboard .lb-badge{display:inline-block;padding:2px 9px;border-radius:99px;font-weight:800;line-height:1.4;font-variant-numeric:tabular-nums;margin-left:8px;font-size:12px}' +
'  #tab-leaderboard .lb-age,#tab-leaderboard .lb-count{font-variant-numeric:tabular-nums;color:var(--dim)}' +
'  #tab-leaderboard .lb-hint{color:var(--dim);font-size:11px;margin-top:10px}' +
'</style>';

  function shell() {
    return STYLE +
'<div class="panel">' +
'  <h2>Leaderboard</h2>' +
'  <div class="lb-actions">' +
'    <button class="mbtn" id="lb-refresh" type="button">Refresh</button>' +
'    <span class="lb-status" id="lb-status"></span>' +
'  </div>' +
'  <div id="lb-body"></div>' +
'</div>' +
'<details class="method">' +
'  <summary>How the leaderboard ranks characters</summary>' +
'  <p>Every character pulled in the Grader is cached server-side (a Cloudflare Worker + KV). This tab lists them all and ranks each by its <b>average grade</b> — the mean of every equipped gem’s 0–100 grade (the same grade the Grader shows). Click a row to open that loadout in the Grader.</p>' +
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
    return "https://lostark.bible/character/" + encodeURIComponent(region || "") + "/" + encodeURIComponent(name || "");
  }

  function renderTable(chars) {
    var rows = chars.map(function (c, i) {
      var avg = c._avg;
      var gradeTxt = avg == null ? "—" : avg.toFixed(1);
      var badge = avg == null ? "" : rankBadge(rankFromGrade(avg));
      return '<tr data-i="' + i + '">' +
        '<td class="lb-rank">#' + (i + 1) + '</td>' +
        '<td><a class="lb-name" href="' + bibleUrl(c.region, c.name) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">' + esc(c.name || "—") + '</a>' +
          '<span class="lb-region">' + esc(c.region || "") + '</span></td>' +
        '<td><span class="lb-grade">' + gradeTxt + '</span>' + badge + '</td>' +
        '<td class="lb-age">' + esc(ageLabel(c.pulledAt)) + '</td>' +
        '</tr>';
    }).join("");

    var body = $("lb-body");
    body.innerHTML =
'<table>' +
'  <thead><tr><th>Rank</th><th>Character</th><th>Avg grade</th><th>Last pulled</th></tr></thead>' +
'  <tbody id="lb-rows">' + rows + '</tbody>' +
'</table>' +
'<div class="lb-hint">Click a character to open its loadout in the Grader.</div>';

    // Row click -> open in Grader. We pass the FULL stored record so the Grader can
    // render without re-fetching.
    var tbody = $("lb-rows");
    tbody.addEventListener("click", function (e) {
      var tr = e.target.closest ? e.target.closest("tr[data-i]") : null;
      if (!tr) return;
      var idx = parseInt(tr.getAttribute("data-i"), 10);
      var ch = chars[idx];
      if (ch && typeof window.graderShowLoadout === "function") {
        window.graderShowLoadout(ch);
      } else if (typeof window.selectTab === "function") {
        window.selectTab("grader");
      }
    });
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
      // compute avg grade, sort descending (nulls last)
      chars.forEach(function (c) { c._avg = avgGradeOf(c); });
      chars.sort(function (a, b) {
        var av = a._avg == null ? -1 : a._avg;
        var bv = b._avg == null ? -1 : b._avg;
        return bv - av;
      });
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
    $("lb-refresh").addEventListener("click", load);

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
