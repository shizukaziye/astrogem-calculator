# Astrogem Vision Worker (Workers AI screenshot engine)

A Cloudflare Worker that reads a Lost Ark **Processing** (gem-cutting) screenshot
with **Workers AI** and returns the parsed state as JSON:

```json
{ "config": { ... }, "state": { ... }, "outcomes": [o1, o2, o3, o4] }
```

This powers the Advisor tab's **Workers AI** engine (the alternative to the default,
offline Tesseract.js engine). It uses **only** the Workers AI binding — no Anthropic,
no API keys, no other secrets.

- Model: `@cf/meta/llama-3.2-11b-vision-instruct` (falls back to
  `@cf/llava-hf/llava-1.5-7b-hf` if the primary errors).
- Files: [`astrogem-vision.js`](./astrogem-vision.js), [`wrangler.toml`](./wrangler.toml).

## Prerequisites

- A Cloudflare account (Workers AI free tier = 10,000 neurons/day).
- `wrangler` CLI installed and logged in: `npx wrangler login`.

## Deploy

```bash
cd worker
npx wrangler deploy
```

Wrangler prints a URL like:

```
https://astrogem-vision.<your-subdomain>.workers.dev
```

## Enable the engine in the app (the one manual step)

Open [`../ocr/workersai-engine.js`](../ocr/workersai-engine.js) and set the
`WORKER_URL` constant at the top of the file to the URL you just got:

```js
const WORKER_URL = "https://astrogem-vision.<your-subdomain>.workers.dev";
```

Reload the Advisor tab. The **Workers AI** engine option becomes selectable (the
engine picker row itself only appears once ≥2 engines are available). The
**structural engine remains the default** and needs nothing.

> **Status (2026-07-18): the vision worker is NOT deployed.** `WORKER_URL` ships
> empty, so the live site runs the structural engine alone (99%+ on the corpus —
> the vision tier's value case shrank accordingly). This file documents the deploy
> path for whenever that decision changes.

## Local development

Workers AI only runs against Cloudflare's GPUs, so you must use `--remote`:

```bash
cd worker
npx wrangler dev --remote
```

Then point `WORKER_URL` at the printed local URL while testing.

## API

| Method | Path | Body | Response |
|--------|------|------|----------|
| `GET`  | `/`  | —    | `{ ok, service, model }` (health check) |
| `POST` | `/`  | raw `image/*` bytes, **or** JSON `{ image: "data:image/png;base64,..." }`, **or** multipart with an `image` file part | `{ config, state, outcomes, model }` or `{ error, raw }` |
| `OPTIONS` | `/` | — | CORS preflight (204) |

The client always re-runs the response through the shared `constraintSnap`
(`ocr/engine.js`), so the Worker is intentionally permissive: it returns best-effort
JSON and lets the client enforce strict legality (valid base cost, in-pool effects,
clamped levels, rarity-consistent turns/rerolls, 4 outcomes).

## CORS / security

`ALLOW_ORIGIN` in `astrogem-vision.js` is currently `"*"` for easy first-run testing.
**Before production, lock it to your Pages origin** (there's a `TODO` at that line),
e.g. `https://astrogem-calculator.pages.dev`. `wrangler.toml` has a commented `[vars]`
block showing how to drive it from config if you prefer not to edit the source.

## Cost note

Each screenshot is one vision-model inference. The 11B vision model is heavier than a
small text model; on the free tier you get a few hundred reads/day. The default
Tesseract engine is free/unlimited and offline — use Workers AI when you want higher
accuracy on a tricky capture.
