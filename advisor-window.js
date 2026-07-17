/**
 * advisor-window.js — the Advisor's in-game-lookalike "Processing" window.
 *
 * A faithful, ORIGINAL SVG/CSS recreation of Lost Ark's Processing modal that doubles
 * as the input form: every element you'd read off a screenshot is the control that
 * sets it. One state model (`win`), DOM is render-only, `normalize()` mirrors
 * ocr/engine.js constraintSnap after every mutation.
 *
 *   - gem icon (click = rarity)   - gem name (click = Order/Chaos)
 *   - "N Astrogem Points" = DERIVED level sum (read-only checksum vs the game)
 *   - the 4-diamond wheel (click a diamond = effect picker; click its digits = level)
 *   - the 4 outcome rows (click = a one-tap editor of fully-formed outcomes)
 *   - reroll pill in GAME units (free counter; the model's paid reroll is translated)
 *   - footer: Processing Cost (0/900/1,800 picker) · Process (x/N) (turn picker)
 *
 * Parse prefill: setParsed(constraint-snapped parse) fills the window; fields whose
 * parsed.confidence < 0.8 get a pulsing "confirm me" highlight that clears on tap or
 * edit (see the confidence contract in ocr/engine.js constraintSnap).
 *
 * API (window.AdvisorWindow):
 *   init(hostEl, { onChange })
 *   getState() -> the exact advisor `state` shape (rosterBound left false; the
 *                 caller owns that toggle):
 *     { config, currentTurn, maxTurns, rerollsRemaining, processCost,
 *       processCostMultiplier, totalGoldSpent: 0, rosterBound: false,
 *       outcomes: [4], history: [] }
 *   setParsed(parsed)      // constraint-snapped {config,state,outcomes,rarity,confidence?}
 *   clearUnconfirmed()
 *   unconfirmedCount()
 */
