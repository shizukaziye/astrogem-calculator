# Pipeline Tables — Methodology

This documents the **Pipeline Tables** tab of `astrogem-calculator` (the
"which gems to cut / fuse / throw away" strategy view). The collector
`tools/collect-stats.js` bakes `data/pipeline.json` (and, with `--axis=support`,
`data/pipeline-support.json`) using the **exact Bellman DP** in `model/dp.js`
(which runs on the closed-form core `model/astrogem.js` + `model/nested.js`);
`pipeline.js` renders the tab.

It reproduces the layout and verdict colors of the deployed reference page
<https://shizukaziye.github.io/astrogem-pipeline-table/> (source:
`ark-grid-solver/index`).

> **The cut/fuse/throw decision is made PER EFFECT-PAIR BUCKET, not per tier.**
> When a gem drops, the two effects it rolled are its archetype (its bucket). That
> is what you assess. **Tier** (legendary/relic/ancient by level-sum) is a
> *secondary* concern — it classifies the *fodder* a below-baseline cut becomes,
> for fusion "after the fact." A modeling difference vs the deployed page's
> distribution sampler is flagged at the bottom — read it.

---

## 1. Scoring — real % damage (log-space `D`) × a multiplicative willpower

A gem has four levelled stats, each `1–5`: **Willpower efficiency**, **Order/Chaos**,
and **two side effects** (effects depend on base cost; no duplicate effect).

Damage in Lost Ark is **multiplicative**, so each damage line is scored as the log of
its multiplier — additive in log space and ≈ the % damage gain (the same convention
as the accessory calculator, `~/lost-ark-accessory` §2):

```
D = 100 · ln(multiplier)                              (≈ % damage for small values)
gemDamage(config) = D(effect1) + D(effect2) + D(order)
gemValue(config)  = gemDamage × M(effectiveCost)      ← THE value / EV quantity
```

**Willpower is not a damage line** — it is efficiency (`effectiveCost = baseCost −
willpowerLevel`), folded in as a quality multiplier `M(effectiveCost)` calibrated so
a perfect gem of every base cost ties exactly (`gemValue ≈ 1.5021` = grade 100).
Since the 2026-06-26 scoring rework this multiplicative `gemValue` is what the
grade, the DP terminal value, and every EV layer in this bake use; the support axis
has a parallel `supportValue`. Full derivation + the `M` table:
`docs/how-a-gem-is-graded.md`.

The older **additive** `score(config) = Σ line D` (willpower as an additive `±D`
line, a perfect gem ≈ 1.34–1.44%) survives only as a legacy layer — the grader's
raw %-damage readout (`relDamage`) and the JS↔Python reference battery. It is no
longer the value metric anywhere. `damagePercent(config) = (e^(gemDamage/100) −
1)·100` gives the exact multiplicative %.

### Per-line `D` constants (derived from real stat baselines)

