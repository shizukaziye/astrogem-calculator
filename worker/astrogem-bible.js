/**
 * astrogem-bible.js — Cloudflare Worker that fetches a character page from
 * lostark.bible (server-side, with a browser User-Agent so it returns 200 instead
 * of the 403 that default fetchers get), extracts the embedded `arkGridCores`
 * hydration data, and returns each equipped astrogem in the shape the Grader tab
 * expects:
 *
 *   { region, name, source, gems: [ {
 *       slot, baseCost, gemType, willpowerLevel, orderLevel,
 *       effect1, effect1Level, effect2, effect2Level
 *   }, ... ] }
 *
 * No Anthropic / external paid API — this is a plain HTML fetch + parse. No secrets
 * or bindings required. The owner deploys it and pastes the URL into grader.js
 * (WORKER_URL), exactly like the Workers-AI vision Worker.
 *
 * Endpoints:
 *   GET /?region=NA&name=Paroxysmal  -> { region, name, gems:[...], pulledAt, cached }
 *                                       (KV-cached 7d; add &refresh=1 to force fresh)
 *   GET /?list=1                     -> { characters:[{region,name,gems,pulledAt}, ...] }
 *   GET /                            -> health JSON { ok, service }
 *   OPTIONS /                        -> CORS preflight
 *
 * KV (binding CHARS, see wrangler.bible.toml): each pulled character is stored under
 * key "region:name" (lowercased) as { region, name, gems, pulledAt, ... }, and its
 * key is appended to the "__index__" array so ?list=1 can enumerate every character.
 * If the CHARS binding is absent the Worker still works — it just fetches fresh every
 * time (cached:false) and ?list=1 returns an empty list.
 *
 * --- The two reverse-engineered maps (derived by cross-referencing arkGridCores
 *     with the RENDERED gem display for NA/Paroxysmal; see worker/README-bible.md) ---
 *
 * 1. EFFECT ID -> NAME. Each gem's `opts` carry a numeric stat id. Verified against
 *    the page's rendered per-stat "Lv. NN" totals (the sum of that stat's levels
 *    across every gem) — the computed opt-id level totals matched the rendered
 *    labels exactly (2001=49 Atk, 2002=50 AddDmg, 2003=43 Boss, 2011=16 AllyDmg,
 *    2012=2 Brand, 2013=7 AllyAtk):
 *      2001 Attack Power | 2002 Additional Damage | 2003 Boss Damage
 *      2011 Ally Damage Enh. | 2012 Brand Power | 2013 Ally Attack Enh.
 *
 * 2. GEM -> baseCost (8/9/10) + gemType (order/chaos), both from the gem `id`
 *    (format 674 [type] 1 [shape] 2 [variant]):
 *      gemType = id[3]: '0' => order, '1' => chaos  (agrees with the core's
 *                base: 10001-10003 = Order Sun/Moon/Star, 10004-10006 = Chaos).
 *      baseCost = 8 + (id[5] % 3): order shapes 0/1/2 and chaos shapes 3/4/5 both
 *                map 0->8, 1->9, 2->10. Validated on all 24 Paroxysmal gems: every
 *                gem's two opts fall inside exactly the cost's effect pool (0
 *                mismatches), an independent cross-check of the cost rule.
 *
 *    willpowerLevel = gem.costReduc, orderLevel = gem.corePoints, the two side
 *    effects = gem.opts (each {id, level}). costReduc/corePoints are confirmed in
 *    1..5; opts levels in 1..5.
 */

const ALLOW_ORIGIN = "*"; // TODO(before production): lock to the deployed Pages origin.

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// 1. effect id -> name (see header).
const EFFECT_ID_TO_NAME = {
  2001: "Attack Power",
  2002: "Additional Damage",
  2003: "Boss Damage",
  2011: "Ally Damage Enh.",
  2012: "Brand Power",
  2013: "Ally Attack Enh."
};

// Core base id -> human slot label (matches the rendered "Order Sun" etc.).
const SLOT_LABEL = {
  10001: "Order Sun",
  10002: "Order Moon",
  10003: "Order Star",
  10004: "Chaos Sun",
  10005: "Chaos Moon",
  10006: "Chaos Star"
};

// 2. derive cost + type from the gem id (see header).
function costFromGemId(idStr) {
  const shape = parseInt(idStr[5], 10);
  if (!Number.isFinite(shape)) return null;
  return 8 + (shape % 3); // 0/3->8, 1/4->9, 2/5->10
}
function typeFromGemId(idStr) {
  return idStr[3] === "0" ? "order" : "chaos";
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOW_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}
function json(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, corsHeaders(), extraHeaders || {})
  });
}

