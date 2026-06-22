/**
 * pipeline.js — "Pipeline Tables" tab (BUCKET-PRIMARY).
 *
 * The cut / fuse / throw decision is made PER EFFECT-PAIR BUCKET — the two effects
 * a gem rolled are its archetype. So every gem cell stacks the FOUR buckets:
 *   2D  (2_damage)         both effects damage          — best
 *   Op  (optimal_damage)   better single damage + dead
 *   Sub (suboptimal_damage)worse  single damage + dead
 *   No  (no_damage)        both dead effects             — no direct damage, but still
 *                                                        worth its TIER's fodder value (never 0)
 * Each bucket row shows its CUT VALUE (the exact Bellman-DP value of cutting a
 * fresh level-1 gem of that archetype) + P(above baseline) + a verdict color.
 *
 * TIER (Leg/Relic/Anc by level-sum) is NOT the cell axis — it is the fusion-FODDER
 * classification, shown in a SEPARATE "Fusion / fodder by tier" section ("for
 * after"): below-baseline cuts become fodder, classified by tier, fused 3->1.
 *
 * Two modes:
 *   BAKED  fetch data/pipeline.json; render the fixed gold tiers (NRB then RB),
 *          one table per tier, BL rows x (Uncommon/Rare/Epic)x(c8/c9/c10) cells,
 *          each stacking the 4 buckets; NRB tables add the weekly "Pipeline" group.
 *   LIVE   any gold-per-1%-damage + baseline: INTERPOLATE the baked DP grid for the
 *          per-bucket cut values (the exact DP is ~3s/cell — too slow live) and the
 *          weekly throughput. The interpolation is bilinear over (gpd, baseline).
 *
 * VERDICT COLORS (reproduced from the deployed ark-grid-solver/index page; bands on
 * the cut-value gold EV):
 *   GREEN   (>= 18k)  worth resetting if below baseline (reroll once, same bucket) ↻
 *   YELLOW->DIM (>0)  worth cutting, not resetting  (10-18k / 5-10k / 1-5k bands)
 *   RED     (<= 0)    don't cut
 *   PURPLE            fuse pre-cutting (NRB) — when fodder-fusion beats the weak cut
 *
 * Reuses styles.css; a SCOPED <style> adds the bucket-grid + verdict-cell styles.
 */