Each damage line's per-level `D` is computed **in code** from the gem grid's
contribution against the **other** (non-grid) sources of that stat you already have.
The yardstick is the **lvl-30 marginal**: the value of ONE more level of the stat on
top of an already-full lvl-30 grid (a single gem can't see the rest of the grid):

```
base = 1 + other + gridAdd
per-level D = 100 · ln( (base + gridAdd/levels) / base )
```

| Component | Bucket baseline (`other` + grid `+30` levels) | per-level / per-point `D` |
|-----------|-----------------------------------------------|---------------------------|
| Attack Power | other 12.1% (adrenaline relic book lv7 9% + accessories 3.1%); +1.1% over 30 | `100·ln((1.132+0.011/30)/1.132)` = **0.032386** |
| Additional Damage | other 33.6% (100-quality weapon 30% + high necklace 2.6% + pet 1%); +2.42% over 30 | `100·ln((1.3602+0.0242/30)/1.3602)` = **0.059287** |
| Boss Damage | no other sources; +2.5% over 30 | `100·ln((1.025+0.025/30)/1.025)` = **0.081268** |
| Order/Chaos | flat ×1.0016 per point | `100·ln(1.0016)` = **0.159872** per point — `orderScore = orderLevel × 0.159872` (NOT relative to level 4) |
| Willpower | efficiency vs cost 4; keeps the old willpower:attack ratio (2.4 : 1.0) | `2.4 × 0.032386` = **±0.077726** per cost-level. `willpowerCost = baseCost − willpowerLevel`; cost `<4` → `(4−cost)×D`, cost `>4` → `(cost−4)×(−D)`, cost `4` → 0. In the value model this additive form feeds only the legacy `score`; `gemValue` folds willpower in as the multiplier `M` instead (§1, grading doc §5) |
| Brand Power / Ally Damage Enh. / Ally Attack Enh. (support) | — | `0` on the DPS axis (they carry the parallel support axis — grading doc §8) |

The bucket baselines live in `SCORING.baselines` (JS and Python) so the assumptions
are **visible and editable**; the per-level `D` values are recomputed from them.

> **Historical note.** Before the lvl-30-marginal yardstick the per-level `D` was the
> 30-level *average* `100·ln((1+other+gridAdd)/(1+other))/30`, giving the slightly
> higher constants (0.032549 / 0.059839 / 0.082309 / ±0.078119) you may find in older
> notes. The code derives everything from the baselines at full precision, and
> JS↔Python match exactly.

Effect pools by base cost:

- **8:** Additional Damage, Attack Power, Brand Power, Ally Damage Enh.
- **9:** Boss Damage, Attack Power, Ally Damage Enh., Ally Attack Enh.
- **10:** Boss Damage, Additional Damage, Brand Power, Ally Attack Enh.

---

## 2. Tiers and the within-tier stat distribution

Tier is set by the **level sum** `WP + Order + E1 + E2` (each `1–5`, so sum `4–20`):

| Tier | Level sum |
|------|-----------|
| Legendary | 4 – 15 |
| Relic | 16 – 18 |
| Ancient | 19 – 20 |

For a **random gem within a tier** the core uses a closed-form distribution:

1. **Level sum** is chosen with probability proportional to the number of 4-stat
   partitions achieving it (`levelSumWays`); e.g. ancient 19 has 4 ways, 20 has 1 →
   80% / 20%.
2. **Stats given the sum** are **uniform over all valid `(WP, Order, E1, E2)`
   partitions** of that sum (`scoreDistributionForTier`).
3. **Effect pair** is uniform over the `C(4,2)=6` unordered pairs from the cost's
   pool, with the two partition levels assigned to the two effects (score is
   symmetric, so both assignments are averaged).

This yields an **exact** value distribution per `(baseCost, tier)` — no sampling.
(`scoreDistributionForTier` enumerates on the **`gemValue` scale** — damage ×
willpower multiplier — and is axis-aware: the support bake enumerates
`supportValue` the same way.)

---

## 3. Gold value of a gem

The value quantity is the multiplicative `gemValue` (§1; `supportValue` on the
support axis), already in ≈%-damage units, so there is no score→damage conversion.
`goldPerDamage` is **gold per 1% damage** and `baseline` is a threshold on the same
value scale (for support gems the party benefit is applied as ×3 on gpd at this
step — `SUPPORT_GPD_MULTIPLIER`):

```
directValue(v) = max(0, (v − baseline) × goldPerDamage)
```

In the app the baseline is entered as a **0–100 grade** (your weakest equipped
gem's grade); `gradeToScore` / `supportGradeToScore` — the inverse of the global
value grade — turns it into this threshold. The bake evaluates exactly the twelve
grade rows the tab renders (§7a).

A gem whose value is **below baseline** is not a keeper; it is **fodder**, valued
by fusion (§4).

---

## 4. Fusion model

Fuse **3 gems** of the same base cost → **1** output gem (random effects, random
level sum). **Cost: 500 gold** per fusion.

Output-tier mix (additive per-input contributions, normalized; `fusionOutputDist`):

| Input (3 of same tier) | Legendary | Relic | Ancient |
|------------------------|-----------|-------|---------|
| 3 Legendaries | 99% | 1% | 0% |
| 3 Relics | 19% | 75% | 6% |
| 3 Ancients | 0% | 25% | 75% |

The mixed inputs are the recipes the model actually uses: `1R+2L → 73/25/2`,
`1A+2L → 35/40/25`.

### Tier expected value (the joint fixed point ACROSS COSTS)

`tierExpectedValue(baseCost, baseline, goldPerDamage)` returns `E[L], E[R], E[A]`,
the **full** expected gold value of a random gem in each tier — keep it if
`value ≥ baseline` (direct value) or fuse it if below. The real fusion recipes
couple not just the three tiers but the three **base costs** (the surplus
legendaries in a relic/ancient fuse are free and can be steered to whichever cost
has the most valuable output), so the core solves ONE joint **9-variable**
fixed point (3 tiers × 3 costs, `_solveJointEV`) by plain iteration — it is a
contraction, and the JS/Python loops are implemented identically so they converge
bit-identically:

```
E[T_c] = directExp[T_c] + pBelow[T_c] · max(0, fodder[T_c])        FC = 500

fodder[L_c] = ( 0.99·E[L_c] + 0.01·E[R_c] − FC ) / 3               (3L, 99/1/0)
G(c)        = 0.73·E[L_c] + 0.25·E[R_c] + 0.02·E[A_c]              (1R+2L output EV)
fodder[R_c] = (1/3)·G(c) + (2/3)·max_c G(c) − FC                   (steered surplus)
H(c)        = 0.35·E[L_c] + 0.40·E[R_c] + 0.25·E[A_c]              (1A+2L output EV)
fodder[A_c] = (1/3)·H(c) + (2/3)·max_c H(c) − FC
```

`directExp[T_c] = Σ_{v≥baseline} P(v)·directValue(v)` and `pBelow[T_c] =
P(v < baseline)` come from the exact per-`(cost, tier)` value distribution (§2).
`fusionValueForTier(tier, cost, …)` returns the per-input `fodder[…]` above,
clamped `≥ 0`. (The earlier per-cost `3×3` linear solve by Gaussian elimination —
"fuse 3 of the same tier at your own cost" — is superseded by this joint model,
commit `75ec11e`; the `_solve3x3` helper still in the file is a leftover of it.)

---

## 5. Buckets — the primary axis (the effect pair = the archetype)

A dropped gem has a **base cost** (8/9/10) and an **effect pair** — two of the four
effects in that cost's pool. The pair is the gem's **archetype = its bucket**, and
it is what you assess when deciding cut / fuse / throw:

| Bucket | Label | Meaning |
|--------|-------|---------|
| `2_damage` | **2D** | both effects are damage — best archetype |
| `optimal_damage` | **Op** | the *better* single damage effect + a dead effect |
| `suboptimal_damage` | **Sub** | the *worse* single damage effect + a dead effect |
| `no_damage` | **No** | both effects dead — DPS-worthless (≈ 0) |

The **exact effect pairs per base cost** (from
`ark-grid-solver/collect-statistics-v2.js` `EFFECT_BUCKETS`, baked into
`meta.effectBuckets`):

| Cost | 2D | Op | Sub | No |
|------|----|----|-----|----|
| 8  | Additional Dmg + Attack | Additional Dmg + Brand | Attack + Brand | Brand + Ally Dmg Enh |
| 9  | Boss Dmg + Attack | Boss Dmg + Ally Dmg Enh | Attack + Ally Dmg Enh | Ally Dmg Enh + Ally Atk Enh |
| 10 | Boss Dmg + Additional Dmg | Boss Dmg + Brand | Additional Dmg + Brand | Brand + Ally Atk Enh |

### Cut value = the exact Bellman DP `W` of a fresh gem

The **value of a bucket** is the optimal expected gold from **cutting a fresh
(level-1) gem of that archetype**:

```
cutValue(rarity, cost, bucket, baseline, gpd)
  = W( freshGem, maxTurns[rarity], maxRerolls[rarity], cm = 0 )
```

`freshGem` has the bucket's two effects and **willpower = order = effect1 =
effect2 = 1** (mirrors `ark-grid-solver` `buildState`). `W` is
`Solver.prototype.W` in `model/dp.js` — the exact Bellman value that takes the
expectation over the random fresh 4-draw **inside** (the without-replacement
4-distinct draw model), choosing optimally between **process / reroll / complete**
at every node. It is **not** `evaluateActionsDP` (that needs the specific drawn
outcomes; the advisor tab uses that). The DP value is **deterministic** (no Monte
Carlo) and is the **source of truth** for the per-bucket verdicts.

Because rarity sets the turn / reroll budget (uncommon 5/1, rare 7/2, epic 9/3),
**cut values rise with rarity** — the Uncommon / Rare / Epic blocks differ
genuinely (unlike the old tier-primary build, where all three were identical).

Sanity check baked into the collector: at (the grade-55 baseline row, 1.5M gold/1%,
epic) the c10 cut values order **2D ≫ Op > Sub ≫ No** (No ≈ 0, DPS-worthless).

### The support-axis bake

`node tools/collect-stats.js --axis=support` re-runs the identical grid on the
SUPPORT scoring axis and writes `data/pipeline-support.json`: the buckets re-key on
the support effects (`EFFECT_BUCKETS_SUPPORT` — Ally Attack Enh. / Brand Power /
Ally Damage Enh. are the live lines, the DPS effects are the dead fillers), the
terminal value is `supportValue`, the twelve grade baselines come from
`supportGradeToScore`, and the ×3 party gpd applies at the gold step. The tab's
DPS/Support toggle picks which file it reads.

### Per cost-cell rendering

Each `(rarity, cost)` cell stacks the **four buckets** (2D / Op / Sub / No). Per
row: the **cut value** (gold) and **P(above baseline)** = `pAbove` (probability the
optimal cut clears baseline), colored by verdict (§7), with `↻` for reset-worthy.

### Pipeline columns (the baked `thru` block; NRB only, per week)

A weekly-throughput model ("Time to Complete 24"). **Note (rendering):** the tab no
longer reads this baked `thru` block — `pipeline.js` computes the weekly-economy
group itself from the baked *cells* plus the editable `CONST` block at the top of
the file (daily gem income, box buy-decisions, 20k resets, pre-cut rarity-upgrade
fusion, post-cut `A+2L → R+2L → 3L` fodder fusion, and the cp% gain; see
`docs/how-the-pipeline-tables-are-computed.md` §7 and the in-page "How these tables
are computed" panel). The `thru` block is still baked with the fields below:

| Column | Meaning |
|--------|---------|
| **Boxes** | Static weekly box-gem schedule (reconstructed income). |
| **Box EV** | Gold value/week of those box gems. |
| **Direct/wk** | Above-baseline gems per week from **cutting**. |
| **Fuse/wk** | Above-baseline gems per week from **recycling below-baseline fodder** (3→1). |
| **Total/wk** | `Direct/wk + Fuse/wk`. |
| **Weeks** | `24 / Total/wk`. Colored: `≤8` fast (green), `8–26` medium (amber), `>26` slow (red). |
| **Gold** | Total gold value flowing in per week. |
| **Avg Score** | Expected % damage of the average keeper. |

---

## 6. Tier = fusion fodder ("for after")

Tier is **not** the cut axis — it is the **fodder classification**. A cut that ends
**below baseline** is fodder; it is classified by its **level-sum tier** (§2:
legendary 4–15, relic 16–18, ancient 19–20) and recycled 3→1 by fusion (§4).

The collector records, per bucket, the **fodder tier split**:

```
p_fodder_leg + p_fodder_relic + p_fodder_anc  =  1 − pAbove
```

computed by **walking the SAME optimal policy** the cut value uses
(`tools/collect-stats-worker.js` `fodderTierSplit`): at every node it follows the
DP's optimal action and propagates reach-probability to the children, accumulating
the terminal gem's tier whenever it ends below baseline. This is a second pass over
the memoized policy, not a re-solve, and it sums **exactly** to `1 − pAbove`.

The Pipeline tab shows this in a **separate "Fusion / fodder by tier (Leg / Relic /
Anc)" section** — the secondary view, "for after." Fresh cuts that fail mostly land
in **legendary** fodder (low level-sum), so the legendary lane dominates.

### Throughput economics (the baked reconstruction — legacy layer)

The deployed page's per-week numbers came from a generator that was **not part of
the model core** and is **not in the source repo**. This throughput layer is a
**faithful, documented reconstruction** driven by the DP cut values. It is still
baked (the `thru` block + the constants echoed into `meta`), but the tab now
renders its own richer economic model from `pipeline.js`'s `CONST` block instead
(see the note in §5). The two structural identities are reproduced **exactly**
(and are exact in the baked JSON):

```
Total/wk = Direct/wk + Fuse/wk
Weeks    = 24 / Total/wk
```

The only non-core inputs are these named, retunable constants (in
`tools/collect-stats.js`, echoed into `meta`):

| Constant | Value | Role |
|----------|-------|------|
| `SLOTS` | 24 | Gem slots to fill. |
| `CUTS_PER_WEEK` | `{uncommon:70, rare:26, epic:9}` | Weekly fresh-cut budget by rarity. Sets the **scale** of `Direct/wk`. |
| `FRESH_BUCKET_MIX` | `{2D:.17, Op:.33, Sub:.33, No:.17}` | Bucket mix of a dropped gem (effect pairs ≈ uniform over the C(4,2)=6 pairs, mapped onto the four archetypes). |
| `BOX_SCHEDULE` | `10×uncommon, 10×rare, 1×epic` | Weekly box gems; valued at the 2D-bucket cut value at that rarity. |
| `FUSION_INPUTS` | 3 | Game rule (3 gems per fusion). |

Derivations (now keyed on **buckets**, not tiers):

- `pAboveFresh = Σ_bucket FRESH_BUCKET_MIX[b] · pAbove(rarity,cost,b)`
- `Direct/wk   = CUTS_PER_WEEK[rarity] · pAboveFresh`
- `fodder/wk   = CUTS_PER_WEEK[rarity] · (1 − pAboveFresh)`
- `Fuse/wk     = (fodder/wk / 3) · (legendary-fusion share × pAboveFresh)` — the recycled output's P(above), a documented legendary-lane proxy
- `Box EV      = Σ_box count · cutValue(box.rarity, cost, 2D)`
- `Gold/wk     = Box EV + CUTS_PER_WEEK[rarity] · Σ_bucket FRESH_BUCKET_MIX[b]·cutValue(b)`
- `avgScore    = expScore of the fresh 2D cut`; `cpGain = max(0, avgScore − baseline)`

> **These constants do not affect the per-bucket DP verdicts** (§7). They only
> scale the weekly-throughput columns. Retune them in `collect-stats.js` without
> touching the DP. The exact original generator's constants are not recoverable.

---

## 7. Verdict colors (how a user reads the table)

Per bucket, comparing its **cut value** (DP `W`) — and, for the purple case, the
fodder-fusion value — against the **reset floor**. These bands and colors are
reproduced from the deployed page (`ark-grid-solver/index`):

| Color | Rule | Meaning |
|-------|------|---------|
| 🟩 **Green** | `cut ≥ reset threshold` (20k, `CONST.RESET_THRESHOLD`) | **Worth resetting** if it lands below baseline (pay the 20k reset, one more try). Marked `↻`. |
| 🟨 **Yellow → dim** | `cut > 0` | **Cut, don't reset.** A 4-shade ramp by magnitude: `10k–reset` / `5–10k` / `1–5k` / `<1k`. |
| 🟥 **Red** | `cut ≤ 0` | **Don't cut** — this archetype is worthless at this baseline. |
| 🟪 **Purple** | (NRB) **block-level**: the pre-cut *rarity-upgrade* fusion value beats opening the block's gems | **Fuse before cutting** — 3-into-1 upgrading beats opening them individually. Marked `⚜`. |

The green floor and the reset cost live in `pipeline.js`'s `CONST` block
(`RESET_THRESHOLD` / `RESET_COST`, both 20k — editable, no re-bake needed); the
yellow bands match the baked `meta.verdict`, whose `green: 18000` is the legacy
deployed-page band that `CONST` now overrides. The purple test is computed
block-level from the real unopened rarity-upgrade fusion mixes (not per-bucket
`fusionValueForTier`). **Roster-bound (RB)** gems are free to cut, so the RB
section shows the per-bucket cut value + % only (no pipeline lane, no purple — you
always cut free gems).

---

## 7a. Every rendered number is a baked exact-DP value (no interpolation)

The exact DP is **~3 s per epic cell** (turn-1, 9 turns / 3 rerolls), far too slow
to recompute on every input change. So the tab renders **only baked values**: one
clickable gpd tier at a time (the 8 baked tiers, `meta.anchorGpd`) and one row per
baked grade baseline (the 12 rank rows C-…S+, `meta.bakedBaselines` =
`gradeToScore(40…95)`). Every number is a **direct key lookup** into
`data/pipeline.json` / `data/pipeline-support.json` — exact and instant. The old
arbitrary-baseline "live" mode (a bilinear interpolation of baked anchors) is
**gone**; nothing is interpolated anywhere.

---

## 8. Caveats

### Superseded scoring models
This tool now values gems with the **multiplicative `gemValue`** (`D = 100·
ln(multiplier)` per damage line, × the willpower multiplier `M`, §1), with gold =
`(value − baseline) × goldPerDamage` where `goldPerDamage` is gold per 1% damage
and `baseline` is a grade-derived threshold on the value scale (§3). Three earlier
generations are superseded:

1. **Additive score as the value metric** (this tool, up to 2026-06-26): value /
   grade / EV all used `score(config) = Σ line D` with willpower as an additive
   `±D` line (and, before `b448333`, the 30-level *average* per-level `D` —
   see the historical note in §1). Superseded by the multiplicative
   `gemValue = gemDamage × M(effectiveCost)` (perfect gems tie at grade 100);
   grading, the DP terminal value, and the whole EV/bake layer moved together in
   commit `4c127aa`. The additive `score` remains only as the grader's raw
   %-damage readout (`relDamage`) and in the JS↔Python reference battery. (The
   `tools/verify-dp.js` MC harness was the one value-metric consumer left behind
   on `A.score`; found and fixed 2026-07-16 — its gate had been failing by the
   score-vs-value gap since the rework.)
2. **Abstract weights + 30.96** (the generation before that): Willpower `±2.4`,
   Attack `1.0`, Additional Damage `1.85`, Boss `2.55`, Order `5.14×(level−4)`,
   with `SCORE_PER_PERCENT_DAMAGE = 30.96` converting score→gold and integer
   baselines ~8–12. The `SCORE_PER_PERCENT_DAMAGE` constant has been **removed**.
   The per-line `D` keep the old willpower:attack *ratio* (2.4 : 1.0) but
   everything is now in % damage; absolute numbers (and baselines) differ in both
   value and unit.
3. **Even older docs** in `ark-grid-solver` (`PROBABILITIES.md`,
   `docs/relic-plus-2-leg-fusion-strategy.md`): `27.3 score = 1% damage`, `1.65 /
   2.27 / 4.32 / ±2.1`, baseline 12. Triply superseded. (The `OUTCOME_RATES`
   probability table in `model/astrogem.js` still matches that repo's
   `PROBABILITIES.md` — outcome rates are game data, not scoring.)

Numbers in those docs/older builds will not match this tool.

### Modeling decision — corrected distribution kept (supersedes the deployed page, ~10–30% higher)

The deployed reference page **sampled** the within-tier stat distribution with a
**sequential, range-clamped** partition sampler (`ark-grid-solver/solver-nested.js`,
`_partitionLevelSum`): draw willpower uniformly in its valid range, then order in
the remaining range, etc. **That is not uniform over partitions** — it biases the
first-drawn stats (willpower, order) toward middle values.

This closed-form core instead uses the **uniform-over-partitions** distribution.
The two genuinely differ. Confirmed at fixed level sums:

| Level sum | # partitions | `E[willpower]` uniform (this core) | `E[willpower]` old sampler |
|-----------|--------------|-----------------------------------|----------------------------|
| 16 | 35 | **4.00** | 3.00 |
| 17 | 20 | **4.25** | 3.50 |
| 19 | 4 | **4.75** | 4.50 |

Higher `E[willpower]` → lower willpower **cost** → less penalty → higher score →
higher EV. Net effect on `tierExpectedValue` vs the old **sampled** numbers
(`ark-grid-solver/stats-output/…`), 500k gpd:

| Cell | Legendary | Relic | Ancient |
|------|-----------|-------|---------|
| bl0 c8 | +13.3% | +24.5% | +5.6% |
| bl0 c9 | +11.3% | +24.5% | +7.2% |
| bl1 c8 | +10.6% | +30.4% | +9.1% |
| bl1 c10 | +13.3% | +27.2% | +7.8% |

Max observed `|Δ| ≈ 30%` (worst for **relic**, where the partition spread is
largest). This is a **real modeling difference**, not Monte-Carlo noise: it is
about whether the in-game gem-generation distribution is uniform over partitions
(this core's assumption) or matches the old sampler's sequential bias.

**Decision (2026-06-22): keep the corrected uniform-over-partitions model.** It is
equivalent to each stat being rolled independently, which is exactly what the
documented fusion mechanic ("output level-sum ∝ number of ways to make that sum")
implies — that statement is only true for independent rolls. The old deployed
page's sequential-clamp sampler is therefore a **superseded sampling shortcut**,
and this tool's fodder/fusion values intentionally run ~10–30% higher than that
page. Per-gem verdicts on a *known* gem are unaffected (they use the gem's exact
stats, no distribution).

---

## Regenerate

```bash
node tools/collect-stats.js                  # writes data/pipeline.json (auto-detects workers)
node tools/collect-stats.js --axis=support   # writes data/pipeline-support.json (support axis)
node tools/collect-stats.js --workers=11     # pin worker count
node tools/collect-stats.js --test --sample=4 --workers=2   # quick smoke test
```

Each axis's bake runs **6912 exact DP solves** (3 rarities × 3 costs × 4 buckets ×
8 gold/1% tiers × 12 grade baselines × 2 roster modes = 3456 cells × NRB/RB).
Because a single turn-1 **epic** DP is ~3 s, the collector **parallelizes with
`worker_threads`** (`tools/collect-stats-worker.js`) and logs progress + a
rarity-aware ETA (uncommon ≈ 0.15 s, rare ≈ 1 s, epic ≈ 3 s per solve, plus a
same-magnitude fodder-policy walk per NRB solve). The committed 2026-06-27 bakes
measured **~45–47 min per axis** (`meta.elapsedSec` ≈ 2715 s DPS / 2832 s support).
The keyed schema is `cells["{rarity}_{cost}_{bucket}_{baseline}_{gpd}"] =
{ nrb:{cut,act,pAbove,expScore,expSpend,fLeg,fRelic,fAnc},
rb:{cut,act,pAbove,expScore,expSpend} }` plus
`thru["{rarity}_{cost}_{baseline}_{gpd}"]` for the (legacy) weekly columns.

After any model change that moves DP outputs, re-run the acceptance gate
(`npm run verify-dp`; `--selfcheck` for the fast frozen-constant check), re-freeze
the selfcheck constants deliberately, and re-bake BOTH axes.

Open `index.html` via a static server; the **Pipeline** tab loads
`data/pipeline.json` / `data/pipeline-support.json` (baked, exact DP) and renders
them by direct key lookup — no interpolation (§7a).
