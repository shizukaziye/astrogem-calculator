# How the Pipeline Tables Are Computed

The **Pipeline** tab answers one question for every kind of gem that can drop:
**should I cut it, fuse it, or throw it away?** This doc explains the math behind
those cut/fuse/throw verdicts and the weekly-throughput columns.

> The exhaustive bake reference (the keyed JSON schema, the regenerate commands, the
> superseded-models history, and the uniform-vs-sampled distribution decision) lives
> in **`../METHODOLOGY.md`** — this doc is the conceptual walkthrough. The DPS and
> support tables are being **re-baked** as of this writing; the structure below is
> stable, the exact numbers come from `data/pipeline.json` (+ `…-support.json`).

---

## 1. The decision is made per **archetype (effect-pair bucket)**, not per tier

When a gem drops it has a **base cost** (8/9/10) and **two side effects** from that
cost's pool. Those two effects are the gem's *archetype* — and the cut/fuse/throw
call is made on the archetype. Each archetype collapses into one of **four buckets**:

| Bucket | Label | Meaning |
|---|---|---|
| `2_damage` | **2D** | both effects are damage lines — the best archetype |
| `optimal_damage` | **Op** | the *better* single damage line + a dead line |
| `suboptimal_damage` | **Sub** | the *worse* single damage line + a dead line |
| `no_damage` | **No** | both lines dead — worthless (≈ 0) |

The exact effect pairs per bucket are baked into `meta.effectBuckets` (see
METHODOLOGY §5). **Tier** (legendary/relic/ancient, by level-sum) is *not* the cut
axis — it only classifies the *fodder* a failed cut becomes, for fusion (§5).

---

## 2. Turning a gem into gold

A gem's worth is its **% damage above your weakest equipped gem**, priced in gold:

```
directValue = max(0, (gemScore − baseline) × goldPerDamage)
```

- **`gemScore`** ≈ the gem's % damage (the log-space `D` sum from
  *how-a-gem-is-graded.md*).
- **`baseline`** = the % damage of the weakest gem you'd replace (your bar, ~0.5–2.5).
- **`goldPerDamage`** = how much a 1%-damage upgrade is worth to you in gold.

A gem **below baseline isn't a keeper** — it becomes **fodder**, valued only through
fusion (§5).

> **Scoring caveat (the rebake).** The grader now scores a single gem with the
> *multiplicative* `gemValue` model (perfect gems of every cost tie at grade 100 — see
> the grading doc). The pipeline's EV layer still uses the older *additive* `score`
> (willpower + effects + order, ≈ % damage) and its `gradeToScore` inverse. They agree
> to first order for these small values; the **in-progress re-bake unifies the
> pipeline onto the same multiplicative model**. Per-gem grading and pipeline EV will
> then share one scale.

---

## 3. The cut value = an exact Bellman DP

Cutting a gem is a sequence of **process / reroll / complete** choices under a turn +
reroll budget set by rarity:

| Rarity | turns | rerolls |
|---|---:|---:|
| Uncommon | 5 | 1 |
| Rare | 7 | 2 |
| Epic | 9 | 3 |

The **value of a bucket** is the optimal expected gold from cutting a **fresh
(all-level-1)** gem of that archetype, played perfectly:

```
cutValue = W( freshGem, maxTurns[rarity], maxRerolls[rarity] )
```

`W` (in `model/dp.js`) is the **exact Bellman value**: at every node it takes the
expectation over the random 4-option draw (the without-replacement "4 distinct
options" model) and picks the best of **process** (commit to an option, advancing a
random stat), **reroll** (pay to redraw the 4 options), or **complete** (stop and bank
the gem's current value). It is *deterministic* — no Monte Carlo — and is the **source
of truth** for the per-bucket verdicts. Because the budget grows with rarity, cut
values rise Uncommon → Rare → Epic (the three blocks genuinely differ).

For a **random** gem in a tier (needed for fusion EV), the core uses a **closed-form**
distribution rather than sampling: the level-sum is chosen ∝ the number of
`(wp, order, e1, e2)` partitions that make it, and stats are **uniform over those
partitions** (`scoreDistributionForTier`). This is exact, and it's a deliberate
correction over the deployed page's sequential sampler (METHODOLOGY §8 quantifies the
~10–30% difference).

