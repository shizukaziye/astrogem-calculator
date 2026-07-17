# OCR evaluation samples

This folder holds the A/B test set for the Advisor's screenshot-reading engines
(structural, Tesseract.js legacy, Workers AI). The harness is `tools/eval-ocr.js`.

> **Status: 3 real samples (2026-07-16).** `turn1/turn2/turn3-epic-c9-chaos` are three
> consecutive turns of one real epic cost-9 chaos cut, captured at two different
> resolutions on purpose (1143×1269 webp, 1183×1278 png) so a parser can't get away with
> hardcoded pixel offsets.
>
> **Corpus status (2026-07-17): 50 real screenshots** — the 3 dev shots + the station
> frame + 46 lower-resolution (~713×768) captures across 6 full cuts: rare + epic,
> Corrosion (cost 8) + Distortion (cost 9), all six effects except the two Order-gem
> exclusives, lowers (▼), do-nothing ("Processing State Maintained"), Cost ±100% (incl.
> a persistent 1,800 footer), reroll pill states 2/2·1/2·1/1 and the gold **Charge**
> button (free rerolls spent), View Other Items +1/+2, and chat-line noise.
>
> | engine | headline (per-field avg) | scalar fields | outcomes | whole-parse | flag-coverage |
> |--------|-------------------------|---------------|----------|-------------|---------------|
> | **structural** (free tier) | **88.1%** | 88.7% | 81.5% | 17/50 | 94.4% |
>
> Arc, for honesty: the engine scored **100% on the 3-shot dev corpus it was tuned on,
> then 65.3% cold** on this unseen corpus; targeted calibration (2× upscale for small
> panels, red lower-amounts, Charge/Maintained/+2 vocab, anchor-relative + self-locating
> text reads, footer read voting) brought it to 88.1%. The ≥95% FREE ship gate is NOT
> yet met — dominant remaining misses are the points-header digit at low res (orderLevel
> 74%) and Process (x/N) digit quality (currentTurn 76%). **Flag-coverage is the safety
> net**: ~94% of wrong fields carry confidence < 0.8 and pulse "confirm me" in the UI.
> The 3 dev shots still parse 3/3 whole.
>
> **Why Tesseract alone was abandoned:** it reads the plain-background footer perfectly
> (`Process (x/N)`, cost, balance = 100%) and fails on everything drawn over the nebula
> art: the gem name comes back as `€haos Astrogém: Distortion`, stats as `Villpowesr` /
> `ossiDamages'`, and the `▲` glyph as `A`, so `Lv. 2 ▲` becomes `Lv. 20A` and `+2`
> vanishes entirely. Mean confidence 41–44%. The structural engine keeps Tesseract only
> for chroma-masked micro-crops at known coordinates and derives everything positional
> from the wheel geometry + color science (see `ocr/structural-engine.js` header).
>
> Notable structural findings baked into the engine, all measured on these samples:
> wheel level text sits INSIDE each diamond (W/E say "Lv. N", N/S show a bare digit);
> the S diamond is gold so its digit is unrecoverable by color — the header
> "N Astrogem Points" line-sum solves it arithmetically; caption amounts render
> CHARTREUSE (h≈70–90), a different pigment from wheel gold (h≈50); the ▲/▼ arrow must
> be classified in a small box at the amount line's right end AND the icon's own hue
> family discounted (a red willpower face out-counts a real green ▲ otherwise).

## File format

Add **matching pairs**, one per screenshot:

```
samples/<name>.png      # the screenshot (also .jpg/.jpeg/.webp)
samples/<name>.json     # the hand-checked ground truth for that screenshot
```

The image must be a Lost Ark **Processing** (gem-cutting) window showing the gem
name, the four stat diamonds (Willpower / Order / the two side effects), the
"One of the following is randomly applied" outcome list, and the footer with the
`Process (x/N)` counter and processing cost. A full-window capture works best.

### Ground-truth JSON

Fill in exactly what the screenshot shows. Levels are 1–5; the four outcomes are the
four lines in the "randomly applied" list. Example:

