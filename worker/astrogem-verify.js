/**
 * worker/astrogem-verify.js — the flagged-field AI VERIFIER (WS4).
 *
 * NOT a screenshot parser. The structural engine is the reader; this worker gets
 * asked about ONLY the specific fields the parser flagged as uncertain — one
 * small panel crop + a closed-vocabulary question list — and answers with a tiny
 * JSON object. Design + rationale: docs/how-the-advisor-works.md §6.
 *
 * Token economy (why this stays inside the free tier):
 *   - no call at all when a parse has zero flagged fields (the common case),
 *   - ONE call covers every flagged field of a parse,
 *   - the image is a ≤768px webp of the panel, not the full screenshot,
 *   - answers are a ≤200-token JSON object,
 *   - identical (image, fields) requests are served from the KV cache for free.
 *
 * Budget (Shizu 2026-07-18: "hard cap at 90% usage per day so we don't pay
 * anything"): a KV day-counter estimates Neuron spend and REFUSES (429) past
 * DAILY_NEURON_BUDGET = 9,000 (90% of the 10,000/day free allocation).
 * EST_NEURONS_PER_CALL is deliberately conservative until calibrated — after
 * ~10 real calls, read the actual burn off the Cloudflare dashboard
 * (AI > Workers AI > usage) and tune the constant; the effective daily call cap
 * is DAILY_NEURON_BUDGET / EST_NEURONS_PER_CALL (= 90 calls/day as shipped).
 *
 * Gate: requires ?k=<site token> (the same LockedIn-derived hash gate.js sends
 * to the bible/data workers). CORS locked to the site origins.
 *
 * Routes:
 *   GET  /            -> { ok, model, budget:{date, calls, estNeurons, capNeurons} }
 *   POST /verify?k=   -> body { image: dataURL, fields: [{ key, ask }] }
 *                     -> { values: {key: string}, model, cached, budget }
 *   OPTIONS *         -> CORS preflight
 *
 * KV (binding BUDGET — shares the astrogem-data namespace, distinct prefixes):
 *   vb:<YYYY-MM-DD>   the day's { calls, estNeurons }
 *   vc:<sha256>       cached answers, 7d TTL
 *
 * Deploy:  npx wrangler deploy -c wrangler-verify.toml
 */
"use strict";

const PRIMARY_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const FALLBACK_MODEL = "@cf/llava-hf/llava-1.5-7b-hf";

const GATE_TOKEN = "6104928cd0cc5374f5330e63e6a834f99aef7579db15c77d9d154932bf7a8ced";
const ALLOW_ORIGINS = [
  "https://shizukaziye.github.io",
  "http://localhost:8080",
  "http://127.0.0.1:8080"
];

const DAILY_NEURON_BUDGET = 9000;   // 90% of the free 10,000/day — never pay
const EST_NEURONS_PER_CALL = 100;   // conservative until dashboard-calibrated
const MAX_BODY = 2 * 1024 * 1024;   // the crop should be ~50-200KB; 2MB is generous
const MAX_FIELDS = 20;
const CACHE_TTL = 7 * 24 * 3600;

function cors(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = ALLOW_ORIGINS.indexOf(origin) !== -1 ? origin : ALLOW_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}
function json(request, body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, cors(request))
  });
}

function dayKey() { return "vb:" + new Date().toISOString().slice(0, 10); }

async function readBudget(env) {
  const raw = await env.BUDGET.get(dayKey());
  const b = raw ? JSON.parse(raw) : { calls: 0, estNeurons: 0 };
  return b;
}
async function writeBudget(env, b) {
  // 2-day TTL: the key dies on its own after the day passes
  await env.BUDGET.put(dayKey(), JSON.stringify(b), { expirationTtl: 2 * 24 * 3600 });
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Pull the first balanced top-level {...} out of a possibly-fenced response.
function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{"), end = t.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let slice = t.slice(start, end + 1);
  // models emit bare fractions ("currentTurn": 5/9) which are invalid JSON — quote them
  slice = slice.replace(/:\s*(\d+\s*\/\s*\d+)/g, ': "$1"');
  try { return JSON.parse(slice); }
  catch (e) { try { return JSON.parse(slice.replace(/,\s*([}\]])/g, "$1")); } catch (e2) { return null; } }
}

function buildPrompt(fields) {
  const lines = [
    "This is a crop of the Lost Ark astrogem 'Processing' window.",
    "Answer ONLY about the requested items. Output ONE JSON object mapping each key to a short string answer — no prose, no markdown.",
    ""
  ];
  for (const f of fields) lines.push('"' + f.key + '": ' + f.ask);
  lines.push("");
  lines.push("JSON only.");
  return lines.join("\n");
}