---

## 4. Fusion — recycling fodder 3 → 1

Three gems of the same base cost fuse into one (random output), costing **500 gold**.
The output tier depends on the inputs (`fusionOutputDist`, additive-per-input then
normalized): e.g. 3 Legendaries → 99/1/0% Leg/Relic/Anc, 3 Relics → 19/75/6%, 3
Ancients → 0/25/75%.

Because a fused output can itself be kept or re-fused, the per-tier expected values
are **coupled** and solved as a 3×3 linear fixed point (`tierExpectedValue`):

```
E[T] = directExp[T] + P(below baseline in T) · ( mix(T)·E − 500 ) / 3
```

`directExp[T]` is the expected direct value of a random tier-`T` gem that clears
baseline; the `mix(T)·E` term is the expected value of fusing 3 of them. Solved by
elimination, components clamped ≥ 0. The per-gem **fusion value** of a fodder tier is
`max(0, (mix(tier)·E − 500) / 3)`.

---

## 5. Tiers are the **fodder** classification

A cut that ends **below baseline** is fodder, classified by its level-sum tier
(Legendary 4–15, Relic 16–18, Ancient 19–20) and recycled by fusion. The collector
records the fodder tier split per bucket by **walking the DP's own optimal policy** a
second time and accumulating where below-baseline cuts land — it sums exactly to
`1 − P(above baseline)`. Fresh failed cuts mostly land **legendary** (low level-sum),
so the legendary fodder lane dominates. The tab shows this in a separate
"Fusion / fodder by tier" section — the "for after" view.

---

## 6. Reading the verdict colors

Each bucket's **cut value** (and, for purple, the fodder-fusion value) is compared to
a reset floor:

| Color | Rule | Meaning |
|---|---|---|
| 🟩 **Green** | cut ≥ 18k | **Worth resetting** if it lands below baseline (reroll once). Marked `↻`. |
| 🟨 **Yellow** (4-shade ramp) | cut > 0 | **Cut, don't reset.** Dimmer = lower value (10–18k / 5–10k / 1–5k / <1k). |
| 🟥 **Red** | cut ≤ 0 | **Don't cut** — worthless at this baseline. |
| 🟪 **Purple** | fodder-fusion value > the weak cut value | **Fuse before cutting** — 3-into-1 nets more than completing one. Marked `⚜`. |

**Roster-bound (RB)** gems are free to cut, so their section shows the cut value + odds
only (no pipeline lane, no purple — you always cut a free gem). Thresholds live in
`meta.verdict`.

---

## 7. The weekly-throughput columns

A "time to fill 24 slots" model layered on the DP cut values. Per `(rarity, cost,
baseline, gpd)` it computes: **Box EV** (value/week of the fixed weekly box gems),
**Direct/wk** (above-baseline keepers from cutting), **Fuse/wk** (keepers recycled
from fodder), **Total/wk = Direct + Fuse**, **Weeks = 24 / Total/wk** (green ≤8 / amber
8–26 / red >26), **Gold/wk**, and **Avg Score**. The scale constants
(`CUTS_PER_WEEK`, `FRESH_BUCKET_MIX`, `BOX_SCHEDULE`) are named and retunable in the
collector and **do not affect the per-bucket DP verdicts** — only the throughput
columns (METHODOLOGY §6).

---

## 8. Baked vs live mode

A single epic DP cell is ~3 s, far too slow to recompute on input changes. So the
collector **bakes** a dense grid of exact DP values (rarities × costs × buckets ×
gold-per-damage anchors × baselines × roster modes) into `data/pipeline.json`.

- **Baked mode** renders fixed gold/baseline tiers straight from that grid (exact DP).
- **Live mode** takes any `(goldPerDamage, baseline)` and **bilinearly interpolates**
  the per-bucket cut values, `P(above)`, fodder split, and throughput from the baked
  anchors — instant, and faithful to the exact DP it interpolates.

---

*See also: `how-a-gem-is-graded.md` (the per-line `D` scoring this builds on) and the
full bake reference in `../METHODOLOGY.md`.*
