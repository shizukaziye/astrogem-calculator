# Pipeline Tables — Methodology

This documents the **Pipeline Tables** tab of `astrogem-calculator` (the
"which gems to cut / fuse / throw away" strategy view). The collector
`tools/collect-stats.js` bakes `data/pipeline.json` using the **exact Bellman DP**
in `model/dp.js` (which runs on the closed-form core `model/astrogem.js` +
`model/nested.js`); `pipeline.js` renders the tab.

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

## 1. Scoring — real % damage (log-space `D`)

A gem has four levelled stats, each `1–5`: **Willpower efficiency**, **Order/Chaos**,
and **two side effects** (effects depend on base cost; no duplicate effect).

Damage in Lost Ark is **multiplicative**, so each line is scored as the log of its
multiplier — additive in log space and ≈ the % damage gain (the same convention as
the accessory calculator, `~/lost-ark-accessory` §2):

```
D = 100 · ln(multiplier)      (≈ % damage for small values)
score(config) = Σ line D      (≈ the gem's total % damage)
```

`score(config)` therefore **returns the gem's approximate % damage** (a perfect gem
is ≈ 1.34–1.44%). `damagePercent(config) = (e^(score/100) − 1)·100` gives the exact
multiplicative %, which ≈ `score` for these small values.

### Per-line `D` constants (derived from real stat baselines)

Each damage line's per-level `D` is computed **in code** from the gem grid's
contribution against the **other** (non-grid) sources of that stat you already have:

```
per-level D = 100 · ln( (1 + other + gridAdd) / (1 + other) ) / levels
```

| Component | Bucket baseline (`other` + grid `+30` levels) | per-level / per-point `D` |
|-----------|-----------------------------------------------|---------------------------|
| Attack Power | other 12.1% (adrenaline relic book lv7 9% + accessories 3.1%); +1.1% over 30 | `100·ln(1.132/1.121)/30` = **0.032549** |
| Additional Damage | other 33.6% (100-quality weapon 30% + high necklace 2.6% + pet 1%); +2.42% over 30 | `100·ln(1.3602/1.336)/30` = **0.059839** |
| Boss Damage | no other sources; +2.5% over 30 | `100·ln(1.025/1.0)/30` = **0.082309** |
| Order/Chaos | flat ×1.0016 per point | `100·ln(1.0016)` = **0.159872** per point — `orderScore = orderLevel × 0.159872` (NOT relative to level 4) |
| Willpower | efficiency vs cost 4; converted from the old ±2.4 by the old willpower:attack ratio (2.4 : 1.0) | `2.4 × 0.032549` = **±0.078119** per cost-level. `willpowerCost = baseCost − willpowerLevel`; cost `<4` → `(4−cost)×0.078119`, cost `>4` → `(cost−4)×(−0.078119)`, cost `4` → 0 |
| Brand Power / Ally Damage Enh. / Ally Attack Enh. (support) | — | `0` |

The bucket baselines live in `SCORING.baselines` (JS and Python) so the assumptions
are **visible and editable**; the per-level `D` values are recomputed from them.

> **Willpower precision note.** The constant computed from the baseline is
> `2.4 × 0.0325494523… = 0.0781187…`; the "0.078118" you may see written elsewhere is
> that value with the attack per-level pre-rounded to `0.032549`. The code derives it
> from the baseline (full precision), and JS↔Python match exactly.

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

This yields an **exact** score distribution per `(baseCost, tier)` — no sampling.

---

## 3. Gold value of a gem

Score **is** % damage now, so there is no score→damage conversion. `goldPerDamage`
is **gold per 1% damage** and `baseline` is a **%-damage** threshold (the % damage of
your weakest equipped gem — typically ~0.5–2.5):

```
directValue(scoreD) = max(0, (scoreD − baseline) × goldPerDamage)
```

A gem whose % damage is **below baseline** is not a keeper; it is **fodder**, valued
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

(Mixed inputs the legend mentions: `1R+2L → 73/25/2`, `1A+2L → 35/40/25`.)

### Tier expected value (the joint fixed point)

`tierExpectedValue(baseCost, baseline, goldPerDamage)` returns `E[L], E[R], E[A]`,
the **full** expected gold value of a random gem in each tier — keep it if
`score ≥ baseline` (direct value) or fuse it if below. Because a fused output can
itself land in a higher/lower tier, the three values are coupled and solved as a
`3×3` linear fixed point:

```
E[T] = directExp[T] + pBelow[T] · ( mix(T)·E − fusionCost ) / 3
```

where `directExp[T] = Σ_{score≥baseline} P(score)·directValue(score)`,
`pBelow[T] = P(score < baseline)`, `mix(T)` is the output mix for 3 copies of `T`,
and `fusionCost = 500`. Solved by Gaussian elimination, each component clamped `≥0`.

`fusionValueForTier(tier, …)` = per-gem value of fusing 3 of a tier =
`max(0, (mix(tier)·E − 500) / 3)`.

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

