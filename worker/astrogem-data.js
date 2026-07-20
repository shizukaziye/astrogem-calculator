/**
 * worker/astrogem-data.js — the Advisor's parse-collection endpoint.
 *
 * A record ships only when the user presses Get advice MANUALLY (auto-advice runs
 * after every parse but does not store — 2026-07-17): the image, the parser's
 * reading (with per-field confidences), and the state the user actually ran —
 * their corrections are ground-truth labels, though fallible ones: cross-check
 * against the stored image before promoting (a live correction once contradicted
 * its own screenshot's points checksum). tools/pull-collected.js downloads new
 * records for labeling review.
 *
 * Storage: ONE KV value per record, image embedded as a webp data-URL (KV values
 * cap at 25MB; a bounded webp capture is ~150-700KB). R2 was abandoned for KV
 * (dashboard-enable friction, code 10042); revisit only if volume demands it.
 *
 * Routes (all require the site token ?k= — but note the asymmetry: READING
 * (/list, /obj) is genuinely password-gated, while /collect's token arrives from
 * every client unconditionally (gate.js collectToken) because collection must
 * never be blocked by the lock (Shizu 2026-07-18: "only the AI-powered parsing
 * should be password locked"). The ?k on /collect only stops blind endpoint
 * scans; the real quota protection is DAILY_WRITE_CAP below — KV free tier
 * allows 1k writes/day and a record is one write):
 *   POST /collect      body: JSON { image, parse, final, changed, meta } -> { ok, id }
 *   GET  /list?cursor= -> { keys: [...], cursor }
 *   GET  /obj?key=     -> the stored record JSON
 *   GET  /health       -> ok (ungated)
 *
 * Deploy:  npx wrangler deploy -c wrangler-data.toml
 */
"use strict";

const ALLOW_ORIGINS = [
  "https://shizukaziye.github.io",
  "http://localhost:8080",
  "http://127.0.0.1:8080"
];
const GATE_TOKEN = "6104928cd0cc5374f5330e63e6a834f99aef7579db15c77d9d154932bf7a8ced";
// MEASURED 2026-07-19: bodies ≥6MB kill the free-tier isolate mid-read — Cloudflare
// then serves an HTML 500 WITHOUT CORS headers, which browsers mask as a bare
// "network error" (exactly how a night of Shizu's records died: a pre-crop client
// shipping 5-9MB full frames). ≤5MB parses fine. Gate BELOW the kill line so
// oversize is a visible CORS'd 413 the client can react to, never a silent death.
const MAX_BODY = 5 * 1024 * 1024;
const DAILY_WRITE_CAP = 300;   // records/day — far above real use, far below the 1k KV free tier

function cors(req) {
  const origin = req.headers.get("Origin") || "";
  const allow = ALLOW_ORIGINS.indexOf(origin) !== -1 ? origin : ALLOW_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}
function gated(u) { return (u.searchParams.get("k") || "") === GATE_TOKEN; }
function json(obj, status, req) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, cors(req))
  });
}

// Every FAILED /collect attempt is journaled to KV (err:<day>/<ts>, 7-day TTL,
// ≤40 writes/day) with status + size + UA + origin. Debugging doctrine: a
// browser masks the interesting failures (CORS-hidden rejects, stale clients'
// oversize sends) — the journal sees every attempt that REACHED Cloudflare, so
// "no col/ record AND no err/ entry" proves the request never left the user's
// machine (extension/DNS block), while an err/ entry names the reject reason.
async function logErr(env, req, status, detail) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const ecKey = "ec:" + day;
    const ec = parseInt((await env.COLLECT.get(ecKey)) || "0", 10);
    if (ec >= 40) return;
    await env.COLLECT.put("err:" + day + "/" + Date.now().toString(36), JSON.stringify({
      status: status, detail: String(detail).slice(0, 120),
      ua: (req.headers.get("User-Agent") || "").slice(0, 90),
      origin: req.headers.get("Origin") || "", len: req.headers.get("Content-Length") || ""
    }), { expirationTtl: 7 * 24 * 3600 });
    await env.COLLECT.put(ecKey, String(ec + 1), { expirationTtl: 2 * 24 * 3600 });
  } catch (e) {}
}

// The whole handler runs behind this catch: an uncaught throw would otherwise
// surface as a Cloudflare error page with NO CORS headers, which the browser
// reports as a plain "network error" — indistinguishable from being offline.
// (A hard resource kill still can't be caught; MAX_BODY is what prevents those.)
export default {
  async fetch(req, env) {
    try { return await handle(req, env); }
    catch (e) {
      await logErr(env, req, 500, "uncaught: " + String(e && e.message || e));
      return json({ error: "worker error: " + String(e && e.message || e).slice(0, 140) }, 500, req);
    }
  }
};

