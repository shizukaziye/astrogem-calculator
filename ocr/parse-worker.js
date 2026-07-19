/**
 * ocr/parse-worker.js — the structural parse, OFF the main thread.
 *
 * The parse is seconds of tight pixel loops + OCR; on the main thread it froze
 * the whole site (Shizu 2026-07-19: "I don't want the whole website to freeze").
 * This classic Web Worker loads the same engine stack and runs parseStructural +
 * constraintSnap here, with its own Tesseract instance fed ImageData (no DOM).
 *
 * Protocol (structural-engine.js is the only client):
 *   -> { type:"init", urls:[...] }         importScripts the engine stack; the
 *                                          client sends its own cache-busted URLs
 *                                          so worker and page never version-skew
 *   <- { type:"ready" } | { type:"init-error", error }
 *   -> { type:"parse", id, width, height, buf }   buf: transferred RGBA buffer
 *   <- { type:"result", id, result } | { type:"result", id, error }
 *
 * Any failure here disables the offload client-side and the parse falls back to
 * the inline path — behavior-identical, just blocking.
 */
"use strict";

self.onmessage = function (ev) {
  var msg = ev.data || {};
  if (msg.type === "init") {
    try {
      importScripts.apply(null, msg.urls);
      self.postMessage({ type: "ready" });
    } catch (e) {
      self.postMessage({ type: "init-error", error: String(e && e.message || e) });
    }
    return;
  }
  if (msg.type === "parse") {
    var raster = { width: msg.width, height: msg.height, data: new Uint8ClampedArray(msg.buf) };
    parseJob(msg.id, raster);
  }
};

// Worker-side Tesseract POOL (2 instances): the engine's reads dominated wall
// time and were serialized on one instance. Two instances let independent reads
// (the engine issues level nodes and outcome cells concurrently) overlap, and
// each instance CACHES its last parameters — identical-param calls skip the
// setParameters round-trip entirely. Same self-healing rules as the main
// thread's browserOcr; recognize() gets ImageData directly (no canvas here).
var POOL_N = 2;
var _pool = [];   // [{p: workerPromise|null, q: tailPromise, params: lastParamsKey, busy: int}]
for (var pi = 0; pi < POOL_N; pi++) _pool.push({ p: null, q: Promise.resolve(), params: "", busy: 0 });
function slotWorker(slot) {
  if (!slot.p) {
    slot.p = self.Tesseract.createWorker("eng", 1, { logger: function () {} });
    slot.p.catch(function () { slot.p = null; slot.params = ""; });
  }
  return slot.p;
}
function wOcr(raster, opts) {
  var psm = String((opts && opts.psm) || 6);
  var wl = (opts && opts.whitelist) || "";
  var key = psm + "|" + wl;
  // prefer an idle slot already configured with these params, then any idle
  // slot, then the least-busy — parameter affinity minimizes setParameters swaps
  var slot = null, si;
  for (si = 0; si < _pool.length; si++) if (!_pool[si].busy && _pool[si].params === key) { slot = _pool[si]; break; }
  if (!slot) for (si = 0; si < _pool.length; si++) if (!_pool[si].busy) { slot = _pool[si]; break; }
  if (!slot) { slot = _pool[0]; for (si = 1; si < _pool.length; si++) if (_pool[si].busy < slot.busy) slot = _pool[si]; }
  slot.busy++;
  var call = slot.q.catch(function () {}).then(function () {
    return slotWorker(slot).then(function (w) {
      var setP = slot.params === key ? Promise.resolve() : w.setParameters({
        tessedit_pageseg_mode: psm, user_defined_dpi: "150", tessedit_char_whitelist: wl
      }).then(function () { slot.params = key; }).catch(function () { slot.params = ""; });
      return setP.then(function () {
        return w.recognize(new ImageData(new Uint8ClampedArray(raster.data), raster.width, raster.height));
      }).then(function (res) {
        return { text: (res && res.data && res.data.text) || "", conf: ((res && res.data && res.data.confidence) || 40) / 100 };
      });
    }).catch(function () {
      slot.p = null; slot.params = "";   // dead instance — retry fresh next call
      return { text: "", conf: 0, failed: true };
    });
  }).then(function (r) { slot.busy--; return r; }, function (e) { slot.busy--; throw e; });
  slot.q = call;
  return call;
}

function parseJob(id, raster) {
  Promise.resolve().then(function () {
    return self.OcrStructuralEngine.parseStructural(raster, wOcr);
  }).then(function (raw) {
    var snapped = self.OcrEngineAPI.constraintSnap(raw);
    snapped.confidence = raw.confidence ? snapped.confidence : undefined;
    if (raw.ocrDegraded) snapped.ocrDegraded = true;
    if (raw._srcPanel) snapped._srcPanel = raw._srcPanel;
    self.postMessage({ type: "result", id: id, result: snapped });
  }).catch(function (e) {
    self.postMessage({ type: "result", id: id, error: String(e && e.message || e) });
  });
}