async function runVision(env, model, bytes, prompt) {
  const result = await env.AI.run(model, {
    image: Array.from(bytes),
    prompt: prompt,
    max_tokens: 200,
    temperature: 0
  });
  let v = result && (result.response || result.description || result.text);
  if (v == null && result && typeof result === "object") v = result;
  // llama-3.2 sometimes returns the JSON answer as an OBJECT, not text
  if (v != null && typeof v === "object") return JSON.stringify(v);
  return v || "";
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });

    if (request.method === "GET") {
      const b = env.BUDGET ? await readBudget(env) : { calls: -1, estNeurons: -1 };
      return json(request, {
        ok: true, service: "astrogem-verify", model: PRIMARY_MODEL,
        budget: { date: dayKey().slice(3), calls: b.calls, estNeurons: b.estNeurons, capNeurons: DAILY_NEURON_BUDGET, estPerCall: EST_NEURONS_PER_CALL }
      });
    }
    if (request.method !== "POST") return json(request, { error: "Method not allowed" }, 405);
    if (!env.AI) return json(request, { error: "Workers AI binding missing (wrangler-verify.toml)." }, 500);
    if (!env.BUDGET) return json(request, { error: "BUDGET KV binding missing (wrangler-verify.toml)." }, 500);

    const url = new URL(request.url);
    if ((url.searchParams.get("k") || "") !== GATE_TOKEN) return json(request, { error: "Locked." }, 403);

    const len = parseInt(request.headers.get("content-length") || "0", 10);
    if (len > MAX_BODY) return json(request, { error: "Body too large." }, 413);

    let body;
    try { body = await request.json(); } catch (e) { return json(request, { error: "JSON body required." }, 400); }
    const dataUrl = body.image || "";
    const fields = Array.isArray(body.fields) ? body.fields.slice(0, MAX_FIELDS) : [];
    if (!/^data:image\/(webp|png|jpeg);base64,/.test(dataUrl)) return json(request, { error: "image must be a webp/png/jpeg data URL." }, 400);
    if (!fields.length || !fields.every(f => f && typeof f.key === "string" && typeof f.ask === "string" && f.key.length <= 32 && f.ask.length <= 300)) {
      return json(request, { error: "fields must be [{key, ask}] (1-" + MAX_FIELDS + ")." }, 400);
    }

    // cache first — identical checks are free
    const cacheKey = "vc:" + await sha256Hex(dataUrl + "|" + fields.map(f => f.key + "=" + f.ask).join("|"));
    const cached = await env.BUDGET.get(cacheKey);
    if (cached) {
      const b0 = await readBudget(env);
      return json(request, Object.assign(JSON.parse(cached), { cached: true, budget: { calls: b0.calls, estNeurons: b0.estNeurons, capNeurons: DAILY_NEURON_BUDGET } }));
    }

    // budget gate — the hard 90% cap
    const b = await readBudget(env);
    if (b.estNeurons + EST_NEURONS_PER_CALL > DAILY_NEURON_BUDGET) {
      return json(request, {
        error: "Daily AI budget exhausted (" + b.estNeurons + "/" + DAILY_NEURON_BUDGET + " est. Neurons). Resets at UTC midnight.",
        budget: { calls: b.calls, estNeurons: b.estNeurons, capNeurons: DAILY_NEURON_BUDGET }
      }, 429);
    }
    b.calls += 1; b.estNeurons += EST_NEURONS_PER_CALL;
    await writeBudget(env, b);

    const bytes = base64ToBytes(dataUrl.replace(/^data:[^;]+;base64,/, ""));
    const prompt = buildPrompt(fields);

    let text = "", usedModel = PRIMARY_MODEL, primaryError = null;
    try { text = await runVision(env, PRIMARY_MODEL, bytes, prompt); }
    catch (e1) {
      primaryError = String(e1 && e1.message || e1).slice(0, 200);
      // 5016: Meta's license needs a ONE-TIME "agree" prompt per account — do the
      // handshake and retry once (self-healing; after the first success this path
      // never runs again)
      if (/5016|submit the prompt 'agree'/i.test(primaryError)) {
        try {
          await env.AI.run(PRIMARY_MODEL, { prompt: "agree" });
          text = await runVision(env, PRIMARY_MODEL, bytes, prompt);
          primaryError = null;
        } catch (e1b) { primaryError = String(e1b && e1b.message || e1b).slice(0, 200); }
      }
      if (primaryError) {
        try { usedModel = FALLBACK_MODEL; text = await runVision(env, FALLBACK_MODEL, bytes, prompt); }
        catch (e2) { return json(request, { error: "Vision model error: " + (e2 && e2.message || e2), primaryError: primaryError }, 502); }
      }
    }

    const parsed = extractJson(text) || {};
    const values = {};
    for (const f of fields) if (parsed[f.key] != null) values[f.key] = String(parsed[f.key]).slice(0, 60);

    const payload = { values: values, model: usedModel };
    if (primaryError) payload.primaryError = primaryError;   // ops visibility: why the fallback ran
    if (!Object.keys(values).length) payload.raw = String(text).slice(0, 300);   // ops visibility: what the model said when nothing parsed
    // only cache useful answers — an empty/transient failure must not poison 7 days
    if (Object.keys(values).length) await env.BUDGET.put(cacheKey, JSON.stringify(payload), { expirationTtl: CACHE_TTL });
    return json(request, Object.assign({}, payload, { cached: false, budget: { calls: b.calls, estNeurons: b.estNeurons, capNeurons: DAILY_NEURON_BUDGET } }));
  }
};
