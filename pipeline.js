/**
 * pipeline.js — "Pipeline Tables" tab.
 *
 * Strategic "which gems to cut / fuse / throw away" view, built on the closed-form
 * core (model/astrogem.js, attached to window). Two modes:
 *
 *   BAKED  fetch data/pipeline.json and render the six fixed gold tiers
 *          (500k, 1M, 1.5M, 2.5M, 3.5M, 5M), NRB + RB, exactly like the deployed
 *          astrogem-pipeline-table page (sticky baseline rows; per cost x tier
 *          gem-value cells; weekly-throughput pipeline columns).
 *
 *   LIVE   any gold-per-1%-damage + baseline. The per-gem cut/fuse/throw value
 *          table is recomputed DIRECTLY from the closed-form core (instant); the
 *          per-week throughput numbers are interpolated from the dense baked grid.
 *
 * VERDICT COLORS (per gem, vs baseline & reset economics):
 *   GREEN       directEV >= 20k  -> worth resetting if below baseline (reroll once)
 *   YELLOW-DIM  directEV > 0     -> cut, don't reset
 *   RED         directEV <= 0    -> don't cut
 *   PURPLE      fuse3 > directEV  AND directEV < reset floor -> fuse before cutting
 *
 * Everything closed-form: window.tierExpectedValue / goldValue / fusionValueForTier
 * / scoreDistributionForTier. Reuses the dark-theme classes in styles.css; a small
 * SCOPED <style> block adds the bucket-grid + verdict-cell styles (not in styles.css).
 */
