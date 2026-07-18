# OCR engines (Advisor screenshot reading)

The Advisor tab can prefill its form from a Lost Ark **Processing** screenshot.
There are **swappable engines** behind one interface, plus a shared repair pass
(`constraintSnap`) that guarantees the Advisor only ever sees a **legal** game state.

| file | what it is |
|------|------------|
| `engine.js` | the common interface + `constraintSnap` + a small engine registry. No backend. |
| `tesseract-engine.js` | client-side Tesseract.js OCR. Offline, no accounts. |
| `layout.js` | the structural parser's pure image-analysis core — environment-agnostic raster functions (browser canvas + Node sharp) shared by the structural engine; calibrated via `tools/dump-structural.js`. |
| `structural-engine.js` | the "structural" parser: reads the screenshot's rigid layout + color coding first (panel/wheel anchors, self-calibrated icon hues from `layout.js`) and uses OCR only where it is strong. |
| `workersai-engine.js` | optional engine: POSTs the image to a Cloudflare Worker (`../worker/`) running a Workers AI vision model. Disabled until you set `WORKER_URL`. |

## The interface

An engine is any object exposing:

```js
async parseScreenshot(imageElOrBlob) -> { config, state, outcomes:[4] }
isAvailable() -> boolean        // can it run here/now?
name, label                     // identity for the engine picker
```

Shapes:

```js
config = { baseCost, gemType, willpowerLevel, orderLevel,
           effect1, effect1Level, effect2, effect2Level }
state  = { currentTurn, maxTurns, rerollsRemaining,
           processCost, processCostMultiplier, totalGoldSpent, rosterBound }
outcomes = [o1, o2, o3, o4]     // applyOutcome-shaped (see below)
```

Outcome objects (the shape `model/nested.js#applyOutcome` consumes):

```js
{ type:'raise_effect'|'lower_effect', target:'willpower'|'order'|'effect1'|'effect2', amount:1..4 }
{ type:'change_side_option', target:'effect1'|'effect2' }
{ type:'change_gold_cost', change:+100|-100 }
{ type:'reroll_increase', change:1|2 }
{ type:'do_nothing' }
```

Engines self-register on load. The Advisor lists them via `ocrListEngines()` and
picks one with `ocrGetEngine(name)`; the picker row auto-hides when only one
engine is available (the production state: **structural** is the sole live engine).

## `constraintSnap` — the accuracy lever

`constraintSnap(parsed)` is shared by every engine (on the `BaseEngine` prototype;
in Node via `require("./engine.js").constraintSnap`). It takes a
noisy/partial/impossible parse and returns a fully **legal**
`{ config, state, outcomes:[4] }`:

- **baseCost** snapped to `{8,9,10}` (nearest; defaults to 10).
- **effects** canonicalized (case/space/punct + common OCR misreads) and snapped into
  `EFFECT_POOLS[baseCost]`; `effect1 !== effect2` is forced.
- **levels** clamped to `1..5`.
- **rarity** snapped to `{uncommon,rare,epic}`; `maxTurns`/`maxRerolls` derived from it.
- **currentTurn** clamped to `1..maxTurns` (from `currentTurn` or `turnsRemaining`);
  **turn 1 ⇒ full rerolls**; `rerollsRemaining` clamped to `0..9` — NOT to
  `maxRerolls`, because `reroll_increase` outcomes stack the counter uncapped.
- **processCostMultiplier** clamped to `[-100,100]` and snapped to the steps the game
  actually uses (`-100 / 0 / +100`); **processCost** made consistent with
  `900 × (1 + mult/100)`.
- **outcomes** padded/trimmed to exactly 4 and each repaired (legal type/target,
  amount `1..4`, cost `±100`, reroll `1..2`).

It reads its constants (`EFFECT_POOLS`, `RARITY`, `COSTS`) from `model/astrogem.js`,
so it stays in sync if the model changes. Each engine runs its raw parse through
`this.constraintSnap(...)` before returning, so downstream `window.evaluateActions`
always gets a legal state.

## Engine 1 — structural (the DEFAULT and only live engine)

`structural-engine.js` reads the screen's STRUCTURE and COLOR first and uses OCR
only where it is strong — anchored to the wheel's diamond geometry, normalized to
one canonical scale, template-matching the game's own fixed font, and arbitrated
by game-rule constraints (the points checksum, effect pools, legal state ranges).
It emits a full per-field confidence map; anything below 0.8 pulses "confirm me"
in the Advisor window. The complete strategy, with the measured constants and the
debugging methodology behind them, is documented in
[`../docs/how-the-advisor-works.md`](../docs/how-the-advisor-works.md).

It uses the global `Tesseract` (CDN) for its masked micro-OCR calls, with a
self-healing worker queue: a failed/blocked worker degrades the parse honestly
(every confidence capped at 0.5 + an explicit status message) instead of failing
or silently guessing.

## The legacy Tesseract lexicon (`tesseract-engine.js`)

The original full-frame Tesseract engine — superseded 2026-07-16 and no longer
registered. What remains is its text-parsing LIBRARY: the structural engine
consumes `GEM_NAME_COST` + `normalizeOcrText`, and `tools/eval-ocr.js` still
scores `parseConfig`/`parseCuttingState`/`parseOutcomes` as the legacy baseline
row (~58% — the measured reason it was replaced).

## Engine 2 — Workers AI (optional, NOT currently deployed)

`workersai-engine.js` POSTs the screenshot to the Cloudflare Worker in `../worker/`
(`astrogem-vision.js`), which runs `@cf/meta/llama-3.2-11b-vision-instruct` (LLaVA
fallback) and returns the same JSON shape. The client then runs `constraintSnap`.

It is **disabled until you deploy and set the URL**:

1. `cd ../worker && wrangler deploy` (see `../worker/README.md`).
2. Paste the printed URL into the `WORKER_URL` constant at the top of
   `workersai-engine.js`.
3. Reload — the **Workers AI** button in the engine picker becomes selectable.

While `WORKER_URL` is empty, `isAvailable()` returns `false` and the Advisor shows
the option disabled with a tooltip explaining the one setup step.

## A/B testing

`tools/eval-ocr.js` scores the engines' per-field accuracy against the real
screenshot + ground-truth pairs in `../samples/` (see `../samples/README.md` for
the samples, the measured per-engine scores, and how to add more).
