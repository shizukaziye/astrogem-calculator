# How a Gem Is Graded

This explains, in full, the math behind the **Grader** tab — how a single astrogem
gets a 0–100 grade and a letter rank, and how a whole 6-core grid rolls up into a
"% total damage" number. Everything here is implemented in `model/astrogem.js`
(mirrored in `model/astrogem.py`); this doc is the *why* behind those functions.

---

## 1. The game pieces

An **astrogem** sits in one of a character's **6 cores** (Order Sun/Moon/Star,
Chaos Sun/Moon/Star). Each gem has:

| Property | Range | What it does |
|---|---|---|
| **Base cost** | 8, 9, or 10 | The gem's intrinsic cost. Determines the **side-effect pool** (below). |
| **Willpower** (`willpowerLevel`) | 1–5 | **Reduces** the gem's cost: `effectiveCost = baseCost − willpowerLevel`. More willpower = cheaper = better. |
| **Order/Chaos** (`orderLevel`) | 1–5 | Core points. The headline damage stat (every gem can roll it). |
| **Side effect 1 & 2** | from the pool, level 1–5 each | Two stat lines drawn from the gem's base-cost pool. |

The **side-effect pool depends on base cost** (`EFFECT_POOLS`):

| Base cost | Effect pool |
|---|---|
| **8** | Additional Damage · Attack Power · Brand Power · Ally Damage Enh. |
| **9** | Boss Damage · Attack Power · Ally Damage Enh. · Ally Attack Enh. |
| **10** | Boss Damage · Additional Damage · Brand Power · Ally Attack Enh. |

For a **DPS** gem only three of these lines are damage: **Attack Power, Additional
Damage, Boss Damage**. Brand Power / Ally Damage Enh. / Ally Attack Enh. are
*support* lines and contribute **zero** to a DPS grade (and the other way round for support).

The sum `willpower + order + effect1 + effect2` (each 1–5, so 4–20) also sets the
finished-gem **tier**, which only matters for fusion fodder:

| Tier | level-sum |
|---|---|
| Legendary | 4–15 |
| Relic | 16–18 |
| Ancient | 19–20 |

---

## 2. The one assumption everything rests on: **damage is multiplicative**

In Lost Ark your damage multipliers stack *multiplicatively*, not additively. If
one source gives +10% and another +10%, you have ×1.1 × ×1.1 = ×1.21, not +20%.

That single fact drives the whole model. To make multiplicative things **add up**
(so we can score, sum, and compare), we work in **log space**. We measure every
contribution as

> **D = 100 · ln(multiplier)**

Because `ln(a·b) = ln(a) + ln(b)`, multiplicative damage becomes **additive** in D.
D is in "≈ % damage" units: for small contributions `D ≈ %`, and a total D converts
back to real damage with `damage% = (e^(D/100) − 1) · 100`.

This is the key to everything below: **a gem's value is the sum of its lines' D,
and a character's value is built by adding D in log space.**

---

## 3. Where the per-line numbers come from (the baselines)

A stat line (say Attack Power) is only worth what it multiplies. Each damage stat
is modeled as a bucket with two pieces of context (`STAT_BASELINES`):

| Stat | `other` (from gear, outside the grid) | `gridAdd` (a full lvl-30 grid adds) |
|---|---|---|
| **Attack Power** | 0.121 (12.1%) | 0.011 (1.1%) |
| **Additional Damage** | 0.336 (33.6%) | 0.0242 (2.42%) |
| **Boss Damage** | 0.0 | 0.025 (2.5%) |
| **Order/Chaos** | — | flat ×1.0016 per point |

`other` is how much of that stat you already have from gear; `gridAdd` is how much a
**fully-leveled grid** contributes on top. These are the empirical anchors — change
them and every number downstream moves, which is why they live in one place.

### Per-gem yardstick: the lvl-30 marginal

A *single* gem can't see the rest of your grid, so it's graded against a fixed
yardstick: **how much one more level of this stat is worth, on top of an already-full
lvl-30 grid.** That marginal multiplier is

> `D_perLevel = 100 · ln( (1 + other + gridAdd + gridAdd/30) / (1 + other + gridAdd) )`

Plugging in the baselines gives the exact per-line values used for grading:

| Line | D per level | Note |
|---|---:|---|
| **Attack Power** | **0.03239** | small (you already have lots of attack from gear) |
| **Additional Damage** | **0.05929** | |
| **Boss Damage** | **0.08127** | biggest per level (0% from gear → least diluted) |
| **Order/Chaos** | **0.15987** | `100·ln(1.0016)` per point — the headline stat |
| **Willpower** | **0.07773** | per cost-level; see §5 |

So a Boss Damage line is worth ~2.5× an Attack Power line *per level* — purely
because you start with 0% boss damage from gear but 12.1% attack, so the grid's
contribution is far less diluted for boss.

