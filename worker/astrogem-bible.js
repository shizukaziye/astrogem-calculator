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
function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, corsHeaders())
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
const LASTWRITE_KEY = "lb:lastwrite";        // ms timestamp of the most recent character write (plain overwrite, race-free).
const BUILTAT_KEY = "lb:builtat";            // ms timestamp the snapshot was last rebuilt by the cron.
const QP = "q:p:";                           // premium lookup-queue key prefix (region+name ride in KV metadata).
const QF = "q:f:";                           // free lookup-queue key prefix.
const DRAIN_PER_RUN = 6;                      // max characters cached per cron run (~6/min) — deliberately gentle on lostark.bible (an aggressive rate just gets rate-limited/timed-out, which FAILS more than it caches). Time-budgeted below so it never overruns the 60s cron; monthly guard caps the total.
const MONTHLY_CHAR_BUDGET = 300000;          // hard cap on characters cached per calendar month (~2 writes each ≈ 66% of the 1M/mo write budget → no overage, ever).
const USAGE_KEY = "usage:drained";           // {month:"YYYY-MM", count} — characters cached this month (the budget guard).
const DRAIN_DELAY_MS = 3000;                 // pause between lostark.bible fetches (~1 req / 3s) — gentle enough to avoid upstream rate-limiting/timeouts, which cost more than they cache.
const DRAIN_BUDGET_MS = 50000;               // stop a drain run after ~50s no matter the count, so it never overruns the 60s cron (margin for the snapshot rebuild + no overlapping runs).
const UPSTREAM_FAIL_LIMIT = 6;               // consecutive fetch failures before assuming lostark.bible is down/limiting and backing off this run (one bad/slow character is skipped, not fatal — no head-of-line blocking).
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
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": isKR ? "ko-KR,ko;q=0.9" : "en-US,en;q=0.9"
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
      // Bump the leaderboard "last write" stamp so the next cron run rebuilds the snapshot.
      // handleList enumerates keys via KV list() (race-free); no per-key index to maintain.
      await env.CHARS.put(LASTWRITE_KEY, String(Date.now()));
    } catch (e) {
      // Storage failure is non-fatal: still return the freshly fetched data.
    }
  }
  return json(Object.assign({}, record, { cached: false }, extra), 200);
}

// Rebuild the leaderboard list from a race-free KV enumeration. This is the EXPENSIVE path
// (~one KV read per stored character) — handleList only calls it when the snapshot is stale.
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

