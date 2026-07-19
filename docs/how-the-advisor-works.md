# How the Advisor Reads and Decides

The Advisor tab does two hard things: it **reads** the live Lost Ark Processing
screen into an exact game state, and it **decides** the optimal action with the
same Bellman DP that bakes the Pipeline tables. This doc is the full strategy for
both — especially the parser, whose design was learned the hard way across ~30
measured iterations (93.5% → 99.5% on the core corpus in two days). Read this
before touching `ocr/structural-engine.js`.

---

## 1. The one-paragraph strategy

**Read structure and color first; use OCR last; let the game's own rules
arbitrate; never be confidently wrong.** The Processing window is a fixed-layout,
fixed-font, color-coded UI — almost nothing about it is "text in the wild." So
the parser anchors everything to geometry it can measure (the wheel's diamond
signature), normalizes every capture to one canonical scale, reads each element
with the strongest available *evidence channel* (pixel templates of the game's
own font, color masks, aspect ratios — OCR only where text sits on plain
background), and then lets hard game constraints (the points checksum, effect
pools, legal ranges) arbitrate between noisy reads. Every field carries an honest
confidence; anything under 0.8 pulses "confirm me" in the window. The measured
invariant that matters more than the accuracy number: **zero silent errors** —
on every corpus run, 100% of wrong fields are flagged.

## 2. The pipeline, stage by stage

```
raster ─▶ panel detect ─▶ fitWheel ─▶ normalize to CANON_GAP ─▶ per-element reads
                                                                    │
              constraint arbitration (checksum / pools / hints) ◀───┘
                                    │
                 constraintSnap ─▶ legal state + confidence map
```

### 2.1 Anchors: the red-over-gold diamond pair

`ocr/layout.js` finds the wheel by its one invariant signature: the red
(willpower) diamond directly above the gold (order/chaos) diamond. A downsampled
scan proposes candidates; `fitWheel` then fits ALL FOUR diamond faces using blob
**bounding-box centers** (symmetric under the holes the digits punch in the
faces) and cross-validates two independent rulers — the red↔gold vertical
distance vs. the W↔E horizontal distance ÷ 1.40 — keeping the coarse anchors if
they disagree by >8%. Every later coordinate is expressed in **gap units**
(gap = red→gold distance), which is what makes the parser resolution-independent.

*Why bbox centers and cross-validation:* four earlier generations of anchor
refinement (vertical scans, plateau detection, edge steps) each measured
net-negative — glow drags centroids, faces are plateaus. Only the two-ruler
cross-check survived contact with the corpus.

### 2.2 Normalization: one canonical scale

The capture is cropped to the panel (+6% margin sides/top, **+16% bottom** — the
panel-bounds detection can undershoot and once amputated the Process button
entirely; five "turn misreads" were actually a crop bug) and resampled so the
gap equals `CANON_GAP = 246`. Scale factors snap to coarse steps {0.5, 1, 2, 3}:
fractional factors like 1.99 interpolate every row and blur thin glyphs below
the chroma-mask thresholds (measured: a whole field dropped 50 points from this
alone).

### 2.3 Evidence channels, strongest first

Each element is read by the best channel available for it, with the others as
fallbacks — and the channel ORDER is measured, not aesthetic:

| element | primary channel | why |
|---|---|---|
| wheel levels (N/W/E) | glyph templates of the game's own font (bitmapSim commit, ink-IoU veto) | fixed font ⇒ pixel comparison beats OCR; the IoU veto kills '5'↔'3'-style sim ties |
| the S (order/chaos) digit | **saturation** mask (vivid pure yellow s≈0.9 on muted gold s≈0.5) | gold-on-gold defeats chroma AND luminance; saturation separates. Fed to the solver as a HINT, never pinned |
| points header | anchored positional read: recognize "Astrogem", the 1–2 boxes before the 'A' are digits BY CONSTRUCTION; ink-IoU within the FEASIBLE digit set | closed world beats open-world OCR; feasibility comes from committed levels + the S-hint |
| effect names | white-text mask excluding face-tinted specular (slot-aware: W is always green, E always blue) + fuzzed lexicon constrained to the cost's effect pool | the pool constraint kills whole classes of misreads |
| gem name → baseCost | n-gram-scored suffix match (never first-match-wins: "immutaBILITY" contains "staBILITY") + the pair→cost cross-check (some effect pairs exist in exactly one pool) | measured collision: Immutability read as cost-8 Stability whenever a pet covered the name |
| footer (Process x/N, cost) | plain-background OCR with a three-way vote (template digits / located line / footer block) + a last-resort rescue band | the footer is the one place OCR is genuinely strong |
| reroll pill / Charge | OCR + template+aspect verification; dim rescue at a 0.52 ink floor (between pill background ~0.47 and ink ~0.55); Charge word retried at v>0.32 | tiny dim text right at the OCR floor; the denominator is {1,2} so aspect alone decides it |
| outcome cells | icon hue self-calibrated against the same image's own W/E diamonds; chartreuse/red amount lines; grey cells get a dedicated dilated OCR pass; sign rules ("a '+' is fat and survives; the thin '−' is what drops") | icon colors follow the SLOT, not the effect — a fixed effect→color table would be wrong |
| degraded-tier levels & names (LAST rung) | **analysis-by-synthesis** (§2.6): pristine reference patches blurred to candidate degradations, correlated over a sub-pixel grid, dual-scored | the only classical method (of nine tried) that reads sub-10px digits; commits only on cross-channel agreement |

