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
 *   GET /?region=NA&name=Paroxysmal  -> { region, name, gems:[...] }
 *   GET /                            -> health JSON { ok, service }
 *   OPTIONS /                        -> CORS preflight
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

// Pull the balanced `arkGridCores:[ ... ]` array literal out of the page HTML and
// parse it. The data is a JS object literal (unquoted keys), not JSON, so we quote
// the keys before JSON.parse. Returns the parsed array, or null.
function extractArkGridCores(html) {
  const marker = "arkGridCores:[";
  const at = html.indexOf(marker);
  if (at === -1) return null;
  // Scan from the opening '[' keeping bracket depth so nested arrays don't fool us.
  let start = at + "arkGridCores:".length;
  let depth = 0, end = -1;
  for (let k = start; k < html.length; k++) {
    const c = html[k];
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) { end = k + 1; break; }
    }
  }
  if (end === -1) return null;
  const literal = html.slice(start, end);
  // Quote bare identifier keys: {id:..,base:..} -> {"id":..,"base":..}
  const jsonish = literal.replace(/([{,])\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
  try {
    return JSON.parse(jsonish);
  } catch (e) {
    return null;
  }
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

async function handleCharacter(region, name) {
  // lostark.bible character page: /character/<REGION>/<Name>
  const url =
    "https://lostark.bible/character/" +
    encodeURIComponent(region) + "/" + encodeURIComponent(name);

  let resp;
  try {
    resp = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
      },
      // Follow SvelteKit redirects (region casing etc.).
      redirect: "follow"
    });
  } catch (e) {
    return json({ error: "Upstream fetch failed: " + (e && e.message || e), url: url }, 502);
  }

  if (resp.status === 404) {
    return json({ error: "Character not found on lostark.bible.", region: region, name: name, url: url, upstreamStatus: 404 }, 404);
  }
  if (!resp.ok) {
    return json({ error: "lostark.bible returned HTTP " + resp.status + ".", region: region, name: name, url: url, upstreamStatus: resp.status }, 502);
  }

  const html = await resp.text();
  const cores = extractArkGridCores(html);
  if (!cores) {
    return json({
      error: "Could not find arkGridCores data on the page (the character may have no Ark Grid set, or the site layout changed).",
      region: region, name: name, url: url
    }, 422);
  }

  const gems = [];
  const warnings = [];
  for (const core of cores) {
    const rawGems = Array.isArray(core.gems) ? core.gems : [];
    for (const rg of rawGems) {
      const m = mapGem(rg, core);
      gems.push(m.gem);
      for (const w of m.warnings) warnings.push(w);
    }
  }

  return json({
    region: region,
    name: name,
    source: "lostark.bible",
    url: url,
    coreCount: cores.length,
    gemCount: gems.length,
    gems: gems,
    warnings: warnings
  }, 200);
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== "GET") {
      return json({ error: "Method not allowed (use GET ?region=&name=)." }, 405);
    }

    const u = new URL(request.url);
    const region = (u.searchParams.get("region") || "").trim();
    const name = (u.searchParams.get("name") || "").trim();

    if (!region && !name) {
      return json({ ok: true, service: "astrogem-bible", usage: "GET /?region=NA&name=CharacterName" });
    }
    if (!region || !name) {
      return json({ error: "Both ?region= and ?name= are required (e.g. ?region=NA&name=Paroxysmal)." }, 400);
    }

    return handleCharacter(region, name);
  }
};
