# How the Leaderboard Ranks Characters

The **Leaderboard** tab ranks every cached character. It has a **DPS / Support**
toggle that switches the whole board between two scoring axes. This doc covers
exactly what it sorts by, the two numbers each row shows, and the rules for who
appears. The underlying gem math is in *how-a-gem-is-graded.md* — this is the
roll-up to a whole character and the ordering.

---

## 1. The two numbers per character

Each character contributes its valid gems to two independent figures (`leaderboard.js`):

### Total damage % — *the ranking basis*

This is what the board **sorts by** (descending). It's the whole-grid lvl-0
multiplicative total from *how-a-gem-is-graded.md §9*:

- **DPS board:** `totalDmg = gridDamage(gems, "dps")` — the real % damage the grid
  adds over no grid (effects accumulate into diminishing stat buckets; order is
  per-core with the 17-point floor, 6 cores multiplying). Typically ~10%, up to ~14%
  for the best grids.
- **Support board:** `partyDmg = gridDamage(gems, "support")` — the same shape on
  the support axis. It is already the **per-ally** party damage: the support
  coefficients in the model are stored per-DPS (÷3), so no extra division happens
  here (the ×3 party benefit exists only at the pipeline's gold step).

### Avg grade — *the quality column*

A 0–100 **quality** grade (shown as a rank badge), computed so that **equivalent
builds tie regardless of which gem sits in which core**. It is the *geometric mean*
of the gems' values, mapped onto the global grade scale:

```
avgGrade = valueToGrade( exp( gridQuality(gems, axis) / nGems ) )
         = grade-equivalent of the geometric-mean gem value
```

where `gridQuality = Σ ln(gemValue)` (see §10 of the grading doc). Because it's built
from a sum of logs, swapping gems between cores never changes it. It is **separate
from the total damage** — total damage is "how much does the grid do," avg grade is
"how clean is the build."

> Two characters can have the same total damage but different avg grades (e.g. one
> reached it with a few great gems + filler, the other with uniformly good gems), and
> the board ranks by **total damage**, not avg grade.

---

## 2. The DPS / Support toggle

| | **DPS board** (default) | **Support board** |
|---|---|---|
| Who's listed | every character… (minus "support mains", §4) | **only** the 4 support classes: Bard, Paladin, Artist, Valkyrie |
| Sorted by | `gridDamage(dps)` | `gridDamage(support)` (already per-ally) |
| Damage column | Total dmg % | Party dmg % |
| Avg-grade axis | DPS `gemValue` | support `supportValue` |
| Theme | pink/magenta accent | cyan/blue accent |

The support board keeps **every** support-class character (even a DPS-built one) and
ranks them by their support build.

---

## 3. No grade floor — every graded character shows

Both boards are **floorless**: a character appears at *any* grade (F-tier included),
not just B− and above. The full board is paginated (100/row pages); the name search
finds **any** character by name at any grade, showing its true overall rank. The only
rows dropped are characters with no gradeable gems and, on the DPS board, the
"support mains" of §4.

---

## 4. The DPS board drops "support mains"

A support-class player (Bard/Paladin/etc.) graded on the **DPS** axis looks terrible —
their support gems aren't DPS gems. Listing those throwaway DPS builds would just
clutter the DPS board. So the DPS board **hides a character iff:**

> it is a **support class** *and* its **support build outranks its DPS build by ≥ 2
> sub-ranks**.

"Sub-ranks" are the `−` / plain / `+` thirds of every letter, numbered consecutively:

```
F− F  F+ D− D  D+ C− C  C+ B− B  B+ A− A  A+ S− S  S+
 0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17
```

So **B− (9) → B+ (11) is a gap of 2.** A character whose support grade is ≥ 2 sub-ranks
above its DPS grade (e.g. *B− DPS but B+ support*) is treated as a genuine support main
and **moved to the Support board instead**. A support within 1 sub-rank, or whose DPS
is as good or better, **stays on both boards** (`isSupportMain` in `leaderboard.js`).

This is build-and-class based: a DPS class never gets dropped (its support build is
always far below its DPS build), and a support player who actually built DPS stays on
the DPS board.

---

## 5. What a row reflects

A character's gems are pulled from lostark.bible (cached server-side) and the board is
rebuilt from that snapshot. "Valid gems" are the equipped, parseable gems; a character
with no valid gems shows "—" and doesn't rank. The total damage and avg grade both
recompute live whenever you flip the DPS/Support toggle or filter by class/region.

---

*See also: `how-a-gem-is-graded.md` for `gridDamage`, `gemValue`, `gridQuality`, and
the rank cutoffs this page builds on.*