### 2.4 Constraint arbitration — the checksum solver

The four wheel levels MUST sum to the points header. The solver:

- **pins every committed read** (template or OCR, any confidence) — the
  constraint may FILL unread nodes and re-solve a sum mismatch, but it never
  overrides a value actually read (overriding low-conf-but-correct reads was a
  measured regression);
- fills a single unknown by arithmetic; enumerates ≥2 unknowns by template
  score, with the S-hint breaking otherwise-blind ties;
- treats checksum agreement as **corroboration, not proof**: confidence lifts
  are proportional to each read's own evidence (`conf + 0.25`, capped) — a flat
  boost once promoted a 0.52 near-guess to "confident" when a coordinated
  points+willpower misread happened to cohere;
- rejects a finished points read that is INFEASIBLE against committed levels +
  hint when ≥2 nodes are unknown (a blurred '15' read as '18' once forced the
  correct levels out of existence).

### 2.5 Honest confidence

`constraintSnap` (ocr/engine.js) turns the raw parse into a legal state and the
UI flags every field with confidence < **0.8**. The full constant table lives in
the code; the convention: ≥0.85 = independently corroborated, 0.75–0.8 =
single-channel but plausible (flagged), ≤0.72 = deliberately capped classes
(e.g. order/willpower outcome direction without a readable sign). Two systemic
guards: the browser OCR queue is **self-healing** (a dead Tesseract worker
resolves `{failed:true}`, is discarded, and ≥3 failures cap EVERY confidence at
0.5 with an explicit status — a poisoned promise chain once made dead-OCR parses
emit pool-guessed effects at 0.8 forever), and eval prints SILENT errors + flag
coverage on every run so the zero-silents invariant is re-verified continuously.

### 2.6 Analysis-by-synthesis — the degraded-tier rescue (2026-07-19)

When the template AND OCR ladders both fail on a level digit or an effect name,
the last rung fits the degradation instead of fighting it: pristine 32×32
reference patches (baked from native-tier labeled samples by
`tools/build-level-refs.js` into `ocr/level-refs.js`, gradient-energy
self-aligned, exemplars **stratified across resolution tiers**) are Gaussian-
blurred to candidate degradations and correlated against the observed patch over
a sub-pixel alignment grid — position itself becomes a fitted parameter when no
line locates (the wide scan). A value commits ONLY when raw-luminance and
gradient-magnitude scorings agree on the winner above a node-specific margin
floor (S = 0.015, others 0.01), and **overriding an existing read demands
gm ≥ 0.03** — asymmetric on purpose. Names get the same treatment at 48×16 plus
a purely structural rung first: fuzzy keyword × measured caption line-count ×
pool uniqueness ("jamage" on two lines in pool 9 ⇒ Ally Damage Enh., uniquely).

Eight classical method families failed before this one worked (masked templates,
pre-upscaled masks, greyscale OCR — which *hallucinates* — glyph NCC, reference
patches in three configurations, the joint board solve); their failure modes are
recorded in the error-review artifact. Three calibration knobs were tried,
caught regressing by the tribunal, and reverted (W↔E ref pooling produced the
only agreeing-wrong ever measured; sharpest-only exemplars traded fixes for
regressions; a flat 0.01 margin let a clean capture's gold agree-wrong at
exactly 0.010). **The tribunal is the method**: every knob passes the full eval
with the 55 clean captures untouched and zero silents, or it reverts.

## 3. The decision layer

`model/dp.js` ranks four actions from the parsed state (advisor.js calls
`evaluateActionsDP`; the nested-MC is the fallback):

