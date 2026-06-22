# Pipeline Tables — Methodology

This documents the **Pipeline Tables** tab of `astrogem-calculator` (the
"which gems to cut / fuse / throw away" strategy view). It is built entirely on
the dependency-free closed-form core `model/astrogem.js`. The collector
`tools/collect-stats.js` bakes `data/pipeline.json`; `pipeline.js` renders the tab.

It reproduces the deployed reference page
<https://shizukaziye.github.io/astrogem-pipeline-table/> (source:
`ark-grid-solver/index`). **One important modeling difference is flagged at the
bottom — read it.**

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

## 5. What the Pipeline tab shows

### Gem cells (per cost × tier)

Each base-cost cell stacks the three tiers (**Leg / Relic / Anc**). Per row:

- **Direct EV** — `directExp[tier]` (expected direct-sale gold of a random gem of
  that tier above baseline).
- **% above baseline** — `P(score ≥ baseline)` for that tier.
- A glyph: `↻` reset-worthy, `⚜` fuse-first.

These are **exact closed-form** values (the source of truth for the verdict
colors). They depend on `(cost, baseline, goldPerDamage)` but **not** on rarity —
rarity only changes the throughput columns, so the per-tier gold/% is identical
across the Uncommon / Rare / Epic blocks by construction.

### Pipeline columns (NRB only, per week)

A weekly-throughput model ("Time to Complete 24"):

| Column | Meaning |
|--------|---------|
| **Box EV** | Weekly box gold above baseline (gold value of weekly box gems that clear baseline). |
| **Direct/wk** | Above-baseline gems per week from **cutting**. |
| **Fuse/wk** | Above-baseline gems per week from **recycling below-baseline fodder** (3→1). |
| **Total/wk** | `Direct/wk + Fuse/wk`. |
| **Weeks** | `24 / Total/wk`. Colored: `≤8` fast (green), `8–26` medium (amber), `>26` slow (red). |
| **Gold/wk** | Total gold value flowing in per week. |

LIVE mode also surfaces **avg keeper combat-power gain** = `avgScore − baseline`
(% damage of the average equipped gem above baseline — score is already % damage).

---

## 6. Throughput economics (reconstruction — read this)

The deployed page's per-week numbers came from a generator script that was **not
part of the model core** we build on, and is **not present** in the source repo.
The throughput layer here is therefore a **faithful, fully-documented
reconstruction** driven by the closed-form core. The two structural identities the
deployed page obeys are reproduced **exactly** (and are exact in the baked JSON):

```
Total/wk = Direct/wk + Fuse/wk
Weeks    = 24 / Total/wk
```

Everything feeding them is closed-form; the only non-core inputs are these named,
retunable constants (in `tools/collect-stats.js`, also echoed into `meta`):

| Constant | Value | Role |
|----------|-------|------|
| `SLOTS` | 24 | Gem slots to fill. |
| `CUTS_PER_WEEK` | `{uncommon:70, rare:26, epic:9}` | Weekly fresh-cut budget by rarity. Sets the **scale** of `Direct/wk = cuts × P(above)`. Calibrated so low-baseline `Total/wk` lands in the deployed page's ~15–25/wk regime. |
| `FRESH_TIER_MIX` | `{L:0.86, R:0.13, A:0.01}` | Tier split of a freshly-cut gem (matches the reference fresh-cut mix). |
| `BOX_SCHEDULE` | `10×Leg, 10×Relic, 1×Anc` | Weekly box gems; valued at their tier `directEV`. |
| `FUSION_INPUTS` | 3 | Game rule (3 gems per fusion). |

Derivations:

- `pAboveFresh = Σ_tier FRESH_TIER_MIX[tier] · P(above|tier)`
- `Direct/wk   = CUTS_PER_WEEK[rarity] · pAboveFresh`
- `fodder/wk   = CUTS_PER_WEEK[rarity] · (1 − pAboveFresh)`
- `Fuse/wk     = (fodder/wk / 3) · P(fused legendary-lane output clears baseline)`
- `Box EV      = Σ_box count · directEV(box.tier)`
- `Gold/wk     = Box EV + CUTS_PER_WEEK[rarity] · Σ_tier FRESH_TIER_MIX[tier]·E[tier]`
- `avgScore    = tier-weighted E[score | above]`; `cpGain = avgScore − baseline` (score is % damage)

> **These constants do not affect the per-gem closed-form verdicts** (§7). They
> only scale the weekly-throughput columns. Retune them in `collect-stats.js`
> without touching the model core. The exact original generator's constants are
> not recoverable from what shipped.

---

## 7. Verdict colors (how a user reads the table)

Per gem, comparing its closed-form **Direct EV** (and fusion value) against the
**reset floor** (20,000 gold):

| Color | Rule | Meaning |
|-------|------|---------|
| 🟩 **Green** | `Direct EV ≥ 20k` | High value — **worth resetting** (reroll once, same bucket) if it lands below baseline. Marked `↻`. |
| 🟨 **Yellow-dim** | `0 < Direct EV < 20k` and cutting beats fusing | **Cut, don't reset** — worth completing but not worth a reroll. |
| 🟥 **Red** | `Direct EV ≤ 0` and no fusion value | **Don't cut** — a random gem here is worthless at this baseline. |
| 🟪 **Purple** | fusion value `> Direct EV` (and the cut value is weak/zero) | **Fuse before cutting** — you get more by fusing 3 of these than by completing one. Marked `⚜`. |

**Roster-bound (RB)** gems are *free to cut*, so a "don't cut" (red) cell that still
has positive fusion value is shown as purple (fuse it) rather than red. The RB
section shows gem EV and % only (no pipeline lane — you always cut free gems).

The reset floor (20k) and the green threshold are in `meta.verdictThresholds`.

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
node tools/collect-stats.js     # writes data/pipeline.json
```

Open `index.html` via a static server; the **Pipeline** tab loads
`data/pipeline.json` (baked) and recomputes live tables from the core.
