# astrogem-calculator

A clean, from-scratch rebuild of the Lost Ark **astrogem-cutting** tool. This repo
is the **foundation**: a dependency-free, verified model core (JS with a Python
mirror kept in lockstep) plus an app shell. The two UI tabs (Pipeline, Advisor)
are stubs for later agents to build on top of the core.

## What's here

```
model/astrogem.js   PURE deterministic core (scoring, fusion, tier EV). No DOM, no deps.
model/astrogem.py   Python mirror of the deterministic layer (stdlib only).
model/nested.js     Nested Monte Carlo evaluator (evaluateActions). Depends on astrogem.js.
refs.json           Captured-reference battery (generated FROM the JS core).
tools/gen-refs.js   Regenerates refs.json.
verify.js           Recomputes refs.json with astrogem.js, asserts equality. PASS/FAIL.
verify.py           Recomputes refs.json with astrogem.py, asserts equality. JS<->Python guard.
index.html          App shell: header + tab bar (Pipeline / Advisor).
styles.css          Shared dark theme + tab styling.
pipeline.js         "Pipeline" tab (STUB).
advisor.js          "Advisor" tab (STUB).
ocr/engine.js       OCR engine interface contract (STUB).
data/pipeline.json  Placeholder dataset for the Pipeline tab.
```

## The model in one paragraph

A gem has willpower, order, and two side effects (each level 1–5). The **DPS score**
weights willpower vs. cost 4 (±2.4/level), Attack Power 1.0, Additional Damage 1.85,
Boss Damage 2.55, and Order 5.14×(level−4); support effects score 0. A gem's **gold
value** is its direct sale value when its score clears a `baseline`, else its
**fusion-fodder** value. Fusing 3 gems of a tier produces a higher/lower-tier gem
with known odds, so each tier's expected value depends on the others — resolved as
a small **3×3 fixed point** over E[Legendary], E[Relic], E[Ancient] per
`(baseCost, baseline, goldPerDamage)`. The score distribution per tier is computed
in **closed form** (enumerating level-sum partitions × effect pairs), not by
sampling. The **Advisor** uses a nested Monte Carlo over the official per-turn
outcome table to rank Process / Reroll / Complete.

> Constants are the **current canonical generation**. Older docs in the source
> project quoted superseded values (27.3 / 1.65 / 2.27 / 4.32 / baseline 12) — those
> are NOT used here.

## Run verification

```bash
node tools/gen-refs.js   # regenerate refs.json (or: npm run genrefs)
node verify.js           # JS self-consistency      (or: npm run verify)
python3 verify.py        # JS <-> Python parity
```

All three should report `ALL CHECKS PASSED` and exit 0.

## Run a local server (to open the app shell)

The page loads its scripts/data over HTTP, so open it via a static server rather
than `file://`:

```bash
npm run serve            # npx http-server on :8080
# or, no npm:
python3 -m http.server 8080
```

Then visit <http://localhost:8080/>.

## Public API (model/astrogem.js)

Both a browser `<script>` (attaches exports to `window` / `globalThis.Astrogem`)
and a Node `require()` (CommonJS). Key functions:

- `score(config)`, `scoreBreakdown(config)`, `willpowerCost(baseCost, wpLevel)`
- `availableEffects(baseCost)`, `validateConfig(config)`
- `classifyTier(levelSum)`, `outputLevelSumDist(tier)`, `fusionOutputDist(inputTiers)`
- `outcomeProbabilities(state)`
- `goldValue(score, baseline, goldPerDamage)`
- `tierExpectedValue(baseCost, baseline, goldPerDamage)` → `{legendary, relic, ancient}`
- `fusionValueForTier(tier, baseCost, baseline, goldPerDamage)`

`model/nested.js` adds `evaluateActions(state, baseline, goldPerDamage, numRuns, onProgress, options)`.