// Cron entry: rebuild the leaderboard snapshot, but ONLY when a character was written since the
// last build (lastWrite > builtAt) — so idle 10-min windows cost ~2 small reads instead of a
// full re-read of every stored character. Race-free: lastWrite is a plain overwrite and the
// build is a fresh list() enumeration. Stamps builtAt at the START so a write landing mid-build
// re-triggers next run. Never pins an empty result (e.g. a throttled read).
async function rebuildSnapshotIfChanged(env) {
  if (!env || !env.CHARS) return;
  const lastWrite = parseInt((await env.CHARS.get(LASTWRITE_KEY)) || "0", 10);
  const builtAt = parseInt((await env.CHARS.get(BUILTAT_KEY)) || "0", 10);
  if (builtAt > 0 && lastWrite <= builtAt) return; // nothing changed since the last build
  if (builtAt > 0 && (Date.now() - builtAt) < SNAPSHOT_MIN_INTERVAL_MS) return; // throttle: rebuild at most ~every 30 min
  const startedAt = Date.now();
  const characters = await buildCharacterList(env);
  if (!characters.length) return;
  await env.CHARS.put(SNAPSHOT_KEY, JSON.stringify({ builtAt: startedAt, characters: characters }));
  await env.CHARS.put(BUILTAT_KEY, String(startedAt));
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
  if (used >= MONTHLY_CHAR_BUDGET) return;
  let processed = 0, cached = 0, failed = 0, consecFail = 0, stop = false;
  const t0 = Date.now();
  for (const prefix of [QP, QF]) {
    if (stop || processed >= DRAIN_PER_RUN) break;
    let list;
    try { list = await env.CHARS.list({ prefix: prefix }); } catch (e) { break; }
    // FIFO: drain OLDEST-enqueued first. KV list() returns keys alphabetically, so re-order by the
    // enqueue `ts` stamped into each entry's metadata (pre-FIFO entries have no ts -> 0 -> treated
    // as oldest, so they clear first). The queue is gate-bounded, so one unpaged list() is plenty.
    const ordered = list.keys.slice().sort(function (a, b) { return ((a.metadata && a.metadata.ts) || 0) - ((b.metadata && b.metadata.ts) || 0); });
    for (const k of ordered) {
      if (processed >= DRAIN_PER_RUN || Date.now() - t0 > DRAIN_BUDGET_MS) { stop = true; break; }
      const md = k.metadata || {};
      if (!md.region || !md.name) { await env.CHARS.delete(k.name); continue; } // malformed -> drop
      let res = null;
      try { res = await fetchCharacterData(md.region, md.name); } catch (e) { res = null; } // timeout/network -> treat as upstream error
      if (!res || res.status >= 500) {
        // lostark.bible 502s on a chunk of requests independent of our rate; one quick retry
        // catches the transient ones in THIS run, so they don't consume a future run's slot.
        await new Promise(function (r) { setTimeout(r, DRAIN_DELAY_MS); });
        try { res = await fetchCharacterData(md.region, md.name); } catch (e) { res = null; }
      }
      if (res && res.ok) {
        consecFail = 0;
        const record = Object.assign({}, res.data, { pulledAt: Date.now() });
        try { await env.CHARS.put(charKey(md.region, md.name), JSON.stringify(record)); await env.CHARS.delete(k.name); cached++; } catch (e) {}
      } else if (res && res.status >= 400 && res.status < 500) {
        consecFail = 0;
        await env.CHARS.delete(k.name); // not found / bad request -> drop from queue
      } else {
        // 5xx / network error / timeout: SKIP this character (leave it queued) so one bad or slow
        // character can't head-of-line-block the queue. Count attempts in its metadata so a
        // PERMANENTLY broken entry (e.g. some KR names) is eventually DROPPED instead of retried
        // forever at the head, starving everyone behind it.
        failed++;
        const att = (md.attempts | 0) + 1;
        console.log("[drain-fail] " + md.region + ":" + md.name + " status=" + (res ? res.status : "throw") + " att=" + att);
        try {
          if (att >= MAX_FETCH_ATTEMPTS) await env.CHARS.delete(k.name);                                  // give up — drop it
          else await env.CHARS.put(k.name, "", { metadata: { region: md.region, name: md.name, attempts: att }, expirationTtl: QUEUE_TTL_S });
        } catch (e) {}
        if (++consecFail >= UPSTREAM_FAIL_LIMIT) { stop = true; break; } // sustained streak -> upstream down, back off
      }
      processed++;
      if (processed < DRAIN_PER_RUN) await new Promise(function (r) { setTimeout(r, DRAIN_DELAY_MS); });
    }
  }
  if (processed > 0 || failed > 0) console.log("[drain] processed=" + processed + " cached=" + cached + " failed=" + failed + (stop ? " (backed off)" : ""));
  if (cached > 0) {
    try { await env.CHARS.put(LASTWRITE_KEY, String(Date.now())); } catch (e) {}
    try { await env.CHARS.put(USAGE_KEY, JSON.stringify({ month: month, count: used + cached }), { expirationTtl: 40 * 24 * 3600 }); } catch (e) {}
  }
}

// Where a queued character sits in the drain order (PREMIUM queue first, then FREE, each
// alphabetical by key) + the total queued + a rough ETA (~DRAIN_PER_RUN cached per minute).
// Lists both queues (bounded by the enqueue gate, so well under the 1000-key page limit). A
// just-enqueued key may not show in list() yet (KV is eventually consistent) — then we report
// it at the tail (slightly pessimistic), which the next poll corrects.
async function queueStatus(env, region, name, tier) {
  const key = charKey(region, name);
  let premium = [], free = [];
  // FIFO order: sort by the enqueue ts (old entries without a ts sort first, as oldest).
  const byTs = function (keys) { return keys.slice().sort(function (a, b) { return ((a.metadata && a.metadata.ts) || 0) - ((b.metadata && b.metadata.ts) || 0); }).map(function (k) { return k.name; }); };
  try { premium = byTs((await env.CHARS.list({ prefix: QP })).keys); } catch (e) {}
  try { free = byTs((await env.CHARS.list({ prefix: QF })).keys); } catch (e) {}
  let position;
  if (tier === "premium") {
    const pi = premium.indexOf(QP + key);
    position = (pi >= 0 ? pi : premium.length) + 1;          // premium is drained first
  } else {
    const fi = free.indexOf(QF + key);
    position = premium.length + (fi >= 0 ? fi : free.length) + 1;  // free comes after all premium
  }
  const total = Math.max(premium.length + free.length, position);  // count self even if list() lags
  return { position: position, total: total, etaMinutes: Math.ceil(position / DRAIN_PER_RUN) };
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

// Add a not-yet-cached character to the premium/free queue, gated by a GLOBAL enqueue rate so the
// queue can't be filled faster than the drain empties it (keeps monthly writes bounded). region+name
// stored as KV metadata (the drain reads them from list() without an extra get).
async function enqueueChar(env, region, name, premium, wantPos) {
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
    return queuedResponse(env, region, name, premium ? "premium" : "free", { justQueued: true }, wantPos);
  }
  return json({ queued: true, justQueued: true, tier: premium ? "premium" : "free", region: region, name: normalizeName(name) }, 200);
}

