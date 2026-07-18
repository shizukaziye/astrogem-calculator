# Code Audit — dead code + optimization spots

A pass over the codebase for (a) leftover/dead code and (b) 10 places to optimize
**without changing functionality** — cutting code, speeding things up, or (most
important) reducing **Cloudflare KV** and **lostark.bible** usage.

> The pipeline bake files (`tools/collect-stats.js`, `model/*.js`, `pipeline.js`,
> `data/pipeline*.json`) are being **re-baked in a separate fork**, so anything in them
> below is *flagged for that fork*, not changed here.

> **Status update (2026-07-16).** This audit is a 2026-06-26 snapshot; much has since
> landed:
> - The **rebake fork merged** (2026-06-27): the pipeline EV layer + `gradeToScore`
>   run on the multiplicative `gemValue`/`supportValue`, both axes are baked.
> - **#1, #2, #3 are implemented** in `worker/astrogem-bible.js` (`q:order` ordered
>   queue snapshot, `lb:dirty:` incremental leaderboard rebuild, `nf:` not-found
>   markers — the code comments cite these audit items).
> - **#10 is superseded**: `advisor.js` no longer carries a Workers-AI/`WORKER_URL`
>   branch — engines live behind the `ocr/engine.js` registry
>   (`ocr/workersai-engine.js` keeps its own `WORKER_URL`).
> - The **legacy `score()` layer** now has one fewer consumer: `tools/verify-dp.js`
>   was still measuring the MC gate on `A.score` (the last value-metric use) and was
>   fixed 2026-07-16. `score()` remains for the grader's raw %-damage readout
>   (`relDamage`) and the JS↔Python reference battery; `gradeBounds()` no longer has
>   any caller.
> - Still open: **#7** (brute-force `valueBounds()`/`gradeBounds()`), the rest of
>   **#9** (`OLD_SCORING_MODE`/`OLD_W`), the `ALLOW_ORIGIN` CORS TODO, and #6.
>
> **Status update (2026-07-18 — the whole-repo audit pass).** Four parallel area
> audits re-verified everything; landed in the "audit pass 1" commit:
> - `gradeBounds`/`grade_bounds` (JS+PY), `_solve3x3` (JS+PY), `Solver.branchStats`,
>   `layout.refineWheelAnchors`, `layout.isGreenUp/isRedDown/isWheelLevelText`,
>   dead `ocr/engine.js` window globals + snap-substep exports, the ENTIRE
>   unreachable browser half of `tesseract-engine.js`, and
>   `Favorites.count/isFull/MAX` — all REMOVED (grep-verified zero references).
> - `pipeline.js` now reads `RESET_COST` from the model's `COSTS.reset` (was a
>   duplicated constant); `dp.js` derives fresh-gem rerolls from `RARITY`;
>   `validateConfig` validates `gemType`; editing an Advisor field clears a stale
>   verdict (the onChange no-op gap).
> - NEW: `tools/lint-labels.js` gates the sample corpus ahead of `eval-gate`.
> - "Tesseract is the live/default engine" is stale EVERYWHERE it appears — the
>   structural engine has been the sole live engine since 2026-07-16; the docs
>   were rewritten accordingly (ocr/README, worker/README, this file's §opt-10).
> - Still open from the 06-26 list: #7 remainder (`valueBounds` brute force — the
>   live one), #9 (`OLD_SCORING_MODE`/`OLD_W`, self-documented analysis toggle),
>   the `ALLOW_ORIGIN` CORS TODO, #6.

---

## Dead / legacy code

| Where | What | Disposition |
|---|---|---|
| `model/astrogem.js` `OLD_SCORING_MODE` / `OLD_W` / `setOldScoring` | Head-to-head "old abstract weights" comparison mode, **hardcoded `false`**, never on in the app. | Remove once analysis no longer needs it — **fork's file**, flagged. |
| `model/astrogem.js` `score()` / `gradeToScore()` | The **legacy additive** scoring layer. Grading no longer uses it; only the pipeline EV still does, "until the Stage-2 rebake." | Will be removed by the **rebake** — flagged. |
| `grader.js` `var since` (in `runPull`) | Computed but unused after the queue-watch rewrite (superseded by `sinceTs`). | **✅ Removed this pass.** |
| `advisor.js` Workers-AI engine | Shown but **disabled** behind a never-set `WORKER_URL` (Tesseract is the live engine). | Keep as a deliberate future hook, or trim — see opt #10. |
| `worker/astrogem-bible.js:55` `ALLOW_ORIGIN = "*"` | `TODO`: lock CORS to the Pages origin before "production." | Tighten if desired (security, not dead code). |

