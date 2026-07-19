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
const MAX_BODY = 12 * 1024 * 1024;   // native-4K webp bodies run 1-9MB; KV's 25MB value cap is the true ceiling
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

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
    if (u.pathname === "/health") return json({ ok: true }, 200, req);
    if (!gated(u)) return json({ error: "locked" }, 403, req);

    if (req.method === "POST" && u.pathname === "/collect") {
      const len = parseInt(req.headers.get("Content-Length") || "0", 10);
      if (len > MAX_BODY) return json({ error: "too large" }, 413, req);
      let body;
      try { body = await req.json(); } catch (e) { return json({ error: "bad json" }, 400, req); }
      if (!body || typeof body !== "object") return json({ error: "bad body" }, 400, req);
      // a record without a real capture or a final state is useless for training —
      // reject it loudly so the client can tell the user (a silent 1×1-pixel test
      // record once sat in the store masquerading as data)
      if (typeof body.image !== "string" || !/^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]{1000,}/.test(body.image)) {
        return json({ error: "image required (real capture, not a stub)" }, 400, req);
      }
      if (!body.final || typeof body.final !== "object" || !body.final.config) {
        return json({ error: "final state required" }, 400, req);
      }

      const now = new Date();
      const day = now.toISOString().slice(0, 10);

      // daily write cap — the collect token is public-in-source, so this counter
      // is what actually protects the KV write quota
      const dcKey = "dc:" + day;
      const dcCount = parseInt((await env.COLLECT.get(dcKey)) || "0", 10);
      if (dcCount >= DAILY_WRITE_CAP) {
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
};
