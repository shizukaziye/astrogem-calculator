/**
 * model/dp-worker.js — runs the exact Bellman DP (model/dp.js) off the main thread.
 *
 * Fixes #6: advisor.js used to call window.evaluateActionsDP(...) synchronously on
 * the main thread, inside a bare setTimeout(fn, 30) that only let the "Solving…"
 * status text paint before starting — not real chunking. A big solve (early turns
 * on an Epic gem: many reachable (config, t, r, cm) memo keys, each a
 * without-replacement combinatorial-Bernoulli expectation over the outcome pool)
 * could block input/rendering for its entire duration with no way to interact with
 * the page meanwhile.
 *
 * This worker loads the SAME model files the main thread does (astrogem.js sets
 * self.Astrogem, nested.js sets self.AstrogemNested, dp.js reads both off `self`
 * exactly as it reads them off `window` in the main thread — see dp.js's own
 * root.Astrogem / root.AstrogemNested fallback) and exposes exactly one message:
 *
 *   postMessage({ state, baseline, goldPerDamage, numRuns, options })
 *   -> postMessage({ ok: true, result }) | { ok: false, error }
 *
 * `state`/`baseline`/`options` etc. are plain JSON — no functions, no DOM — so they
 * survive structured clone across the worker boundary untouched. onProgress is NOT
 * passed through: evaluateActionsDP only ever calls it once at the end anyway (see
 * its own comment — "the DP is deterministic", no per-node progress exists yet),
 * so there's nothing worth relaying mid-solve. The caller shows an indeterminate
 * "still solving" state instead of a fake linear progress bar while this is in
 * flight (see advisor.js's av-bar-indeterminate).
 *
 * Deploy note: these ?v= MUST match index.html's — model/astrogem.js (eager
 * <script>) and model/nested.js / model/dp.js (advisor's LAZY_TABS) — every time
 * one of those files changes. Same convention index.html already documents; a
 * worker with a stale cached copy of the model would silently diverge from the
 * main thread's freshly-versioned one, which is exactly the class of bug the
 * staleness beacon in advisor.js (CLIENT_V) exists to catch on the main thread —
 * this worker has no such beacon of its own, so the version bump is the only guard.
 */
importScripts("astrogem.js?v=51", "nested.js?v=51", "dp.js?v=55");

self.onmessage = function (e) {
  var m = e.data || {};
  try {
    var result = evaluateActionsDP(m.state, m.baseline, m.goldPerDamage, m.numRuns, null, m.options);
    self.postMessage({ ok: true, result: result });
  } catch (err) {
    self.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
};