Everything else (`gate.js`, `favorites.js`, `queue-admin.html`) is lean.

---

## 10 optimization spots

Ordered by impact. **Tier 1 = reduce Cloudflare/lostark.bible usage (most important).**

### Tier 1 — fewer KV ops / fewer upstream fetches

**1. Cache the queue order in a cron-written key (`q:order`).** *(Recommended — biggest KV-`list` saver.)*
`queueStatus()` does **two KV `list()`s** (the priciest KV op) on every `&pos` re-sync,
and the metrics endpoint + the cache-path membership check each list too. The cron
already lists both queues every minute to drain them — have it also write the ordered
queue (keys by `ts`) to one `q:order` key. Then a position lookup is a **single cheap
read** (find the index), the cache path checks membership in that same key, and the
dashboard reads it directly. Turns the per-watcher, per-30s list cost into ~0.

**2. Incremental leaderboard snapshot.** *(Recommended — biggest KV-`read` saver.)*
`buildCharacterList()` re-reads **every stored character** (~4000 KV reads) each time
the snapshot rebuilds (≤ every 30 min). Have the drain append each freshly-cached key
to a small "dirty" set; the rebuild then reads **only those records** and merges them
into the existing snapshot, instead of re-reading all 4000. Cuts thousands of reads
per rebuild down to the few dozen that actually changed.

**3. Suppress re-fetching not-found (404) characters.** *(Recommended — lostark.bible saver.)*
When the drain gets a 4xx it drops the queue entry, but nothing remembers the miss — so
a tab watching a typo'd/deleted name keeps re-enqueuing it and the drain keeps hitting
lostark.bible and 404-ing in a loop. Write a short-TTL `notfound:region:name` marker on
a 4xx and check it at enqueue → known-missing names stop generating upstream fetches.

**4. Parallelize the cache-path queue check.** *(✅ Implemented.)*
The queue-aware cached lookup did `get(QP)` then `get(QF)` as two sequential awaits;
now one `Promise.all` round-trip. (`worker/astrogem-bible.js`, cache block.)

### Tier 2 — latency / compute

**5. Parallelize the metrics endpoint reads.** *(✅ Implemented.)*
`?metrics=1` did 4 sequential awaits (`list(QP)`, `list(QF)`, usage, lastWrite); now one
`Promise.all`. Cuts the owner dashboard's poll latency ~4×.

**6. Compute the inactive leaderboard axis lazily.** *(Recommended.)*
`renderTable()` precomputes **both** axes' figures (`_avg/_dmg/_savg/_pdmg`) for all
~4000 characters on every fetch, but the active DPS board never needs `_pdmg` and the
support board never needs `_avg/_dmg`. Compute the inactive board's ranking figure on
toggle instead of upfront — roughly halves the per-fetch client work. (`_savg` must stay
eager: the DPS board's support-main check needs it.)

**7. Replace the brute-force `valueBounds()`/`gradeBounds()`.** *(Recommended — fork's file.)*
Both run a **6-deep nested loop** (thousands of `gemValue` evals) on first call to find
a min/max that are structurally just *the worst legal gem* and *the perfect gem*.
Compute them with two direct evaluations instead. (`model/astrogem.js` — left for the
rebake fork.)

### Tier 3 — code reduction

**8. Remove the dead `var since` in `grader.js`.** *(✅ Implemented.)*
Unused after the queue-watch rewrite.

**9. Drop `OLD_SCORING_MODE` + the legacy `score()` layer.** *(Recommended — fork's file.)*
See the dead-code table. Once the pipeline finishes migrating to `gemValue`, the
old-weights comparison mode and the additive `score`/`gradeToScore` path can go,
trimming a meaningful chunk of `model/astrogem.js`.

**10. Trim the disabled Workers-AI advisor engine.** *(Recommended / optional.)*
The advisor's Workers-AI branch is dead behind a never-set `WORKER_URL`. If Tesseract is
the permanent engine, removing the branch + its UI selector trims `advisor.js`; if a
cloud OCR is still planned, keep it as the intentional hook it is.

---

## Summary

- **Implemented now (no behavior change):** #4, #5 (worker read parallelization), #8
  (dead `since`).
- **Highest-value recommendations:** #1 (`q:order` snapshot) and #2 (incremental
  leaderboard snapshot) — together they remove almost all of the steady-state KV-`list`
  and KV-`read` load; #3 cuts wasted lostark.bible fetches.
- **Left for the rebake fork:** #7, #9 (and the `model/astrogem.js` dead code).