---

## 4. A gem's raw damage

`gemDamage` is just the sum of the gem's damage lines in D:

```
gemDamage = effectScore(effect1) + effectScore(effect2) + orderScore(order)
```

where `effectScore(line, level) = level × D_line` (and = 0 for non-DPS lines), and
`orderScore(level) = level × 0.15987`.

Willpower is deliberately **not** in `gemDamage` — willpower isn't damage, it's
*efficiency* (a cheaper gem of the same damage is strictly better). It enters as a
multiplier next.

---

## 5. Willpower → a multiplier that makes "perfect" gems tie

Willpower reduces effective cost (`effectiveCost = baseCost − willpowerLevel`), and a
cheaper gem is better. We model that as a **quality multiplier `M(effectiveCost)`**
on the gem's damage.

The calibration target: **a perfect gem of every base cost should grade 100.** A
perfect gem is willpower 5, order 5, top-two effects at level 5. Its effective cost
is `baseCost − 5`, i.e. **3 (from base 8), 4 (base 9), or 5 (base 10)**. Their raw
damages differ (different pools), so `M` is chosen to make their *values* identical:

```
M(5) = 1
M(4) = Dperfect(base10) / Dperfect(base9)   ≈ 1.09835
M(3) = Dperfect(base10) / Dperfect(base8)   ≈ 1.19433
```

For effective cost **6+** (a high-base-cost gem with poor willpower) `M` continues
**linearly** at the cost-4→5 slope, punishing low willpower hard:

| effective cost | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
|---|---:|---:|---:|---:|---:|---:|---:|
| **M** | 1.194 | 1.098 | 1.000 | 0.902 | 0.803 | 0.705 | 0.607 |

`M` is **computed from the perfect-gem damages**, so if you ever change the effect
weights, the willpower curve re-derives itself and the "perfect gems tie" property
holds automatically. (The 4.25 figure used as a neutral baseline elsewhere is just a
non-integer cost; `M` interpolates linearly between integer costs.)

### The grading value

```
gemValue = gemDamage × M(effectiveCost)
```

This is the single quantity a gem is graded on. By construction, **every perfect
gem — cost 3, 4, or 5 — has the exact same `gemValue ≈ 1.50214`.**

---

## 6. From value to a 0–100 grade and a letter rank

The grade is a **global** linear normalization of `gemValue` (the same scale for all
base costs, since perfect gems already tie):

```
grade = 100 × (gemValue − minValue) / (maxValue − minValue)
```

where `minValue ≈ 0.09698` and `maxValue ≈ 1.50214` are the worst and best possible
gems over *every* (cost, willpower, order, effect-pair, levels) combination. So:

- **grade 100** = a perfect gem of its type;
- **grade 0** = the worst legal gem;
- two builds with the same `gemValue` always read the same grade, regardless of base cost.

The letter rank splits the 0–100 line at user-chosen cutoffs (`RANK_CUTS`), and each
band is split into `−` / plain / `+` thirds:

| Rank | grade ≥ |
|---|---:|
| **S** | 85 |
| **A** | 70 |
| **B** | 55 |
| **C** | 40 |
| **D** | 20 |
| **F** | 0 |

e.g. grade 55–60 = `B−`, 60–65 = `B`, 65–70 = `B+`. (These thirds are what the
leaderboard's "support main" rule counts — see *how-the-leaderboard-ranks.md*.)

---

## 7. Order / Chaos in detail

Order/Chaos is the one line every gem rolls, and it's the strongest (0.15987 D per
point). For **per-gem grading** it's flat: `orderScore = orderLevel × 0.15987`.

In the **whole-grid total** (§9) it behaves differently: it's evaluated **per core**
with a **17-point floor**. A core needs ~17 order points before it starts paying
out, and only points above 17 count. With 6 gems × ~4.25 points that floor models
"the grid needs to be mostly built before order does much," and it's why a perfect
maxed grid's order contribution is ~2.9%, not a runaway number.

---

## 8. Support gems — the parallel axis

Support classes (Bard, Paladin, Artist, Valkyrie) don't deal damage; they buff the
party. There's a complete **parallel scoring axis** with the same structure but
support coefficients (`SUPPORT_SCORING`). The damage lines flip: **Ally Attack Enh.,
Brand Power, Ally Damage Enh.** are the "damage" lines; Attack/Additional/Boss → 0.

A support gem buffs all 3 DPS in the party, so its *raw* party value is ~3× a single
DPS buff. To keep per-gem grades and the leaderboard on a comparable per-character
scale, every support coefficient is stored **÷3** (the ×3 party benefit is reapplied
only at the gold step, `SUPPORT_GPD_MULTIPLIER = 3`):