- **Process** — expectation over the actual 4 drawn outcomes (branch-faithful:
  `change_side_option` fans uniformly over the pool).
- **Reroll** — a fresh draw at reroll−1. Illegal on turn 1 (the counter shows
  but the button is greyed until one process — a game rule learned by
  correction). Model rerolls = shown free + 1 while the paid Charge is unspent;
  counters STACK past the denominator (3/2, 5/2…).
- **Complete** — the gem's current value (turn 1 = dismantle = 0).
- **Reset** — last turn only: pay `COSTS.reset` (20,000g) for a fresh cut.
  Because a reset MAY re-roll the side effects, whenever Reset is live the DP
  also values a fresh cut for **every** effect pair the gem could land
  (`resetCombos`, C(4,2)=6 — same-class pairs are free via the class-keyed
  memo) and the UI renders the pair table with a disclaimer.

Advice runs **automatically after every successful parse**; only a MANUAL Get
advice click ships the collection record (auto-stored uncorrected parses would
flood the DB with unreviewed data).

## 4. The collection flywheel — and its one trap

Every manual Get advice ships {image, parse, final state, diff} to the
`astrogem-data` worker (KV). The capture is **cropped to `_srcPanel`** (native
panel pixels, pill/footer margins included — records run ~150KB) and the save is
**guaranteed**: an adaptive quality ladder keeps the payload provably inside the
worker's 12MB cap, the worker writes the record BEFORE the day counter, failures
return honest errors, and the client shows "✓ saved" / "⚠ NOT saved (why)" on
every attempt with automatic re-staging for retry. (A record once vanished
silently — oversized body + counter-first writes + a silent locked-gate discard;
each hole is closed and E2E-proven.) Collection is NOT password-gated — only the
AI verifier is; the worker's daily write cap is the quota guard.

Corrections are ground-truth labels…
**fallibly** so: a live correction once contradicted its own screenshot's
checksum (the parser had been right). The rules that follow:

1. `tools/pull-collected.js` fetches records; promote to `samples/` only after
   **checking the stored image** against the final state.
2. `tools/lint-labels.js` validates every label structurally (pools, ranges,
   outcome shapes, cost/multiplier coherence) and runs ahead of `eval-gate`.
3. When the parser and a label disagree, **the pixels get the final vote** — of
   five "failures" walked through with the owner on 2026-07-18, two were label
   errors (both times the parser had out-read the human).

## 5. The debugging methodology (how the 30 iterations actually went)

The process that worked, distilled — future sessions should start here:

1. **Instrument before theorizing.** Every wrong field gets a `_debug` dump of
   what the engine actually saw (masks, boxes, scores, OCR text) before any fix
   is designed. The three biggest wins of the project (the saturation S-digit,
   the crop amputating the button, the '15'→'18' feasibility gate) were all
   found by *looking at pixels/dumps*, not by reasoning about code.
2. **Eval-gate every change.** `npm run eval-gate` after each edit; a change
   ships only if the headline holds AND silents stay zero. Several "obviously
   better" designs (a joint level solver, three pill-read rewrites) shipped
   silent errors and were reverted the same hour.
3. **Prefer closed-world evidence.** Restricting candidates (digits-only,
   feasible-sums-only, pool-only, {1,2}-denominator-only) repeatedly rescued
   reads that open-world matching failed — the game's rules are the parser's
   biggest asset.
4. **Keep failed experiments cheap.** Revert to the committed baseline the
   moment an approach trades errors instead of removing them; the corpus is the
   arbiter, not the elegance of the idea.
5. **Suspect the labels.** At 99%+, label noise rivals parser error.

## 6. Known limits and open ends

Current state (2026-07-19, v82, 60-sample corpus): **99.7% headline, zero silent
errors, all 55 clean captures whole-parse-perfect, and exactly ONE wrong scalar
in the entire corpus — the tooltip-occluded reroll pill** (absent pixels; no
reader of any kind). The AI verifier reads every remaining flagged field
correctly when unlocked.

- **Physical occlusion** (a pet sprite, a hovering tooltip) is unwinnable by
  reading — the information is not in the image. Flagged, verifier-eligible
  where pixels exist elsewhere.
- ~~Chat-rerendered captures below the OCR floor~~ **RESOLVED (2026-07-19)**:
  the analysis-by-synthesis rescue (§2.6) reads their levels and names
  classically; the tier itself is extinct in production (native-resolution
  collection since v60).