(function () {
  "use strict";

  // ---- display constants (mirrored from data/pipeline.json meta) ----
  var FIXED_GPD = [500000, 1000000, 1500000, 2500000, 3500000, 5000000];
  var COSTS = [8, 9, 10];
  var RARITIES = ["uncommon", "rare", "epic"];
  var RARITY_LABEL = { uncommon: "Uncommon", rare: "Rare", epic: "Epic" };
  var BUCKETS = ["2_damage", "optimal_damage", "suboptimal_damage", "no_damage"];
  var BUCKET_LABEL = { "2_damage": "2D", "optimal_damage": "Op", "suboptimal_damage": "Sub", "no_damage": "No" };
  var TIERS = ["legendary", "relic", "ancient"];
  var TIER_LABEL = { legendary: "Leg", relic: "Relic", ancient: "Anc" };
  var BAKED_BASELINES = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5];

  // Verdict gold-EV bands (from the deployed page).
  var V = { green: 18000, yellowHi: 10000, yellowMid: 5000, yellowLo: 1000 };
  var SLOTS = 24;

  var DATA = null;          // baked data/pipeline.json (lazy-fetched)
  var MODE = "baked";       // 'baked' | 'live'
  var ROSTER = "nrb";       // 'nrb' | 'rb'
  var LIVE = { gpd: 1500000, baseline: 1.0 };

  // ---------------------------------------------------------------------------
  // formatting
  // ---------------------------------------------------------------------------
  function fmtGold(g) {
    if (g == null) return "—";
    g = Math.round(g);
    if (g >= 1000000) {
      var m = (g / 1000000).toFixed(g >= 10000000 ? 0 : 1);
      m = m.replace(/\.0$/, "");
      return m + "M";
    }
    if (g >= 1000) {
      var k = (g / 1000).toFixed(g >= 100000 ? 0 : 1);
      k = k.replace(/\.0$/, "");
      return k + "k";
    }
    return String(g);
  }
  function fmtGoldFull(g) { return g == null ? "—" : Math.round(g).toLocaleString("en-US"); }
  function fmtPct(p) { return p == null ? "—" : (p * 100).toFixed(1) + "%"; }
  function fmtNum(x, dp) { return x == null ? "—" : Number(x).toFixed(dp == null ? 2 : dp); }

  // ---------------------------------------------------------------------------
  // verdict (per bucket cut value). reset flag = green (reset-worthy if below BL).
  // ---------------------------------------------------------------------------
  // cut    = DP value of cutting a fresh gem of this bucket.
  // fuse3  = per-gem fodder value if cut fails (used only for the purple "fuse first").
  // For NRB, when the cut value is below the reset floor AND fusing the fodder beats
  // it, the deployed page paints PURPLE (fuse pre-cutting). RB gems are free to cut.
  function verdict(cut, fuse3, roster) {
    if (cut == null) return { cls: "v-red", glyph: "", reset: false };
    if (cut >= V.green) return { cls: "v-green", glyph: "↻", reset: true };
    if (cut > 0) {
      // dim-yellow sub-bands by magnitude (mirrors the deployed 4-shade ramp).
      var cls = cut >= V.yellowHi ? "v-y1" : cut >= V.yellowMid ? "v-y2" : cut >= V.yellowLo ? "v-y3" : "v-y4";
      if (roster === "nrb" && fuse3 != null && fuse3 > cut) return { cls: "v-purple", glyph: "⚜", reset: false };
      return { cls: cls, glyph: "", reset: false };
    }
    // cut <= 0
    if (roster === "nrb" && fuse3 != null && fuse3 > 0) return { cls: "v-purple", glyph: "⚜", reset: false };
    return { cls: "v-red", glyph: "", reset: false };
  }

  // ---------------------------------------------------------------------------
  // baked lookups
  // ---------------------------------------------------------------------------
  function cellKey(rarity, cost, bucket, bl, gpd) { return rarity + "_" + cost + "_" + bucket + "_" + bl + "_" + gpd; }
  function thruKey(rarity, cost, bl, gpd) { return rarity + "_" + cost + "_" + bl + "_" + gpd; }

  function bakedBucket(rarity, cost, bucket, bl, gpd, roster) {
    if (!DATA) return null;
    var c = DATA.cells[cellKey(rarity, cost, bucket, bl, gpd)];
    if (!c) return null;
    return c[roster] || null;
  }

  // ---------------------------------------------------------------------------
  // bilinear interpolation over the baked (gpd, baseline) grid
  // ---------------------------------------------------------------------------
  function anchors(list, x) {
    if (x <= list[0]) return [list[0], list[0]];
    if (x >= list[list.length - 1]) { var hi = list[list.length - 1]; return [hi, hi]; }
    for (var i = 0; i < list.length - 1; i++) if (x >= list[i] && x <= list[i + 1]) return [list[i], list[i + 1]];
    return [list[0], list[0]];
  }
  function gpdAnchors(gpd) { return anchors((DATA && DATA.meta.anchorGpd) || FIXED_GPD, gpd); }
  function blAnchors(bl) { return anchors((DATA && DATA.meta.bakedBaselines) || BAKED_BASELINES, bl); }

  // Bilinear-interpolate a numeric field from a (gpd, bl) -> value accessor.
  function bilerp(getter, gpd, bl) {
    var ga = gpdAnchors(gpd), ba = blAnchors(bl);
    var gLo = ga[0], gHi = ga[1], bLo = ba[0], bHi = ba[1];
    var v00 = getter(gLo, bLo), v01 = getter(gLo, bHi), v10 = getter(gHi, bLo), v11 = getter(gHi, bHi);
    if (v00 == null) return null;
    if (v01 == null) v01 = v00; if (v10 == null) v10 = v00; if (v11 == null) v11 = v10;
    var tb = bHi === bLo ? 0 : (bl - bLo) / (bHi - bLo);
    var tg = gHi === gLo ? 0 : (gpd - gLo) / (gHi - gLo);
    var lo = v00 + (v01 - v00) * tb;
    var hi = v10 + (v11 - v10) * tb;
    return lo + (hi - lo) * tg;
  }

  // Interpolated per-bucket cut value + pAbove + fodder split for LIVE mode.
  function liveBucket(rarity, cost, bucket, bl, gpd, roster) {
    if (!DATA) return null;
    var cut = bilerp(function (g, b) { var x = bakedBucket(rarity, cost, bucket, b, g, roster); return x ? x.cut : null; }, gpd, bl);
    if (cut == null) return null;
    var pAbove = bilerp(function (g, b) { var x = bakedBucket(rarity, cost, bucket, b, g, roster); return x ? x.pAbove : null; }, gpd, bl);
    var out = { cut: cut, pAbove: pAbove };
    if (roster === "nrb") {
      out.fLeg = bilerp(function (g, b) { var x = bakedBucket(rarity, cost, bucket, b, g, "nrb"); return x ? x.fLeg : null; }, gpd, bl);
      out.fRelic = bilerp(function (g, b) { var x = bakedBucket(rarity, cost, bucket, b, g, "nrb"); return x ? x.fRelic : null; }, gpd, bl);
      out.fAnc = bilerp(function (g, b) { var x = bakedBucket(rarity, cost, bucket, b, g, "nrb"); return x ? x.fAnc : null; }, gpd, bl);
    }
    return out;
  }

  // A fodder-fusion value proxy for the purple verdict: the per-gem value of fusing
  // 3 of the dominant (legendary) fodder tier at this gpd/baseline, from the core.
  function fuse3Proxy(cost, bl, gpd) {
    if (typeof window.fusionValueForTier !== "function") return null;
    return window.fusionValueForTier("legendary", cost, bl, gpd);
  }

  // ---------------------------------------------------------------------------
  // render: one bucket-stacked gem cell (4 rows: 2D / Op / Sub / No)
  // ---------------------------------------------------------------------------
  function gemCell(getBucket, fuse3, roster, sep) {
    var rows = "";
    for (var i = 0; i < BUCKETS.length; i++) {
      var b = BUCKETS[i];
      var x = getBucket(b);
      var cut = x ? x.cut : null;
      var pa = x ? x.pAbove : null;
      var v = verdict(cut, fuse3, roster);
      rows += '<div class="bkt-row ' + v.cls + '">'
        + '<span class="bkt-label">' + BUCKET_LABEL[b] + '</span>'
        + '<span class="bkt-val">' + fmtGold(cut) + '</span>'
        + '<span class="bkt-pct">' + fmtPct(pa) + '</span>'
        + '<span class="bkt-reset">' + v.glyph + '</span>'
        + '</div>';
    }
    return '<td class="gem' + (sep ? " sep" : "") + '"><div class="bkt-grid">' + rows + '</div></td>';
  }

  function weeksClass(w) { return w == null ? "slow" : (w <= 8 ? "fast" : (w <= 26 ? "med" : "slow")); }

  // Aggregate the three rarity throughput lanes into one (the deployed page's single
  // per-baseline Pipeline lane). Sum Direct/Fuse/Gold across rarities, derive Total
  // and Weeks from the sums so the identities stay exact. Box EV / Avg Score are
  // cell-level (not per-rarity) — taken from the uncommon lane (all rarities share them).
  function aggThru(bl, gpd, cost) {
    var d = 0, f = 0, gold = 0, boxEV = null, avg = null;
    for (var ri = 0; ri < RARITIES.length; ri++) {
      var t = DATA.thru[thruKey(RARITIES[ri], cost, bl, gpd)];
      if (!t) continue;
      d += t.directPerWk || 0; f += t.fusePerWk || 0; gold += t.goldPerWk || 0;
      if (boxEV == null) { boxEV = t.boxEV; avg = t.avgScore; }
    }
    var tot = d + f;
    return {
      directPerWk: Math.round(d * 100) / 100,
      fusePerWk: Math.round(f * 100) / 100,
      totalPerWk: Math.round(tot * 100) / 100,
      weeks: tot > 0 ? Math.round((SLOTS / tot) * 10) / 10 : null,
      goldPerWk: Math.round(gold),
      boxEV: boxEV, avgScore: avg
    };
  }

  // ---------------------------------------------------------------------------
  // BAKED table for one gpd tier (roster = 'nrb' | 'rb')
  // ---------------------------------------------------------------------------
  function bakedTable(gpd, roster) {
    var baked = (DATA.meta && DATA.meta.bakedBaselines) || BAKED_BASELINES;
    var win = (DATA.meta.baselineWindow && DATA.meta.baselineWindow[gpd]) || [baked[0], baked[baked.length - 1]];
    var rowBL = baked.filter(function (b) { return b >= win[0] - 1e-9 && b <= win[1] + 1e-9; });
    var isNrb = roster === "nrb";

    var head = '<table class="pipe-table"><thead>'
      + '<tr><th rowspan="2">BL</th>'
      + '<th colspan="3" class="sep">Uncommon</th>'
      + '<th colspan="3" class="sep">Rare</th>'
      + '<th colspan="3" class="sep">Epic</th>'
      + (isNrb ? '<th colspan="8" class="sep">Pipeline (per week)</th>' : '')
      + '</tr><tr>'
      + '<th class="sep">c8</th><th>c9</th><th>c10</th>'
      + '<th class="sep">c8</th><th>c9</th><th>c10</th>'
      + '<th class="sep">c8</th><th>c9</th><th>c10</th>'
      + (isNrb
        ? '<th class="sep">Boxes</th><th>Box EV</th><th>Direct<br>/wk</th><th>Fuse<br>/wk</th>'
          + '<th>Total<br>/wk</th><th>Weeks</th><th>Gold</th><th>Avg<br>Score</th>'
        : '')
      + '</tr></thead><tbody>';

    var body = "";
    for (var bi = 0; bi < rowBL.length; bi++) {
      var bl = rowBL[bi];
      var row = '<tr><td class="pipe blcell"><b>' + bl + '</b></td>';
      for (var ri = 0; ri < RARITIES.length; ri++) {
        for (var ci = 0; ci < COSTS.length; ci++) {
          (function (rarity, cost, sep) {
            var f3 = fuse3Proxy(cost, bl, gpd);
            row += gemCell(function (b) { return bakedBucket(rarity, cost, b, bl, gpd, roster); }, f3, roster, sep);
          })(RARITIES[ri], COSTS[ci], ci === 0);
        }
      }
      if (isNrb) {
        // The deployed page's Pipeline is a SINGLE per-baseline lane that mixes the
        // whole weekly production. We reconstruct it by AGGREGATING the three rarity
        // lanes (you cut uncommons in bulk + some rare/epic): sum Direct/Fuse/Gold,
        // derive Total + Weeks from the summed values (identities stay exact). Box EV
        // and Avg Score are cell-level (not per-rarity); use the c9 lane.
        var agg = aggThru(bl, gpd, 9);
        var boxTxt = (DATA.meta.boxSchedule || []).map(function (s) { return s.count + "x" + s.rarity.slice(0, 3); }).join("<br>");
        row += '<td class="pipe sep boxcell">' + (boxTxt || "—") + '</td>'
          + '<td class="pipe num">' + fmtGoldFull(agg.boxEV) + '</td>'
          + '<td class="pipe num">' + fmtNum(agg.directPerWk) + '</td>'
          + '<td class="pipe num">' + fmtNum(agg.fusePerWk) + '</td>'
          + '<td class="pipe num"><b>' + fmtNum(agg.totalPerWk) + '</b></td>'
          + '<td class="pipe num ' + weeksClass(agg.weeks) + '">' + (agg.weeks == null ? "—" : agg.weeks) + '</td>'
          + '<td class="pipe num">' + fmtGold(agg.goldPerWk) + '/wk</td>'
          + '<td class="pipe num"><b>' + fmtNum(agg.avgScore) + '</b></td>';
      }
      row += "</tr>";
      body += row;
    }
    return head + body + "</tbody></table>";
  }

  // ---------------------------------------------------------------------------
  // Fodder VALUE per gem by tier — the "worth that much as fodder" numbers: what a
  // single below-baseline gem of each tier is worth as fusion material (3->1).
  // Depends only on (cost, baseline, gpd), so it's the same for baked and live.
  function fodderValueTable(gpd, bl) {
    if (typeof window.fusionValueForTier !== "function") return "";
    var rows = "";
    for (var ci = 0; ci < COSTS.length; ci++) {
      var c = COSTS[ci];
      rows += '<tr><td>c' + c + '</td>'
        + '<td class="num sep"><span class="legendary">' + fmtGold(window.fusionValueForTier("legendary", c, bl, gpd)) + '</span></td>'
        + '<td class="num"><span class="relic">' + fmtGold(window.fusionValueForTier("relic", c, bl, gpd)) + '</span></td>'
        + '<td class="num"><span class="ancient">' + fmtGold(window.fusionValueForTier("ancient", c, bl, gpd)) + '</span></td></tr>';
    }
    return '<p class="note"><b>Fodder value per gem</b> — what ONE below-baseline gem of each tier is worth as '
      + 'fusion material (3→1). This is why even a "No"/below-baseline gem is never zero.</p>'
      + '<table class="pipe-table"><thead><tr><th>Cost</th>'
      + '<th class="sep">Legendary</th><th>Relic</th><th>Ancient</th></tr></thead><tbody>'
      + rows + '</tbody></table>';
  }

  // Fusion / fodder by tier section (the "for after" view).
  // Below-baseline cuts become fodder; this shows where that fodder lands (Leg /
  // Relic / Anc) per rarity/cost, averaged over the four buckets weighted by the
  // fresh-drop bucket mix. Baked: read p_fodder_*; Live: interpolate.
  // ---------------------------------------------------------------------------
  function fodderSection(gpd, bl, getBucket) {
    var mix = (DATA && DATA.meta.freshBucketMix) || { "2_damage": 0.17, optimal_damage: 0.33, suboptimal_damage: 0.33, no_damage: 0.17 };
    var rows = "";
    for (var ri = 0; ri < RARITIES.length; ri++) {
      var rarity = RARITIES[ri];
      for (var ci = 0; ci < COSTS.length; ci++) {
        var cost = COSTS[ci];
        var fl = 0, fr = 0, fa = 0, pa = 0, wsum = 0;
        for (var bi = 0; bi < BUCKETS.length; bi++) {
          var b = BUCKETS[bi];
          var x = getBucket(rarity, cost, b);
          if (!x) continue;
          var w = mix[b] || 0;
          fl += w * (x.fLeg || 0); fr += w * (x.fRelic || 0); fa += w * (x.fAnc || 0);
          pa += w * (x.pAbove || 0); wsum += w;
        }
        if (wsum > 0) { fl /= wsum; fr /= wsum; fa /= wsum; pa /= wsum; }
        var fodder = fl + fr + fa;
        rows += '<tr><td><b>' + RARITY_LABEL[rarity] + '</b></td><td>c' + cost + '</td>'
          + '<td class="num sep">' + fmtPct(pa) + '</td>'
          + '<td class="num">' + fmtPct(fodder) + '</td>'
          + '<td class="num sep"><span class="legendary">' + fmtPct(fl) + '</span></td>'
          + '<td class="num"><span class="relic">' + fmtPct(fr) + '</span></td>'
          + '<td class="num"><span class="ancient">' + fmtPct(fa) + '</span></td></tr>';
      }
    }
    return '<h2 id="fodder">Fusion / fodder by tier (Leg / Relic / Anc) — for after</h2>'
      + '<p class="note">A below-baseline cut is <b>fodder</b>: classified by tier (level-sum), 3 fuse into 1. '
      + 'This is the secondary axis — the cut decision above is per bucket. Columns: P(cut clears baseline), '
      + 'P(becomes fodder), and the fodder tier split (sums to P(fodder)). Averaged over the fresh-drop bucket mix '
      + 'at ' + fmtGold(gpd) + '/1% dmg, baseline ' + bl + '%.</p>'
      + fodderValueTable(gpd, bl)
      + '<table class="pipe-table"><thead><tr><th>Rarity</th><th>Cost</th>'
      + '<th class="sep">P(above)</th><th>P(fodder)</th>'
      + '<th class="sep">Leg</th><th>Relic</th><th>Anc</th></tr></thead><tbody>'
      + rows + '</tbody></table>';
  }

  // ---------------------------------------------------------------------------
  // BAKED view (all fixed gpd tiers, NRB then RB) + fodder section
  // ---------------------------------------------------------------------------
  function bakedResults() {
    var out = '<div class="toc"><b>Jump to:</b> '
      + '<a href="#nrb">Non-Roster Bound</a> <a href="#rb">Roster Bound</a> <a href="#fodder">Fusion / fodder</a></div>';
    out += '<h1 class="sec" id="nrb">Non-Roster Bound</h1>'
      + '<p class="note">NRB gems cost gold to cut. Each cell stacks the four buckets '
      + '(<b>2D</b> / <b>Op</b> / <b>Sub</b> / <b>No</b>); the number is the exact DP value of cutting a fresh gem '
      + 'of that archetype, colored by verdict. The Pipeline group is the weekly production flow.</p>';
    for (var i = 0; i < FIXED_GPD.length; i++) {
      out += '<h2>' + fmtGold(FIXED_GPD[i]) + ' gold / 1% damage — NRB</h2>' + bakedTable(FIXED_GPD[i], "nrb");
    }
    out += '<h1 class="sec" id="rb">Roster Bound</h1>'
      + '<p class="note">Roster-bound gems are free to cut — always cut. Per-bucket cut value + % above baseline shown (no pipeline lane).</p>';
    for (var j = 0; j < FIXED_GPD.length; j++) {
      out += '<h2>' + fmtGold(FIXED_GPD[j]) + ' gold / 1% damage — RB</h2>' + bakedTable(FIXED_GPD[j], "rb");
    }
    // Fodder section uses a representative tier (1.5M, baseline 1.0) of the baked grid.
    out += fodderSection(1500000, 1.0, function (rarity, cost, b) { return bakedBucket(rarity, cost, b, 1.0, 1500000, "nrb"); });
    return out;
  }

  // ---------------------------------------------------------------------------
  // LIVE view — interpolate the baked DP grid for any gpd/baseline.
  // ---------------------------------------------------------------------------
  function liveResults() {
    var gpd = LIVE.gpd, bl = LIVE.baseline, roster = ROSTER;
    if (!DATA) {
      return '<div class="placeholder"><b>Live mode needs the baked grid.</b>'
        + '<div class="note">data/pipeline.json is still loading (live mode interpolates it).</div></div>';
    }

    var head = '<table class="pipe-table"><thead>'
      + '<tr><th rowspan="2"></th>'
      + '<th colspan="3" class="sep">Uncommon</th>'
      + '<th colspan="3" class="sep">Rare</th>'
      + '<th colspan="3" class="sep">Epic</th></tr><tr>'
      + '<th class="sep">c8</th><th>c9</th><th>c10</th>'
      + '<th class="sep">c8</th><th>c9</th><th>c10</th>'
      + '<th class="sep">c8</th><th>c9</th><th>c10</th></tr></thead><tbody>';
    // Single "row" whose cells stack the four buckets (like one BL row of the baked table).
    var row = '<tr><td class="pipe blcell"><b>' + bl + '%</b></td>';
    for (var ri = 0; ri < RARITIES.length; ri++) {
      for (var ci = 0; ci < COSTS.length; ci++) {
        (function (rarity, cost, sep) {
          var f3 = fuse3Proxy(cost, bl, gpd);
          row += gemCell(function (b) { return liveBucket(rarity, cost, b, bl, gpd, roster); }, f3, roster, sep);
        })(RARITIES[ri], COSTS[ci], ci === 0);
      }
    }
    row += "</tr>";
    var gemTbl = head + row + "</tbody></table>";

    // Weekly throughput (interpolated) for the epic c9/c10 lanes.
    var thruTbl = "";
    if (roster === "nrb") {
      thruTbl = '<h2>Weekly throughput (interpolated)</h2>'
        + '<table class="pipe-table"><thead><tr><th>Rarity</th><th class="sep num">Direct/wk</th>'
        + '<th class="num">Fuse/wk</th><th class="num">Total/wk</th><th class="num">Weeks to ' + SLOTS + '</th>'
        + '<th class="num">Gold/wk</th><th class="num">Avg Score</th></tr></thead><tbody>';
      for (var rj = 0; rj < RARITIES.length; rj++) {
        var rar = RARITIES[rj];
        var d = bilerp(function (g, b) { var t = DATA.thru[thruKey(rar, 9, b, g)]; return t ? t.directPerWk : null; }, gpd, bl);
        var f = bilerp(function (g, b) { var t = DATA.thru[thruKey(rar, 9, b, g)]; return t ? t.fusePerWk : null; }, gpd, bl);
        var tot = (d || 0) + (f || 0);
        var wk = tot > 0 ? SLOTS / tot : null;
        var gold = bilerp(function (g, b) { var t = DATA.thru[thruKey(rar, 9, b, g)]; return t ? t.goldPerWk : null; }, gpd, bl);
        var avg = bilerp(function (g, b) { var t = DATA.thru[thruKey(rar, 9, b, g)]; return t ? t.avgScore : null; }, gpd, bl);
        thruTbl += '<tr><td><b>' + RARITY_LABEL[rar] + '</b></td>'
          + '<td class="sep num">' + fmtNum(d) + '</td><td class="num">' + fmtNum(f) + '</td>'
          + '<td class="num"><b>' + fmtNum(tot) + '</b></td>'
          + '<td class="num ' + weeksClass(wk) + '">' + (wk == null ? "—" : wk.toFixed(1)) + '</td>'
          + '<td class="num">' + (gold == null ? "—" : fmtGold(gold) + "/wk") + '</td>'
          + '<td class="num">' + fmtNum(avg) + '</td></tr>';
      }
      thruTbl += '</tbody></table>';
    }

    // Fodder section (interpolated).
    var fod = roster === "nrb"
      ? fodderSection(gpd, bl, function (rarity, cost, b) { return liveBucket(rarity, cost, b, bl, gpd, "nrb"); })
      : "";

    return '<h2>Per-bucket cut value — ' + fmtGold(gpd) + ' gold / 1% damage, baseline ' + bl + '% dmg'
      + ' (' + (roster === "nrb" ? "Non-Roster Bound" : "Roster Bound") + ')</h2>'
      + '<p class="note">Interpolated from the baked DP grid (the exact DP is ~3s/cell — too slow to recompute live). '
      + 'Each cell stacks the four buckets; the number is the cut value of a fresh gem of that archetype. '
      + 'Verdict bands: green ≥ ' + fmtGold(V.green) + ' (reset-worthy) · yellow > 0 · red ≤ 0 · purple = fuse first.</p>'
      + gemTbl + thruTbl + fod;
  }

  // ---------------------------------------------------------------------------
  // legend
  // ---------------------------------------------------------------------------
  function legendHtml() {
    return '<div class="legend-box"><div class="lg-title">How to read these tables</div>'
      + '<div class="grid c2"><div>'
      + '<div class="lg-h">Gem cells — stacked by BUCKET</div>'
      + '<p class="note">Each cost cell stacks the four effect-pair buckets: '
      + '<b>2D</b> (both damage) · <b>Op</b> (best single damage) · <b>Sub</b> (worse single damage) · <b>No</b> (no damage). '
      + 'Per row: <b>cut value</b> (the DP value of cutting a fresh gem of that archetype) and <b>% above baseline</b>. '
      + 'A gem must beat the baseline (a %-damage threshold) to be an upgrade. Values rise with rarity (more turns/rerolls).</p>'
      + '<div class="lg-h">Verdict colors</div>'
      + '<p><span class="sw v-green"></span> <b>Green</b> (≥ ' + fmtGold(V.green) + ') — worth resetting if below baseline (↻)<br>'
      + '<span class="sw v-y1"></span><span class="sw v-y2"></span><span class="sw v-y3"></span> <b>Yellow–dim</b> (&gt; 0) — cut, don\'t reset<br>'
      + '<span class="sw v-red"></span> <b>Red</b> (≤ 0) — don\'t cut<br>'
      + '<span class="sw v-purple"></span> <b>Purple</b> (⚜) — fuse pre-cutting (NRB; fusing the fodder beats the weak cut)</p>'
      + '</div><div>'
      + '<div class="lg-h">Pipeline (NRB only, per week)</div>'
      + '<p class="note"><b>Direct/wk</b> — above-baseline gems/week from cutting.<br>'
      + '<b>Fuse/wk</b> — above-baseline gems/week from recycling fodder (3→1).<br>'
      + '<b>Total/wk</b> = Direct + Fuse · <b>Weeks</b> = ' + SLOTS + ' / Total/wk.<br>'
      + '<span class="sw fast"></span>≤8 &nbsp; <span class="sw med"></span>8–26 &nbsp; <span class="sw slow"></span>&gt;26 weeks<br>'
      + '<b>Gold</b> — weekly gold inflow · <b>Avg Score</b> — % damage of the avg keeper.</p>'
      + '<div class="lg-h">Tier = fusion fodder ("for after")</div>'
      + '<p class="note">Tier (Leg / Relic / Anc by level-sum) is NOT the cut axis — it classifies the FODDER a failed cut '
      + 'becomes. See the "Fusion / fodder by tier" section below.</p>'
      + '</div></div></div>';
  }

  function methodologyHtml() {
    return '<details class="method"><summary>Methodology</summary>'
      + '<p><b>The cut decision is per BUCKET (effect pair).</b> When a gem drops, its two effects are its archetype: '
      + '<b>2_damage</b> (both damage), <b>optimal_damage</b> (better single damage + dead), <b>suboptimal_damage</b> '
      + '(worse single damage + dead), <b>no_damage</b> (both dead). The exact effect pairs per base cost are fixed '
      + '(see data/pipeline.json meta.effectBuckets).</p>'
      + '<p><b>Cut value = exact Bellman DP.</b> A bucket\'s value is W(freshGem, maxTurns[rarity], maxRerolls[rarity]), '
      + 'the optimal expected gold from cutting a fresh level-1 gem of that archetype, taking the expectation over the '
      + 'random 4-draw inside (model/dp.js). It is deterministic (no Monte Carlo). Values increase with rarity because '
      + 'epic gets 9 turns / 3 rerolls vs uncommon\'s 5 / 1.</p>'
      + '<p><b>Scoring is real % damage.</b> Each line scores D = 100·ln(multiplier) (additive in log space, ≈ % damage); '
      + 'a perfect gem ≈ 1.3–1.4%. Baseline is the % damage of your weakest equipped gem; gold value = '
      + 'max(0,(score−baseline)) × goldPerDamage (gold per 1% damage).</p>'
      + '<p><b>Tier is the fusion fodder, not the cut axis.</b> A below-baseline cut becomes fodder, classified by '
      + 'level-sum tier (legendary 4–15, relic 16–18, ancient 19–20) and fused 3→1. The bake records the per-bucket '
      + 'fodder tier split (p_fodder_leg/relic/anc, summing to 1−P(above)) by walking the SAME optimal policy the value '
      + 'uses. Shown separately in "Fusion / fodder by tier".</p>'
      + '<p><b>Verdict colors</b> reproduce the deployed ark-grid-solver page: green ≥ 18k (reset-worthy), a yellow→dim '
      + 'ramp for >0 (10–18k / 5–10k / 1–5k / <1k), red ≤ 0 (don\'t cut), purple = fuse the fodder before cutting (NRB).</p>'
      + '<p><b>Throughput</b> is a documented reconstruction (the deployed page\'s weekly generator was not part of the '
      + 'model core): Direct/wk = weekly cut budget × P(above) over the fresh-drop bucket mix; Fuse/wk recycles '
      + 'below-baseline cuts (3→1); Total/wk = Direct+Fuse; Weeks = ' + SLOTS + '/Total/wk. Constants (cut budget, box '
      + 'schedule, bucket mix) are in data/pipeline.json meta and METHODOLOGY.md — retunable without touching the DP.</p>'
      + '<p><b>Live mode interpolates</b> the baked DP grid bilinearly over (gpd, baseline): the exact DP is ~3s/cell, '
      + 'too slow to recompute live, so any gold/baseline reads off the dense baked anchors.</p>'
      + '</details>';
  }

  // ---------------------------------------------------------------------------
  // inputs (sticky, collapsible)
  // ---------------------------------------------------------------------------
  function inputsHtml() {
    return '<div class="inputs" id="pl-inputs">'
      + '<div class="ihdr"><span>Pipeline inputs</span>'
      + '<span class="tgl" id="pl-caret" onclick="window.__plToggleInputs()">▾</span></div>'
      + '<div id="pl-inbody"><div class="barrow">'
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
      ? "Baked view: the fixed gold tiers (500k · 1M · 1.5M · 2.5M · 3.5M · 5M), NRB then RB, straight from data/pipeline.json (exact DP)."
      : "Live view: per-bucket cut values interpolated from the baked DP grid for any gold/baseline (the exact DP is too slow to recompute live).";
  }

  // ---------------------------------------------------------------------------
  // scoped styles (NOT in styles.css)
  // ---------------------------------------------------------------------------
  function scopedStyle() {
    return '<style>'
      + '#tab-pipeline .legend-box{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin:8px 0 16px}'
      + '#tab-pipeline .legend-box .lg-title{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:var(--accent);font-weight:700;margin-bottom:10px}'
      + '#tab-pipeline .lg-h{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--accent);font-weight:700;margin:10px 0 4px}'
      + '#tab-pipeline .sw{display:inline-block;width:13px;height:13px;border-radius:3px;vertical-align:middle;margin-right:5px;border:1px solid #0006}'
      + '#tab-pipeline .toc{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:10px 16px;margin:8px 0}'
      + '#tab-pipeline .toc a{color:var(--accent);text-decoration:none;margin-right:16px}'
      + '#tab-pipeline .toc a:hover{text-decoration:underline}'
      + '#tab-pipeline h1.sec{font-size:16px;color:var(--accent);border-top:2px solid var(--border);padding-top:16px;margin-top:30px}'
      + '#tab-pipeline h2{font-size:15px;color:var(--accent);margin-top:22px}'
      + '#tab-pipeline .pipe-table{width:auto;min-width:100%;font-size:12.5px;margin:6px 0 8px;border-collapse:collapse}'
      + '#tab-pipeline .pipe-table th{position:sticky;top:0;background:var(--panel2);z-index:2;text-align:center;white-space:nowrap;padding:6px 5px;border:1px solid var(--border);font-size:11px;color:var(--accent)}'
      + '#tab-pipeline .pipe-table td{padding:0;text-align:center;vertical-align:top;border:1px solid var(--border)}'
      + '#tab-pipeline .pipe-table td.pipe{padding:5px 8px;vertical-align:middle}'
      + '#tab-pipeline .pipe-table td.blcell{font-weight:700;color:var(--text)}'
      + '#tab-pipeline .pipe-table td.boxcell{font-size:11px;color:var(--dim);padding:4px 6px;vertical-align:middle;line-height:1.4}'
      + '#tab-pipeline .pipe-table td.num{padding:5px 8px;vertical-align:middle;font-variant-numeric:tabular-nums}'
      + '#tab-pipeline .sep{border-left:2px solid var(--accent)!important}'
      + '#tab-pipeline .bkt-grid{display:flex;flex-direction:column}'
      + '#tab-pipeline .bkt-row{display:flex;align-items:center;min-height:22px;padding:1px 5px;gap:6px;border-bottom:1px solid #0003}'
      + '#tab-pipeline .bkt-row:last-child{border-bottom:none}'
      + '#tab-pipeline .bkt-label{width:30px;text-align:left;font-size:10px;font-weight:700;flex-shrink:0;color:#aab2c5}'
      + '#tab-pipeline .bkt-val{flex:1;text-align:right;font-weight:700;font-variant-numeric:tabular-nums}'
      + '#tab-pipeline .bkt-pct{width:42px;text-align:right;color:#cbd2e0;font-size:10.5px;flex-shrink:0}'
      + '#tab-pipeline .bkt-reset{width:14px;text-align:center;font-size:12px;color:#bfe7c8;flex-shrink:0}'
      // verdict backgrounds — green / 4-shade yellow ramp / red / purple (dark, legible)
      + '#tab-pipeline .v-green{background:#1f6b3e!important;color:#d6ffe6}'
      + '#tab-pipeline .v-y1{background:#3a5a2a!important;color:#dff0c0}'
      + '#tab-pipeline .v-y2{background:#4a5520!important;color:#eee6a8}'
      + '#tab-pipeline .v-y3{background:#5a4a1e!important;color:#f0dca0}'
      + '#tab-pipeline .v-y4{background:#544020!important;color:#e8d2a0}'
      + '#tab-pipeline .v-red{background:#4a1c1c!important;color:#ef9a9a}'
      + '#tab-pipeline .v-purple{background:#3a2a66!important;color:#cdb4ff}'
      + '#tab-pipeline .fast{background:#1b4332!important;color:#9be8b4;font-weight:700}'
      + '#tab-pipeline .med{background:#3d3200!important;color:#f0d68a;font-weight:700}'
      + '#tab-pipeline .slow{background:#4a1515!important;color:#ef9a9a;font-weight:700}'
      + '#tab-pipeline .sw.fast{background:#1b4332}#tab-pipeline .sw.med{background:#3d3200}#tab-pipeline .sw.slow{background:#4a1515}'
      + '#tab-pipeline .sw.v-green{background:#1f6b3e}#tab-pipeline .sw.v-y1{background:#3a5a2a}#tab-pipeline .sw.v-y2{background:#4a5520}#tab-pipeline .sw.v-y3{background:#5a4a1e}#tab-pipeline .sw.v-red{background:#4a1c1c}#tab-pipeline .sw.v-purple{background:#3a2a66}'
      + '#tab-pipeline .legendary{color:#f0c674}#tab-pipeline .relic{color:#c79bff}#tab-pipeline .ancient{color:#ff9d6e}'
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
    el.innerHTML = scopedStyle() + inputsHtml() + legendHtml()
      + '<div id="pl-results"></div>' + methodologyHtml();
    renderBody();
    ensureData();
  }

  function ensureData() {
    if (DATA || ensureData._loading) return;
    ensureData._loading = true;
    fetch("data/pipeline.json")
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (j) { DATA = j; ensureData._loading = false; renderBody(); })
      .catch(function (e) {
        ensureData._loading = false;
        var host = document.getElementById("pl-results");
        if (host) {
          host.innerHTML = '<div class="placeholder"><b>Could not load data/pipeline.json</b>'
            + '<div class="note">Serve over http (static server). ' + e.message + '</div></div>';
        }
      });
  }

  // ---------------------------------------------------------------------------
  // event handlers
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

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", render);
  else render();
})();