export default {
  async fetch(request, env) {
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
      let qp = [], qf = [];
      try { qp = (await env.CHARS.list({ prefix: QP })).keys; } catch (e) {}
      try { qf = (await env.CHARS.list({ prefix: QF })).keys; } catch (e) {}
      const now = Date.now();
      const mapq = function (keys, tier) {
        return keys.slice().sort(function (a, b) { return ((a.metadata && a.metadata.ts) || 0) - ((b.metadata && b.metadata.ts) || 0); })
          .map(function (k) { const m = k.metadata || {}; return { region: m.region || "", name: m.name || "", tier: tier, waitedS: m.ts ? Math.round((now - m.ts) / 1000) : null }; });
      };
      const list = mapq(qp, "premium").concat(mapq(qf, "free")).slice(0, 500);
      const usage = (await kvGetJson(env, USAGE_KEY)) || {};
      let lastWrite = 0;
      try { lastWrite = parseInt(await env.CHARS.get(LASTWRITE_KEY), 10) || 0; } catch (e) {}
      return json({
        ok: true, nowMs: Date.now(),
        drain: { perRun: DRAIN_PER_RUN, delayMs: DRAIN_DELAY_MS, perMin: DRAIN_PER_RUN },
        queue: { premium: qp.length, free: qf.length, total: qp.length + qf.length, list: list },
        usage: { month: usage.month || "", count: (usage.count | 0), budget: MONTHLY_CHAR_BUDGET },
        lastWriteMs: lastWrite
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

    // FREE + UNLIMITED: a cached character returns immediately (just a KV read) with NO rate
    // limit — look up as many stored characters as you like. The limits below apply only to a
    // MISS (a fresh lostark.bible fetch + DB write), which is the part that actually costs us.
    if (!refresh && env.CHARS) {
      const cached = await kvGetJson(env, key);
      if (cached && Array.isArray(cached.gems) && typeof cached.pulledAt === "number" && (Date.now() - cached.pulledAt) < CACHE_TTL_MS) {
        return json(Object.assign({}, cached, { cached: true }), 200);
      }
    }

    // MISS. New clients send &queue=1 -> the character is QUEUED (cached later by the drain).
    // Old clients (no &queue=1) keep the legacy synchronous fetch so nothing breaks mid-migration.
    const wantQueue = u.searchParams.get("queue") === "1";
    const wantPos = u.searchParams.get("pos") === "1"; // compute queue position/ETA (2 KV lists) only when asked — the initial lookup + manual refresh set &pos=1; the 8s auto-poll omits it, so waiting costs only cheap get()s.

    // Already in the queue? Don't re-add — confirm it's still queued (cheap get) and, only when the
    // client asked (&pos=1), its live position/total/ETA. This is also the poll path the client hits
    // while it waits for the drain, kept list()-free so a waiting tab is nearly free to serve.
    if (wantQueue && env.CHARS) {
      if ((await env.CHARS.get(QP + key)) !== null) return queuedResponse(env, region, name, "premium", { alreadyQueued: true }, wantPos);
      if ((await env.CHARS.get(QF + key)) !== null) {
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
    if (wantQueue) return enqueueChar(env, region, name, premium, wantPos);
    return handleCharacter(env, region, name, refresh, { premium: premium, nextMs: 5000 });
  },

  async scheduled(controller, env, ctx) {
    // Every minute: drain a few queued characters (paced), then refresh the leaderboard snapshot
    // if it's due (rebuildSnapshotIfChanged self-throttles to ~every 30 min so reads stay low).
    await drainQueue(env);
    await rebuildSnapshotIfChanged(env);
  }
};