| Support line | per-level value (per-DPS) |
|---|---:|
| Ally Attack Enh. | 0.0596 / 3 |
| Brand Power | 0.0434 / 3 |
| Ally Damage Enh. | 0.0195 / 3 |
| Order/Chaos (avg) | 0.0747 / 3 = 0.0249 |
| Willpower | **(2/3)** × the DPS willpower contribution |

**Per-core order values.** Unlike DPS, a support gem's order points are worth
different amounts by core, because each core grants a different party buff. A
*standalone* support gem grade uses the average (0.0747/3); the *whole grid* uses
the per-core value (`SUPPORT_ORDER_PER_CORE`, base values shown, stored ÷3):

| Core | Buff it grants | per-point value (base) |
|---|---|---:|
| Order Sun | Ally Attack | 0.0694 |
| Order Moon | Ally Damage | 0.0640 |
| Order Star | Serenade | 0.0486 |
| Chaos Sun | Ally Damage | 0.0753 |
| **Chaos Moon** | **Brand (strongest)** | **0.1044** |
| Chaos Star | Weapon Power | 0.0869 |

So a support point in Chaos Moon (Brand) is worth ~2.1× one in Order Star.

Everything else (the willpower multiplier, the global grade normalization, the
ranks) works identically — just with `supportValue` instead of `gemValue`. The
Grader's **DPS / Support toggle** picks which axis a loadout is judged on; it
auto-defaults to Support for support classes.

---

## 9. The whole-character total — "% total damage"

A single gem is graded against the lvl-30 marginal yardstick (§3). But the **grid as
a whole** is judged differently: *how much real damage does the entire 6-core grid
add over having no grid at all?* This is the number on the leaderboard and the
"Total % dmg" line in the grader.

It's a **level-0 multiplicative** model (`gridDamage`):

1. **Effects accumulate into stat buckets.** Sum every gem's Attack/Additional/Boss
   levels into three totals. Each bucket is then a multiplicative gain over your
   *other gear*:

   > `D_bucket = 100 · ln( (1 + other + levelSum × gridAdd/30) / (1 + other) )`

   Because of the `ln`, two gems of the same stat give **diminishing returns** — the
   second level of Boss Damage is worth slightly less than the first. This is the big
   difference from per-gem grading (which can't see the rest of the grid).

2. **Order/Chaos is per-core with the 17-point floor.** For each core, add up its
   gems' order points, then

   > `D_core = 100 · ln(1 + 0.0016 × max(0, points − 17))`

   and the **6 cores multiply** (their D add). A fully-maxed grid lands around
   `1.0048⁶ ≈ +2.9%` from order — diminishing returns and the floor fall out of the
   math, no special-casing.

3. Total `gridDamage = ΣD_bucket + ΣD_core` (×100), then displayed as a damage %.

The support total (`supportGridDamage`) is the same shape: support **effects stay
linear** (the party per-level values are flat in this model — no bucket diminishing),
and order is the per-core 17-floor form with each core's own rate. The UI shows it
**÷3** ("per-ally party %").

> **Important:** per-gem grades use the lvl-30 *marginal* yardstick, while the grid
> total uses the lvl-0 *cumulative* model with diminishing returns. So **the per-gem
> numbers do not sum to the grid total — by design.** A gem's grade answers "how good
> is this gem?"; the total answers "how much does my whole grid do?"

---

## 10. Grid quality (the leaderboard's "avg grade")

Separately from raw damage, a grid has a **quality** score that's *pairing-invariant*
— two builds with the same set of gems tie regardless of which gem sits in which core:

```
gridQuality = Σ ln(gemValue)     (sum over the grid's gems; supportValue for support)
```

Because it's a sum of logs (= log of the product of values), swapping gems between
cores doesn't change it, and the per-gem grades roll straight up into it. The
leaderboard shows this as the **average grade** (rank), separate from the **total
damage %**.

---

## 11. Quick worked example

A cost-10 gem, willpower 5 (→ effective cost 5), order 5, Boss Damage 5, Additional
Damage 5:

- `gemDamage = 5·0.08127 (boss) + 5·0.05929 (add) + 5·0.15987 (order) = 1.50214`
- `effectiveCost = 10 − 5 = 5` → `M(5) = 1`
- `gemValue = 1.50214 × 1 = 1.50214` → the maximum → **grade 100, rank S+**

Drop willpower to 1 (effective cost 9): `M(9) = 0.607`, so
`gemValue = 1.50214 × 0.607 ≈ 0.911` → grade ≈ 58 → **B−**. Same damage lines, much
worse gem, because the cost is far higher.

---

*See also: `how-the-pipeline-tables-are-computed.md` (cut/fuse/throw EV) and
`how-the-leaderboard-ranks.md` (ranking + the support-main rule).*