```json
{
  "config": {
    "baseCost": 10,
    "gemType": "order",
    "willpowerLevel": 3,
    "orderLevel": 4,
    "effect1": "Boss Damage",
    "effect1Level": 2,
    "effect2": "Additional Damage",
    "effect2Level": 1
  },
  "state": {
    "currentTurn": 4,
    "maxTurns": 9,
    "rerollsRemaining": 2,
    "processCost": 900,
    "processCostMultiplier": 0,
    "totalGoldSpent": 2700,
    "rosterBound": false
  },
  "outcomes": [
    { "type": "raise_effect", "target": "willpower", "amount": 1 },
    { "type": "raise_effect", "target": "effect1", "amount": 2 },
    { "type": "change_side_option", "target": "effect2" },
    { "type": "change_gold_cost", "change": -100 }
  ]
}
```

### Field reference

**config**
| field | values |
|-------|--------|
| `baseCost` | `8`, `9`, or `10` |
| `gemType` | `"order"` or `"chaos"` |
| `willpowerLevel`, `orderLevel`, `effect1Level`, `effect2Level` | `1`–`5` |
| `effect1`, `effect2` | one of `"Attack Power"`, `"Additional Damage"`, `"Boss Damage"`, `"Brand Power"`, `"Ally Damage Enh."`, `"Ally Attack Enh."` — must be valid for the base cost and must differ |

Base-cost effect pools: 8 → {Additional Damage, Attack Power, Brand Power, Ally
Damage Enh.}; 9 → {Boss Damage, Attack Power, Ally Damage Enh., Ally Attack Enh.};
10 → {Boss Damage, Additional Damage, Brand Power, Ally Attack Enh.}.

**state**
| field | values |
|-------|--------|
| `maxTurns` | `5` (uncommon), `7` (rare), `9` (epic) |
| `currentTurn` | `1`–`maxTurns`. The footer shows `Process (x/N)`: x = attempts remaining, so `currentTurn = N − x + 1`. |
| `rerollsRemaining` | `0`–maxRerolls (1/2/3 for uncommon/rare/epic). On turn 1 this is the full allotment. |
| `processCost` | gold shown, e.g. `900`. `processCostMultiplier` is `-100`, `0`, or `100` (the cost is `900 × (1 + mult/100)`). |
| `totalGoldSpent` | gold spent so far (optional; not OCR-able, set if you know it) |
| `rosterBound` | `true`/`false` (roster-bound gems cost no gold to process) |

**outcomes** — exactly 4, each one of:
| shape | meaning |
|-------|---------|
| `{ "type": "raise_effect", "target": "willpower"\|"order"\|"effect1"\|"effect2", "amount": 1-4 }` | a `+` to that stat |
| `{ "type": "lower_effect", "target": ..., "amount": 1-4 }` | a `−` to that stat |
| `{ "type": "change_side_option", "target": "effect1"\|"effect2" }` | re-rolls that side effect |
| `{ "type": "change_gold_cost", "change": 100\|-100 }` | processing cost +/- 100% |
| `{ "type": "reroll_increase", "change": 1\|2 }` | grants extra rerolls |
| `{ "type": "do_nothing" }` | the "—" / maintain option |

Outcome order does **not** matter for scoring — the harness matches them as an
unordered set.

## Running

```bash
node tools/eval-ocr.js                 # score every engine that can run locally
node tools/eval-ocr.js --engines=tesseract
WORKER_URL=https://astrogem-vision.<sub>.workers.dev node tools/eval-ocr.js
# or:  node tools/eval-ocr.js --worker-url=https://...
```

The harness prints per-sample and per-field accuracy for each engine, plus an
unordered-set score for the 4 outcomes.

## Honest caveats

- **Tesseract in Node** runs full-frame OCR through the same parser + `constraintSnap`
  the browser uses, but it **cannot** do the regional `<canvas>` cropping the browser
  engine does, so its Node scores are a **conservative lower bound** on real
  in-browser accuracy. Treat them as a floor, not the final word.
- **Workers AI** can only be scored against a **deployed** Worker (see
  `worker/README.md`); without a URL it is skipped.
- The constants/effect pools are read from `model/astrogem.js`, so this set stays in
  sync if the model's pools ever change.

`.gitignore` note: large screenshots can be committed if you want them in the repo,
or kept local. The harness only needs the pairs to exist on disk at run time.
