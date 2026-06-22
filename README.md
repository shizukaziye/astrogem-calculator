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
model/dp.js         EXACT Bellman DP for optimal cut decisions (topLevelAdvice /
                    evaluateActionsDP). The Advisor's default engine; the MC is the
                    cross-check. Depends on astrogem.js + nested.js.
refs.json           Captured-reference battery (generated FROM the JS core).
tools/gen-refs.js   Regenerates refs.json.
verify.js           Recomputes refs.json with astrogem.js, asserts equality. PASS/FAIL.
verify.py           Recomputes refs.json with astrogem.py, asserts equality. JS<->Python guard.
tools/verify-dp.js  DP acceptance gate: DP value vs an INDEPENDENT Monte-Carlo of the
                    DP-optimal policy, over a battery of start states. PASS/FAIL.
index.html          App shell: header + tab bar (Pipeline / Advisor).
styles.css          Shared dark theme + tab styling.
pipeline.js         "Pipeline" tab (STUB).
advisor.js          "Advisor" tab (STUB).
ocr/engine.js       OCR engine interface contract (STUB).
data/pipeline.json  Placeholder dataset for the Pipeline tab.
```

## The model in one paragraph

A gem has willpower, order, and two side effects (each level 1–5). Damage is
multiplicative, so each line is scored in **real % damage**: `D = 100·ln(multiplier)`
(additive in log space). The per-line values are derived from real stat baselines —
Attack Power ≈ 0.0325/lvl, Additional Damage ≈ 0.0598/lvl, Boss Damage ≈ 0.0823/lvl,
Order ≈ 0.1599 per point (flat), Willpower ≈ ±0.0781 per cost-level vs cost 4; support
effects score 0. A gem's **score is its approximate % damage** (a perfect gem ≈ 1.3–1.4%).
A gem's **gold value** is its direct sale value when its % damage clears a `baseline`
(itself a %-damage threshold), else its **fusion-fodder** value; `goldPerDamage` is
gold per 1% damage. Fusing 3 gems of a tier produces a higher/lower-tier gem with
known odds, so each tier's expected value depends on the others — resolved as a small
**3×3 fixed point** over E[Legendary], E[Relic], E[Ancient] per
`(baseCost, baseline, goldPerDamage)`. The score distribution per tier is computed
in **closed form** (enumerating level-sum partitions × effect pairs), not by
sampling. The **Advisor** ranks Process / Reroll / Complete with an **exact Bellman
dynamic program** (`model/dp.js`): `W(config, t, r, costMult)` = the optimal expected
NET gold value of an in-progress cut, computed on demand with memoization. A
nested-Monte-Carlo evaluator (`model/nested.js`) is retained as the **independent
cross-check** (`tools/verify-dp.js`) that proves the DP correct.

> Scoring is **real % damage** (log-space). This supersedes the old abstract-weight
> model (WP ±2.4 / ATK 1.0 / AddDmg 1.85 / Boss 2.55 / Order 5.14, with a 30.96
> score→gold conversion) and the even older `27.3 / 1.65 / 2.27 / 4.32` docs in the
> source project — neither is used here. See `METHODOLOGY.md` §1, §8.

## Run verification

```bash
node tools/gen-refs.js   # regenerate refs.json (or: npm run genrefs)
node verify.js           # JS self-consistency        (or: npm run verify)
python3 verify.py        # JS <-> Python parity
node tools/verify-dp.js --selfcheck   # fast deterministic DP self-check (frozen W values)
node tools/verify-dp.js               # DP vs independent Monte-Carlo gate (or: npm run verify-dp)
```

The first three report `ALL CHECKS PASSED` and exit 0. `verify-dp.js` simulates many
full cuts under the DP-optimal policy and asserts the DP value matches the MC mean:
the **leveraged (CORE) rare/epic decisions agree to within 2%**; a documented short
low-baseline (EDGE) corner is within ~6% (the conditional-Bernoulli without-replacement
draw approximation — see the file header and `model/dp.js`). Use `DP_MODEL=iid` to
validate the faster (but ~4–7% looser on long cuts) i.i.d. draw model, and
`DP_MC_RUNS=50000` to tighten the MC confidence interval.

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

`model/nested.js` adds `evaluateActions(state, baseline, goldPerDamage, numRuns, onProgress, options)`
(the Monte-Carlo evaluator / fallback).

`model/dp.js` (the exact decision model) adds:

- `evaluateActionsDP(state, baseline, goldPerDamage, numRuns, onProgress, options)` —
  drop-in for `evaluateActions` with the identical return shape, backed by the DP
  (`numRuns`/`onProgress` ignored; it is deterministic). The Advisor calls this by
  default and falls back to `evaluateActions` if it is unavailable or throws.
- `topLevelAdvice(state, baseline, goldPerDamage, options)` — the underlying ranker.
  `options.drawModel` is `"wor"` (default, exact without-replacement) or `"iid"`
  (faster approximation). Returns `{bestAction, allActions:[{name,value,
  aboveBaselineOdds,expectedScore,expectedCost,description}], currentValue,
  expectedValues, expectedScores}`.
- `Solver(baseline, goldPerDamage, rosterBound, {drawModel})` with `.W(config,t,r,cm)`
  (optimal NET value) and `.branchStats(config,t,r,cm)` (expected final score /
  P(above baseline) / expected future spend along the optimal policy).
- `chooseAction(solver, config, t, r, cm, outcomes, allowComplete)` — the optimal
  action given the actual 4 drawn outcomes (used by the MC cross-check).
