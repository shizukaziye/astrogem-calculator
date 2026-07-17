# How the Pipeline Tables Are Computed

The **Pipeline** tab answers one question for every kind of gem that can drop:
**should I cut it, fuse it, or throw it away?** This doc explains the math behind
those cut/fuse/throw verdicts and the weekly-throughput columns.

> The exhaustive bake reference (the keyed JSON schema, the regenerate commands, the
> superseded-models history, and the uniform-vs-sampled distribution decision) lives
> in **`../METHODOLOGY.md`** — this doc is the conceptual walkthrough. Both axes are
> baked on the multiplicative `gemValue`/`supportValue` model (2026-06-27); the
> exact numbers come from `data/pipeline.json` (+ `…-support.json`).

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
directValue = max(0, (gemValue − baseline) × goldPerDamage)
```

- **`gemValue`** = the gem's grading value (damage `D` × the willpower multiplier,
  from *how-a-gem-is-graded.md*), in ≈%-damage units.
- **`baseline`** = the bar set by the weakest gem you'd replace — entered as a
  **0–100 grade** and converted to this scale by `gradeToScore` (the inverse of the
  global value grade). The bake evaluates exactly the twelve grade rows the tab
  shows (C-…S+, grades 40–95).
- **`goldPerDamage`** = how much a 1%-damage upgrade is worth to you in gold (for
  support gems the ×3 party benefit is applied here).

A gem **below baseline isn't a keeper** — it becomes **fodder**, valued only through
fusion (§5).

> **One scale everywhere (since the 2026-06-27 rebake).** Per-gem grading and the
> pipeline's whole EV layer use the same *multiplicative* `gemValue` model (perfect
> gems of every cost tie at grade 100 — see the grading doc); the support bake uses
> `supportValue` the same way. The older *additive* `score` survives only as the
> grader's raw %-damage readout, not as a value metric.

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

Because a fused output can itself be kept or re-fused, the expected values are
**coupled** — and the real recipes (`3L`, `1R+2L`, `1A+2L`) couple the **base
costs** too: the two legendaries in a relic/ancient fuse are free surplus that can
be steered to whichever cost has the most valuable output. So the core solves one
**joint 9-variable fixed point** (3 tiers × 3 costs, `tierExpectedValue` /
`_solveJointEV`) by iteration:

```
E[T_c] = directExp[T_c] + P(below baseline in T_c) · max(0, fodder[T_c])
```

`directExp[T_c]` is the expected direct value of a random tier-`T` gem at cost `c`
that clears baseline; `fodder[T_c]` is the per-input value of that tier's fusion
recipe — e.g. relic fodder is `(1/3)·G(c) + (2/3)·max_c G(c) − 500` where `G(c)`
is the `1R+2L` output EV at cost `c` and the `max_c` term is the steered surplus
(METHODOLOGY §4 has the full formulas). The per-gem **fusion value** of a fodder
tier is that `fodder[T_c]`, clamped ≥ 0 (`fusionValueForTier`).

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
| 🟩 **Green** | cut ≥ the reset threshold (20k) | **Worth resetting** if it lands below baseline (pay the 20k reset, one more try). Marked `↻`. |
| 🟨 **Yellow** (4-shade ramp) | cut > 0 | **Cut, don't reset.** Dimmer = lower value (10k–reset / 5–10k / 1–5k / <1k). |
| 🟥 **Red** | cut ≤ 0 | **Don't cut** — worthless at this baseline. |
| 🟪 **Purple** | **block-level:** pre-cut *rarity-upgrade* fusion beats opening the gems | **Fuse before cutting** — upgrading 3-into-1 nets more than opening them individually. Marked `⚜`. |

**Roster-bound (RB)** gems are free to cut, so their section shows the cut value + odds
only (no pipeline lane, no purple — you always cut a free gem). The green/reset
threshold and reset cost are `RESET_THRESHOLD` / `RESET_COST` (both 20k) in
`pipeline.js`'s editable `CONST` block; the yellow bands match the baked
`meta.verdict` (whose legacy `green: 18000` the `CONST` value overrides).

---

## 7. The weekly-economy group ("Time to Complete 24")

A full economic loop layered on the baked DP cut values, computed client-side by
`pipeline.js` from the editable **`CONST` block** at the top of that file — no
re-bake needed to retune it:

- **Income**: daily NRB gem drops (UC 4.4 / Rare 0.9 / Epic 0.4 per day, ×7) plus
  **box buy decisions** — a box type is bought (up to its weekly cap) iff its
  box-gem EV beats its cost (vendor 1,185 g ≤10/wk; mat ≈1,636 g ≤20/wk; epic
  43,000 g ≤1/wk; boxes roll 80/15/5 UC/Rare/Epic and 60/30/10 cost 8/9/10).
- **Processing**: every gem is cut at its bucket's DP policy. A *finished*
  below-baseline gem is **reset** (pay 20k, one more try) when its cut-EV ≥ the
  20k reset threshold; a weak block can be **fused pre-cut** into a rarity
  upgrade when that beats opening it (the purple verdict).
- **Fodder**: post-cut below-baseline gems fuse in priority `A+2L → R+2L → 3L`.
- **Outputs**: **Weeks = 24 / (Direct/wk + Fuse/wk)** (green ≤8 / amber 8–26 /
  red >26), net **Gold/wk** for the whole loop, and **cp%** — the combat-power
  gain once all 24 slots clear the baseline: `1.3·(1 + Total%dmg/100) − 1` with
  `Total%dmg = 24 × (avgScore − baseline)`. `avgScore` weights each kept
  archetype's conditional score-when-above (a gpd-stable offline exact-DP solve,
  `COND_SCORE`) by the per-gpd `P(above)` read live from the baked cells.

The collector still bakes the *original, simpler* throughput reconstruction
(`CUTS_PER_WEEK`, `FRESH_BUCKET_MIX`, `BOX_SCHEDULE` → the JSON's `thru` block,
METHODOLOGY §6), but the tab renders the `CONST` model above. Neither affects the
per-bucket DP verdicts.

---

## 8. Everything rendered is baked (no live mode, no interpolation)

A single epic DP cell is ~3 s, far too slow to recompute on input changes. So the
collector **bakes** the full grid of exact DP values — 3 rarities × 3 costs × 4
buckets × **8 gold-per-damage tiers** × **12 grade baselines** × NRB/RB — into
`data/pipeline.json` (and `…-support.json` for the support axis), and the tab
renders those values by **direct key lookup**: one clickable gpd tier at a time,
one row per baked grade. Exact and instant. The old arbitrary-baseline "live"
mode (a bilinear interpolation of baked anchors) is gone — every number shown is
an exact DP solve.

---

*See also: `how-a-gem-is-graded.md` (the per-line `D` scoring this builds on) and the
full bake reference in `../METHODOLOGY.md`.*