(function (root) {
  "use strict";

  var A = root.Astrogem || root;
  var RARITY = A.RARITY || { uncommon: { maxTurns: 5, maxRerolls: 1 }, rare: { maxTurns: 7, maxRerolls: 2 }, epic: { maxTurns: 9, maxRerolls: 3 } };
  var EFFECT_POOLS = A.EFFECT_POOLS || {};

  // ---- stat -> visual style (single source of truth; placeholders are flagged so a
  // future screenshot pass can correct them without touching markup) ----
  var STAT_STYLE = {
    willpower:            { g1: "#c0392b", g2: "#e0533f", label: "Willpower Efficiency" },
    points:               { g1: "#c98a2e", g2: "#e0a83f", label: "Points" },
    // In-game, the side diamonds are colored by SLOT, not by effect (verified on
    // Shizu's rare frame 2026-07-16: Atk. Power rendered green as the LEFT effect on
    // the epic cut but blue as the RIGHT effect on the rare one). W = green, E = blue.
    slotW:                { g1: "#4a9e3f", g2: "#6ab84f" },
    slotE:                { g1: "#2f7fd0", g2: "#3f9be0" },
    // effect-name colors remain only as picker swatches
    "Attack Power":       { g1: "#4a9e3f", g2: "#6ab84f" },
    "Boss Damage":        { g1: "#2f7fd0", g2: "#3f9be0" },
    "Additional Damage":  { g1: "#b5722a", g2: "#d98f35", placeholder: true },
    "Brand Power":        { g1: "#7a4fd0", g2: "#9a6fe8", placeholder: true },
    "Ally Damage Enh.":   { g1: "#2f9d92", g2: "#3fc0b2", placeholder: true },
    "Ally Attack Enh.":   { g1: "#c04f8a", g2: "#e06aa8", placeholder: true },
    grey:                 { g1: "#6f747a", g2: "#8a9099" }
  };
  var RARITY_COLOR = { epic: "#b06fe0", rare: "#4f9be0", uncommon: "#5aae4a" };

  // ---- state ----
  var host = null, onChangeCb = null, onAppliedCb = null;
  var win = {
    rarity: "epic",
    config: { baseCost: 9, gemType: "chaos", willpowerLevel: 1, orderLevel: 1,
      effect1: "Attack Power", effect1Level: 1, effect2: "Boss Damage", effect2Level: 1 },
    currentTurn: 1,
    rerollsRemaining: 3,          // MODEL units (incl. the paid final reroll)
    costMult: 0,
    outcomes: [{ type: "do_nothing" }, { type: "do_nothing" }, { type: "do_nothing" }, { type: "do_nothing" }],
    unconfirmed: {}               // key -> 1 (e.g. "config.effect1", "outcomes.2", "state.rerollsRemaining")
  };
  var pop = null;                 // open popover descriptor

  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function maxTurns() { return (RARITY[win.rarity] || RARITY.epic).maxTurns; }
  function maxRerolls() { return (RARITY[win.rarity] || RARITY.epic).maxRerolls; }
  function pool() { return (EFFECT_POOLS[win.config.baseCost] || []).slice(); }
  function pointsSum() { var c = win.config; return (c.willpowerLevel | 0) + (c.orderLevel | 0) + (c.effect1Level | 0) + (c.effect2Level | 0); }
  function processCost() { return Math.max(1, Math.round(900 * (1 + win.costMult / 100))); }

  // ---- normalize (the UI-side mirror of constraintSnap) ----
  function normalize() {
    var c = win.config;
    c.baseCost = [8, 9, 10].indexOf(c.baseCost) !== -1 ? c.baseCost : 9;
    c.gemType = c.gemType === "order" ? "order" : "chaos";
    ["willpowerLevel", "orderLevel", "effect1Level", "effect2Level"].forEach(function (k) {
      c[k] = Math.max(1, Math.min(5, parseInt(c[k], 10) || 1));
    });
    var p = pool();
    if (p.indexOf(c.effect1) === -1) c.effect1 = p[0];
    if (p.indexOf(c.effect2) === -1 || c.effect2 === c.effect1) {
      for (var i = 0; i < p.length; i++) if (p[i] !== c.effect1) { c.effect2 = p[i]; break; }
    }
    win.currentTurn = Math.max(1, Math.min(maxTurns(), parseInt(win.currentTurn, 10) || 1));
    win.rerollsRemaining = Math.max(0, Math.min(9, parseInt(win.rerollsRemaining, 10)));
    if (isNaN(win.rerollsRemaining)) win.rerollsRemaining = maxRerolls();
    if (win.currentTurn === 1) win.rerollsRemaining = Math.max(win.rerollsRemaining, maxRerolls());
    win.costMult = win.costMult >= 50 ? 100 : (win.costMult <= -50 ? -100 : 0);
    win.outcomes = (win.outcomes || []).slice(0, 4);
    while (win.outcomes.length < 4) win.outcomes.push({ type: "do_nothing" });
  }

  // ---- SVG art (all original; generated from STAT_STYLE) ----
  var defsInjected = false;
  function statKey(name) { return STAT_STYLE[name] ? name : "grey"; }
  function gradId(key) { return "pw-g-" + String(key).toLowerCase().replace(/[^a-z]+/g, "-"); }
  function injectDefs() {
    if (defsInjected && document.getElementById("pw-svg-defs")) return;
    var stops = Object.keys(STAT_STYLE).map(function (k) {
      var s = STAT_STYLE[k];
      return '<linearGradient id="' + gradId(k) + '" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="' + s.g1 + '"/><stop offset="1" stop-color="' + s.g2 + '"/></linearGradient>';
    }).join("");
    var div = document.createElement("div");
    div.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
    div.innerHTML = '<svg id="pw-svg-defs" aria-hidden="true"><defs>' + stops +
      '<linearGradient id="pw-g-frame" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#aab3c2"/><stop offset="1" stop-color="#5d6673"/></linearGradient>' +
      '</defs></svg>';
    document.body.appendChild(div);
    defsInjected = true;
  }
  // The gemstone diamond: rounded rotated square + pewter frame with 4 corner spikes +
  // a top bevel highlight. One path set, scales to any px.
  function makeDiamond(key, px) {
    key = statKey(key);
    var spikes = px >= 24
      ? '<path d="M50 0 L56 12 L44 12 Z  M100 50 L88 56 L88 44 Z  M50 100 L44 88 L56 88 Z  M0 50 L12 44 L12 56 Z" fill="url(#pw-g-frame)"/>'
      : "";
    return '<svg viewBox="0 0 100 100" width="' + px + '" height="' + px + '" aria-hidden="true">' +
      spikes +
      '<path d="M50 8 L92 50 L50 92 L8 50 Z" fill="url(#pw-g-frame)"/>' +
      '<path d="M50 14 L86 50 L50 86 L14 50 Z" fill="url(#' + gradId(key) + ')" stroke="#1c222e" stroke-width="1.5"/>' +
      '<path d="M50 14 L86 50 L50 50 Z" fill="#ffffff" opacity="0.14"/>' +
      '</svg>';
  }
  function coinSvg() {
    return '<svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">' +
      '<circle cx="10" cy="10" r="8.5" fill="#e8b23a" stroke="#8a6414" stroke-width="1.4"/>' +
      '<circle cx="10" cy="10" r="5.2" fill="none" stroke="#8a6414" stroke-width="1"/></svg>';
  }
  function refreshSvg() {
    return '<svg viewBox="0 0 20 20" width="13" height="13" aria-hidden="true">' +
      '<path d="M10 3 a7 7 0 1 0 7 7" fill="none" stroke="#c7ccd6" stroke-width="2"/>' +
      '<path d="M10 0 L14 3.2 L10 6.4 Z" fill="#c7ccd6"/></svg>';
  }
  function gemIconSvg(rarity, processed) {
    var rc = RARITY_COLOR[rarity] || RARITY_COLOR.epic;
    return '<svg viewBox="0 0 56 56" width="52" height="52" aria-hidden="true">' +
      '<rect x="3" y="3" width="50" height="50" rx="7" fill="#182238" stroke="' + rc + '" stroke-width="3"/>' +
      '<path d="M28 12 L41 28 L28 44 L15 28 Z" fill="#8fd7ee" stroke="#3e7f96" stroke-width="1.6"/>' +
      '<path d="M28 12 L41 28 L28 28 Z" fill="#ffffff" opacity="0.35"/>' +
      '<path d="M22 24 L34 24 M28 18 L28 34 M23 32 L33 32" stroke="#1e6f86" stroke-width="1.6" fill="none"/>' +
      (processed
        ? '<g><circle cx="46" cy="46" r="8.5" fill="#c9ccd4" stroke="#5d6673" stroke-width="1.4"/>' +
          '<circle cx="46" cy="46" r="3" fill="#5d6673"/>' +
          '<path d="M46 36.5 v3 M46 52.5 v3 M36.5 46 h3 M52.5 46 h3 M39.5 39.5 l2 2 M50.5 50.5 l2 2 M52.5 39.5 l-2 2 M41.5 50.5 l-2 2" stroke="#5d6673" stroke-width="1.6"/></g>'
        : "") +
      '</svg>';
  }

  // ---- outcome captions (game phrasing; template map is deliberately tiny so the
  // owner can fine-tune wording against real screenshots) ----
  function statDisplay(target) {
    var c = win.config;
    if (target === "willpower") return "Willpower Efficiency";
    if (target === "order") return c.gemType === "chaos" ? "Chaos Points" : "Order Points";
    if (target === "effect1") return c.effect1;
    return c.effect2;
  }
  function outcomeStatKey(o) {
    if (!o || o.type === "do_nothing" || o.type === "reroll_increase" || o.type === "change_gold_cost") return "grey";
    if (o.target === "willpower") return "willpower";
    if (o.target === "order") return "points";
    if (o.target === "effect1") return "slotW";   // slot color, like the game
    if (o.target === "effect2") return "slotE";
    return "grey";
  }
  function captionFor(o) {
    if (!o || o.type === "do_nothing") return '<span class="pw-dim">tap to set</span>';
    var amt = o.amount || 1;
    if (o.type === "raise_effect") {
      var d = (o.target === "willpower" || o.target === "order") ? "+" + amt : "Lv. " + amt;
      return esc(statDisplay(o.target)) + ' <b>' + d + '</b> <span class="pw-up">▲</span>';
    }
    if (o.type === "lower_effect") {
      var d2 = (o.target === "willpower" || o.target === "order") ? "−" + amt : "Lv. " + amt;
      return esc(statDisplay(o.target)) + ' <b>' + d2 + '</b> <span class="pw-dn">▼</span>';
    }
    if (o.type === "change_side_option") return esc(statDisplay(o.target)) + '<br><span class="pw-sub2">Effect Changed</span>';
    if (o.type === "change_gold_cost") return 'Cost <b>' + (o.change > 0 ? "+100%" : "−100%") + '</b>';
    if (o.type === "reroll_increase") return 'View Other Items<br><span class="pw-sub2">+' + (o.change || 1) + ' time' + ((o.change || 1) > 1 ? "s" : "") + '</span>';
    return '<span class="pw-dim">—</span>';
  }

  // ---- styles ----
  function css() {
    return '<style id="pw-style">' +
      '#av-window .pw-metabar{display:flex;gap:8px 14px;flex-wrap:wrap;align-items:center;margin-bottom:10px}' +
      // groups wrap as units — a lone "10" chip orphaned on its own line reads badly
      '#av-window .pw-metabar .grp{display:inline-flex;gap:8px;align-items:center;white-space:nowrap}' +
      '#av-window .pw-metabar .lab{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);font-weight:700}' +
      '#av-window .pw-frame{position:relative;max-width:420px;margin:0 auto;background:linear-gradient(180deg,#131a29 0%,#0e1420 100%);border:1px solid var(--border);outline:1px solid #39414f;outline-offset:-4px;border-radius:12px;padding:16px 14px 14px;font-family:Georgia,"Times New Roman",serif;color:#e7e9ee;box-shadow:0 10px 30px rgba(0,0,0,.45)}' +
      '#av-window .pw-title{text-align:center;font-size:22px;letter-spacing:.08em;color:#f5f7fb;margin:0 0 10px}' +
      '#av-window .pw-head{text-align:center}' +
      '#av-window button{font-family:inherit}' +
      '#av-window .pw-btnreset{background:none;border:0;padding:0;cursor:pointer;color:inherit}' +
      '#av-window .pw-gemname{display:block;margin:6px auto 2px;font-size:17px;background:none;border:0;cursor:pointer}' +
      '#av-window .pw-points{font-size:13px;color:#e7e9ee}' +
      '#av-window .pw-points .q{display:inline-flex;width:15px;height:15px;border-radius:50%;background:#2b8f7c;color:#dff6ef;font-size:10px;align-items:center;justify-content:center;margin-left:5px;font-family:sans-serif;cursor:help}' +
      '#av-window .pw-resetpill{display:block;margin:9px auto;background:#3a3f4a;border:1px solid #4a5160;border-radius:7px;color:#b9bfca;font-size:13px;padding:5px 0;width:72%;text-align:center}' +
      '#av-window .pw-wheel{position:relative;width:300px;height:286px;margin:4px auto}' +
      '#av-window .pw-node{position:absolute;width:96px;background:none;border:0;cursor:pointer;color:#f2f4f8;text-align:center;padding:0}' +
      '#av-window .pw-node .nm{display:block;font-size:12px;line-height:1.15;text-shadow:0 1px 3px #000;margin-top:2px}' +
      // display:table + margin auto: the badge shrink-wraps on its OWN centered line —
      // inline-block let short names ("Chaos Points") pull it beside them instead.
      // Explicit dark background: a bare <button> otherwise renders the UA's white
      // chrome, which drowns the gold digits.
      '#av-window .pw-node .lv{display:table;margin:2px auto 0;background:rgba(8,11,18,.72);border:1px solid rgba(242,201,76,.45);color:#f2c94c;font-size:13px;font-weight:700;padding:0 7px;border-radius:5px;cursor:pointer;text-shadow:0 1px 2px #000}' +
      '#av-window .pw-node .lv:hover{background:rgba(242,201,76,.2);border-color:#f2c94c}' +
      '#av-window .pw-dial{position:absolute;inset:0;pointer-events:none;opacity:.10}' +
      '#av-window .pw-divider{border:0;border-top:1px solid #39414f;margin:8px 0 6px}' +
      '#av-window .pw-hint{text-align:center;color:#d7dbe4;font-size:13px;margin:2px 0 8px}' +
      '#av-window .pw-outcomes{display:grid;grid-template-columns:1fr 1fr 1fr 1fr 56px;gap:6px;align-items:start}' +
      '#av-window .pw-orow{background:none;border:1px solid transparent;border-radius:8px;cursor:pointer;color:#e7e9ee;text-align:center;font-size:11.5px;line-height:1.25;padding:4px 2px}' +
      '#av-window .pw-orow:hover{border-color:#39414f;background:rgba(102,199,255,.05)}' +
      '#av-window .pw-orow .ic{display:block;margin:0 auto 2px;width:22px;height:22px}' +
      '#av-window .pw-up{color:#5fc94f}#av-window .pw-dn{color:#e0533f}' +
      '#av-window .pw-sub2{color:#c8cdd8;font-size:10.5px}' +
      '#av-window .pw-dim{color:#8a93a5;font-style:italic}' +
      '#av-window .pw-rerollpill{align-self:center;display:inline-flex;gap:5px;align-items:center;background:#2c3240;border:1px solid #454c5c;border-radius:8px;color:#e7e9ee;font-size:13px;padding:5px 8px;cursor:pointer;font-variant-numeric:tabular-nums}' +
      '#av-window .pw-footer{margin-top:10px;font-size:14px}' +
      '#av-window .pw-frow{display:flex;justify-content:space-between;align-items:center;padding:4px 2px;border-top:1px solid #232a38}' +
      '#av-window .pw-frow .v{display:inline-flex;gap:6px;align-items:center;font-variant-numeric:tabular-nums}' +
      '#av-window .pw-frow button.v{background:none;border:0;color:#fff;font-size:14px;cursor:pointer;border-radius:6px;padding:2px 6px}' +
      '#av-window .pw-frow button.v:hover{background:rgba(102,199,255,.1)}' +
      '#av-window .pw-balance{color:#b9a7e6}' +
      '#av-window .pw-turnnote{font-size:12px;color:#97a0b4;margin:6px 0 2px;text-align:center}' +
      '#av-window .pw-turnnote b{color:#e0a83f;font-weight:600}' +
      '#av-window .pw-buttons{display:flex;gap:8px;margin-top:8px}' +
      '#av-window .pw-buttons .bc{flex:1;background:#2b313d;border:1px solid #3a4150;border-radius:7px;color:#aab1bd;font-size:14px;padding:9px 0;text-align:center}' +
      '#av-window .pw-buttons .bp{flex:1;background:#39414f;border:1px solid #4a5468;border-radius:7px;color:#fff;font-size:14px;padding:9px 0;text-align:center;cursor:pointer}' +
      '#av-window .pw-buttons .bp:hover{background:#414b5c}' +
      // confidence overlay
      '#av-window .pw-unconfirmed{outline:2px solid #e8b84a;outline-offset:2px;border-radius:8px;animation:pwPulse 1.6s ease-in-out infinite;position:relative}' +
      '@keyframes pwPulse{0%,100%{outline-color:#e8b84a}50%{outline-color:rgba(232,184,74,.25)}}' +
      '#av-window .pw-confstrip{max-width:420px;margin:0 auto 8px;background:rgba(232,184,74,.12);border:1px solid #e8b84a;color:#f0d090;border-radius:8px;font-size:12.5px;padding:7px 11px}' +
      // popover
      '#av-window .pw-pop{position:absolute;z-index:60;background:var(--panel2,#1b2030);border:1px solid var(--border,#2a3142);border-radius:10px;box-shadow:0 12px 30px rgba(0,0,0,.55);padding:10px;min-width:230px;font-family:inherit}' +
      '#av-window .pw-pop h4{margin:0 0 7px;font-size:12px;color:var(--dim,#97a0b4);text-transform:uppercase;letter-spacing:.05em;font-family:sans-serif}' +
      '#av-window .pw-pop .grp{margin-bottom:7px}' +
      '#av-window .pw-pop .grp .gl{font-size:12px;margin-bottom:3px;display:flex;gap:6px;align-items:center}' +
      '#av-window .pw-pop .opts{display:flex;gap:5px;flex-wrap:wrap}' +
      '#av-window .pw-pop button.opt{background:var(--panel,#161a24);border:1px solid var(--border,#2a3142);border-radius:7px;color:var(--text,#e7e9ee);cursor:pointer;padding:6px 10px;font-size:13px;min-width:38px}' +
      '#av-window .pw-pop button.opt:hover{border-color:var(--accent,#66c7ff)}' +
      '#av-window .pw-pop button.opt.on{border-color:var(--accent,#66c7ff);background:rgba(102,199,255,.12)}' +
      '#av-window .pw-pop button.opt:disabled{opacity:.3;cursor:default}' +
      '#av-window .pw-pop .sw{display:inline-block;width:10px;height:10px;border-radius:3px}' +
      '#av-window .pw-pop .pfoot{display:flex;justify-content:flex-end;margin-top:9px;padding-top:9px;border-top:1px solid var(--border,#2a3142)}' +
      '#av-window .pw-pop button.papply{border-color:var(--accent,#66c7ff);color:var(--accent,#66c7ff);font-weight:700}' +
      '#av-window .pw-pop button.papply:hover{background:rgba(102,199,255,.14)}' +
      '@media (max-width:480px){#av-window .pw-pop{position:fixed;left:8px;right:8px;bottom:8px;min-width:0}}' +
      '</style>';
  }

  // ---- render ----
  function conf(key) { return win.unconfirmed[key] ? ' pw-unconfirmed' : ''; }
  function render() {
    if (!host) return;
    injectDefs();
    normalize();
    var c = win.config;
    var N = maxTurns();
    var x = N - win.currentTurn + 1;                      // attempts remaining (game display)
    var freeShown = Math.max(0, win.rerollsRemaining - 1); // model - the paid one
    var freeDenom = Math.max(1, maxRerolls() - 1);
    var unconfN = Object.keys(win.unconfirmed).length;

    var wheelNode = function (pos, key, label, lv, editable, keyId, lvKeyId) {
      var xy = { N: "left:102px;top:0", W: "left:8px;top:88px", E: "left:196px;top:88px", S: "left:102px;top:176px" }[pos];
      return '<div class="pw-node" style="' + xy + '">' +
        '<button type="button" class="pw-btnreset' + conf(keyId) + '" data-act="' + (editable || "") + '" aria-label="' + esc(label) + '">' +
        makeDiamond(key, 64) +
        '<span class="nm">' + esc(label) + '</span></button>' +
        '<button type="button" class="lv' + conf(lvKeyId) + '" data-act="level" data-target="' + lvKeyId + '" aria-label="' + esc(label) + ' level">' + lv + '</button>' +
        '</div>';
    };

    host.innerHTML = css() +
      (unconfN ? '<div class="pw-confstrip">Parsed — <b>' + unconfN + '</b> field' + (unconfN > 1 ? "s" : "") + ' need a look; tap the highlighted ones to confirm.</div>' : "") +
      '<div class="pw-metabar">' +
      '<span class="grp"><span class="lab">Rarity</span>' +
      ["uncommon", "rare", "epic"].map(function (r) {
        return '<button type="button" class="mbtn' + (win.rarity === r ? " active" : "") + '" data-act="rarity" data-v="' + r + '">' + r.charAt(0).toUpperCase() + r.slice(1) + ' (' + RARITY[r].maxTurns + ')</button>';
      }).join("") + '</span>' +
      '<span class="grp"><span class="lab">Base cost</span>' +
      [8, 9, 10].map(function (b) {
        return '<button type="button" class="mbtn' + (c.baseCost === b ? " active" : "") + conf("config.baseCost") + '" data-act="basecost" data-v="' + b + '">' + b + '</button>';
      }).join("") + '</span>' +
      '</div>' +
      '<div class="pw-frame" id="pw-frame">' +
      '  <h3 class="pw-title">Processing</h3>' +
      '  <div class="pw-head">' +
      '    <button type="button" class="pw-btnreset" data-act="rarity-pop" aria-label="Rarity" title="Click to change rarity">' + gemIconSvg(win.rarity, win.currentTurn > 1) + '</button>' +
      '    <button type="button" class="pw-gemname' + conf("config.gemType") + '" data-act="gemtype" style="color:' + (RARITY_COLOR[win.rarity] || "#b06fe0") + '" title="Click to switch Order/Chaos">' +
             esc(c.gemType === "chaos" ? "Chaos Astrogem" : "Order Astrogem") + '</button>' +
      '    <div class="pw-points">' + pointsSum() + ' Astrogem Points<span class="q" title="Derived: the four levels summed. Check it against the number the game shows — a mismatch means a transcription slip.">?</span></div>' +
      '    <div class="pw-resetpill">Reset (1/1)</div>' +
      '  </div>' +
      '  <div class="pw-wheel">' +
      '    <svg class="pw-dial" viewBox="0 0 300 270" aria-hidden="true">' +
      '      <circle cx="150" cy="132" r="106" fill="none" stroke="#8892a3" stroke-width="1.5" stroke-dasharray="5 7"/>' +
      '      <circle cx="150" cy="132" r="76" fill="none" stroke="#8892a3" stroke-width="1"/>' +
      '      <path d="M150 16 v20 M150 228 v20 M34 132 h20 M246 132 h20" stroke="#8892a3" stroke-width="1.5"/>' +
      '    </svg>' +
      wheelNode("N", "willpower", "Willpower Efficiency", c.willpowerLevel, "", "pw-noedit-n", "config.willpowerLevel") +
      wheelNode("W", "slotW", c.effect1, "Lv. " + c.effect1Level, "effect1", "config.effect1", "config.effect1Level") +
      wheelNode("E", "slotE", c.effect2, "Lv. " + c.effect2Level, "effect2", "config.effect2", "config.effect2Level") +
      wheelNode("S", "points", (c.gemType === "chaos" ? "Chaos" : "Order") + " Points", c.orderLevel, "gemtype", "config.gemType2", "config.orderLevel") +
      '  </div>' +
      '  <hr class="pw-divider">' +
      '  <div class="pw-hint">One of the following is randomly applied.</div>' +
      '  <div class="pw-outcomes">' +
      win.outcomes.map(function (o, i) {
        return '<button type="button" class="pw-orow' + conf("outcomes." + i) + '" data-act="outcome" data-i="' + i + '">' +
          '<span class="ic">' + makeDiamond(outcomeStatKey(o), 22) + '</span>' + captionFor(o) + '</button>';
      }).join("") +
      '    <button type="button" class="pw-rerollpill' + conf("state.rerollsRemaining") + '" data-act="rerolls" title="Rerolls — the game counts only the FREE ones here; the paid one is handled in the editor">' +
             refreshSvg() + ' ' + Math.min(freeShown, freeDenom) + ' / ' + freeDenom + '</button>' +
      '  </div>' +
      '  <div class="pw-footer">' +
      '    <div class="pw-frow"><span>Processing Cost</span>' +
      '      <button type="button" class="v' + conf("state.processCostMultiplier") + '" data-act="cost">' + processCost().toLocaleString("en-US") + ' ' + coinSvg() + '</button></div>' +
      '    <div class="pw-frow"><span>Balance</span><span class="v pw-balance">— ' + coinSvg() + '</span></div>' +
      (win.currentTurn === 1 ? '<div class="pw-turnnote">Available after <b>processing 1 time</b></div>' : "") +
      '    <div class="pw-buttons">' +
      '      <span class="bc">Processing Complete</span>' +
      '      <button type="button" class="bp' + conf("state.currentTurn") + '" data-act="turn">Process (' + x + '/' + N + ')</button>' +
      '    </div>' +
      '  </div>' +
      '</div>';
    wire();
  }

  // ---- popover machinery ----
  function closePop() {
    if (pop && pop.el && pop.el.parentNode) pop.el.parentNode.removeChild(pop.el);
    pop = null;
  }
  function openPop(anchor, title, bodyHtml, onClick) {
    // clicking the control that opened the popover closes it (toggle)
    if (pop && pop.anchor === anchor) { closePop(); return; }
    closePop();
    var frame = host.querySelector("#pw-frame");
    var el = document.createElement("div");
    el.className = "pw-pop";
    el.innerHTML = "<h4>" + title + "</h4>" + bodyHtml;
    frame.appendChild(el);
    // position near the anchor, clamped inside the frame
    var fr = frame.getBoundingClientRect(), ar = anchor.getBoundingClientRect();
    if (window.innerWidth > 480) {
      var top = ar.bottom - fr.top + 6;
      var left = Math.max(6, Math.min(fr.width - el.offsetWidth - 6, ar.left - fr.left));
      if (top + el.offsetHeight > fr.height - 6) top = Math.max(6, ar.top - fr.top - el.offsetHeight - 6);
      el.style.top = top + "px"; el.style.left = left + "px";
    }
    el.onclick = function (ev) {
      var b = ev.target.closest ? ev.target.closest("button.opt") : null;
      if (b && !b.disabled) onClick(b);
      ev.stopPropagation();
    };
    pop = { el: el, anchor: anchor };
  }
  function optBtn(v, label, on, disabled, extra) {
    return '<button type="button" class="opt' + (on ? " on" : "") + '"' + (disabled ? " disabled" : "") +
      ' data-v="' + esc(v) + '"' + (extra || "") + '>' + label + '</button>';
  }

  function markConfirmed(key) { if (win.unconfirmed[key]) { delete win.unconfirmed[key]; } }

  // ---- editors ----
  function editLevel(anchor, key) {
    var map = { "config.willpowerLevel": "willpowerLevel", "config.orderLevel": "orderLevel", "config.effect1Level": "effect1Level", "config.effect2Level": "effect2Level" };
    var f = map[key];
    var cur = win.config[f];
    openPop(anchor, "Level", '<div class="opts">' + [1, 2, 3, 4, 5].map(function (v) { return optBtn(v, v, v === cur); }).join("") + '</div>',
      function (b) { win.config[f] = parseInt(b.getAttribute("data-v"), 10); markConfirmed(key); closePop(); render(); emit(); });
  }
  function editEffect(anchor, which) {
    var cur = win.config[which], other = win.config[which === "effect1" ? "effect2" : "effect1"];
    var body = '<div class="opts" style="flex-direction:column;align-items:stretch">' + pool().map(function (e) {
      var s = STAT_STYLE[statKey(e)];
      return optBtn(e, '<span class="sw" style="background:linear-gradient(135deg,' + s.g1 + ',' + s.g2 + ')"></span> ' + esc(e) + (e === other ? ' <span style="opacity:.5;font-size:11px">(other slot)</span>' : ""), e === cur, e === other);
    }).join("") + '</div>';
    openPop(anchor, which === "effect1" ? "Effect 1 (left diamond)" : "Effect 2 (right diamond)", body,
      function (b) { win.config[which] = b.getAttribute("data-v"); markConfirmed("config." + which); closePop(); render(); emit(); });
  }
  function editGemType(anchor) {
    openPop(anchor, "Gem type", '<div class="opts">' +
      optBtn("order", "Order", win.config.gemType === "order") + optBtn("chaos", "Chaos", win.config.gemType === "chaos") + '</div>',
      function (b) { win.config.gemType = b.getAttribute("data-v"); markConfirmed("config.gemType"); markConfirmed("config.gemType2"); closePop(); render(); emit(); });
  }
  function editRarity(anchor) {
    openPop(anchor, "Rarity", '<div class="opts">' + ["uncommon", "rare", "epic"].map(function (r) {
      return optBtn(r, r.charAt(0).toUpperCase() + r.slice(1) + " — " + RARITY[r].maxTurns + " turns", win.rarity === r);
    }).join("") + '</div>',
      function (b) { setRarity(b.getAttribute("data-v")); closePop(); render(); emit(); });
  }
  function editTurn(anchor) {
    var N = maxTurns();
    var body = '<div class="opts">' + Array.apply(null, Array(N)).map(function (_, i) {
      var t = i + 1;
      return optBtn(t, "Turn " + t + " <span style='opacity:.6'>(" + (N - t + 1) + "/" + N + ")</span>", t === win.currentTurn);
    }).join("") + '</div>';
    openPop(anchor, "Current turn — Process (x/" + N + ") shows attempts remaining", body,
      function (b) { win.currentTurn = parseInt(b.getAttribute("data-v"), 10); markConfirmed("state.currentTurn"); closePop(); render(); emit(); });
  }
  function editCost(anchor) {
    openPop(anchor, "Processing cost", '<div class="opts">' +
      optBtn(-100, "0", win.costMult === -100) + optBtn(0, "900", win.costMult === 0) + optBtn(100, "1,800", win.costMult === 100) + '</div>',
      function (b) { win.costMult = parseInt(b.getAttribute("data-v"), 10); markConfirmed("state.processCostMultiplier"); closePop(); render(); emit(); });
  }
  function editRerolls(anchor) {
    var freeDenom = Math.max(1, maxRerolls() - 1);
    var opts = [];
    for (var m = 0; m <= freeDenom + 1; m++) {
      var free = Math.max(0, m - 1);
      var label = m === 0 ? "0 <span style='opacity:.6'>(all spent)</span>"
        : Math.min(free, freeDenom) + "/" + freeDenom + " free " + (m >= 1 ? "+ paid" : "");
      opts.push(optBtn(m, label, win.rerollsRemaining === m));
    }
    var body = '<div class="opts" style="flex-direction:column;align-items:stretch">' + opts.join("") + '</div>' +
      '<div style="font-size:11px;color:var(--dim,#97a0b4);margin-top:6px">The in-game counter shows FREE rerolls only; the final paid reroll (3,800g) is not counted there. Model total = counter + 1 while the paid one is unused.</div>';
    openPop(anchor, "Rerolls remaining (model units)", body,
      function (b) { win.rerollsRemaining = parseInt(b.getAttribute("data-v"), 10); markConfirmed("state.rerollsRemaining"); closePop(); render(); emit(); });
  }
  // ---- "process this outcome" (the game chose it) ----
  // Mirrors model/nested.js _applyProcessStep: cost multiplier ACCUMULATES (never
  // auto-resets), reroll_increase stacks, change_side_option keeps the level and only
  // swaps the name (the player is asked what it rolled into). Entry point: the
  // Process button in the outcome editor — never a bare row click.
  var lastApply = null;   // pre-apply snapshot for undo
  function describeOutcome(o) {
    var amt = o.amount || 1;
    if (o.type === "raise_effect") return statDisplay(o.target) + " +" + amt + " ▲";
    if (o.type === "lower_effect") return statDisplay(o.target) + " −" + amt + " ▼";
    if (o.type === "change_side_option") return statDisplay(o.target) + " → effect changed";
    if (o.type === "change_gold_cost") return "Cost " + (o.change > 0 ? "+" : "") + o.change + "%";
    if (o.type === "reroll_increase") return "View Other Items +" + (o.change || 1);
    return "nothing";
  }
  function applyChosenOutcome(i) {
    var o = win.outcomes[i] || { type: "do_nothing" };
    lastApply = JSON.parse(JSON.stringify(win));
    var c = win.config, amt = o.amount || 1;
    var pickEffect = null;
    if (o.type === "raise_effect") {
      if (o.target === "willpower") c.willpowerLevel = Math.min(5, c.willpowerLevel + amt);
      else if (o.target === "order") c.orderLevel = Math.min(5, c.orderLevel + amt);
      else if (o.target === "effect1") c.effect1Level = Math.min(5, c.effect1Level + amt);
      else if (o.target === "effect2") c.effect2Level = Math.min(5, c.effect2Level + amt);
    } else if (o.type === "lower_effect") {
      if (o.target === "willpower") c.willpowerLevel = Math.max(1, c.willpowerLevel - amt);
      else if (o.target === "order") c.orderLevel = Math.max(1, c.orderLevel - amt);
      else if (o.target === "effect1") c.effect1Level = Math.max(1, c.effect1Level - amt);
      else if (o.target === "effect2") c.effect2Level = Math.max(1, c.effect2Level - amt);
    } else if (o.type === "change_side_option") {
      pickEffect = o.target;   // level stays; the game rolled a new name — ask below
    } else if (o.type === "change_gold_cost") {
      win.costMult = Math.max(-100, Math.min(100, win.costMult + o.change));
    } else if (o.type === "reroll_increase") {
      win.rerollsRemaining = Math.min(9, win.rerollsRemaining + (o.change || 1));
    }
    var finished = win.currentTurn >= maxTurns();
    win.currentTurn = Math.min(maxTurns(), win.currentTurn + 1);
    win.outcomes = [{ type: "do_nothing" }, { type: "do_nothing" }, { type: "do_nothing" }, { type: "do_nothing" }];
    win.unconfirmed = {};
    normalize(); render(); emit();
    if (onAppliedCb) try { onAppliedCb({ outcome: o, description: describeOutcome(o), turn: win.currentTurn, maxTurns: maxTurns(), finished: finished }); } catch (e) {}
    if (pickEffect) {
      var slotBtn = host.querySelector('[data-act="' + pickEffect + '"]');
      editEffect(slotBtn || host.querySelector(".pw-frame"), pickEffect);
    }
  }

  function editOutcome(anchor, i) {
    var c = win.config;
    function raiseRow(target, level) {
      var name = statDisplay(target);
      var s = STAT_STYLE[outcomeStatKey({ type: "raise_effect", target: target })] || STAT_STYLE.grey;
      var btns = [1, 2, 3, 4].map(function (n) {
        return optBtn(JSON.stringify({ type: "raise_effect", target: target, amount: n }), "+" + n, false, level + n > 5);
      }).join("") + optBtn(JSON.stringify({ type: "lower_effect", target: target, amount: 1 }), "−1", false, level <= 1);
      var extra = (target === "effect1" || target === "effect2")
        ? optBtn(JSON.stringify({ type: "change_side_option", target: target }), "Change effect", false, false)
        : "";
      return '<div class="grp"><div class="gl"><span class="sw" style="background:linear-gradient(135deg,' + s.g1 + ',' + s.g2 + ')"></span>' + esc(name) + '</div><div class="opts">' + btns + extra + '</div></div>';
    }
    var body =
      raiseRow("willpower", c.willpowerLevel) +
      raiseRow("order", c.orderLevel) +
      raiseRow("effect1", c.effect1Level) +
      raiseRow("effect2", c.effect2Level) +
      '<div class="grp"><div class="gl">Cost</div><div class="opts">' +
      optBtn(JSON.stringify({ type: "change_gold_cost", change: 100 }), "+100%", false, win.costMult === 100) +
      optBtn(JSON.stringify({ type: "change_gold_cost", change: -100 }), "−100%", false, win.costMult === -100) + '</div></div>' +
      '<div class="grp"><div class="gl">View Other Items</div><div class="opts">' +
      optBtn(JSON.stringify({ type: "reroll_increase", change: 1 }), "+1 time", false, false) +
      optBtn(JSON.stringify({ type: "reroll_increase", change: 2 }), "+2 times", false, false) + '</div></div>' +
      '<div class="grp"><div class="gl">Other</div><div class="opts">' +
      optBtn(JSON.stringify({ type: "do_nothing" }), "— nothing", false, false) + '</div></div>' +
      // Process = "the game applied THIS one": advances the turn, resets the board
      '<div class="pfoot"><button type="button" class="opt papply" data-apply="1" ' +
      'title="The game chose this outcome — apply it and advance to the next turn">Process ▸</button></div>';
    openPop(anchor, "Outcome " + (i + 1), body, function (b) {
      if (b.getAttribute("data-apply")) {
        closePop();
        applyChosenOutcome(i);
        return;
      }
      try { win.outcomes[i] = JSON.parse(b.getAttribute("data-v")); } catch (e) {}
      markConfirmed("outcomes." + i);
      closePop(); render(); emit();
    });
  }

  function setRarity(r) {
    if (!RARITY[r]) return;
    var wasFull = win.rerollsRemaining >= maxRerolls();
    win.rarity = r;
    win.currentTurn = Math.min(win.currentTurn, maxTurns());
    if (wasFull || win.rerollsRemaining > 9) win.rerollsRemaining = maxRerolls();
  }

  // ---- wiring ----
  function wire() {
    host.onclick = function (ev) {
      var t = ev.target;
      var btn = t.closest ? t.closest("button") : null;
      if (!btn) { closePop(); return; }
      var act = btn.getAttribute("data-act");
      if (!act) return;
      if (act === "rarity") { setRarity(btn.getAttribute("data-v")); render(); emit(); return; }
      if (act === "rarity-pop") { editRarity(btn); return; }
      if (act === "basecost") { win.config.baseCost = parseInt(btn.getAttribute("data-v"), 10); markConfirmed("config.baseCost"); render(); emit(); return; }
      if (act === "gemtype") { editGemType(btn); return; }
      if (act === "effect1") { editEffect(btn, "effect1"); return; }
      if (act === "effect2") { editEffect(btn, "effect2"); return; }
      if (act === "level") { editLevel(btn, btn.getAttribute("data-target")); return; }
      if (act === "outcome") { editOutcome(btn, parseInt(btn.getAttribute("data-i"), 10)); return; }
      if (act === "rerolls") { editRerolls(btn); return; }
      if (act === "cost") { editCost(btn); return; }
      if (act === "turn") { editTurn(btn); return; }
    };
    document.addEventListener("keydown", escClose);
  }
  function escClose(ev) { if (ev.key === "Escape") closePop(); }

  function emit() {
    if (onChangeCb) try { onChangeCb({ unconfirmed: Object.keys(win.unconfirmed).length }); } catch (e) {}
  }

  // ---- public API ----
  var API = {
    init: function (hostEl, opts) {
      host = hostEl;
      onChangeCb = (opts && opts.onChange) || null;
      onAppliedCb = (opts && opts.onApplied) || null;
      render();
    },
    // revert the last Process (one level deep)
    undoApply: function () {
      if (!lastApply) return false;
      win = lastApply;
      lastApply = null;
      normalize(); render(); emit();
      return true;
    },
    getState: function () {
      normalize();
      var c = win.config;
      return {
        config: { baseCost: c.baseCost, gemType: c.gemType, willpowerLevel: c.willpowerLevel, orderLevel: c.orderLevel,
          effect1: c.effect1, effect1Level: c.effect1Level, effect2: c.effect2, effect2Level: c.effect2Level },
        currentTurn: win.currentTurn,
        maxTurns: maxTurns(),
        rerollsRemaining: win.rerollsRemaining,
        processCost: processCost(),
        processCostMultiplier: win.costMult,
        totalGoldSpent: 0,
        rosterBound: false,
        outcomes: win.outcomes.map(function (o) { return JSON.parse(JSON.stringify(o)); }),
        history: []
      };
    },
    setParsed: function (parsed) {
      if (!parsed) return;
      var cfg = parsed.config || {}, st = parsed.state || {};
      win.rarity = parsed.rarity ||
        (st.maxTurns === 5 ? "uncommon" : st.maxTurns === 7 ? "rare" : "epic");
      win.config = {
        baseCost: cfg.baseCost, gemType: cfg.gemType,
        willpowerLevel: cfg.willpowerLevel, orderLevel: cfg.orderLevel,
        effect1: cfg.effect1, effect1Level: cfg.effect1Level,
        effect2: cfg.effect2, effect2Level: cfg.effect2Level
      };
      win.currentTurn = st.currentTurn || 1;
      win.rerollsRemaining = st.rerollsRemaining != null ? st.rerollsRemaining : maxRerolls();
      win.costMult = st.processCostMultiplier || 0;
      win.outcomes = (parsed.outcomes || []).slice(0, 4);
      // confidence -> "confirm me" marks (threshold 0.8; see ocr/engine.js contract)
      win.unconfirmed = {};
      var CT = 0.8;
      var conf = parsed.confidence;
      if (conf) {
        var cc = conf.config || {}, sc = conf.state || {}, oc = conf.outcomes || [];
        Object.keys(cc).forEach(function (k) { if (cc[k] != null && cc[k] < CT) win.unconfirmed["config." + k] = 1; });
        ["currentTurn", "rerollsRemaining", "processCostMultiplier"].forEach(function (k) {
          if (sc[k] != null && sc[k] < CT) win.unconfirmed["state." + k] = 1;
        });
        oc.forEach(function (v, i) { if (v != null && v < CT) win.unconfirmed["outcomes." + i] = 1; });
      }
      render(); emit();
    },
    clearUnconfirmed: function () { win.unconfirmed = {}; render(); emit(); },
    unconfirmedCount: function () { return Object.keys(win.unconfirmed).length; }
  };
  root.AdvisorWindow = API;
})(typeof window !== "undefined" ? window : this);