(function () {
  "use strict";

  // ---- constants mirrored from the core / collector (display only) ----
  var FIXED_GPD = [500000, 1000000, 1500000, 2500000, 3500000, 5000000];
  var COSTS = [8, 9, 10];
  var TIERS = ["legendary", "relic", "ancient"];
  var TIER_LABEL = { legendary: "Leg", relic: "Relic", ancient: "Anc" };
  var RARITIES = ["uncommon", "rare", "epic"];
  var GREEN_GOLD = 20000;   // >= 20k: worth resetting (task spec)
  var SLOTS = 24;

  var DATA = null;          // baked data/pipeline.json (lazy-fetched)
  var MODE = "baked";       // 'baked' | 'live'
  var ROSTER = "nrb";       // 'nrb' | 'rb'   (live mode toggle)
  // baseline is now a %-DAMAGE threshold (weakest equipped gem's % damage).
  var LIVE = { gpd: 1500000, baseline: 1.0 };
  // The discrete baselines baked into data/pipeline.json (see collect-stats.js).
  var BAKED_BASELINES = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5];

  // ---------------------------------------------------------------------------
  // formatting
  // ---------------------------------------------------------------------------
  function fmtGold(g) {
    g = Math.round(g);
    if (g >= 1000000) {
      var m = (g / 1000000).toFixed(g >= 10000000 ? 0 : 2);
      m = m.replace(/\.?0+$/, ""); // strip trailing zeros AND a bare dot
      return m + "M";
    }
    if (g >= 1000) {
      var k = (g / 1000).toFixed(g >= 100000 ? 0 : 1);
      k = k.replace(/\.0$/, "");
      return k + "k";
    }
    return String(g);
  }
  function fmtGoldFull(g) { return Math.round(g).toLocaleString("en-US"); }
  function fmtPct(p) { return (p * 100).toFixed(1) + "%"; }
  function fmtNum(x, dp) { return x == null ? "—" : Number(x).toFixed(dp == null ? 2 : dp); }

  // ---------------------------------------------------------------------------
  // verdict logic (closed-form, per gem)
  // ---------------------------------------------------------------------------
  // directEV  = E[direct sale gold] for a random gem of this tier (>= baseline part)
  // fuse3     = per-gem value of fusing 3 of this tier
  // Returns { cls, label, reset } where cls drives the cell background.
  function verdict(directEV, fuse3) {
    if (directEV >= GREEN_GOLD) {
      return { cls: "v-green", label: "reset if below BL", reset: true };
    }
    if (directEV > 0) {
      // If fusing is strictly better than the (weak) cut value, prefer fusing.
      if (fuse3 > directEV) return { cls: "v-purple", label: "fuse before cutting", reset: false };
      return { cls: "v-yellow", label: "cut, don't reset", reset: false };
    }
    // directEV <= 0
    if (fuse3 > 0) return { cls: "v-purple", label: "fuse before cutting", reset: false };
    return { cls: "v-red", label: "don't cut", reset: false };
  }

  // ---------------------------------------------------------------------------
  // closed-form cell (used by LIVE; mirrors what the collector bakes)
  // ---------------------------------------------------------------------------
  function liveCell(cost, baseline, gpd) {
    var ev = window.tierExpectedValue(cost, baseline, gpd);
    var per = {};
    for (var i = 0; i < TIERS.length; i++) {
      var tier = TIERS[i];
      var dist = window.scoreDistributionForTier(cost, tier);
      var pAbove = 0, dExp = 0, sw = 0;
      dist.forEach(function (p, sc) {
        if (sc >= baseline) { pAbove += p; dExp += p * window.goldValue(sc, baseline, gpd); sw += p * sc; }
      });
      per[tier] = {
        pAbove: pAbove,
        avgAbove: pAbove > 0 ? sw / pAbove : baseline,
        directEV: dExp,
        fullEV: ev[tier],
        fuse3: window.fusionValueForTier(tier, cost, baseline, gpd)
      };
    }
    return per;
  }

  // ---------------------------------------------------------------------------
  // baked-grid lookup + interpolation (for LIVE throughput)
  // ---------------------------------------------------------------------------
  function cellKey(gpd, bl, cost) { return gpd + "_" + bl + "_" + cost; }

  function nearestGpdAnchors(gpd) {
    var anchors = (DATA && DATA.meta && DATA.meta.anchorGpd) || FIXED_GPD;
    if (gpd <= anchors[0]) return [anchors[0], anchors[0]];
    if (gpd >= anchors[anchors.length - 1]) { var hi = anchors[anchors.length - 1]; return [hi, hi]; }
    for (var i = 0; i < anchors.length - 1; i++) {
      if (gpd >= anchors[i] && gpd <= anchors[i + 1]) return [anchors[i], anchors[i + 1]];
    }
    return [anchors[0], anchors[0]];
  }

  // Nearest baked baselines bracketing `bl` (the baked baseline axis is the discrete
  // BAKED_BASELINES list, not consecutive integers).
  function nearestBaselineAnchors(bl) {
    var baked = (DATA && DATA.meta && DATA.meta.bakedBaselines) || BAKED_BASELINES;
    if (bl <= baked[0]) return [baked[0], baked[0]];
    if (bl >= baked[baked.length - 1]) { var hi = baked[baked.length - 1]; return [hi, hi]; }
    for (var i = 0; i < baked.length - 1; i++) {
      if (bl >= baked[i] && bl <= baked[i + 1]) return [baked[i], baked[i + 1]];
    }
    return [baked[0], baked[0]];
  }

  // Bilinear interpolate a throughput field across (gpd, baseline) from the grid.
  function interpThru(cost, rarity, field, gpd, baseline) {
    if (!DATA) return null;
    var blAnc = nearestBaselineAnchors(baseline);
    var blLo = blAnc[0], blHi = blAnc[1];
    var anc = nearestGpdAnchors(gpd);
    var gLo = anc[0], gHi = anc[1];
    function val(g, bl) {
      var c = DATA.cells[cellKey(g, bl, cost)];
      if (!c) return null;
      if (field === "boxEV" || field === "avgScore" || field === "cpGain") return c[field];
      return c.thru && c.thru[rarity] ? c.thru[rarity][field] : null;
    }
    var v00 = val(gLo, blLo), v01 = val(gLo, blHi), v10 = val(gHi, blLo), v11 = val(gHi, blHi);
    if (v00 == null) return null;
    var tb = blHi === blLo ? 0 : (baseline - blLo) / (blHi - blLo);
    var tg = gHi === gLo ? 0 : (gpd - gLo) / (gHi - gLo);
    var lo = v00 + (v01 - v00) * tb;
    var hi = (v10 == null ? lo : v10) + ((v11 == null ? (v10 == null ? lo : v10) : v11) - (v10 == null ? lo : v10)) * tb;
    return lo + (hi - lo) * tg;
  }

  // ---------------------------------------------------------------------------
  // rendering: one gem-value cell (4 micro-rows: the 3 tiers + a "fresh cut" row)
  // ---------------------------------------------------------------------------
  // We render per cost a stacked cell of the three tiers (Leg / Relic / Anc), each
  // showing its direct-sale gold EV + P(above baseline) + reset/fuse glyph, colored
  // by verdict. This mirrors the deployed page's 4-row bucket cell, keyed to the
  // closed-form tier values the core actually computes.
  function gemCell(perTier, roster, sep) {
    var rows = "";
    for (var i = 0; i < TIERS.length; i++) {
      var tier = TIERS[i];
      var p = perTier[tier];
      var v = verdict(p.directEV, p.fuse3);
      // Roster-bound gems are free to cut: always at least "cut" (never red on cost).
      var cls = v.cls;
      if (roster === "rb" && cls === "v-red" && p.fuse3 > 0) cls = "v-purple";
      var glyph = v.reset ? "↻" : (cls === "v-purple" ? "⚜" : "");
      rows += '<div class="bkt-row ' + cls + '">'
        + '<span class="bkt-label ' + tier + '">' + TIER_LABEL[tier] + '</span>'
        + '<span class="bkt-val">' + fmtGold(p.directEV) + '</span>'
        + '<span class="bkt-pct">' + fmtPct(p.pAbove) + '</span>'
        + '<span class="bkt-reset">' + glyph + '</span>'
        + '</div>';
    }
    return '<td class="gem' + (sep ? " sep" : "") + '"><div class="bkt-grid">' + rows + '</div></td>';
  }

  // weeks color band
  function weeksClass(w) {
    if (w == null) return "slow";
    if (w <= 8) return "fast";
    if (w <= 26) return "med";
    return "slow";
  }

  // ---------------------------------------------------------------------------
  // BAKED table for one gpd tier
  // ---------------------------------------------------------------------------
  function bakedTable(gpd, roster) {
    var baked = (DATA.meta && DATA.meta.bakedBaselines) || BAKED_BASELINES;
    var win = (DATA.meta.baselineWindow && DATA.meta.baselineWindow[gpd]) || [baked[0], baked[baked.length - 1]];
    var blMin = win[0], blMax = win[1];
    // The baselines (from the baked set) that fall inside this gpd's window.
    var rowBaselines = baked.filter(function (b) { return b >= blMin - 1e-9 && b <= blMax + 1e-9; });
    var isNrb = roster === "nrb";

    var head = '<table class="pipe-table"><thead>'
      + '<tr><th rowspan="2">BL</th>'
      + '<th colspan="3" class="sep">Uncommon</th>'
      + '<th colspan="3" class="sep">Rare</th>'
      + '<th colspan="3" class="sep">Epic</th>'
      + (isNrb ? '<th colspan="6" class="sep">Pipeline (per-week)</th>' : '')
      + '</tr><tr>'
      + '<th class="sep">c8</th><th>c9</th><th>c10</th>'
      + '<th class="sep">c8</th><th>c9</th><th>c10</th>'
      + '<th class="sep">c8</th><th>c9</th><th>c10</th>'
      + (isNrb
        ? '<th class="sep">Box EV</th><th>Direct/wk</th><th>Fuse/wk</th><th>Total/wk</th><th>Weeks</th><th>Gold/wk</th>'
        : '')
      + '</tr></thead><tbody>';

    var body = "";
    for (var bli = 0; bli < rowBaselines.length; bli++) {
      var bl = rowBaselines[bli];
      var row = '<tr><td class="pipe blcell"><b>' + bl + '</b></td>';
      // 9 gem cells: rarity x cost. (Closed-form tier values don't depend on rarity;
      // the rarity blocks differ only in the throughput columns. We still render the
      // three rarity blocks so the layout matches the deployed page; the per-tier
      // gold/% is identical across rarities by construction of the closed-form core.)
      for (var ri = 0; ri < RARITIES.length; ri++) {
        for (var ci = 0; ci < COSTS.length; ci++) {
          var c = DATA.cells[cellKey(gpd, bl, COSTS[ci])];
          row += gemCell(c.tiers, roster, ci === 0);
        }
      }
      if (isNrb) {
        // Pipeline columns use the c9 cell as the representative cut target (the
        // deployed page's pipeline is a single per-baseline lane; c9 is the
        // canonical "best random cut" cost). Box EV / avg score are cost-invariant.
        var rep = DATA.cells[cellKey(gpd, bl, 9)];
        var uc = rep.thru.uncommon;
        row += '<td class="pipe sep num">' + fmtGoldFull(rep.boxEV) + '</td>'
          + '<td class="pipe num">' + fmtNum(uc.directPerWk) + '</td>'
          + '<td class="pipe num">' + fmtNum(uc.fusePerWk) + '</td>'
          + '<td class="pipe num"><b>' + fmtNum(uc.totalPerWk) + '</b></td>'
          + '<td class="pipe num ' + weeksClass(uc.weeks) + '">' + (uc.weeks == null ? "—" : uc.weeks) + '</td>'
          + '<td class="pipe num">' + fmtGold(uc.goldPerWk) + '/wk</td>';
      }
      row += "</tr>";
      body += row;
    }
    return head + body + "</tbody></table>";
  }

  // ---------------------------------------------------------------------------
  // LIVE table (closed-form, any gpd/baseline)
  // ---------------------------------------------------------------------------
  function liveResults() {
    var gpd = LIVE.gpd, bl = LIVE.baseline, roster = ROSTER;

    // Per-gem closed-form table for the three costs.
    var cells = {};
    for (var ci = 0; ci < COSTS.length; ci++) cells[COSTS[ci]] = liveCell(COSTS[ci], bl, gpd);

    var gemTbl = '<table class="pipe-table live"><thead><tr>'
      + '<th>Tier</th><th class="sep">c8 direct EV</th><th>c8 fuse/gem</th><th>c8 verdict</th>'
      + '<th class="sep">c9 direct EV</th><th>c9 fuse/gem</th><th>c9 verdict</th>'
      + '<th class="sep">c10 direct EV</th><th>c10 fuse/gem</th><th>c10 verdict</th>'
      + '</tr></thead><tbody>';
    for (var ti = 0; ti < TIERS.length; ti++) {
      var tier = TIERS[ti];
      var rowHtml = '<tr><td class="' + tier + '"><b>' + tier.charAt(0).toUpperCase() + tier.slice(1) + '</b></td>';
      for (var cj = 0; cj < COSTS.length; cj++) {
        var p = cells[COSTS[cj]][tier];
        var v = verdict(p.directEV, p.fuse3);
        var vcls = v.cls;
        if (roster === "rb" && vcls === "v-red" && p.fuse3 > 0) vcls = "v-purple";
        var glyph = v.reset ? " ↻" : (vcls === "v-purple" ? " ⚜" : "");
        rowHtml += '<td class="sep num">' + fmtGold(p.directEV)
          + ' <span class="dim">(' + fmtPct(p.pAbove) + ')</span></td>'
          + '<td class="num">' + fmtGold(p.fuse3) + '</td>'
          + '<td class="' + vcls + ' verdict-cell">' + v.label + glyph + '</td>';
      }
      rowHtml += "</tr>";
      gemTbl += rowHtml;
    }
    gemTbl += "</tbody></table>";

    // Throughput (interpolated from baked grid), per rarity.
    var thruTbl = "";
    if (DATA) {
      thruTbl = '<h2>Weekly throughput (interpolated)</h2>'
        + '<table class="pipe-table"><thead><tr>'
        + '<th>Rarity</th><th class="sep num">Direct/wk</th><th class="num">Fuse/wk</th>'
        + '<th class="num">Total/wk</th><th class="num">Weeks to ' + SLOTS + '</th>'
        + '<th class="num">Gold/wk</th></tr></thead><tbody>';
      for (var rj = 0; rj < RARITIES.length; rj++) {
        var rar = RARITIES[rj];
        var d = interpThru(9, rar, "directPerWk", gpd, bl);
        var f = interpThru(9, rar, "fusePerWk", gpd, bl);
        var tot = (d || 0) + (f || 0);
        var wk = tot > 0 ? SLOTS / tot : null;
        var gold = interpThru(9, rar, "goldPerWk", gpd, bl);
        thruTbl += '<tr><td><b>' + rar + '</b></td>'
          + '<td class="sep num">' + fmtNum(d) + '</td>'
          + '<td class="num">' + fmtNum(f) + '</td>'
          + '<td class="num"><b>' + fmtNum(tot) + '</b></td>'
          + '<td class="num ' + weeksClass(wk) + '">' + (wk == null ? "—" : wk.toFixed(1)) + '</td>'
          + '<td class="num">' + (gold == null ? "—" : fmtGold(gold) + "/wk") + '</td></tr>';
      }
      var boxEV = interpThru(9, null, "boxEV", gpd, bl);
      var cp = interpThru(9, null, "cpGain", gpd, bl);
      thruTbl += '</tbody></table>'
        + '<p class="note">Box EV (weekly box gold above baseline): <b>'
        + (boxEV == null ? "—" : fmtGoldFull(boxEV)) + '</b> · '
        + 'avg keeper combat-power gain: <b>' + (cp == null ? "—" : (cp).toFixed(2) + "%") + '</b> '
        + '(damage of the average equipped gem above baseline). '
        + 'Throughput numbers interpolate the dense baked grid; the per-gem table above is exact closed-form.</p>';
    }

    return '<h2>Per-gem value — ' + fmtGold(gpd) + ' gold / 1% damage, baseline ' + bl + '% dmg'
      + ' (' + (roster === "nrb" ? "Non-Roster Bound" : "Roster Bound") + ')</h2>'
      + '<p class="note">Direct EV = E[direct sale gold] of a random gem in that tier. '
      + 'Scores are real % damage (a perfect gem is ~1.3–1.4% damage); baseline is the % damage '
      + 'of your weakest equipped gem. Fuse/gem = value of fusing 3 of that tier. '
      + 'Verdict compares them to the reset floor (' + fmtGold(GREEN_GOLD) + ').</p>'
      + gemTbl + thruTbl;
  }

  // ---------------------------------------------------------------------------
  // BAKED view (all six gpd tiers, NRB then RB)
  // ---------------------------------------------------------------------------
  function bakedResults() {
    var out = "";
    out += '<h1 class="sec" id="nrb">Non-Roster Bound</h1>';
    for (var i = 0; i < FIXED_GPD.length; i++) {
      out += '<h2>' + fmtGold(FIXED_GPD[i]) + ' gold / 1% damage — NRB</h2>' + bakedTable(FIXED_GPD[i], "nrb");
    }
    out += '<h1 class="sec" id="rb">Roster Bound</h1>'
      + '<p class="note">Roster-bound gems are free to cut — always cut. Per-tier gold EV and % above baseline shown (no pipeline lane).</p>';
    for (var j = 0; j < FIXED_GPD.length; j++) {
      out += '<h2>' + fmtGold(FIXED_GPD[j]) + ' gold / 1% damage — RB</h2>' + bakedTable(FIXED_GPD[j], "rb");
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // legend + methodology
  // ---------------------------------------------------------------------------
  function legendHtml() {
    return '<div class="legend-box">'
      + '<div class="lg-title">How to read these tables</div>'
      + '<div class="grid c2">'
      + '<div>'
      + '<div class="lg-h">Gem cells (per tier)</div>'
      + '<p class="note">Each cost cell stacks the three tiers — <span class="legendary">Leg</span> / '
      + '<span class="relic">Relic</span> / <span class="ancient">Anc</span>. Per row: '
      + '<b>direct-sale gold EV</b> (left) and <b>% of that tier above baseline</b> (right). '
      + 'A gem must beat the baseline (a %-damage threshold) to be an upgrade.</p>'
      + '<div class="lg-h">Verdict colors</div>'
      + '<p><span class="sw v-green"></span> <b>Green</b> (≥ ' + fmtGold(GREEN_GOLD) + ') — worth resetting if below baseline (↻)<br>'
      + '<span class="sw v-yellow"></span> <b>Yellow-dim</b> (&gt; 0) — cut, don\'t reset<br>'
      + '<span class="sw v-red"></span> <b>Red</b> (≤ 0) — don\'t cut<br>'
      + '<span class="sw v-purple"></span> <b>Purple</b> (⚜) — fuse before cutting (fusing beats the weak cut value)</p>'
      + '</div>'
      + '<div>'
      + '<div class="lg-h">Pipeline (NRB only, per week)</div>'
      + '<p class="note"><b>Box EV</b> — weekly box gold above baseline.<br>'
      + '<b>Direct/wk</b> — above-baseline gems/week from cutting.<br>'
      + '<b>Fuse/wk</b> — above-baseline gems/week from recycling fodder.<br>'
      + '<b>Total/wk</b> = Direct + Fuse · <b>Weeks</b> = ' + SLOTS + ' / Total/wk.<br>'
      + '<span class="sw fast"></span>≤8 &nbsp; <span class="sw med"></span>8–26 &nbsp; <span class="sw slow"></span>&gt;26 weeks</p>'
      + '<div class="lg-h">Fusion (per the core)</div>'
      + '<p class="note">3 Leg → 99/1/0 · 1R+2L → 73/25/2 · 1A+2L → 35/40/25 (L/R/A). 500g per fusion. '
      + 'Below-baseline outputs are recycled as fodder.</p>'
      + '</div></div></div>';
  }

  function methodologyHtml() {
    return '<details class="method"><summary>Methodology</summary>'
      + '<p><b>Scoring is real % damage.</b> Damage is multiplicative, so each line is scored '
      + '<b>D = 100·ln(multiplier)</b> (additive in log space, ≈ % damage). Per-level values, '
      + 'derived from real stat baselines: Attack Power ≈ 0.0325/lvl; Additional Damage ≈ 0.0598/lvl; '
      + 'Boss Damage ≈ 0.0823/lvl; Order ≈ 0.1599 <i>per point</i> (flat, level×0.1599); Willpower ≈ ±0.0781 per '
      + 'cost-level vs cost 4 (cost = baseCost−wpLevel). Support lines score 0. A gem\'s total score ≈ its % damage '
      + '(a perfect gem ≈ 1.3–1.4%).</p>'
      + '<p><b>Tiers</b> by level-sum (WP+Order+E1+E2, each 1–5): legendary 4–15, relic 16–18, ancient 19–20. '
      + 'Within a tier P(level-sum) ∝ number of 4-stat partitions; stats are <i>uniform over partitions</i> of the sum.</p>'
      + '<p><b>Gold value.</b> Direct = max(0,(score−baseline))×goldPerDamage, where goldPerDamage is gold per <b>1% damage</b> '
      + 'and baseline is a <b>%-damage</b> threshold (your weakest equipped gem). A below-baseline gem is fodder; its value is '
      + 'the per-gem fusion value, resolved with the tier EVs as a 3×3 fixed point (a fused output may itself be above/below baseline).</p>'
      + '<p><b>Throughput.</b> A documented weekly model: Direct/wk = weekly cut budget × P(above baseline) over the fresh-cut '
      + 'tier mix; Fuse/wk recycles below-baseline cuts (3→1) through the legendary fusion lane; Total/wk = Direct+Fuse; '
      + 'Weeks = ' + SLOTS + '/Total/wk. The exact weekly-budget / box-schedule constants of the original page were not part of '
      + 'the model core, so they are reconstructed and documented (METHODOLOGY.md).</p>'
      + '<p><b>Caveat — superseded model.</b> Earlier versions scored gems with abstract weights (WP ±2.4, ATK 1.0, '
      + 'AddDmg 1.85, Boss 2.55, Order 5.14) and converted score→gold via 30.96 score = 1% damage. That is superseded: '
      + 'the score IS % damage now. <b>Modeling flag:</b> the deployed reference page SAMPLED the per-gem stat distribution '
      + 'with a sequential, non-uniform partition sampler; this core is uniform over partitions and runs ~10–30% higher at '
      + 'the tier level (worst for relic). See METHODOLOGY.md.</p>'
      + '</details>';
  }

  // ---------------------------------------------------------------------------
  // inputs (sticky, collapsible) — only meaningful in LIVE mode
  // ---------------------------------------------------------------------------
  function inputsHtml() {
    return '<div class="inputs" id="pl-inputs">'
      + '<div class="ihdr"><span>Pipeline inputs</span>'
      + '<span class="tgl" id="pl-caret" onclick="window.__plToggleInputs()">▾</span></div>'
      + '<div id="pl-inbody">'
      + '<div class="barrow">'
      + '<span class="mbtn ' + (MODE === "baked" ? "active" : "") + '" id="pl-m-baked" onclick="window.__plSetMode(\'baked\')">Baked tiers</span>'
      + '<span class="mbtn ' + (MODE === "live" ? "active" : "") + '" id="pl-m-live" onclick="window.__plSetMode(\'live\')">Live</span>'
      + '<span style="width:14px"></span>'
      + '<span class="mbtn ' + (ROSTER === "nrb" ? "active" : "") + '" id="pl-r-nrb" onclick="window.__plSetRoster(\'nrb\')">Non-Roster Bound</span>'
      + '<span class="mbtn ' + (ROSTER === "rb" ? "active" : "") + '" id="pl-r-rb" onclick="window.__plSetRoster(\'rb\')">Roster Bound</span>'
      + '</div>'
      + '<div class="ig" id="pl-live-fields" style="' + (MODE === "live" ? "" : "display:none") + '">'
      + '<div class="fld"><label>Gold per 1% damage</label>'
      + '<input id="pl-gpd" type="number" min="100000" step="50000" value="' + LIVE.gpd + '"></div>'
      + '<div class="fld"><label>Baseline (weakest equipped % dmg)</label>'
      + '<input id="pl-bl" type="number" min="0" max="3" step="0.05" value="' + LIVE.baseline + '"></div>'
      + '<div class="fld" style="align-self:end"><button class="primary" onclick="window.__plRecalc()">Recalculate</button></div>'
      + '</div>'
      + '<p class="note" id="pl-mode-note">' + modeNote() + '</p>'
      + '</div></div>';
  }
  function modeNote() {
    return MODE === "baked"
      ? "Baked view: the six fixed gold tiers (500k · 1M · 1.5M · 2.5M · 3.5M · 5M), straight from data/pipeline.json."
      : "Live view: per-gem table recomputed instantly from the closed-form core for any gold/baseline; weekly throughput interpolated from the dense grid.";
  }

  // ---------------------------------------------------------------------------
  // scoped styles (NOT in styles.css — verdict cells + bucket grid)
  // ---------------------------------------------------------------------------
  function scopedStyle() {
    return '<style>'
      + '#tab-pipeline .legend-box{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin:8px 0 16px}'
      + '#tab-pipeline .legend-box .lg-title{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:var(--accent);font-weight:700;margin-bottom:10px}'
      + '#tab-pipeline .lg-h{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--accent);font-weight:700;margin:10px 0 4px}'
      + '#tab-pipeline .sw{display:inline-block;width:13px;height:13px;border-radius:3px;vertical-align:middle;margin-right:5px;border:1px solid #0006}'
      + '#tab-pipeline h1.sec{font-size:16px;color:var(--accent);border-top:2px solid var(--border);padding-top:16px;margin-top:30px}'
      + '#tab-pipeline .pipe-table{width:auto;min-width:100%;font-size:12.5px;margin:6px 0 8px}'
      + '#tab-pipeline .pipe-table th{position:sticky;top:0;background:var(--panel2);z-index:2;text-align:center;white-space:nowrap}'
      + '#tab-pipeline .pipe-table td{padding:0;text-align:center;vertical-align:top;border-bottom:1px solid var(--border)}'
      + '#tab-pipeline .pipe-table td.pipe{padding:5px 8px;vertical-align:middle}'
      + '#tab-pipeline .pipe-table td.blcell{font-weight:700;color:var(--text)}'
      + '#tab-pipeline .sep{border-left:2px solid var(--border)!important}'
      + '#tab-pipeline .bkt-grid{display:flex;flex-direction:column}'
      + '#tab-pipeline .bkt-row{display:flex;align-items:center;min-height:22px;padding:1px 5px;gap:6px;border-bottom:1px solid #0003}'
      + '#tab-pipeline .bkt-row:last-child{border-bottom:none}'
      + '#tab-pipeline .bkt-label{width:34px;text-align:left;font-size:10px;font-weight:700;flex-shrink:0}'
      + '#tab-pipeline .bkt-val{flex:1;text-align:right;font-weight:700;font-variant-numeric:tabular-nums}'
      + '#tab-pipeline .bkt-pct{width:42px;text-align:right;color:#cbd2e0;font-size:10.5px;flex-shrink:0}'
      + '#tab-pipeline .bkt-reset{width:14px;text-align:center;font-size:12px;color:#bfe7c8;flex-shrink:0}'
      + '#tab-pipeline .verdict-cell{font-size:11px;font-weight:700;padding:5px 8px;white-space:nowrap}'
      // verdict backgrounds (dark, legible)
      + '#tab-pipeline .v-green{background:#1b4a30!important;color:#9be8b4}'
      + '#tab-pipeline .v-yellow{background:#4a4012!important;color:#f0d68a}'
      + '#tab-pipeline .v-red{background:#4a1c1c!important;color:#ef9a9a}'
      + '#tab-pipeline .v-purple{background:#3a2a66!important;color:#cdb4ff}'
      + '#tab-pipeline .fast{background:#1b4332!important;color:#9be8b4;font-weight:700}'
      + '#tab-pipeline .med{background:#3d3200!important;color:#f0d68a;font-weight:700}'
      + '#tab-pipeline .slow{background:#4a1515!important;color:#ef9a9a;font-weight:700}'
      + '#tab-pipeline .sw.fast{background:#1b4332}#tab-pipeline .sw.med{background:#3d3200}#tab-pipeline .sw.slow{background:#4a1515}'
      + '#tab-pipeline .dim{color:var(--dim);font-weight:400;font-size:10.5px}'
      + '#tab-pipeline .tablewrap{overflow-x:auto;max-width:100%}'
      + '</style>';
  }

  // ---------------------------------------------------------------------------
  // render orchestration
  // ---------------------------------------------------------------------------
  function renderBody() {
    var host = document.getElementById("pl-results");
    if (!host) return;
    if (MODE === "baked") {
      if (!DATA) { host.innerHTML = '<div class="placeholder"><b>Loading baked tiers…</b></div>'; return; }
      host.innerHTML = '<div class="tablewrap">' + bakedResults() + '</div>';
    } else {
      host.innerHTML = '<div class="tablewrap">' + liveResults() + '</div>';
    }
  }

  function render() {
    var el = document.getElementById("tab-pipeline");
    if (!el) return;
    if (typeof window.tierExpectedValue !== "function") {
      el.innerHTML = '<div class="placeholder"><b>Model core not loaded</b>'
        + '<div class="note">pipeline.js needs model/astrogem.js (window.tierExpectedValue).</div></div>';
      return;
    }
    el.innerHTML = scopedStyle()
      + inputsHtml()
      + legendHtml()
      + '<div id="pl-results"></div>'
      + methodologyHtml();
    renderBody();
    ensureData();
  }

  // fetch the baked data once (used by baked view + live interpolation)
  function ensureData() {
    if (DATA || ensureData._loading) { return; }
    ensureData._loading = true;
    fetch("data/pipeline.json")
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (j) { DATA = j; ensureData._loading = false; renderBody(); })
      .catch(function (e) {
        ensureData._loading = false;
        var host = document.getElementById("pl-results");
        if (MODE === "baked" && host) {
          host.innerHTML = '<div class="placeholder"><b>Could not load data/pipeline.json</b>'
            + '<div class="note">Serve over http (the page must be opened via a static server). ' + e.message + '</div></div>';
        } else {
          // live mode can still render the closed-form per-gem table without the grid
          renderBody();
        }
      });
  }

  // ---------------------------------------------------------------------------
  // event handlers (exposed on window for inline onclick)
  // ---------------------------------------------------------------------------
  window.__plSetMode = function (m) {
    MODE = m;
    document.getElementById("pl-m-baked").classList.toggle("active", m === "baked");
    document.getElementById("pl-m-live").classList.toggle("active", m === "live");
    var lf = document.getElementById("pl-live-fields");
    if (lf) lf.style.display = m === "live" ? "" : "none";
    var note = document.getElementById("pl-mode-note");
    if (note) note.textContent = modeNote();
    renderBody();
  };
  window.__plSetRoster = function (rb) {
    ROSTER = rb;
    document.getElementById("pl-r-nrb").classList.toggle("active", rb === "nrb");
    document.getElementById("pl-r-rb").classList.toggle("active", rb === "rb");
    renderBody();
  };
  window.__plRecalc = function () {
    var g = parseFloat(document.getElementById("pl-gpd").value);
    var b = parseFloat(document.getElementById("pl-bl").value);
    if (isFinite(g) && g > 0) LIVE.gpd = g;
    if (isFinite(b) && b >= 0) LIVE.baseline = b;
    renderBody();
  };
  window.__plToggleInputs = function () {
    var body = document.getElementById("pl-inbody");
    var caret = document.getElementById("pl-caret");
    if (!body) return;
    var hidden = body.style.display === "none";
    body.style.display = hidden ? "" : "none";
    if (caret) caret.textContent = hidden ? "▾" : "▸";
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }
})();
