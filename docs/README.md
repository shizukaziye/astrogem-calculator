# Astrogem Calculator — Docs

Deep-dive documentation for the Lost Ark **astrogem** tool. These cover the **math and
game mechanics** behind each tab so you can get full context here instead of reading
through the code. Most cover the **math**; the lookup-queue / drain / rate-control **plumbing**
has its own doc — see *Operations* below.

## The math docs

| Doc | What it explains |
|---|---|
| **[how-a-gem-is-graded.md](how-a-gem-is-graded.md)** | The whole scoring model: multiplicative damage in log space, the stat baselines and per-line `D` values, the willpower multiplier that makes perfect gems tie, the 0–100 grade + letter ranks, the support axis, and the lvl-0 whole-grid "% total damage". **Start here** — the other docs build on it. |
| **[how-the-pipeline-tables-are-computed.md](how-the-pipeline-tables-are-computed.md)** | The cut / fuse / throw decision per effect-pair archetype: the exact Bellman DP cut value, the fusion fixed-point EV, the verdict colors, and the weekly-throughput model. (Full bake reference: [`../METHODOLOGY.md`](../METHODOLOGY.md).) |
| **[how-the-leaderboard-ranks.md](how-the-leaderboard-ranks.md)** | How a whole character is ranked: total damage % (the sort key), the pairing-invariant avg-grade, the DPS/Support toggle, the floorless boards, and the "support main" exclusion. |
| **[how-the-advisor-works.md](how-the-advisor-works.md)** | The Advisor end to end: the structural screenshot parser (anchor geometry → normalization → graded evidence → constraint arbitration → honest confidence), the exact-DP action ranking incl. Reset, the collection flywheel, and the debugging methodology that got the parser to 99%+. |

## Operations / infrastructure

| Doc | What it explains |
|---|---|
| **[how-the-queue-and-drain-work.md](how-the-queue-and-drain-work.md)** | The "pull from lostark.bible" plumbing: the lookup queue (premium/free lanes), the every-minute drain, the run/off/probe modes + circuit breaker, the enqueue-kick that caches a fresh character in ~2s (and the KV-list-consistency bug behind it), every edge rate-limit layer, the admin page, and the full endpoint / KV-key / constant reference. |

## The four tabs (quick map)

- **Grader** — paste a character (pulled from lostark.bible) or enter a gem by hand; get
  each gem's 0–100 grade + rank and the loadout's total % damage. Math:
  *how-a-gem-is-graded.md*.
- **Pipeline** — the cut/fuse/throw strategy tables, color-coded by gold value, for any
  gold-per-damage and baseline. Math: *how-the-pipeline-tables-are-computed.md*.
- **Advisor** — share your game screen or drop a screenshot; the structural parser
  reads the gem state (99%+ per-field, every uncertain field flagged for one-tap
  confirmation), advice runs automatically, and the exact Bellman DP ranks
  Process / Reroll / Complete / Reset — including the per-pair reset-value table
  when reset is live. Corrected readings feed a collection flywheel that grows the
  training corpus. Math + parsing: *how-the-advisor-works.md*.
- **Leaderboard** — every cached character ranked by total damage, with a DPS/Support
  toggle. Math: *how-the-leaderboard-ranks.md*.

## The model core

All scoring lives in **`model/astrogem.js`** (a pure, dependency-free module) with a
Python mirror **`model/astrogem.py`** kept in lockstep — `verify.js` / `verify.py`
assert they match against a captured reference battery (`refs.json`). The exact Bellman
DP is `model/dp.js`. Every assumption (the stat baselines, the willpower ratio, the
rank cutoffs) is a named constant in one place so it stays visible and editable.