async function handle(req, env) {
    const u = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
    if (u.pathname === "/health") return json({ ok: true }, 200, req);
    if (!gated(u)) return json({ error: "locked" }, 403, req);

    if (req.method === "POST" && u.pathname === "/collect") {
      // gate on the header FIRST (browsers always send it for string bodies),
      // then re-check the actual text — both run BEFORE the expensive parse
      const len = parseInt(req.headers.get("Content-Length") || "0", 10);
      if (len > MAX_BODY) { await logErr(env, req, 413, "content-length " + len); return json({ error: "too large (" + Math.round(len / 1e5) / 10 + "MB > 5MB)" }, 413, req); }
      let raw;
      try { raw = await req.text(); } catch (e) { await logErr(env, req, 400, "body read failed"); return json({ error: "body read failed" }, 400, req); }
      if (raw.length > MAX_BODY) { await logErr(env, req, 413, "raw length " + raw.length); return json({ error: "too large" }, 413, req); }
      let body;
      try { body = JSON.parse(raw); } catch (e) { await logErr(env, req, 400, "bad json"); return json({ error: "bad json" }, 400, req); }
      if (!body || typeof body !== "object") { await logErr(env, req, 400, "bad body"); return json({ error: "bad body" }, 400, req); }
      // a record without a real capture or a final state is useless for training —
      // reject it loudly so the client can tell the user (a silent 1×1-pixel test
      // record once sat in the store masquerading as data)
      if (typeof body.image !== "string" || !/^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]{1000,}/.test(body.image)) {
        await logErr(env, req, 400, "image missing/stub");
        return json({ error: "image required (real capture, not a stub)" }, 400, req);
      }
      if (!body.final || typeof body.final !== "object" || !body.final.config) {
        await logErr(env, req, 400, "final state missing");
        return json({ error: "final state required" }, 400, req);
      }

      const now = new Date();
      const day = now.toISOString().slice(0, 10);

      // daily write cap — the collect token is public-in-source, so this counter
      // is what actually protects the KV write quota
      const dcKey = "dc:" + day;
      const dcCount = parseInt((await env.COLLECT.get(dcKey)) || "0", 10);
      if (dcCount >= DAILY_WRITE_CAP) {
        await logErr(env, req, 429, "daily cap");
        return json({ error: "daily collection cap reached (" + DAILY_WRITE_CAP + "/day) — resets at UTC midnight" }, 429, req);
      }

      const id = now.getTime().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      const key = "col/" + day + "/" + id;
      const record = {
        id: id,
        ts: now.toISOString(),
        image: typeof body.image === "string" ? body.image : null,
        parse: body.parse || null,       // engine output incl. confidence map
        final: body.final || null,       // state at Get advice (user-corrected)
        changed: body.changed || null,   // precomputed diff (client convenience)
        meta: body.meta || null          // engine name, app version, source
      };
      // RECORD FIRST, counter after (a live record once vanished while the
      // counter incremented — the old order consumed cap on a failed write and
      // let the client believe the save landed); a caught failure reports 500
      // so the client's NOT-saved note is truthful and the record re-stages
      try {
        await env.COLLECT.put(key, JSON.stringify(record));
      } catch (e) {
        await logErr(env, req, 500, "storage write: " + String(e && e.message || e));
        return json({ error: "storage write failed: " + String(e && e.message || e).slice(0, 120) }, 500, req);
      }
      await env.COLLECT.put(dcKey, String(dcCount + 1), { expirationTtl: 2 * 24 * 3600 }).catch(function () {});
      return json({ ok: true, id: id }, 200, req);
    }

    if (req.method === "GET" && u.pathname === "/list") {
      const cursor = u.searchParams.get("cursor") || undefined;
      const res = await env.COLLECT.list({ prefix: "col/", cursor: cursor, limit: 500 });
      return json({
        keys: res.keys.map(k => ({ key: k.name })),
        cursor: res.list_complete ? null : res.cursor
      }, 200, req);
    }

    if (req.method === "GET" && u.pathname === "/obj") {
      const key = u.searchParams.get("key") || "";
      if (!/^col\//.test(key)) return json({ error: "bad key" }, 400, req);
      const val = await env.COLLECT.get(key);
      if (val == null) return json({ error: "not found" }, 404, req);
      const h = cors(req);
      h["Content-Type"] = "application/json";
      return new Response(val, { status: 200, headers: h });
    }

    return json({ error: "no route" }, 404, req);
}
