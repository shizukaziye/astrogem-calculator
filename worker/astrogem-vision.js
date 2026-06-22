/**
 * astrogem-vision.js — Cloudflare Worker that reads a Lost Ark "Processing" modal
 * screenshot with Workers AI (a vision model) and returns the parsed gem state as
 * JSON in the shape the Advisor expects: { config, state, outcomes:[4] }.
 *
 * NO Anthropic / external API — inference runs entirely on the Workers AI binding
 * (`env.AI`). No secrets required. See worker/README.md for deploy instructions and
 * where to paste the resulting URL into ocr/workersai-engine.js.
 *
 * Endpoints:
 *   GET  /            -> health JSON { ok, model }
 *   POST /            -> body is the raw image bytes (any image/*), OR
 *                        JSON { image: "data:image/png;base64,..." } / { imageBase64 }
 *                     -> { config, state, outcomes:[4], raw? }
 *   OPTIONS /         -> CORS preflight
 *
 * The client (ocr/workersai-engine.js) still runs the response through the shared
 * constraintSnap, so this Worker can be permissive: best-effort JSON, light
 * coercion here, strict legality enforced client-side.
 */

// Primary + fallback vision models. 11B Llama vision is the better reader; LLaVA is
// the cheaper/faster alternative kept as a fallback if the primary errors.
const PRIMARY_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const FALLBACK_MODEL = "@cf/llava-hf/llava-1.5-7b-hf";

// TODO(before production): lock this to the deployed Pages origin instead of "*",
// e.g. const ALLOW_ORIGIN = "https://astrogem-calculator.pages.dev";
const ALLOW_ORIGIN = "*";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOW_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

// The instruction we give the vision model. We ask for STRICT JSON in the Advisor
// schema and spell out the enums so the model snaps to legal values where it can.
const SYSTEM_PROMPT =
  "You read a screenshot of the Lost Ark astrogem 'Processing' (gem cutting) window " +
  "and output ONLY a JSON object. No prose, no markdown, no code fences.";

const USER_PROMPT = [
  "Extract the gem-cutting state from this Lost Ark Processing screenshot.",
  "",
  "Return EXACTLY this JSON shape (numbers as numbers, not strings):",
  "{",
  '  "config": {',
  '    "baseCost": 8|9|10,',
  '    "gemType": "order"|"chaos",',
  '    "willpowerLevel": 1-5,',
  '    "orderLevel": 1-5,',
  '    "effect1": <name>, "effect1Level": 1-5,',
  '    "effect2": <name>, "effect2Level": 1-5',
  "  },",
  '  "state": {',
  '    "currentTurn": 1-9, "maxTurns": 5|7|9,',
  '    "rerollsRemaining": 0-3,',
  '    "processCost": <gold number>, "processCostMultiplier": -100|0|100,',
  '    "totalGoldSpent": <number>, "rosterBound": false',
  "  },",
  '  "outcomes": [o1,o2,o3,o4]',
  "}",
  "",
  "Effect <name> must be one of: \"Attack Power\", \"Additional Damage\", \"Boss Damage\", \"Brand Power\", \"Ally Damage Enh.\", \"Ally Attack Enh.\".",
  "baseCost 8 effects come from {Additional Damage, Attack Power, Brand Power, Ally Damage Enh.};",
  "baseCost 9 from {Boss Damage, Attack Power, Ally Damage Enh., Ally Attack Enh.};",
  "baseCost 10 from {Boss Damage, Additional Damage, Brand Power, Ally Attack Enh.}.",
  "effect1 and effect2 must differ.",
  "",
  "Each of the 4 outcomes is the change listed under 'One of the following is randomly applied', encoded as ONE of:",
  '  {"type":"raise_effect","target":"willpower"|"order"|"effect1"|"effect2","amount":1-4}',
  '  {"type":"lower_effect","target":"willpower"|"order"|"effect1"|"effect2","amount":1-4}',
  '  {"type":"change_side_option","target":"effect1"|"effect2"}',
  '  {"type":"change_gold_cost","change":100|-100}',
  '  {"type":"reroll_increase","change":1|2}',
  '  {"type":"do_nothing"}',
  "The Process (x/N) counter is x=attempts remaining out of N=max turns; currentTurn = N - x + 1.",
  "Output the JSON object only."
].join("\n");