// Pull the astrogem cores out of the page. A page can carry several
// `arkGridCores:[ ... ]` arrays — lostark.bible stores one per loadout
// (classification "most_recent_raid" / "most_recent_chaos_dungeon"), and the chaos
// loadout is frequently empty. We parse every array (each is a JS object literal with
// unquoted keys, so we quote the keys before JSON.parse), then prefer the RAID
// loadout's, falling back to whichever array actually has gems. Returns an array or null.
function extractArkGridCores(html) {
  const marker = "arkGridCores:[";
  const occ = [];
  let from = 0;
  while (true) {
    const at = html.indexOf(marker, from);
    if (at === -1) break;
    // Scan from the opening '[' keeping bracket depth so nested arrays don't fool us.
    const start = at + "arkGridCores:".length;
    let depth = 0, end = -1;
    for (let k = start; k < html.length; k++) {
      const c = html[k];
      if (c === "[") depth++;
      else if (c === "]") { depth--; if (depth === 0) { end = k + 1; break; } }
    }
    if (end === -1) break;
    const literal = html.slice(start, end);
    // Quote bare identifier keys: {id:..,base:..} -> {"id":..,"base":..}
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

  // The first arkGridCores right after a given loadout classification, if it has gems.
  function afterClass(cls) {
    const at = html.indexOf('classification:"' + cls + '"');
    if (at === -1) return null;
    const o = occ.find(function (x) { return x.at > at; });
    return (o && gemCount(o.cores) > 0) ? o.cores : null;
  }
  let raid = afterClass("most_recent_raid");
  const chaos = afterClass("most_recent_chaos_dungeon");
  // Raid fallback: the array with the most gems, so a non-standard layout still grades.
  if (!raid) {
    let best = occ[0];
    for (const o of occ) { if (gemCount(o.cores) > gemCount(best.cores)) best = o; }
    raid = (gemCount(best.cores) > 0) ? best.cores : null;
  }
  return { raid: raid, chaos: chaos };
}

// Map one raw gem (from arkGridCores) + its core to the Grader config shape.
// Returns { gem, warnings:[...] } — warnings note any unknown id / out-of-range
// level so the client can surface them rather than silently dropping a gem.
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

// ---- KV cache config + helpers ----
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // a cached character is "fresh" for 7 days.
const INDEX_KEY = "__index__";               // KV key holding a JSON array of all char keys.
const SNAPSHOT_KEY = "lb:snapshot";          // single KV key holding the whole leaderboard list (?list=1 serves it).
const DIRTY_PREFIX = "lb:dirty:";            // #3: per-character "changed since last snapshot" marker — the cron merges only these instead of re-reading every character.
const SNAPSHOT_DIRTY_TTL_S = 7 * 24 * 3600;  // a dirty marker self-expires after 7 days (safety net; the rebuild normally clears it).
const LASTWRITE_KEY = "lb:lastwrite";        // ms timestamp of the most recent character write (plain overwrite, race-free).
const BUILTAT_KEY = "lb:builtat";            // ms timestamp the snapshot was last rebuilt by the cron.
const QP = "q:p:";                           // premium lookup-queue key prefix (region+name ride in KV metadata).
const QF = "q:f:";                           // free lookup-queue key prefix.
const DRAIN_PER_RUN = 10;                     // DEFAULT chars cached per cron run (= per minute); admin-configurable at runtime via the queue-admin Controls (drain:config.drainPerMin). Time-budgeted below so it never overruns the 60s cron; monthly guard caps the total.
const MONTHLY_CHAR_BUDGET = 300000;          // hard cap on characters cached per calendar month (~2 writes each ≈ 66% of the 1M/mo write budget → no overage, ever).
const USAGE_KEY = "usage:drained";           // {month:"YYYY-MM", count} — characters cached this month (the budget guard).
const DRAIN_DELAY_MS = 3000;                 // pause between lostark.bible fetches (~1 req / 3s) — gentle enough to avoid upstream rate-limiting/timeouts, which cost more than they cache.
const DRAIN_BUDGET_MS = 50000;               // stop a drain run after ~50s no matter the count, so it never overruns the 60s cron (margin for the snapshot rebuild + no overlapping runs).
const PAUSE_FAIL_LIMIT = 5;                   // consecutive fetch failures that PAUSE the whole queue (circuit-breaker): the streak is re-queued at the FRONT, new lookups get the "unavailable" notice, and the drain backs off to a single probe every PAUSE_PROBE_MS until one succeeds.
const PAUSE_PROBE_MS = 5 * 60 * 1000;        // fallback probe interval (old pause states that predate the adaptive backoff).
const PAUSE_PROBE_FIRST_MS = 60 * 1000;      // ADAPTIVE backoff: first probe ~1 min after pausing (catch a quick recovery),
const PAUSE_PROBE_MAX_MS = 30 * 60 * 1000;   // then ×2 per failed probe, capped at 30 min — a long outage costs very few probes.
const NOTFOUND_PREFIX = "nf:";               // short-lived "no such character" marker: a typo'd/deleted name isn't re-fetched in a loop.
const DRAIN_LOCK_KEY = "drain:lock";         // serialize active drains (cron + enqueue-kicks) so two never overlap + double-fetch lostark.bible; auto-expires (crash safety).
const NOTFOUND_TTL_S = 60 * 60;              // remember not-found for 1 hour (self-corrects if it was a transient 404).
const Q_ORDER_KEY = "q:order";               // #1: cron-maintained ordered queue snapshot — lets position/metrics/probe skip the 2 KV list()s.
const Q_ORDER_TTL_MS = 90 * 1000;            // trust the snapshot for 90s (rewritten each active drain minute); older -> re-list for correctness.
const DRAIN_CONFIG_KEY = "drain:config";      // admin drain state: { mode:"run"|"off"|"probe", drainPerMin, lastProbe?, interval? }. mode!="run" gates enqueues + drives the "lookups temporarily unavailable" notice. Set via ?control (owner-only).
const DRAIN_MODES = ["run", "off", "probe"]; // run = draining; off = frozen (no upstream requests); probe = paused but periodically probing lostark.bible to auto-resume on recovery.
const UNAVAILABLE_MSG = "Character lookups are temporarily unavailable";
const MAX_FETCH_ATTEMPTS = 5;                // after this many failed fetches a queued character is DROPPED, so a permanently-broken entry (e.g. some KR names) can't sit at the head retrying forever and starving everyone behind it.
const QUEUE_TTL_S = 7 * 24 * 60 * 60;        // a queued request expires after 7 days if never drained.
const SNAPSHOT_MIN_INTERVAL_MS = 30 * 60 * 1000; // rebuild the leaderboard snapshot at most every ~30 min (the read-heavy part).
// Access token the GATED client appends as ?k= (== gate.js's salted hash). Requests without it
// are un-refreshed pre-gate clients -> 403'd before any KV work, so they stop draining the quota.
// Not the password (a one-way hash); a stale client just needs to refresh the page.
const GATE_TOKEN = "6104928cd0cc5374f5330e63e6a834f99aef7579db15c77d9d154932bf7a8ced";
function gated(u) { return (u.searchParams.get("k") || "") === GATE_TOKEN; }

// key = "region:name" lowercased (e.g. "na:paroxysmal").
function charKey(region, name) {
  return (region + ":" + name).toLowerCase();
}

// Normalize a character's DISPLAY name: for Roman/Latin-script names, capitalize the
// first letter and lowercase the rest ("subsz"->"Subsz", "PAROXYSMAL"->"Paroxysmal").
// Korean (Hangul) names are left untouched ("마스터Asia" stays as-is). LA names are
// single tokens (no spaces). NOTE: this only affects the display name; charKey() still
// lowercases "region:name" so the KV cache key stays case-insensitive and lookups hit.
function normalizeName(name){ if(!name) return name; if(/[가-힣㄰-㆏]/.test(name)) return name; return name.charAt(0).toUpperCase()+name.slice(1).toLowerCase(); }

// Read + JSON.parse a KV value, tolerating missing/corrupt entries.
async function kvGetJson(env, key) {
  if (!env || !env.CHARS) return null;
  try {
    const raw = await env.CHARS.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

// (No indexAdd anymore: handleList enumerates keys via KV list(), which is race-free.
// The old read-modify-write on "__index__" could lose an add when two pulls ran
// concurrently, so a character would grade fine yet never appear in ?list=1.)

// --- KR (lopec.kr) support --------------------------------------------------
// lopec.kr is a Next.js app whose RSC payload carries clean gem objects:
//   {icon:"…/use_13_2NN.png", requiredWillpower, orderChaosPoint, effects:[{name,level}]}
// icon 202/203/204 = order c8/c9/c10, 205/206/207 = chaos c8/c9/c10; requiredWillpower
// IS the willpower cost, so willpowerLevel = baseCost − requiredWillpower.
const KR_EFFECT = {
  "추가 피해": "Additional Damage",
  "공격력": "Attack Power",
  "보스 피해": "Boss Damage",
  "아군 공격 강화": "Ally Attack Enh.",
  "아군 피해 강화": "Ally Damage Enh.",
  "낙인력": "Brand Power"
};
const KR_SLOT = { order: ["Order Sun", "Order Moon", "Order Star"], chaos: ["Chaos Sun", "Chaos Moon", "Chaos Star"] };

function parseLopecGems(html) {
  const u = html.replace(/\\"/g, '"'); // unescape the RSC JSON strings
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

// Known advanced classes — lostark.bible renders the English class name as a profile badge.
const CLASS_NAMES = ["Berserker","Destroyer","Gunlancer","Paladin","Slayer","Valkyrie","Arcanist","Summoner","Bard","Sorceress","Wardancer","Scrapper","Soulfist","Glaivier","Striker","Breaker","Deathblade","Shadowhunter","Reaper","Souleater","Sharpshooter","Deadeye","Artillerist","Machinist","Gunslinger","Aeromancer","Wildsoul","Artist","Guardianknight"];

// lopec.kr exposes the class only as its Korean name in the RSC ("class":"버서커").
// Map each Korean advanced-class name to the English name (the same keys the static
// app's class-icon files use). Anchored on user-confirmed: 버서커/환수사/아르카나.
const KR_CLASS = {
  "버서커": "Berserker", "디스트로이어": "Destroyer", "워로드": "Gunlancer", "홀리나이트": "Paladin", "슬레이어": "Slayer", "발키리": "Valkyrie",
  "아르카나": "Arcanist", "서머너": "Summoner", "바드": "Bard", "소서리스": "Sorceress",
  "배틀마스터": "Wardancer", "인파이터": "Scrapper", "기공사": "Soulfist", "창술사": "Glaivier", "스트라이커": "Striker", "브레이커": "Breaker",
  "블레이드": "Deathblade", "데모닉": "Shadowhunter", "리퍼": "Reaper", "소울이터": "Souleater",
  "헌터": "Sharpshooter", "데빌헌터": "Deadeye", "블래스터": "Artillerist", "스카우터": "Machinist", "건슬링어": "Gunslinger",
  "도화가": "Artist", "기상술사": "Aeromancer", "환수사": "Wildsoul",
  "가디언나이트": "Guardianknight" // new class (KR 2025-12-10); icon = Guardianknight.svg
};

// Item level + class from the page. lostark.bible: ilvl in the SvelteKit blob + the class
// as a profile badge. lopec.kr: per-piece "itemLevel" averaged (~= character level) + the
// class from the RSC "class" field (a Korean name) mapped to English via KR_CLASS.
function parseMeta(html, isKR) {
  let itemLevel = null, klass = null;
  if (isKR) {
    const u = html.replace(/\\"/g, '"'); // lopec.kr RSC escapes its quotes
    const lvls = []; const re = /"itemLevel":\s*(\d+)/g; let m;
    while ((m = re.exec(u)) !== null) lvls.push(parseInt(m[1], 10));
    if (lvls.length) itemLevel = Math.round(lvls.reduce((a, b) => a + b, 0) / lvls.length);
    // class: the first RSC "class":"<value>" whose value is a known Korean class name
    // (skips CSS "className"/"firstClass"/"secondClass" — different keys).
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

// Fetch a character page (lostark.bible, or lopec.kr when region is KR) and parse it
// into the stored gem shape. Returns { ok:true, data } or { ok:false, status, body }.
async function fetchCharacterData(region, name) {
  const isKR = String(region).toUpperCase() === "KR";
  // lostark.bible uses "CE" for EU Central; map our single "EU" option to it.
  const bibleRegion = String(region).toUpperCase() === "EU" ? "CE" : region;
  const url = isKR
    ? "https://lopec.kr/character/specPoint/" + encodeURIComponent(name)
    : "https://lostark.bible/character/" + encodeURIComponent(bibleRegion) + "/" + encodeURIComponent(name);
  const site = isKR ? "lopec.kr" : "lostark.bible";

  let resp;
  try {
    resp = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": isKR ? "ko-KR,ko;q=0.9" : "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Referer": isKR ? "https://lopec.kr/" : "https://lostark.bible/",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "sec-ch-ua": "\"Google Chrome\";v=\"124\", \"Chromium\";v=\"124\", \"Not-A.Brand\";v=\"99\"",
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": "\"macOS\""
      },
      // Follow SvelteKit redirects (region casing etc.).
      redirect: "follow"
    });
  } catch (e) {
    return { ok: false, status: 502, body: { error: "Upstream fetch failed: " + (e && e.message || e), url: url } };
  }

  if (resp.status === 404) {
    return { ok: false, status: 404, body: { error: "Character not found on " + site + ".", region: region, name: name, url: url, upstreamStatus: 404 } };
  }
  if (!resp.ok) {
    return { ok: false, status: 502, body: { error: site + " returned HTTP " + resp.status + ".", region: region, name: name, url: url, upstreamStatus: resp.status } };
  }

  const html = await resp.text();

  let gems, warnings, coreCount, chaosGems = null;
  if (isKR) {
    const parsed = parseLopecGems(html);
    gems = parsed.gems; warnings = parsed.warnings; coreCount = 6;
    if (!gems.length) {
      return { ok: false, status: 422, body: {
        error: "Could not find Ark Grid gems on the lopec.kr page (no astrogems set, or the site layout changed).",
        region: region, name: name, url: url
      } };
    }
  } else {
    const presets = extractArkGridCores(html);
    if (!presets.raid) {
      return { ok: false, status: 422, body: {
        error: "Could not find arkGridCores data on the page (the character may have no Ark Grid set, or the site layout changed).",
        region: region, name: name, url: url
      } };
    }
    const raidRes = coresToGems(presets.raid);
    gems = raidRes.gems; warnings = raidRes.warnings; coreCount = presets.raid.length;
    // Chaos-dungeon preset (a separate Ark Grid loadout), if the character has one.
    if (presets.chaos) chaosGems = coresToGems(presets.chaos).gems;
  }

  const meta = parseMeta(html, isKR);
  return { ok: true, data: {
    region: region,
    // Normalize the DISPLAY name (Roman-script -> Title-case; Korean left as-is). This
    // record flows into both the KV value and the JSON response, and ?list=1 echoes it,
    // so the leaderboard shows normalized names. The KV cache KEY is unaffected — it
    // comes from charKey(region, name) on the ORIGINAL requested name, which lowercases.
    name: normalizeName(name),
    source: site,
    url: url,
    itemLevel: meta.itemLevel,
    class: meta.klass,
    coreCount: coreCount,
    gemCount: gems.length,
    gems: gems,
    chaosGems: chaosGems,
    warnings: warnings
  } };
}

// GET /?region=&name= — cache-aware single-character pull.
//   - cache hit (key present, pulledAt < 7d, no &refresh=1) -> return stored JSON, cached:true.
//   - else fetch fresh, store { region, name, gems, pulledAt, ... }, index the key, cached:false.
//   - &refresh=1 bypasses the cache read (force fresh + re-store).
//   - no env.CHARS -> fetch fresh every time, no caching (cached:false, no pulledAt write).
async function handleCharacter(env, region, name, refresh, extra) {
  const key = charKey(region, name);
  extra = extra || {};

  if (env && env.CHARS && !refresh) {
    const cached = await kvGetJson(env, key);
    if (cached && typeof cached.pulledAt === "number" && (Date.now() - cached.pulledAt) < CACHE_TTL_MS) {
      return json(Object.assign({}, cached, { cached: true }, extra), 200);
    }
  }

  const res = await fetchCharacterData(region, name);
  if (!res.ok) return json(Object.assign({}, res.body, extra), res.status);

  const record = Object.assign({}, res.data, { pulledAt: Date.now() });
  if (env && env.CHARS) {
    try {
      await env.CHARS.put(key, JSON.stringify(record));
      await markDirty(env, key);                              // #3: queue this char for the incremental snapshot
      // Bump the leaderboard "last write" stamp (informational for the dashboard).
      await env.CHARS.put(LASTWRITE_KEY, String(Date.now()));
    } catch (e) {
      // Storage failure is non-fatal: still return the freshly fetched data.
    }
  }
  return json(Object.assign({}, record, { cached: false }, extra), 200);
}

// #3: mark a character changed so the next snapshot rebuild merges JUST it (not all ~4000 records).
function markDirty(env, ck) { return env.CHARS.put(DIRTY_PREFIX + ck, "1", { expirationTtl: SNAPSHOT_DIRTY_TTL_S }).catch(function () {}); }

// Full rebuild of the leaderboard list from a race-free KV enumeration. This is the EXPENSIVE path
// (~one KV read per stored character) — used only for the FIRST build; later builds are incremental.
async function buildCharacterList(env) {
  const keys = [];
  let cursor;
  do {
    const res = await env.CHARS.list({ cursor: cursor, limit: 1000 });
    for (const k of res.keys) { if (k.name !== INDEX_KEY && k.name !== SNAPSHOT_KEY) keys.push(k.name); }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  // Read every character record CONCURRENTLY (one KV read each); Promise.all collapses latency.
  const records = await Promise.all(keys.map(function (k) { return kvGetJson(env, k); }));
  const characters = [];
  for (const c of records) {
    if (c && Array.isArray(c.gems)) {
      characters.push({ region: c.region, name: c.name, gems: c.gems, pulledAt: c.pulledAt, itemLevel: c.itemLevel, class: c.class });
    }
  }
  return characters;
}

// GET /?list=1 — leaderboard list. Serves the snapshot key in a SINGLE read and NEVER rebuilds
// on demand: the snapshot is maintained server-side by the cron (rebuildSnapshotIfChanged), so
// reads are decoupled from how often the board is opened. Empty until the first cron build.
async function handleList(env) {
  if (!env || !env.CHARS) return json({ characters: [] }, 200);
  const snap = await kvGetJson(env, SNAPSHOT_KEY);
  const characters = (snap && Array.isArray(snap.characters)) ? snap.characters : [];
  return json({ characters: characters, builtAt: (snap && snap.builtAt) || 0 }, 200);
}

// Cron entry: refresh the leaderboard snapshot INCREMENTALLY. The dirty markers (lb:dirty:<key>,
// written whenever a character is cached) are the change log — list them (one list), read ONLY those
// records, and upsert them into the existing snapshot, instead of re-reading all ~4000 characters.
// The FIRST build (no snapshot yet) still does a full read. Throttled to ~every 30 min. Markers added
// mid-build keep their marker (only the ones we listed are cleared), so nothing is lost.
async function rebuildSnapshotIfChanged(env) {
  if (!env || !env.CHARS) return;
  let dirty;
  try { dirty = await env.CHARS.list({ prefix: DIRTY_PREFIX }); } catch (e) { return; }
  const builtAt = parseInt((await env.CHARS.get(BUILTAT_KEY)) || "0", 10);
  if (builtAt > 0 && !dirty.keys.length) return;                                // nothing changed since the last build
  if (builtAt > 0 && (Date.now() - builtAt) < SNAPSHOT_MIN_INTERVAL_MS) return; // throttle: rebuild at most ~every 30 min
  const startedAt = Date.now();
  const snap = await kvGetJson(env, SNAPSHOT_KEY);
  let characters;
  if (snap && Array.isArray(snap.characters) && snap.characters.length) {
    // INCREMENTAL: merge only the changed characters into the existing snapshot (upsert by region:name).
    characters = snap.characters.slice();
    const idx = {};
    for (let i = 0; i < characters.length; i++) { const c = characters[i]; idx[(c.region + ":" + c.name).toLowerCase()] = i; }
    const charKeys = dirty.keys.map(function (k) { return k.name.slice(DIRTY_PREFIX.length); });
    const recs = await Promise.all(charKeys.map(function (ck) { return kvGetJson(env, ck); }));
    for (const c of recs) {
      if (c && Array.isArray(c.gems)) {
        const e = { region: c.region, name: c.name, gems: c.gems, pulledAt: c.pulledAt, itemLevel: c.itemLevel, class: c.class };
        const id = (c.region + ":" + c.name).toLowerCase();
        if (idx[id] != null) characters[idx[id]] = e; else { idx[id] = characters.length; characters.push(e); }
      }
    }
  } else {
    characters = await buildCharacterList(env);                                  // first build -> full read
  }
  if (!characters.length) return;
  await env.CHARS.put(SNAPSHOT_KEY, JSON.stringify({ builtAt: startedAt, characters: characters }));
  await env.CHARS.put(BUILTAT_KEY, String(startedAt));
  // clear ONLY the markers we listed (any written mid-build keep theirs -> picked up next rebuild).
  await Promise.all(dirty.keys.map(function (k) { return env.CHARS.delete(k.name).catch(function () {}); }));
}

// Rolling per-drain history (~last hour) for the admin dashboard: every cron drain appends one
// entry (what it cached / dropped / failed + why it stopped, with upstream status + message per
// error) so the owner can watch drain activity and diagnose upstream issues without reading logs.
const DRAIN_LOG_KEY = "drain:log";
const DRAIN_LOG_MAX_MS = 60 * 60 * 1000;     // keep ~1 hour of entries
async function appendDrainLog(env, run) {
  try {
    const log = (await kvGetJson(env, DRAIN_LOG_KEY)) || [];
    log.push(run);
    const cut = Date.now() - DRAIN_LOG_MAX_MS;
    const kept = log.filter(function (e) { return e && e.t >= cut; }).slice(-240); // 1h window + hard cap
    await env.CHARS.put(DRAIN_LOG_KEY, JSON.stringify(kept));
  } catch (e) {}
}

// Re-queue characters at the FRONT of the free queue (oldest ts=1, attempts reset) so a paused
// queue resumes by retrying exactly the lookups that failed, first. Dedupes by region:name.
async function requeueFront(env, items) {
  const seen = {};
  for (const it of (items || [])) {
    if (!it || !it.region || !it.name) continue;
    const k = QF + charKey(it.region, it.name);
    if (seen[k]) continue; seen[k] = 1;
    try { await env.CHARS.put(k, "", { metadata: { region: it.region, name: it.name, ts: 1 }, expirationTtl: QUEUE_TTL_S }); } catch (e) {}
  }
}

// PAUSE probe: try the OLDEST queued character once (or a canary if the queue is empty) to see if
// lostark.bible is back. UP = a 200 (cache it) or a 404 (it responded — just no such character);
// DOWN = a 502 (incl. the 401 IP block) / 5xx / network error.
const CANARY = { region: "NA", name: "Paroxysmal" };
// Admin drain config (mode + per-minute rate + probe backoff state). Defaults to running at the
// default rate when unset, so a fresh/empty KV simply drains normally.
async function getDrainConfig(env) {
  let c = null;
  try { c = await kvGetJson(env, DRAIN_CONFIG_KEY); } catch (e) {}
  c = c || {};
  const mode = DRAIN_MODES.indexOf(c.mode) !== -1 ? c.mode : "run";
  let rate = parseInt(c.drainPerMin, 10);
  if (!Number.isFinite(rate) || rate < 1) rate = DRAIN_PER_RUN;
  if (rate > 30) rate = 30;                       // (the time budget caps the effective rate ~16/run anyway)
  return { mode: mode, drainPerMin: rate, lastProbe: c.lastProbe || 0, interval: c.interval || PAUSE_PROBE_FIRST_MS };
}
function setDrainConfig(env, cfg) { return env.CHARS.put(DRAIN_CONFIG_KEY, JSON.stringify(cfg)).catch(function () {}); }
async function probeOldest(env) {
  // Use the q:order snapshot (one read) — STALE is fine, the probe only tests connectivity. Fall
  // back to a fresh list only if the snapshot is empty; a canary if the queue itself is empty.
  let first = null;
  try { const s = await kvGetJson(env, Q_ORDER_KEY); if (s && Array.isArray(s.items) && s.items.length) first = s.items[0]; } catch (e) {}
  if (!first) { const items = await listQueueOrder(env); if (items.length) first = items[0]; }
  const md = first ? { region: first.r, name: first.n } : CANARY;
  const qkey = first ? first.k : null;                      // queue key to clear if the probe succeeds
  if (first && (!md.region || !md.name)) { try { await env.CHARS.delete(qkey); } catch (e) {} return { up: false, result: "skip" }; }
  let res = null;
  try { res = await fetchCharacterData(md.region, md.name); } catch (e) { res = null; }
  if (res && res.ok) {
    if (qkey) { try { await env.CHARS.put(charKey(md.region, md.name), JSON.stringify(Object.assign({}, res.data, { pulledAt: Date.now() }))); await markDirty(env, charKey(md.region, md.name)); await env.CHARS.delete(qkey); } catch (e) {} }
    return { up: true, cached: !!qkey, name: md.region + ":" + md.name };
  }
  if (res && res.status === 404) { if (qkey) { try { await env.CHARS.delete(qkey); } catch (e) {} } return { up: true, cached: false, name: md.region + ":" + md.name }; }
  return { up: false, result: "down", entry: { region: md.region, name: md.name, status: res ? res.status : 0, upstream: (res && res.body && res.body.upstreamStatus) || null, msg: (res && res.body && res.body.error) || "network/timeout" } };
}

// Cron drain: cache up to DRAIN_PER_RUN queued characters per run, PREMIUM queue first then FREE,
// paced ~DRAIN_DELAY_MS apart so we never trip lostark.bible. region+name ride in the key metadata,
// so listing needs no per-key read. A transient upstream error (5xx / upstream 429) stops the run
// and leaves the item queued for next time; a 4xx (not found) drops it. Bumps LASTWRITE so the
// throttled snapshot rebuild picks the new characters up.
async function drainQueue(env) {
  if (!env || !env.CHARS) return;
  // Monthly budget guard: once MONTHLY_CHAR_BUDGET characters are cached this calendar month,
  // pause draining so KV writes can never approach the paid limit (no overage, ever).
  const month = new Date().toISOString().slice(0, 7);
  const usage = await kvGetJson(env, USAGE_KEY);
  let used = (usage && usage.month === month) ? (usage.count | 0) : 0;
  const t0 = Date.now();
  const run = { t: t0, cached: [], dropped: [], failed: [], stop: null }; // per-drain history entry

  // Admin drain MODE (set via ?control on the queue-admin page):
  //   "off"   -> frozen: do nothing, ZERO lostark.bible requests (manual resume).
  //   "probe" -> paused but probe the oldest queued char on a backoff; auto-resume (mode->run) on recovery.
  //   "run"   -> drain normally at cfg.drainPerMin (the active path below).
  const cfg = await getDrainConfig(env);
  if (cfg.mode === "off") return;
  if (cfg.mode === "probe") {
    if (Date.now() - (cfg.lastProbe || 0) < (cfg.interval || PAUSE_PROBE_FIRST_MS)) return; // not time to probe yet
    const probe = await probeOldest(env);
    run.ms = Date.now() - t0;
    if (probe.up) {
      await setDrainConfig(env, { mode: "run", drainPerMin: cfg.drainPerMin });   // RECOVERED -> resume draining
      run.stop = "resumed";
      if (probe.cached && probe.name) {
        run.cached.push(probe.name);
        try { await env.CHARS.put(LASTWRITE_KEY, String(Date.now())); } catch (e) {}
        try { const u = await kvGetJson(env, USAGE_KEY); const c = (u && u.month === month ? (u.count | 0) : 0) + 1; await env.CHARS.put(USAGE_KEY, JSON.stringify({ month: month, count: c }), { expirationTtl: 40 * 24 * 3600 }); } catch (e) {}
      }
    } else {
      await setDrainConfig(env, { mode: "probe", drainPerMin: cfg.drainPerMin, lastProbe: Date.now(), interval: Math.min((cfg.interval || PAUSE_PROBE_FIRST_MS) * 2, PAUSE_PROBE_MAX_MS) }); // still down -> back off ×2
      run.stop = "probe";
      if (probe.entry) run.failed.push(probe.entry);
    }
    await appendDrainLog(env, run);
    return;
  }

  if (used >= MONTHLY_CHAR_BUDGET) { run.stop = "budget"; run.ms = 0; await appendDrainLog(env, run); return; }
  // serialize active drains (the cron + enqueue-kicks) so two never overlap and double-fetch lostark.bible.
  try { if (await env.CHARS.get(DRAIN_LOCK_KEY)) return; await env.CHARS.put(DRAIN_LOCK_KEY, "1", { expirationTtl: 55 }); } catch (e) {}
  const perRun = cfg.drainPerMin;                 // admin-set rate (chars per cron run = per minute)
  const delayMs = Math.round(60000 / perRun);     // pace ONE fetch per (60/rate)s — e.g. 15/min => one every 4s (one character at a time)
  let processed = 0, cached = 0, failed = 0, consecFail = 0, stop = false;
  // #1: list BOTH queues ONCE, up front, in drain order — then write the q:order snapshot at the end
  // so position / metrics / probe reads can skip listing entirely (they read q:order instead).
  const items = await listQueueOrder(env);     // [{k,r,n,t,a,p}] premium-first, oldest-ts first
  const removed = new Set();                    // queue keys cached or dropped this run (gone from the snapshot)
  for (const it of items) {
    if (processed >= perRun || Date.now() - t0 > DRAIN_BUDGET_MS) { run.stop = processed >= perRun ? "full" : "time"; stop = true; break; }
    if (!it.r || !it.n) { try { await env.CHARS.delete(it.k); } catch (e) {} removed.add(it.k); continue; } // malformed -> drop
    let res = null;
    try { res = await fetchCharacterData(it.r, it.n); } catch (e) { res = null; } // ONE fetch — no blind retry (gentler on lostark.bible; a real outage trips the breaker below)
    const upstream = (res && res.body && res.body.upstreamStatus) || null; // the real lostark.bible status behind our 502
    if (res && res.ok) {
      consecFail = 0;
      const record = Object.assign({}, res.data, { pulledAt: Date.now() });
      try { await env.CHARS.put(charKey(it.r, it.n), JSON.stringify(record)); await markDirty(env, charKey(it.r, it.n)); await env.CHARS.delete(it.k); cached++; removed.add(it.k); run.cached.push(it.r + ":" + it.n); } catch (e) {}
    } else if (res && res.status >= 400 && res.status < 500) {
      // ANY 4xx -> drop AND remember it (short TTL) so the page can't re-enqueue + re-fetch the same
      // dead name forever: 404 = no such character, 422 = the page has no Ark Grid astrogems to grade.
      // Store the reason so enqueueChar / the wait long-poll can tell the user WHY (instead of spinning).
      consecFail = 0;
      try { await env.CHARS.delete(it.k); } catch (e) {} removed.add(it.k);
      try { await env.CHARS.put(NOTFOUND_PREFIX + charKey(it.r, it.n), String((res.body && res.body.error) || ("HTTP " + res.status)).slice(0, 300), { expirationTtl: NOTFOUND_TTL_S }); } catch (e) {}
      run.dropped.push({ region: it.r, name: it.n, status: res.status, msg: (res.body && res.body.error) || "dropped" });
    } else if (upstream >= 400 && upstream < 500) {
      // a BLOCK: any 4xx refusal from lostark.bible (401/403/418/429/451 — their anti-bot rotates the
      // code; 404 is already handled above as "not found"). It won't fix itself on a retry, so PAUSE
      // immediately instead of burning the full fail streak to discover it. Re-queue this run at the front.
      run.failed.push({ region: it.r, name: it.n, status: res ? res.status : 0, upstream: upstream, msg: (res.body && res.body.error) || "blocked", att: 1 });
      await requeueFront(env, run.failed);
      await setDrainConfig(env, { mode: "probe", drainPerMin: cfg.drainPerMin, lastProbe: Date.now(), interval: PAUSE_PROBE_FIRST_MS }); // breaker -> PROBE: auto-recovers when lostark.bible is back (admin can force Run/Off)
      run.stop = "blocked"; stop = true; break;
    } else {
      // transient 5xx / network / timeout: SKIP this character (leave it queued) so one bad or slow
      // character can't head-of-line-block the queue. Count attempts so a PERMANENTLY broken entry
      // (e.g. some KR names) is eventually DROPPED instead of retried forever at the head.
      failed++;
      const att = (it.a | 0) + 1;
      run.failed.push({ region: it.r, name: it.n, status: res ? res.status : 0, upstream: upstream, msg: (res && res.body && res.body.error) || "network/timeout", att: att });
      console.log("[drain-fail] " + it.r + ":" + it.n + " status=" + (res ? res.status : "throw") + " att=" + att);
      try {
        if (att >= MAX_FETCH_ATTEMPTS) { await env.CHARS.delete(it.k); removed.add(it.k); }                 // give up — drop it
        else await env.CHARS.put(it.k, "", { metadata: { region: it.r, name: it.n, ts: it.t, attempts: att }, expirationTtl: QUEUE_TTL_S }); // preserve ts (keep FIFO place)
      } catch (e) {}
      if (++consecFail >= PAUSE_FAIL_LIMIT) {
        // circuit-breaker -> PROBE: re-queue this run's failures at the FRONT (attempts reset; the
        // upstream being down isn't the character's fault), then auto-recover via probes. Admin can force Run/Off.
        await requeueFront(env, run.failed);
        await setDrainConfig(env, { mode: "probe", drainPerMin: cfg.drainPerMin, lastProbe: Date.now(), interval: PAUSE_PROBE_FIRST_MS });
        run.stop = "paused"; stop = true; break;
      }
    }
    processed++;
    if (processed < perRun) await new Promise(function (r) { setTimeout(r, delayMs); });
  }
  // #1: refresh the q:order snapshot = items still queued after this run (drain order preserved), so
  // queueStatus / metrics / probe read it instead of listing. (Skipped while paused — early return above.)
  try { await env.CHARS.put(Q_ORDER_KEY, JSON.stringify({ ts: Date.now(), items: items.filter(function (it) { return !removed.has(it.k); }) })); } catch (e) {}
  run.ms = Date.now() - t0;
  // #4: skip logging a do-nothing run (idle / empty queue) — keep drain:log (and its KV write) for
  // runs that actually cached, failed, or dropped something. Liveness is still visible via backlog.
  if (run.cached.length || run.failed.length || run.dropped.length) await appendDrainLog(env, run);
  if (processed > 0 || failed > 0) console.log("[drain] processed=" + processed + " cached=" + cached + " failed=" + failed + (stop ? " (backed off)" : ""));
  if (cached > 0) {
    try { await env.CHARS.put(LASTWRITE_KEY, String(Date.now())); } catch (e) {}
    try { await env.CHARS.put(USAGE_KEY, JSON.stringify({ month: month, count: used + cached }), { expirationTtl: 40 * 24 * 3600 }); } catch (e) {}
  }
  try { await env.CHARS.delete(DRAIN_LOCK_KEY); } catch (e) {}  // release the serialize lock for the next drain/kick
}

// #1: the ordered queue (premium first, then free; each oldest-ts first) as [{k,r,n,t,a,p}].
// listQueueOrder lists both queues fresh; readQueueOrder prefers the cron-maintained q:order
// snapshot (one cheap read) and only re-lists when it's missing or stale — so callers stay
// correct while skipping the two KV list()s in the common (fresh-snapshot) case.
async function listQueueOrder(env) {
  let p = [], f = [];
  try { p = (await env.CHARS.list({ prefix: QP })).keys; } catch (e) {}
  try { f = (await env.CHARS.list({ prefix: QF })).keys; } catch (e) {}
  const map = function (keys, premium) {
    return keys.slice().sort(function (a, b) { return ((a.metadata && a.metadata.ts) || 0) - ((b.metadata && b.metadata.ts) || 0); })
      .map(function (k) { const m = k.metadata || {}; return { k: k.name, r: m.region || "", n: m.name || "", t: m.ts || 0, a: m.attempts || 0, p: premium }; });
  };
  return map(p, true).concat(map(f, false));
}
async function readQueueOrder(env) {
  try { const s = await kvGetJson(env, Q_ORDER_KEY); if (s && Array.isArray(s.items) && Date.now() - (s.ts || 0) < Q_ORDER_TTL_MS) return s.items; } catch (e) {}
  return listQueueOrder(env);
}

// Where a queued character sits in the drain order + the total queued + a rough ETA
// (~DRAIN_PER_RUN cached per minute). Reads the q:order snapshot (no list() when it's fresh). A
// just-enqueued key may not be in the snapshot yet -> reported at the tail, which the next poll corrects.
async function queueStatus(env, region, name, tier) {
  const fullKey = (tier === "premium" ? QP : QF) + charKey(region, name);
  const items = await readQueueOrder(env);                  // premium-first, then free
  const idx = items.findIndex(function (it) { return it.k === fullKey; });
  const position = (idx >= 0 ? idx : items.length) + 1;     // not-yet-listed -> tail (next poll corrects)
  const total = Math.max(items.length, position);
  const dpm = (await getDrainConfig(env)).drainPerMin;     // ETA uses the admin-set rate
  return { position: position, total: total, etaMinutes: Math.ceil(position / dpm), drainPerMin: dpm };
}

// A "queued" JSON response carrying the live queue status (position / total / ETA). Used both
// when a character is freshly queued AND when it's ALREADY queued (so a re-lookup never double-
// adds — it just reports where you are).
async function queuedResponse(env, region, name, tier, extra, wantPos) {
  // Position/total/ETA cost two KV list()s — compute them only when the client asks (&pos=1: the
  // initial lookup + manual refresh). The 8s auto-poll omits &pos, so it pays only the cheap get()s
  // and the client keeps showing the position from its first response.
  const st = wantPos ? await queueStatus(env, region, name, tier) : null;
  return json(Object.assign({ queued: true, tier: tier, region: region, name: normalizeName(name) }, st || {}, extra || {}), 200);
}

// Fast-path KICK: fetch + cache ONE specific just-queued character directly — NO list(), so it dodges
// KV list() eventual-consistency (the just-written queue key isn't visible to an immediate list, which
// made the old drainQueue-kick silently process a stale list and miss the new char). The cron drainQueue
// still does the full, paced, breaker-aware drain. Mirrors the drain's per-char ok/4xx branches; leaves
// block/transient queued for the cron (which owns the circuit-breaker).
async function kickFetch(env, region, name) {
  if (!env || !env.CHARS) return;
  try { const cfg = await getDrainConfig(env); if (cfg.mode !== "run") return; } catch (e) { return; } // off/probe -> don't touch lostark.bible
  const key = charKey(region, name);
  const t0 = Date.now();
  let res = null;
  try { res = await fetchCharacterData(region, name); } catch (e) { res = null; }
  if (res && res.ok) {
    try {
      await env.CHARS.put(key, JSON.stringify(Object.assign({}, res.data, { pulledAt: Date.now() })));
      await markDirty(env, key);
      await env.CHARS.delete(QF + key); await env.CHARS.delete(QP + key);
      await env.CHARS.put(LASTWRITE_KEY, String(Date.now()));
      const m = new Date().toISOString().slice(0, 7);
      const u = await kvGetJson(env, USAGE_KEY);
      await env.CHARS.put(USAGE_KEY, JSON.stringify({ month: m, count: (u && u.month === m ? (u.count | 0) : 0) + 1 }), { expirationTtl: 40 * 24 * 3600 });
      await appendDrainLog(env, { t: Date.now(), cached: [region + ":" + name], dropped: [], failed: [], stop: null, kick: true, ms: Date.now() - t0 }); // so the admin SEES it: a sub-2s kick drains before the live queue list() catches up
    } catch (e) {}
  } else if (res && res.status >= 400 && res.status < 500) {       // OUR 4xx = not-found(404)/no-Ark-Grid(422): drop + remember WHY
    try {
      await env.CHARS.delete(QF + key); await env.CHARS.delete(QP + key);
      await env.CHARS.put(NOTFOUND_PREFIX + key, String((res.body && res.body.error) || ("HTTP " + res.status)).slice(0, 300), { expirationTtl: NOTFOUND_TTL_S });
      await appendDrainLog(env, { t: Date.now(), cached: [], dropped: [{ region: region, name: name, status: res.status, msg: (res.body && res.body.error) || "dropped" }], failed: [], stop: null, kick: true, ms: Date.now() - t0 });
    } catch (e) {}
  }
  // block (our 502 / upstream 4xx) or transient (5xx/network/timeout): leave it queued for the cron drain.
}

// Add a not-yet-cached character to the premium/free queue, gated by a GLOBAL enqueue rate so the
// queue can't be filled faster than the drain empties it (keeps monthly writes bounded). region+name
// stored as KV metadata (the drain reads them from list() without an extra get).
async function enqueueChar(env, region, name, premium, wantPos, ctx) {
  if (env.CHARS) {                                   // one round-trip: drain mode + known-missing (recent 404)?
    const [cfg, miss] = await Promise.all([
      getDrainConfig(env),
      env.CHARS.get(NOTFOUND_PREFIX + charKey(region, name))
    ]);
    if (cfg.mode !== "run") return json({ unavailable: true, error: UNAVAILABLE_MSG }, 503);       // off/probe -> "lookups temporarily unavailable" notice
    if (miss) return json({ error: (typeof miss === "string" && miss.length > 3) ? miss : "We couldn't find that character on lostark.bible — double-check the name and region.", notFound: true }, 404); // #6: known-missing/unparseable -> don't re-queue, and say WHY
  }
  if (env.ENQUEUE_GATE) {
    const g = await env.ENQUEUE_GATE.limit({ key: "enqueue" });
    if (!g.success) return json({ error: "The lookup queue is busy right now — please try again in a moment.", queueBusy: true, rateLimited: true, retryAfterMs: 30000 }, 429);
  }
  if (env.CHARS) {
    const usage = await kvGetJson(env, USAGE_KEY); // monthly budget guard: stop accepting new characters once the cap is hit
    if (usage && usage.month === new Date().toISOString().slice(0, 7) && (usage.count | 0) >= MONTHLY_CHAR_BUDGET) {
      return json({ error: "We've reached this month's character-caching budget — new lookups resume next month. Cached characters and the leaderboard still work normally.", monthlyBudget: true }, 503);
    }
    try { await env.CHARS.put((premium ? QP : QF) + charKey(region, name), "", { metadata: { region: region, name: name, ts: Date.now() }, expirationTtl: QUEUE_TTL_S }); } catch (e) {}
    if (ctx && ctx.waitUntil) ctx.waitUntil(kickFetch(env, region, name)); // KICK: fetch+cache THIS char now, directly (no list() -> immune to KV list lag). The cron drainQueue does the full paced drain.
    return queuedResponse(env, region, name, premium ? "premium" : "free", { justQueued: true }, wantPos);
  }
  return json({ queued: true, justQueued: true, tier: premium ? "premium" : "free", region: region, name: normalizeName(name) }, 200);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== "GET") {
      return json({ error: "Method not allowed (use GET ?region=&name=)." }, 405);
    }

    const u = new URL(request.url);
    const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";

    // Hard backstop on EVERY request (per IP) to stop scripted abuse before any work — an edge
    // rate-limit binding, no KV touched on a blocked hit. The token is public so it can't exempt.
    if (env.HARD_CAP) {
      const h = await env.HARD_CAP.limit({ key: ip });
      if (!h.success) return json({ error: "Too many requests — please slow down.", rateLimited: true, retryAfterMs: 60000, hardCap: true }, 429);
    }

    // GLOBAL overload gate: one shared counter across ALL requests (fixed key, not the IP). When
    // the site-wide rate trips ~1000/min we enter "degraded" mode — free clients are
    // cut off and password clients drop to the free rate. period max 60s, so it's a rolling
    // per-minute proxy for "10k/hour" that auto-recovers when traffic falls.
    const premium = gated(u);
    let degraded = false;
    if (env.GLOBAL_GATE) {
      const g = await env.GLOBAL_GATE.limit({ key: "global" });
      degraded = !g.success;
    }
    const busyMsg = "The site is very busy right now — free access is paused. Enter the password for limited access, or try again shortly.";

    // Public status (no token): is the lookup queue PAUSED (lostark.bible unreachable)? Drives the
    // grader's "lookups temporarily unavailable" notice.
    if (u.searchParams.get("status") === "1") {
      const cfg = env.CHARS ? await getDrainConfig(env) : { mode: "run" };
      // SHORT browser cache: keeps the banner fresh (~30s, in line with the queue re-sync cadence) for
      // active users, while deduping rapid focus re-checks. paused = the drain isn't in "run" mode.
      return json({ ok: true, paused: cfg.mode !== "run", mode: cfg.mode, message: UNAVAILABLE_MSG }, 200, { "Cache-Control": "public, max-age=30" });
    }

    // Owner-only drain CONTROL: set the mode (run/off/probe) and/or the per-minute rate. Drives the
    // queue-admin Controls panel. e.g. ?control=1&k=<token>&mode=off  or  &rate=10
    if (u.searchParams.get("control") === "1") {
      if (!premium) return json({ error: "Forbidden — owner token required." }, 403);
      const cur = await getDrainConfig(env);
      const next = { mode: cur.mode, drainPerMin: cur.drainPerMin };
      const mode = u.searchParams.get("mode");
      let modeChanged = false;
      if (mode && DRAIN_MODES.indexOf(mode) !== -1) {
        next.mode = mode; modeChanged = true;
        if (mode === "probe") { next.lastProbe = 0; next.interval = PAUSE_PROBE_FIRST_MS; } // probe immediately, then back off
      }
      const rate = parseInt(u.searchParams.get("rate"), 10);
      if (Number.isFinite(rate) && rate >= 1 && rate <= 30) next.drainPerMin = rate;
      await setDrainConfig(env, next);
      // Resume/probe RIGHT NOW instead of waiting for the next cron tick — e.g. "Run" -> immediate drain.
      if (modeChanged && next.mode !== "off" && ctx && ctx.waitUntil) { try { ctx.waitUntil(drainQueue(env)); } catch (e) {} }
      return json({ ok: true, config: next }, 200);
    }

    // Leaderboard — open to everyone, throttled vs spam-refresh; free clients cut while degraded.
    if (u.searchParams.get("list") === "1") {
      if (degraded && !premium) return json({ error: busyMsg, rateLimited: true, degraded: true }, 429);
      if (env.LB_THROTTLE) {
        const l = await env.LB_THROTTLE.limit({ key: ip });
        if (!l.success) return json({ error: "The leaderboard refreshes about every 10 minutes — please wait a moment.", rateLimited: true, retryAfterMs: 20000, lbThrottle: true }, 429);
      }
      return handleList(env);
    }

    // Owner-only QUEUE METRICS (gated by the token): backlog counts, the queued list in drain order
    // (PREMIUM first, then FREE, each alphabetical), drain config + monthly usage. Light — two queue
    // list()s + two small get()s, NO big snapshot read — so the private dashboard can poll it often.
    if (u.searchParams.get("metrics") === "1") {
      if (!premium) return json({ error: "Forbidden — owner token required." }, 403);
      // #1: read the q:order snapshot (1 cheap read; lists only if stale) + the small state keys,
      // all independent -> one parallel round-trip.
      const [items, usage0, lw, dlog, cfg] = await Promise.all([
        listQueueOrder(env).catch(function () { return []; }), // admin: always the LIVE queue (1 owner; fresh > cached so new enqueues show immediately)
        kvGetJson(env, USAGE_KEY).catch(function () { return null; }),
        env.CHARS.get(LASTWRITE_KEY).catch(function () { return null; }),
        kvGetJson(env, DRAIN_LOG_KEY).catch(function () { return null; }),
        getDrainConfig(env).catch(function () { return { mode: "run", drainPerMin: DRAIN_PER_RUN }; })
      ]);
      const usage = usage0 || {}, lastWrite = parseInt(lw, 10) || 0;
      const drainLog = Array.isArray(dlog) ? dlog : [];
      const now = Date.now();
      const premiumCount = items.filter(function (it) { return it.p; }).length;
      const freeCount = items.length - premiumCount;
      const list = items.slice(0, 500).map(function (it) { return { region: it.r, name: it.n, tier: it.p ? "premium" : "free", waitedS: it.t > 1e12 ? Math.round((now - it.t) / 1000) : null }; }); // ts<=1e12 = a front-sentinel (e.g. requeued ts=1), not a real wait
      return json({
        ok: true, nowMs: Date.now(),
        drain: { perRun: cfg.drainPerMin, delayMs: Math.round(60000 / cfg.drainPerMin), perMin: cfg.drainPerMin },
        mode: cfg.mode,
        queue: { premium: premiumCount, free: freeCount, total: items.length, list: list },
        usage: { month: usage.month || "", count: (usage.count | 0), budget: MONTHLY_CHAR_BUDGET },
        lastWriteMs: lastWrite,
        drainLog: drainLog,
        paused: cfg.mode !== "run"
      }, 200);
    }

    const region = (u.searchParams.get("region") || "").trim();
    const name = (u.searchParams.get("name") || "").trim();
    const refresh = u.searchParams.get("refresh") === "1";

    if (!region && !name) {
      return json({ ok: true, service: "astrogem-bible", usage: "GET /?region=NA&name=CharacterName (add &refresh=1 to bypass cache, ?list=1 to list all)" });
    }
    if (!region || !name) {
      return json({ error: "Both ?region= and ?name= are required (e.g. ?region=NA&name=Paroxysmal)." }, 400);
    }
    const key = charKey(region, name);

    // Long-poll "wait" endpoint: hold the connection (~25s) and return the MOMENT the drain re-caches
    // this character newer than &since — a real "refresh done" signal, no client polling. Returns
    // {done:false} on timeout so the client simply reconnects. Drives the grader's refresh banner.
    if (u.searchParams.get("wait") === "1" && env.CHARS) {
      const sinceMs = parseInt(u.searchParams.get("since"), 10) || 0;
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        const rec = await kvGetJson(env, key);
        if (rec && Array.isArray(rec.gems) && (rec.pulledAt || 0) > sinceMs) return json(Object.assign({}, rec, { cached: true, done: true }), 200);
        const miss = await env.CHARS.get(NOTFOUND_PREFIX + key);   // dropped (404/422...) while waiting -> stop + report why
        if (miss) return json({ done: false, notFound: true, error: (miss.length > 3 ? miss : "We couldn't find that character on lostark.bible.") }, 200);
        await new Promise(function (r) { setTimeout(r, 1500); });
      }
      return json({ done: false }, 200);
    }

    const wantQueue = u.searchParams.get("queue") === "1";
    const wantPos = u.searchParams.get("pos") === "1"; // position/ETA cost 2 KV lists; the lookup + periodic re-syncs set &pos=1, the local countdown between them is free.

    // CACHED (any age): return the stored gems immediately (free — just a KV read). For &queue
    // clients it's ALSO queue-aware so the page can show the cached grades AND a live refresh
    // banner: if the character is already queued, OR its data is stale (>7d) and we now auto-enqueue
    // a refresh, the response carries {queued, tier, stale, position?}. refresh=1 bypasses all this.
    if (!refresh && env.CHARS) {
      const cached = await kvGetJson(env, key);
      if (cached && Array.isArray(cached.gems) && typeof cached.pulledAt === "number") {
        const fresh = (Date.now() - cached.pulledAt) < CACHE_TTL_MS;
        if (!wantQueue) {
          if (fresh) return json(Object.assign({}, cached, { cached: true }), 200); // legacy client: fresh only
        } else {
          const [inQP, inQF] = await Promise.all([env.CHARS.get(QP + key), env.CHARS.get(QF + key)]); // one round-trip, not two
          const tier = (inQP !== null) ? "premium" : (inQF !== null ? "free" : null);
          // #8: do NOT auto-enqueue a refresh for stale (>7d) data — just flag it `stale` and let the
          // user hit Re-pull (refresh=1) on demand. Gem grids rarely change, so constantly re-fetching
          // every old character in the background isn't worth the lostark.bible load.
          const out = Object.assign({}, cached, { cached: true, stale: !fresh });
          if (tier) { out.queued = true; out.tier = tier; if (wantPos) Object.assign(out, await queueStatus(env, region, name, tier)); }
          return json(out, 200);
        }
      }
    }

    // MISS (uncached). New clients (&queue=1) get QUEUED (cached later by the drain); old clients
    // keep the legacy synchronous fetch so nothing breaks mid-migration.

    // Already in the queue? Don't re-add — confirm it's still queued (cheap get) and, only when the
    // client asked (&pos=1), its live position/total/ETA. This is also the poll path the client hits
    // while it waits for the drain, kept list()-free so a waiting tab is nearly free to serve.
    if (wantQueue && env.CHARS) {
      const qp = (await env.CHARS.get(QP + key)) !== null;
      const qf = !qp && (await env.CHARS.get(QF + key)) !== null;
      if (qp || qf) {
        if (ctx && ctx.waitUntil) ctx.waitUntil(kickFetch(env, region, name)); // still waiting -> fetch it now (covers a kick that lost the KV-list race, and retries a transiently-failed one)
        if (qp) return queuedResponse(env, region, name, "premium", { alreadyQueued: true }, wantPos);
        if (premium) { // a password lookup of a free-queued character bumps it to the premium queue
          try { await env.CHARS.put(QP + key, "", { metadata: { region: region, name: name, ts: Date.now() }, expirationTtl: QUEUE_TTL_S }); await env.CHARS.delete(QF + key); } catch (e) {}
          return queuedResponse(env, region, name, "premium", { alreadyQueued: true, upgraded: true }, wantPos);
        }
        return queuedResponse(env, region, name, "free", { alreadyQueued: true }, wantPos);
      }
    }

    // Rate-limit the fetch/enqueue. EVERYONE (password or not) gets one lookup per ~5s per IP. The
    // password no longer buys a faster rate — it only (a) keeps working while the site is degraded
    // and (b) enqueues into the PRIORITY queue (drained first). Cached lookups already returned above
    // with no limit; the ENQUEUE_GATE + monthly budget guard bound total fill site-wide.
    if (degraded && !premium) return json({ error: busyMsg, rateLimited: true, degraded: true }, 429);
    if (env.LOOKUP_THROTTLE) {
      const t = await env.LOOKUP_THROTTLE.limit({ key: ip });
      if (!t.success) return json({ error: "One new-character lookup every 5 seconds — please wait a moment (cached characters are unlimited).", rateLimited: true, retryAfterMs: 5000, throttled: true }, 429);
    }
    if (wantQueue) return enqueueChar(env, region, name, premium, wantPos, ctx);
    return handleCharacter(env, region, name, refresh, { premium: premium, nextMs: 5000 });
  },

  async scheduled(controller, env, ctx) {
    // Every minute: drain a few queued characters (paced), then refresh the leaderboard snapshot
    // if it's due (rebuildSnapshotIfChanged self-throttles to ~every 30 min so reads stay low).
    await drainQueue(env);
    await rebuildSnapshotIfChanged(env);
  }
};