Sanity check baked into the collector: at (baseline 1.0, 1.5M gold/1%, epic) the
c10 cut values order **2D ≫ Op > Sub ≫ No** (No ≈ 0, DPS-worthless).

### Per cost-cell rendering

Each `(rarity, cost)` cell stacks the **four buckets** (2D / Op / Sub / No). Per
row: the **cut value** (gold) and **P(above baseline)** = `pAbove` (probability the
optimal cut clears baseline), colored by verdict (§7), with `↻` for reset-worthy.

### Pipeline columns (NRB only, per week)

A weekly-throughput model ("Time to Complete 24"):

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

### Throughput economics (reconstruction — read this)

The deployed page's per-week numbers came from a generator that was **not part of
the model core** and is **not in the source repo**. This throughput layer is a
**faithful, documented reconstruction** driven by the DP cut values. The two
structural identities are reproduced **exactly** (and are exact in the baked JSON):

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
| 🟩 **Green** | `cut ≥ 18k` | **Worth resetting** if it lands below baseline (reroll once, same bucket). Marked `↻`. |
| 🟨 **Yellow → dim** | `cut > 0` | **Cut, don't reset.** A 4-shade ramp by magnitude: `10–18k` / `5–10k` / `1–5k` / `<1k`. |
| 🟥 **Red** | `cut ≤ 0` | **Don't cut** — this archetype is worthless at this baseline. |
| 🟪 **Purple** | (NRB) fodder-fusion value `>` the weak cut value | **Fuse before cutting** — you net more by fusing 3 of these than by completing one. Marked `⚜`. |

The fodder-fusion value used for the purple test is `fusionValueForTier("legendary",
cost, baseline, gpd)` (the dominant fodder lane). **Roster-bound (RB)** gems are
free to cut, so the RB section shows the per-bucket cut value + % only (no pipeline
lane, no purple — you always cut free gems). Thresholds are in `meta.verdict`.

---

## 7a. Live mode interpolates the baked DP grid

The exact DP is **~3 s per epic cell** (turn-1, 9 turns / 3 rerolls), far too slow
to recompute on every input change. So **live mode interpolates** the baked grid:
for any `(gpd, baseline)` it **bilinearly interpolates** the per-bucket cut values,
`pAbove`, and the fodder split from the dense baked anchors
(`meta.anchorGpd` × `meta.bakedBaselines`). The throughput columns interpolate the
same way. Only the *baked* values are exact DP; live is an interpolation of them.

---

## 8. Caveats

### Superseded scoring models
This tool now scores gems as **real % damage** (`D = 100·ln(multiplier)`, §1), with
gold = `(score − baseline) × goldPerDamage` where `goldPerDamage` is gold per 1%
damage and `baseline` is a %-damage threshold (§3). Two earlier models are superseded:

1. **Abstract weights + 30.96** (the immediately prior generation of *this* tool):
   Willpower `±2.4`, Attack `1.0`, Additional Damage `1.85`, Boss `2.55`, Order
   `5.14×(level−4)`, with `SCORE_PER_PERCENT_DAMAGE = 30.96` converting score→gold and
   integer baselines ~8–12. The `SCORE_PER_PERCENT_DAMAGE` constant has been **removed**.
   The new per-line `D` keep the old willpower:attack *ratio* (2.4 : 1.0) but everything
   is now in % damage; absolute numbers (and baselines) differ in both value and unit.
2. **Even older docs** in `ark-grid-solver` (`PROBABILITIES.md`,
   `docs/relic-plus-2-leg-fusion-strategy.md`): `27.3 score = 1% damage`, `1.65 / 2.27 /
   4.32 / ±2.1`, baseline 12. Doubly superseded.

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
node tools/collect-stats.js              # writes data/pipeline.json (auto-detects workers)
node tools/collect-stats.js --workers=11 # pin worker count
node tools/collect-stats.js --test --sample=4 --workers=2   # quick smoke test
```

The bake runs **4536 exact DP solves** (3 rarities × 3 costs × 4 buckets × 9
gold/1% anchors × 7 baselines × 2 roster modes). Because a single turn-1 **epic**
DP is ~3 s, the collector **parallelizes with `worker_threads`**
(`tools/collect-stats-worker.js`) and logs progress + a rarity-aware ETA. End to
end it is roughly **15–20 min on ~11 workers** (uncommon ≈ 0.15 s, rare ≈ 1 s, epic
≈ 3 s per cell, plus a same-magnitude fodder-policy walk per cell). The keyed schema
is `cells["{rarity}_{cost}_{bucket}_{baseline}_{gpd}"] = { nrb:{cut,act,pAbove,
expScore,expSpend,fLeg,fRelic,fAnc}, rb:{cut,act,pAbove,expScore,expSpend} }` plus
`thru["{rarity}_{cost}_{baseline}_{gpd}"]` for the weekly columns.

Open `index.html` via a static server; the **Pipeline** tab loads
`data/pipeline.json` (baked, exact DP) and interpolates it for live tables.