// Pull the first balanced top-level {...} out of a model response that may be
// wrapped in prose or ```json fences, then JSON.parse it.
function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  // strip code fences
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  // find first { and matching last }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = t.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch (e) {
    // tolerant repair: trailing commas
    try {
      return JSON.parse(slice.replace(/,\s*([}\]])/g, "$1"));
    } catch (e2) {
      return null;
    }
  }
}

// Decode the request body into a Uint8Array of image bytes.
async function readImageBytes(request) {
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  if (ct.startsWith("image/")) {
    const buf = await request.arrayBuffer();
    return new Uint8Array(buf);
  }
  if (ct.includes("application/json")) {
    const body = await request.json();
    const dataUrl = body.image || body.imageBase64 || body.data;
    if (!dataUrl) throw new Error("JSON body must include image|imageBase64 (base64 or data URL).");
    const b64 = String(dataUrl).replace(/^data:[^;]+;base64,/, "");
    return base64ToBytes(b64);
  }
  if (ct.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("image") || form.get("file");
    if (!file || typeof file.arrayBuffer !== "function") throw new Error("multipart body must include an 'image' file part.");
    return new Uint8Array(await file.arrayBuffer());
  }
  // last resort: treat as raw bytes
  const buf = await request.arrayBuffer();
  if (buf.byteLength > 0) return new Uint8Array(buf);
  throw new Error("Unsupported content-type: " + ct);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Run a vision model with the image; returns the model's raw text.
async function runVision(env, model, bytes) {
  // Llama 3.2 vision + LLaVA on Workers AI accept `image` as an array of byte values
  // plus a text `prompt`. We send a combined system+user prompt and ask for JSON.
  const result = await env.AI.run(model, {
    image: Array.from(bytes),
    prompt: SYSTEM_PROMPT + "\n\n" + USER_PROMPT,
    max_tokens: 768,
    temperature: 0 // deterministic-ish extraction
  });
  // Text-gen-style responses expose `.response`; some models use `.description`.
  return (result && (result.response || result.description || result.text)) || "";
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method === "GET") {
      return json({ ok: true, service: "astrogem-vision", model: PRIMARY_MODEL });
    }
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }
    if (!env || !env.AI) {
      return json({ error: "Workers AI binding 'AI' is not configured (see wrangler.toml)." }, 500);
    }

    let bytes;
    try {
      bytes = await readImageBytes(request);
    } catch (e) {
      return json({ error: "Could not read image: " + (e && e.message || e) }, 400);
    }
    if (!bytes || bytes.length === 0) {
      return json({ error: "Empty image." }, 400);
    }

    let text = "";
    let usedModel = PRIMARY_MODEL;
    try {
      text = await runVision(env, PRIMARY_MODEL, bytes);
    } catch (e1) {
      // fall back to the cheaper vision model
      try {
        usedModel = FALLBACK_MODEL;
        text = await runVision(env, FALLBACK_MODEL, bytes);
      } catch (e2) {
        return json({ error: "Vision model error: " + (e2 && e2.message || e2) }, 502);
      }
    }

    const parsed = extractJson(text);
    if (!parsed) {
      // Return the raw text so the client can show a helpful message / fall back to
      // manual entry; 200 so the client can still inspect it.
      return json({ error: "Model did not return parseable JSON.", model: usedModel, raw: String(text).slice(0, 2000) }, 200);
    }

    // Light shaping only; the client runs constraintSnap for strict legality.
    const out = {
      config: parsed.config || {},
      state: parsed.state || {},
      outcomes: Array.isArray(parsed.outcomes) ? parsed.outcomes.slice(0, 4) : [],
      model: usedModel
    };
    if (parsed.rarity) out.rarity = parsed.rarity;
    return json(out, 200);
  }
};
