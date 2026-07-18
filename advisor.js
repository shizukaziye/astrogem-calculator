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

  // Parse-collection endpoint (worker/astrogem-data.js): every parse + the state the
  // user actually ran advice with (their corrections = ground-truth labels) goes to
  // Cloudflare KV so the corpus grows itself. Gated with the site token; fire-and-forget.
  var DATA_URL = "https://astrogem-data.shizukaziye.workers.dev";

  var lastObjectUrl = null;
  var pendingCollect = null;   // { blob, parsed, source } — one record per parse

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
'  #tab-advisor .av-drop{border:2px dashed var(--border);border-radius:10px;padding:22px 14px;text-align:center;color:var(--dim);cursor:pointer;transition:border-color .15s,background .15s;background:var(--panel2);font-size:13px}' +
'  #tab-advisor .av-drop.drag{border-color:var(--accent);background:rgba(102,199,255,.08);color:var(--text)}' +
'  #tab-advisor .av-drop b{color:var(--text)}' +
// once a screenshot lands, it fills the zone at full column width, undimmed
'  #tab-advisor .av-drop.has-img{padding:8px}' +
'  #tab-advisor .av-drop.has-img .hint{display:none}' +
'  #tab-advisor .av-preview{display:none;width:100%;height:auto;border-radius:8px;border:1px solid var(--border)}' +
'  #tab-advisor .av-drop.has-img .av-preview{display:block}' +
'  #tab-advisor .av-drop .cap{display:none;font-size:11px;color:var(--dim);margin-top:7px}' +
'  #tab-advisor .av-drop.has-img .cap{display:block}' +
'  #tab-advisor .av-status{font-size:12px;color:var(--dim);margin-top:6px;min-height:16px}' +
'  #tab-advisor .av-status.working{color:var(--accent)}' +
'  #tab-advisor .av-status.err{color:var(--bad)}' +
'  #tab-advisor .av-engines{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}' +
'  #tab-advisor .mbtn:disabled{opacity:.45;cursor:not-allowed}' +
'  #tab-advisor .av-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-top:12px}' +
'  #tab-advisor .av-cols{display:flex;gap:16px;align-items:flex-start;margin-top:14px}' +
'  #tab-advisor .av-col-l{flex:0 0 470px;max-width:470px;min-width:0}' +
'  #tab-advisor .av-col-r{flex:1;min-width:280px;display:flex;flex-direction:column;gap:14px}' +
'  @media(max-width:880px){#tab-advisor .av-cols{flex-direction:column}#tab-advisor .av-col-l{flex:1 1 auto;max-width:none;width:100%}#tab-advisor .av-col-r{width:100%}}' +
'  #tab-advisor .av-result-empty{border:1px dashed var(--border);border-radius:10px;background:var(--panel2);color:var(--dim);font-size:13px;text-align:center;padding:26px 16px}' +
'  #tab-advisor .av-setup-panel{margin:0}' +
'  #tab-advisor .av-gorow{margin-top:12px;padding-top:12px;border-top:1px solid var(--border)}' +
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
'  #tab-advisor .linklike{background:none;border:0;color:var(--accent);cursor:pointer;font-size:12px;padding:0 2px;text-decoration:underline}' +
'  #tab-advisor .av-share{display:flex;gap:10px;align-items:center;margin-top:8px}' +
'</style>' +
'<div class="av-wip">⚠ DO NOT USE — WORK IN PROGRESS</div>' +
// two balanced columns: LEFT = the cut (the lookalike window),
// RIGHT = your economy (character/market), the verdict, then the screenshot intake.
'<div class="av-cols">' +
'  <div class="av-col-l">' +
'    <div id="av-window"></div>' +
'  </div>' +
'  <div class="av-col-r">' +
'    <div class="panel av-setup-panel"><div id="av-setup"></div>' +
'      <div class="barrow av-gorow">' +
'        <button class="mbtn" id="av-sim2" data-on="1">Consider Complete: on</button>' +
'        <button class="mbtn" id="av-bound" data-on="0">Roster bound: no</button>' +
'        <button class="primary" id="av-go">Get advice</button>' +
'        <span class="note" id="av-go-note"></span>' +
'      </div>' +
'      <div id="av-warns"></div>' +
'      <div class="av-bar" id="av-bar"><i id="av-bar-i"></i></div>' +
'    </div>' +
'    <div class="av-result-empty" id="av-result-empty">The recommended action appears here once you press <b>Get advice</b>.</div>' +
'    <div class="panel" id="av-result" style="display:none">' +
'      <h2>Recommended action</h2>' +
'      <p class="av-best" id="av-best-line"></p>' +
'      <div class="av-cards" id="av-cards"></div>' +
'      <div class="note" id="av-result-note"></div>' +
'    </div>' +
'    <div class="av-drop" id="av-drop">' +
'      <span class="hint"><b>Drop, paste, or click</b> — a Processing screenshot prefills the window. Or just tap the fields.</span>' +
'      <img id="av-preview" class="av-preview" alt="screenshot preview">' +
'      <span class="cap">click, drop, or paste a new screenshot to replace</span>' +
'      <input type="file" id="av-file" accept="image/*" style="display:none">' +
'    </div>' +
'    <div class="av-share" id="av-share"></div>' +
'    <div class="av-engines" id="av-engines"></div>' +
'    <div class="av-status" id="av-status"></div>' +
'    <div class="note" style="font-size:11px;margin-top:6px">Screenshots you read here are uploaded with the parse and your corrections to improve the reader.</div>' +
'  </div>' +
'</div>' +
'<details class="method">' +
'  <summary>How the advice is computed</summary>' +
'  <p>Each option is scored by an <b>exact decision model</b> (a Bellman dynamic program): the model computes, in closed form, the <i>optimal</i> expected outcome of every line of play to the end of the cut &mdash; assuming you keep playing optimally afterward. The number reported per option is <b>net expected gold</b> = expected final gem value &minus; the processing/reroll gold you&rsquo;d still spend from here on.</p>' +
'  <ul>' +
'    <li><b>Process</b> applies one of the 4 on-screen outcomes (25% each, from the outcomes you confirmed), then plays on optimally.</li>' +
'    <li><b>Reroll</b> redraws the 4 outcomes; only the <i>last</i> reroll costs 3,800g (the on-screen counter shows the free ones; the window translates). Not available on turn 1 &mdash; the game greys it out until the gem has been processed once.</li>' +
'    <li><b>Complete</b> stops now and keeps the current gem (Turn&nbsp;1 = dismantle, value 0). Ranked against Process/Reroll whenever the toggle is on &mdash; it wins when both are negative.</li>' +
'    <li><b>Reset</b> (last turn only): pay 20,000g to return the gem to a fresh unprocessed state. Recommended when it beats both Process and Complete. Because a reset may re-roll the side effects, the advisor also lists the fresh-cut value of every effect pair whenever reset is a live option.</li>' +
'    <li><b>P(above baseline)</b> is the probability the final gem clears your baseline under optimal play. A below-baseline gem is valued as fusion fodder, not zero.</li>' +
'  </ul>' +
'  <p class="note">The baseline is the S/A/B/C/D rank ladder the Grader uses (12 anchor grades); picking a character sets it one rank above your stronger 3rd-lowest gem, and sets the gold-per-1%-damage tier from combat power. On the Support axis gems are valued by party contribution (supportValue) against support-scale baselines; support advice has no Monte-Carlo fallback &mdash; if the exact model fails you get an error, never a silently mis-ranked answer.</p>' +
'</details>';
  }

  // ---------------- engine selector ----------------
  var selectedEngine = "structural";
  function renderEngines() {
    var wrap = $("av-engines");
    var list = (window.ocrListEngines ? window.ocrListEngines() : []);
    if (list.length === 0) { wrap.innerHTML = '<span class="note">No OCR engines registered.</span>'; return; }
    // one usable engine = nothing to choose — hide the row (it reappears when the
    // premium vision engine deploys and becomes available)
    var availN = list.filter(function (e) { try { return e.isAvailable(); } catch (er) { return false; } }).length;
    if (availN <= 1) {
      wrap.style.display = "none";
      var only = list.filter(function (e) { try { return e.isAvailable(); } catch (er) { return false; } })[0];
      if (only) selectedEngine = only.name;
      return;
    }
    wrap.style.display = "";
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
  var EMPTY_HINT = 'The recommended action appears here once you press <b>Get advice</b>.';
  // Blank the recommendation pane (stale advice must never sit next to new state):
  // called on every new parse and at the start of every Get advice run.
  function clearResult(msg) {
    var res = $("av-result");
    if (res) res.style.display = "none";
    var empty = $("av-result-empty");
    if (empty) { empty.style.display = ""; empty.innerHTML = msg || EMPTY_HINT; }
    var h = document.getElementById("av-heur");
    if (h) h.remove();
    var rc = document.getElementById("av-reset-combos");
    if (rc) rc.remove();
  }
  function setStatus(msg, kind) {
    var s = $("av-status");
    s.textContent = msg || "";
    s.className = "av-status" + (kind ? " " + kind : "");
  }

  // ---------------- outcome processed (via the editor's Process button) ----------------
  // The window advanced a turn: the old screenshot and the old advice both describe
  // the PREVIOUS decision point — clear them, offer an undo.
  function onOutcomeApplied(info) {
    $("av-drop").classList.remove("has-img");
    clearResult();
    var s = $("av-status");
    s.className = "av-status";
    s.textContent = info.finished
      ? "Final turn processed — the cut is finished. "
      : "Processed: " + info.description + " — now turn " + info.turn + "/" + info.maxTurns +
        ". Read the next screen or press Get advice. ";
    var u = el("button", { class: "linklike", type: "button" }, "Undo");
    u.addEventListener("click", function () {
      if (window.AdvisorWindow.undoApply && window.AdvisorWindow.undoApply()) {
        if ($("av-preview").src) $("av-drop").classList.add("has-img");
        setStatus("Undone — previous turn restored.");
      }
    });
    s.appendChild(u);
  }

  // ---------------- parse collection ----------------
  // Re-encode the capture as a bounded webp data-URL (collection payloads stay small).
  function toWebpDataUrl(blob, cb) {
    try {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        try {
          var maxW = 1600;
          var sc = Math.min(1, maxW / img.naturalWidth);
          var c = document.createElement("canvas");
          c.width = Math.round(img.naturalWidth * sc);
          c.height = Math.round(img.naturalHeight * sc);
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
          URL.revokeObjectURL(url);
          cb(c.toDataURL("image/webp", 0.8));
        } catch (e) { cb(null); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); cb(null); };
      img.src = url;
    } catch (e) { cb(null); }
  }
  function diffParseVsFinal(parsed, finalState) {
    var changed = [];
    try {
      var pc = (parsed && parsed.config) || {}, fc = finalState.config || {};
      ["baseCost", "gemType", "willpowerLevel", "orderLevel", "effect1", "effect1Level", "effect2", "effect2Level"].forEach(function (k) {
        if (String(pc[k]) !== String(fc[k])) changed.push({ field: "config." + k, parsed: pc[k], corrected: fc[k] });
      });
      var ps = (parsed && parsed.state) || {};
      ["currentTurn", "maxTurns", "rerollsRemaining", "processCostMultiplier"].forEach(function (k) {
        if (String(ps[k]) !== String(finalState[k])) changed.push({ field: "state." + k, parsed: ps[k], corrected: finalState[k] });
      });
      var po = (parsed && parsed.outcomes) || [], fo = finalState.outcomes || [];
      for (var i = 0; i < 4; i++) {
        var a = JSON.stringify(po[i] || null), b = JSON.stringify(fo[i] || null);
        if (a !== b) changed.push({ field: "outcomes." + i, parsed: po[i] || null, corrected: fo[i] || null });
      }
    } catch (e) {}
    return changed;
  }
  function sendCollect(finalState) {
    if (!pendingCollect) return;
    var rec = pendingCollect;
    pendingCollect = null;   // one record per parse
    var tok = (window.astrogemGate && window.astrogemGate.token && window.astrogemGate.token()) || "";
    if (!tok) return;
    toWebpDataUrl(rec.blob, function (dataUrl) {
      var payload = {
        image: dataUrl,
        parse: rec.parsed,
        final: finalState,
        changed: diffParseVsFinal(rec.parsed, finalState),
        meta: { engine: selectedEngine, source: rec.source, v: 1, ua: navigator.userAgent.slice(0, 80) }
      };
      try {
        fetch(DATA_URL + "/collect?k=" + tok, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }).catch(function () {});
      } catch (e) {}
    });
  }

  // ---------------- screenshot handling ----------------
  // Shared parse path: `input` is anything the engine's toRaster accepts
  // (File/Blob/canvas); `sourceNoun` flavors the status line; `collectBlob`
  // (Blob or Promise<Blob>) is the image saved with the collection record.
  function parseWith(input, sourceNoun, collectBlob) {
    var eng = window.ocrGetEngine ? window.ocrGetEngine(selectedEngine) : null;
    if (!eng) { setStatus("Engine not found: " + selectedEngine, "err"); return; }
    var ok = false; try { ok = eng.isAvailable(); } catch (e) { ok = false; }
    if (!ok) {
      setStatus((eng.label || eng.name) + " is unavailable. " +
        ((typeof eng.unavailableReason === "function" && eng.unavailableReason()) || ""), "err");
      return;
    }
    clearResult();   // new screenshot ⇒ any previous recommendation is stale
    setStatus("Reading " + (sourceNoun || "screenshot") + " with " + (eng.label || eng.name) + "…", "working");
    eng.parseScreenshot(input).then(function (parsed) {
      window.AdvisorWindow.setParsed(parsed);
      // stage the collection record; it ships when the user presses Get advice
      // (their edits between now and then are the ground-truth labels)
      Promise.resolve(collectBlob || (input instanceof Blob ? input : null)).then(function (b) {
        if (b) pendingCollect = { blob: b, parsed: parsed, source: sourceNoun === "shared screen" ? "share" : "upload" };
      }).catch(function () {});
      var n = window.AdvisorWindow.unconfirmedCount();
      if (parsed.ocrDegraded) {
        // the Tesseract worker never loaded (blocked CDN / network) or crashed —
        // text reads are guesses, every field is flagged; tell the user why
        setStatus("Text-reading engine failed to load (network/CDN?) — values below are rough guesses from colour only. Check them all, or retry the screenshot.", "err");
      } else {
        // AUTO-ADVICE (Shizu 2026-07-17): a fresh parse runs the solver immediately —
        // no click needed. The auto run does NOT ship the collection record; only a
        // MANUAL Get advice does (the user's corrections are the valuable labels,
        // and auto-stored uncorrected parses would flood the DB with unreviewed data).
        setStatus(n
          ? "Parsed — " + n + " field" + (n > 1 ? "s" : "") + " highlighted below need a look."
          : "Parsed. Double-check the window, then Get advice.", "");
        runAdvice({ auto: true });
      }
    }).catch(function (err) {
      console.error(err);
      setStatus("Could not read the " + (sourceNoun || "screenshot") + ": " + (err && err.message || err) + " — fill the window manually.", "err");
    });
  }
  function showPreviewBlob(blob) {
    var url = URL.createObjectURL(blob);
    if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
    lastObjectUrl = url;
    $("av-preview").src = url;
    $("av-drop").classList.add("has-img");
  }
  function onImageFile(file) {
    if (!file || !/^image\//.test(file.type)) { setStatus("Not an image file.", "err"); return; }
    showPreviewBlob(file);
    parseWith(file, "screenshot", file);
  }

  // ---------------- live screen share (one click per turn, no screenshotting) ----------------
  // getDisplayMedia needs a user gesture and a secure context (https / localhost).
  // First click opens the browser's share picker (pick the Lost Ark window/monitor);
  // after that each "Read screen" click grabs ONE frame and parses it locally; the
  // frame + parse + your corrections are also sent to the collection endpoint to
  // improve the parser (see the note under the drop zone).
  var shareStream = null, shareVideo = null;
  function shareSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  }
  function renderShareBar() {
    var bar = $("av-share");
    if (!bar) return;
    bar.innerHTML = "";
    if (!shareSupported()) return;
    if (!shareStream) {
      var b = el("button", { class: "mbtn", type: "button",
        title: "Pick the Lost Ark window once; then one click reads each turn" }, "🖥 Share game screen &amp; read");
      b.addEventListener("click", startShare);
      bar.appendChild(b);
    } else {
      var read = el("button", { class: "mbtn active", type: "button" }, "📷 Read screen now");
      read.addEventListener("click", grabAndParse);
      var stop = el("button", { class: "linklike", type: "button" }, "stop sharing");
      stop.addEventListener("click", stopShare);
      bar.appendChild(read);
      bar.appendChild(stop);
    }
  }
  function startShare() {
    navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 5, max: 10 } },
      audio: false
    }).then(function (stream) {
      shareStream = stream;
      shareVideo = document.createElement("video");
      shareVideo.muted = true;
      shareVideo.srcObject = stream;
      var track = stream.getVideoTracks()[0];
      if (track) track.addEventListener("ended", stopShare);   // user hit the browser's Stop
      shareVideo.addEventListener("loadeddata", function () {
        renderShareBar();
        grabAndParse();   // read immediately — the picker click IS the first read
      }, { once: true });
      return shareVideo.play();
    }).catch(function (err) {
      var name = err && err.name || "";
      setStatus(name === "NotAllowedError"
        ? "Screen share was cancelled."
        : "Screen share failed: " + (err && err.message || err), "err");
      stopShare();
    });
  }
  function stopShare() {
    if (shareStream) shareStream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    shareStream = null; shareVideo = null;
    renderShareBar();
  }
  function grabAndParse() {
    if (!shareVideo || !shareVideo.videoWidth) { setStatus("No frame from the shared screen yet — try again.", "err"); return; }
    var c = document.createElement("canvas");
    c.width = shareVideo.videoWidth;
    c.height = shareVideo.videoHeight;
    c.getContext("2d").drawImage(shareVideo, 0, 0);
    var blobP = new Promise(function (resolve) {
      try { c.toBlob(function (blob) { if (blob) showPreviewBlob(blob); resolve(blob || null); }, "image/png"); }
      catch (e) { resolve(null); }
    });
    parseWith(c, "shared screen", blobP);
  }

  // ---------------- run advice ----------------
  function runAdvice(opts) {
    // opts.auto === true → triggered by a fresh parse, not a click. Auto runs skip
    // the collection ship; the staged record stays pending so a later MANUAL click
    // (after the user's corrections) still stores it. (A click handler passes the
    // DOM event here — no .auto on it, so clicks are always "manual".)
    var isAuto = !!(opts && opts.auto === true);
    var hasDP = typeof window.evaluateActionsDP === "function";
    var hasMC = typeof window.evaluateActions === "function";
    if (!hasDP && !hasMC) { setStatus("Model not loaded.", "err"); return; }

    var m = window.AdvisorSetup.getMarket();
    var state = window.AdvisorWindow.getState();
    state.rosterBound = $("av-bound").dataset.on === "1";
    // ship the staged collection record: parse + the state the user actually ran
    if (!isAuto) sendCollect(state);
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
    clearResult("Calculating the recommended action…");
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
              clearResult();
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
        if (isAuto) {
          var nA = window.AdvisorWindow.unconfirmedCount();
          setStatus(nA
            ? "Auto-advice shown — " + nA + " highlighted field" + (nA > 1 ? "s" : "") + " to double-check. Correct them and press Get advice to recompute & save."
            : "Auto-advice shown. Press Get advice after any corrections to save the reading.", "");
        } else {
          setStatus("Done.", "");
        }
      } catch (err) {
        console.error(err);
        setStatus("Solver error: " + (err && err.message || err), "err");
        clearResult();
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
    ["Process", "Reroll", "Complete", "Reset"].forEach(function (name) {
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
            ? '<div style="color:var(--dim)">Not applicable' + (name === "Complete" && includeSim2 === false ? " (not ranked)" : (name === "Reroll" ? (state.currentTurn === 1 ? " (turn 1 — process once first)" : " (no rerolls left)") : (name === "Complete" ? " (turn 1 — process once first)" : (name === "Reset" ? " (ranked on the last turn)" : "")))) + "</div>"
            : '<div>P(above baseline): <span class="ev">' + odds + '%</span></div>' +
              '<div>Net EV: <span class="ev ' + evClass + '">' + fmtGold(a.value) + "</span></div>" +
              scoreLine + costLine) +
        "</div>";
      cards.appendChild(c);
    });

    // ---- Reset check (Shizu): a reset MAY re-roll the side nodes, so the single
    // ranked Reset value (same-pair assumption) can't be trusted alone. Whenever
    // reset is live (last turn, or Complete recommended) show the fresh-cut value
    // of EVERY pair this gem could reset into, fee included.
    var priorRc = document.getElementById("av-reset-combos");
    if (priorRc) priorRc.remove();
    if (result.resetCombos && result.resetCombos.length) {
      var rcRows = result.resetCombos.map(function (cb) {
        return '<tr><td style="padding:2px 0">' + cb.effect1 + " + " + cb.effect2 +
          (cb.current ? ' <span style="opacity:.65">(current pair)</span>' : "") + "</td>" +
          '<td style="text-align:right" class="ev ' + (cb.net >= 0 ? "good" : "bad") + '">' + fmtGold(cb.net) + "</td></tr>";
      }).join("");
      var rcBox = el("div", { id: "av-reset-combos", class: "note", style: "margin-top:8px" });
      rcBox.innerHTML =
        "⚠ <b>Before pressing Reset in game:</b> the ranked Reset assumes the side effects come back unchanged, " +
        "but a reset may re-roll them — check the pair you'd accept. Net value of a fresh cut per pair " +
        "(" + Math.round(result.resetCost || 20000).toLocaleString() + "g fee included):" +
        '<table style="width:100%;margin-top:4px;border-collapse:collapse;font-size:12px">' + rcRows + "</table>";
      cards.parentNode.insertBefore(rcBox, cards.nextSibling);
    }

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
    var empty = $("av-result-empty");
    if (empty) empty.style.display = "none";
  }

  // ---------------- init ----------------
  function init() {
    var elTab = $("tab-advisor");
    if (!elTab) return;
    elTab.innerHTML = tabMarkup();

    // Any manual edit (market assumptions or a window field) makes a rendered
    // verdict stale — blank it, same as a new parse does. Cheap no-op when no
    // result is showing.
    var onAnyEdit = function () {
      var res = $("av-result");
      if (res && res.style.display !== "none") clearResult();
    };
    window.AdvisorSetup.init($("av-setup"), { onChange: onAnyEdit });
    window.AdvisorWindow.init($("av-window"), { onChange: onAnyEdit, onApplied: onOutcomeApplied });
    renderEngines();
    renderShareBar();

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
    frame.addEventListener("dragover", function (e) { e.preventDefault(); dz.classList.add("drag"); });
    frame.addEventListener("dragleave", function () { dz.classList.remove("drag"); });
    frame.addEventListener("drop", function (e) {
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
      var t = window.ocrGetEngine && window.ocrGetEngine("structural");
      if (t && typeof t.disposeWorker === "function") t.disposeWorker();
      if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
      stopShare();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