- **Uncommon rarity and Destruction (cost-10) gems** have little/no corpus
  coverage; the vocabulary and pools support them, but they're untested inputs.
  (The one live cost-10 frame ever collected died in a pre-hardening upload.)
- ~~The glyph atlas pollution~~ **RESOLVED (2026-07-18 pass 2):** the atlas was
  regenerated with the tip-gated harvester (clean '1'/'2'/'3', the harvest/read
  segmentation bounds unified at 1.7) and landed at full parity — the one
  regression the swap exposed was the Process-pair template vote trusting
  "last two confident digits" (a narrow '1' matches '+', a word letter faked a
  '5'); it now slash-anchors like the pill read. Net: same headline, zero
  silents, ~10% fewer false alarms (cleaner templates flag less noise).
- The original **Workers-AI full-parse tier was deleted** (2026-07-18) — it
  re-read whole screenshots and never shipped. The WS4 replacement **SHIPPED
  2026-07-18**: the **flagged-field verifier** (`worker/astrogem-verify.js`,
  deployed at `astrogem-verify.shizukaziye.workers.dev`) — the structural parser
  stays the reader; the AI (llama-3.2-11b-vision, LLaVA fallback) is asked only
  about the fields the parser flagged, as one ≤768px panel crop + closed-vocab
  questions, behind the LockedIn site-token gate and a hard KV daily budget
  (9,000 est. Neurons = 90% of the free tier; the worker 429s past it — it can
  never incur paid usage). Client side (`advisor.js verifyFlagged`): runs after
  parse, before auto-advice; arbitration is mechanical — AI agrees → conf lifts
  to 0.85 (unflagged); AI disagrees while parser conf < 0.5 → adopt the AI value
  but KEEP it flagged (0.7). A wrong AI answer therefore can never unflag a
  field — only agreement can. Flag PRECISION is the token budget: every
  flagged-but-correct field is a wasted pull, which is why false-alarm reduction
  preceded the build. Deploy gotchas learned the hard way: Meta's model needs a
  one-time `{prompt:"agree"}` license handshake (the worker self-heals on error
  5016); the model returns its JSON sometimes as an OBJECT, sometimes as text
  with bare fractions (`"currentTurn": 5/9`) — both repaired server-side; and
  empty answers are never cached (a transient failure must not poison the 7-day
  cache). Measured answer quality: 13/13 correct across every readable
  remaining field it was tested on (gold centers, the pet frame, a mangled
  2-line name) — the vision model carries the shape priors classical methods
  lack, which is why it backstops the flags.

## 7. Performance architecture (2026-07-19 optimization sprint)

The parse runs **off the main thread** and the site never freezes:

- `ocr/parse-worker.js` — a classic Web Worker importScripts the same engine
  stack (the client sends its own cache-busted URLs from `LAZY_TABS`, so worker
  and page can never version-skew), receives the decoded raster by zero-copy
  buffer TRANSFER, and runs `parseStructural` + `constraintSnap` there. Any
  offload failure (creation, init, crash) disables it for the session and the
  identical inline path takes over. Measured: 227 rAF/s on the page during a
  full parse — display refresh rate, zero blocking.
- **Tesseract pool (2 instances) with parameter affinity** inside the worker:
  each instance caches its last psm/whitelist; identical-param calls skip the
  setParameters round-trip. The engine issues everything data-independent
  CONCURRENTLY: the four level nodes, the four outcome cells, and the whole
  footer phase (launched early, awaited before outcomes). Serialized backends
  (Node eval, the inline fallback) preserve old behavior through their queues.
- **The footer psm-6 block — the parse's single largest OCR — is skipped** when
  the template∧button-OCR votes already agree on the Process pair and the no-OCR
  cost-template read lands; it is fetched lazily only when actually needed.
- **Warm-up moved to tab load** (the background worker boots its pool while the
  user is still reading the page); the main-thread Tesseract stays cold unless
  the offload is unavailable. **Idle teardown** reclaims the pool's ~160MB of
  wasm heap after 5 minutes without a parse (lazy ~2s re-warm).
- The synthesis reference caches (~400 blur+normalize passes) build once per
  session at module scope, not per parse. `_debug.timing` phase marks are the
  sprint's ruler; the finding that drove everything: **OCR wall-time dominates
  and the pixel loops are nearly free.**

Measured end-to-end in the browser: warm clean-frame parse-to-advice
**1.6–2.3s** (25–35s before the sprint); the worst corpus frame (grey Charge,
every rescue ladder, plus an AI-verifier round-trip) 9.4s, fully in background.
Accuracy was bit-identical at every step — the eval gate ran after each change.
