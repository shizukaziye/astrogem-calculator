# astrogem-calculator

A clean, from-scratch rebuild of the Lost Ark **astrogem-cutting** tool: a
dependency-free, verified model core (JS with a Python mirror kept in lockstep)
plus the full app — **Grader / Pipeline / Advisor / Leaderboard** tabs on a static
site (GitHub Pages), backed by a small Cloudflare worker for character lookups.
**Shipping is two independent steps**: pushing `main` deploys the site; the worker
must be deployed separately (`worker/README-bible.md`).

## What's here

```
model/astrogem.js   PURE deterministic core (scoring, grading, fusion, tier EV). No DOM, no deps.
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
tools/collect-stats.js (+ -worker.js)
                    Bakes the Pipeline datasets: 6912 exact DP solves per axis
                    (--axis=support for the support bake). See METHODOLOGY.md.
data/pipeline.json / data/pipeline-support.json
                    The baked exact-DP grids (DPS / support) the Pipeline tab renders.
index.html          App shell: header + tab bar (Grader / Pipeline / Advisor / Leaderboard).
styles.css          Shared dark theme + tab styling.
grader.js           Grader tab: pull a character (lostark.bible / lopec.kr via the
                    worker) or enter gems by hand; 0-100 grades + ranks + grid totals.
pipeline.js         Pipeline tab: cut/fuse/throw verdict tables + the weekly-economy
                    group (editable CONST block).
advisor.js          Advisor tab: Processing-screen OCR -> live per-turn advice (exact DP).
leaderboard.js      Leaderboard tab: every cached character ranked by total damage.
favorites.js / gate.js / bible-import.js
                    Roster favorites, shared gating, character-import glue.
ocr/                OCR engines (Tesseract + structural layout parser) + engine contract.
samples/            Real Processing-screen captures + ground truth (tools/eval-ocr.js).
worker/             Cloudflare workers: astrogem-bible.js (fetch/cache/queue/leaderboard;
                    DEPLOYED SEPARATELY from the site) + astrogem-vision.js. See READMEs.
queue-admin.html    Owner dashboard for the lookup queue.
docs/               Deep-dive docs: grading, pipeline math, leaderboard, queue/drain.
METHODOLOGY.md      The Pipeline bake reference (scoring, fusion fixed point, schema).
```

## The model in one paragraph

A gem has willpower, order, and two side effects (each level 1–5). Damage is
multiplicative, so each damage line is scored in **real % damage**: `D =
100·ln(multiplier)` (additive in log space). The per-line values are derived from
real stat baselines — Boss Damage ≈ 0.0813/lvl, Additional Damage ≈ 0.0593/lvl,
Attack Power ≈ 0.0324/lvl, Order ≈ 0.1599 per point (flat). **Willpower is
efficiency, not damage**: a gem's value is `gemValue = gemDamage ×
M(effectiveCost)`, a willpower multiplier calibrated so a perfect gem of every
base cost ties exactly — the basis of the **0–100 grade** and letter rank
(S+…F-). Support gems get a parallel `supportValue` axis (per-DPS coefficients,
the ×3 party benefit applied to gold-per-damage). A gem's **gold value** is its
direct sale value when its value clears a `baseline` (a grade-derived threshold),
else its **fusion-fodder** value; `goldPerDamage` is gold per 1% damage. Fusion
(3→1, with the free surplus legendaries of a relic/ancient fuse steerable across
base costs) couples every tier AND base cost — resolved as a **joint 9-variable
fixed point** over E[tier, cost] per `(baseline, goldPerDamage)`. The value
distribution per tier is computed in **closed form** (enumerating level-sum
partitions × effect pairs), not by sampling. The **Advisor** ranks Process /
Reroll / Complete with an **exact Bellman dynamic program** (`model/dp.js`):
`W(config, t, r, costMult)` = the optimal expected NET gold value of an
in-progress cut, computed on demand with memoization. A nested-Monte-Carlo
evaluator (`model/nested.js`) is retained as the **independent cross-check**
(`tools/verify-dp.js`) that proves the DP correct.

> Valuation is the **multiplicative `gemValue`** (real %-damage lines × a willpower
> multiplier; 2026-06-26 rework). This supersedes the earlier additive score-as-value
> model (willpower as an additive ±D line — `score()` survives only as the grader's
> raw %-damage readout and in the reference battery), the old abstract-weight model
> (WP ±2.4 / ATK 1.0 / AddDmg 1.85 / Boss 2.55 / Order 5.14, with a 30.96
> score→gold conversion), and the even older `27.3 / 1.65 / 2.27 / 4.32` docs in the
> source project. See `METHODOLOGY.md` §1, §8 and `docs/how-a-gem-is-graded.md`.

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

- `gemDamage(config)`, `gemValue(config)` — THE value quantity (damage × willpower
  multiplier `M`); `grade(config)` (0–100), `gemRank(config)`, `gradeToScore(g)`,
  `damagePercent(config)`
- support axis: `supportValue(config)`, `supportGrade(config)`,
  `supportGradeToScore(g)`; whole-grid: `gridDamage(gems, axis)`,
  `gridQuality(gems, axis)`
- legacy additive layer: `score(config)`, `relDamage(config)`,
  `scoreBreakdown(config)`; `willpowerCost(baseCost, wpLevel)`
- `availableEffects(baseCost)`, `validateConfig(config)`
- `classifyTier(levelSum)`, `outputLevelSumDist(tier)`, `fusionOutputDist(inputTiers)`
- `outcomeProbabilities(state)`
- `goldValue(value, baseline, goldPerDamage)`
- `tierExpectedValue(baseCost, baseline, goldPerDamage, axis?)` → `{legendary, relic, ancient}`
- `fusionValueForTier(tier, baseCost, baseline, goldPerDamage, axis?)`

`model/nested.js` adds `evaluateActions(state, baseline, goldPerDamage, numRuns, onProgress, options)`
(the Monte-Carlo evaluator / fallback).

`model/dp.js` (the exact decision model) adds:

- `evaluateActionsDP(state, baseline, goldPerDamage, numRuns, onProgress, options)` —
  drop-in for `evaluateActions` with the identical return shape, backed by the DP
  (`numRuns`/`onProgress` ignored; it is deterministic). The Advisor calls this by
  default and falls back to `evaluateActions` if it is unavailable or throws.
- `topLevelAdvice(state, baseline, goldPerDamage, options)` — the underlying ranker.
  `options.drawModel` is `"wor"` (default, exact without-replacement) or `"iid"`
  (faster approximation); `options.axis` is `"dps"` (default) or `"support"`
  (supportValue terminals against a support-scale baseline). Returns
  `{bestAction, allActions:[{name,value,aboveBaselineOdds,expectedScore,
  expectedCost,description}], currentValue, expectedValues, expectedScores}`.
- `Solver(baseline, goldPerDamage, rosterBound, {drawModel, axis, maxTurns})` with
  `.W(config,t,r,cm)` (optimal NET value) and `.branchStats(config,t,r,cm)`
  (expected final score / P(above baseline) / expected future spend along the
  optimal policy). `maxTurns` gates Complete on a 0-process gem.
- `chooseAction(solver, config, t, r, cm, outcomes, allowComplete)` — the optimal
  action given the actual 4 drawn outcomes (used by the MC cross-check).
