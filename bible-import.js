/**
 * bible-import.js — CLIENT-SIDE import of a lostark.bible / lopec.kr loadout.
 *
 * lostark.bible IP-blocks our Cloudflare Worker AND sends no CORS header, so the page
 * can't fetch a character itself. But the gem data is sitting in the page's SOURCE — an
 * `arkGridCores:[{...}]` JS object literal (lostark.bible) or a Next.js RSC payload
 * (lopec.kr, KR). So the user brings the source over (a saved .html file, pasted page
 * source, or a one-click bookmarklet) and we parse it RIGHT HERE — no Worker, no network.
 *
 * The parsing is copied verbatim from worker/astrogem-bible.js (the same code that has
 * been scraping these pages all along) so an imported loadout is byte-identical to a
 * Worker pull. Public API:
 *
 *   BibleImport.parse(text, hint?) -> { source, region, name, itemLevel, class, gems:[...],
 *                                       chaosGems, warnings } | null
 *
 * `text` is the page HTML/source (or, from the bookmarklet, just the arkGridCores slice).
 * `hint` is an optional { region, name } the bookmarklet reads from the page URL.
 * Each emitted gem matches the shape Astrogem.validateConfig expects.
 */
(function (root) {
  "use strict";

  // ---- effect id -> name (lostark.bible) ----
  const EFFECT_ID_TO_NAME = {
    2001: "Attack Power",
    2002: "Additional Damage",
    2003: "Boss Damage",
    2011: "Ally Damage Enh.",
    2012: "Brand Power",
    2013: "Ally Attack Enh."
  };

  // Core base id -> human slot label.
  const SLOT_LABEL = {
    10001: "Order Sun", 10002: "Order Moon", 10003: "Order Star",
    10004: "Chaos Sun", 10005: "Chaos Moon", 10006: "Chaos Star"
  };

  // derive cost + type from the gem id.
  function costFromGemId(idStr) {
    const shape = parseInt(idStr[5], 10);
    if (!Number.isFinite(shape)) return null;
    return 8 + (shape % 3); // 0/3->8, 1/4->9, 2/5->10
  }
  function typeFromGemId(idStr) {
    return idStr[3] === "0" ? "order" : "chaos";
  }

  // Pull every `arkGridCores:[ ... ]` array out of the page (one per loadout). Prefer the
  // RAID loadout, fall back to whichever array actually has gems. Returns { raid, chaos }.
  function extractArkGridCores(html) {
    const marker = "arkGridCores:[";
    const occ = [];
    let from = 0;
    while (true) {
      const at = html.indexOf(marker, from);
      if (at === -1) break;
      const start = at + "arkGridCores:".length;
      let depth = 0, end = -1;
      for (let k = start; k < html.length; k++) {
        const c = html[k];
        if (c === "[") depth++;
        else if (c === "]") { depth--; if (depth === 0) { end = k + 1; break; } }
      }
      if (end === -1) break;
      const literal = html.slice(start, end);
      const jsonish = literal.replace(/([{,])\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
      let parsed = null;
      try { parsed = JSON.parse(jsonish); } catch (e) { parsed = null; }
      if (parsed) occ.push({ at: at, cores: parsed });
      from = end;
    }
    if (!occ.length) return { raid: null, chaos: null };

    function gemCount(cores) {
      let n = 0;
      if (Array.isArray(cores)) {
        for (const core of cores) n += (core && Array.isArray(core.gems)) ? core.gems.length : 0;
      }
      return n;
    }
    function afterClass(cls) {
      const at = html.indexOf('classification:"' + cls + '"');
      if (at === -1) return null;
      const o = occ.find(function (x) { return x.at > at; });
      return (o && gemCount(o.cores) > 0) ? o.cores : null;
    }
    let raid = afterClass("most_recent_raid");
    const chaos = afterClass("most_recent_chaos_dungeon");
    if (!raid) {
      let best = occ[0];
      for (const o of occ) { if (gemCount(o.cores) > gemCount(best.cores)) best = o; }
      raid = (gemCount(best.cores) > 0) ? best.cores : null;
    }
    return { raid: raid, chaos: chaos };
  }

  // Map one raw gem (+ its core) to the Grader config shape. { gem, warnings:[...] }.
  function mapGem(rawGem, core) {
    const warnings = [];
    const idStr = String(rawGem.id);
    const baseCost = costFromGemId(idStr);
    const gemType = typeFromGemId(idStr);
    if (baseCost == null) warnings.push("could not derive cost from gem id " + idStr);
    const opts = Array.isArray(rawGem.opts) ? rawGem.opts : [];
    function nameOf(o) {
      const n = EFFECT_ID_TO_NAME[o && o.id];
      if (!n) warnings.push("unknown effect id " + (o && o.id) + " on gem " + idStr);
      return n || ("Effect#" + (o && o.id));
    }
    const e1 = opts[0] || {}, e2 = opts[1] || {};
    return {
      gem: {
        slot: SLOT_LABEL[core.base] || ("Core " + core.base),
        coreBase: core.base,
        gemId: idStr,
        idx: rawGem.idx,
        baseCost: baseCost,
        gemType: gemType,
        willpowerLevel: rawGem.costReduc,
        orderLevel: rawGem.corePoints,
        effect1: nameOf(e1),
        effect1Level: e1.level,
        effect2: nameOf(e2),
        effect2Level: e2.level
      },
      warnings: warnings
    };
  }

  // Map a whole arkGridCores array (one preset) to the Grader gem-config list.
  function coresToGems(cores) {
    const gems = [], warnings = [];
    for (const core of cores) {
      const rawGems = Array.isArray(core.gems) ? core.gems : [];
      for (const rg of rawGems) {
        const m = mapGem(rg, core);
        gems.push(m.gem);
        for (const w of m.warnings) warnings.push(w);
      }
    }
    return { gems: gems, warnings: warnings };
  }

  // ---- KR (lopec.kr) ----
  const KR_EFFECT = {
    "추가 피해": "Additional Damage", "공격력": "Attack Power", "보스 피해": "Boss Damage",
    "아군 공격 강화": "Ally Attack Enh.", "아군 피해 강화": "Ally Damage Enh.", "낙인력": "Brand Power"
  };
  const KR_SLOT = { order: ["Order Sun", "Order Moon", "Order Star"], chaos: ["Chaos Sun", "Chaos Moon", "Chaos Star"] };

  function parseLopecGems(html) {
    const u = html.replace(/\\"/g, '"');
    const gemRe = /use_13_(\d+)\.png","requiredWillpower":(\d+),"orderChaosPoint":(\d+),"effects":\[(.*?)\]\}/g;
    const effRe = /\{"name":"([^"]*)","level":(\d+)/g;
    const gems = [], warnings = [], counts = { order: 0, chaos: 0 };
    let m;
    while ((m = gemRe.exec(u)) !== null) {
      const icon = parseInt(m[1], 10), rel = icon - 202;
      if (rel < 0 || rel > 5) { warnings.push("unexpected gem icon " + icon); continue; }
      const baseCost = 8 + (rel % 3);
      const gemType = rel < 3 ? "order" : "chaos";
      const effs = [];
      let e;
      while ((e = effRe.exec(m[4])) !== null) {
        const en = KR_EFFECT[e[1]];
        if (!en) warnings.push("unknown KR effect '" + e[1] + "'");
        effs.push({ name: en || ("Effect:" + e[1]), level: parseInt(e[2], 10) });
      }
      const e1 = effs[0] || {}, e2 = effs[1] || {};
      const slot = KR_SLOT[gemType][Math.floor(counts[gemType] / 4)] || (gemType + " gem");
      counts[gemType]++;
      gems.push({
        slot: slot, coreBase: null,
        baseCost: baseCost, gemType: gemType,
        willpowerLevel: baseCost - parseInt(m[2], 10),
        orderLevel: parseInt(m[3], 10),
        effect1: e1.name, effect1Level: e1.level,
        effect2: e2.name, effect2Level: e2.level
      });
    }
    return { gems: gems, warnings: warnings };
  }

  const CLASS_NAMES = ["Berserker","Destroyer","Gunlancer","Paladin","Slayer","Valkyrie","Arcanist","Summoner","Bard","Sorceress","Wardancer","Scrapper","Soulfist","Glaivier","Striker","Breaker","Deathblade","Shadowhunter","Reaper","Souleater","Sharpshooter","Deadeye","Artillerist","Machinist","Gunslinger","Aeromancer","Wildsoul","Artist","Guardianknight"];
  const KR_CLASS = {
    "버서커": "Berserker", "디스트로이어": "Destroyer", "워로드": "Gunlancer", "홀리나이트": "Paladin", "슬레이어": "Slayer", "발키리": "Valkyrie",
    "아르카나": "Arcanist", "서머너": "Summoner", "바드": "Bard", "소서리스": "Sorceress",
    "배틀마스터": "Wardancer", "인파이터": "Scrapper", "기공사": "Soulfist", "창술사": "Glaivier", "스트라이커": "Striker", "브레이커": "Breaker",
    "블레이드": "Deathblade", "데모닉": "Shadowhunter", "리퍼": "Reaper", "소울이터": "Souleater",
    "헌터": "Sharpshooter", "데빌헌터": "Deadeye", "블래스터": "Artillerist", "스카우터": "Machinist", "건슬링어": "Gunslinger",
    "도화가": "Artist", "기상술사": "Aeromancer", "환수사": "Wildsoul", "가디언나이트": "Guardianknight"
  };

  function parseMeta(html, isKR) {
    let itemLevel = null, klass = null;
    if (isKR) {
      const u = html.replace(/\\"/g, '"');
      const lvls = []; const re = /"itemLevel":\s*(\d+)/g; let m;
      while ((m = re.exec(u)) !== null) lvls.push(parseInt(m[1], 10));
      if (lvls.length) itemLevel = Math.round(lvls.reduce((a, b) => a + b, 0) / lvls.length);
      const re2 = /"class":"([^"]+)"/g; let cm;
      while ((cm = re2.exec(u)) !== null) { if (KR_CLASS[cm[1]]) { klass = KR_CLASS[cm[1]]; break; } }
    } else {
      const im = html.match(/ilvl:(\d+)/);
      if (im) itemLevel = parseInt(im[1], 10);
      const re = /bg-neutral-900 px-2 py-1 text-sm">([^<]+)<\/p>/g; let m;
      while ((m = re.exec(html)) !== null) {
        if (CLASS_NAMES.indexOf(m[1]) !== -1) { klass = m[1]; break; }
      }
    }
    return { itemLevel: itemLevel, klass: klass };
  }

  // ---- region/name (best-effort, for a dropped/pasted page that carries no URL hint) ----
  // lostark.bible: a /character/{REGION}/{NAME} path in a canonical/og:url tag. lopec.kr:
  // /character/specPoint/{NAME}. Region codes: NA stays NA, CE -> our "EU".
  function regionNameFromHtml(html) {
    // lostark.bible page title is "Name (REGION) | lostark.bible" (in <title> AND og:title).
    let m = html.match(/(?:<title>|og:title"\s+content=")\s*([^()|<]+?)\s*\(([A-Za-z]{2,4})\)/);
    if (m) {
      let region = m[2].toUpperCase();
      if (region === "CE") region = "EU";
      return { region: region, name: m[1].trim() };
    }
    // fallback: any /character/{REGION}/{NAME} path (also matches /api/og/character/...).
    m = html.match(/\/character\/([A-Za-z]{2,4})\/([^"'<>\\\s/?#]+)/);
    if (m) {
      let region = m[1].toUpperCase();
      if (region === "CE") region = "EU";
      let name = m[2];
      try { name = decodeURIComponent(name); } catch (e) {}
      return { region: region, name: name };
    }
    m = html.match(/lopec\.kr\/character\/specPoint\/([^"'<>\\\s/?#]+)/);
    if (m) {
      let name = m[1];
      try { name = decodeURIComponent(name); } catch (e) {}
      return { region: "KR", name: name };
    }
    return { region: null, name: null };
  }

  // ---- public entry ----
  function parse(text, hint) {
    if (!text || typeof text !== "string") return null;
    const isKR = /use_13_\d+\.png/.test(text) && text.indexOf("requiredWillpower") !== -1;
    const isBible = text.indexOf("arkGridCores:[") !== -1;
    if (!isBible && !isKR) return null;

    let gems = null, warnings = [], chaosGems = null, source = null, isKrPage = false;
    if (isBible) {
      const cores = extractArkGridCores(text);
      if (!cores.raid) return null;
      const r = coresToGems(cores.raid);
      gems = r.gems; warnings = r.warnings;
      chaosGems = cores.chaos ? coresToGems(cores.chaos).gems : null;
      source = "lostark.bible";
    } else {
      const rk = parseLopecGems(text);
      gems = rk.gems; warnings = rk.warnings;
      source = "lopec.kr"; isKrPage = true;
    }
    if (!gems || !gems.length) return null;

    const meta = parseMeta(text, isKrPage);
    const rn = (hint && hint.region) ? { region: hint.region, name: hint.name } : regionNameFromHtml(text);
    return {
      source: source,
      region: (rn && rn.region) || (isKrPage ? "KR" : null),
      name: (hint && hint.name) || (rn && rn.name) || null,
      itemLevel: meta.itemLevel,
      class: meta.klass,
      gems: gems,
      chaosGems: (chaosGems && chaosGems.length) ? chaosGems : null,
      warnings: warnings
    };
  }

  const api = { parse: parse };
  root.BibleImport = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : typeof global !== "undefined" ? global : this);
