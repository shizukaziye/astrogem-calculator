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

// Worker-side Tesseract: same serialization + self-healing rules as the main
// thread's browserOcr (see structural-engine.js), but recognize() gets ImageData
// directly — no canvas exists here and none is needed.
var _wp = null;
function getW() {
  if (!_wp) {
    _wp = self.Tesseract.createWorker("eng", 1, { logger: function () {} });
    _wp.catch(function () { _wp = null; });
  }
  return _wp;
}
var _q = Promise.resolve();
function wOcr(raster, opts) {
  var call = _q.catch(function () {}).then(function () {
    return getW().then(function (w) {
      var params = { tessedit_pageseg_mode: String((opts && opts.psm) || 6), user_defined_dpi: "150" };
      params.tessedit_char_whitelist = (opts && opts.whitelist) || "";
      return w.setParameters(params).catch(function () {}).then(function () {
        return w.recognize(new ImageData(new Uint8ClampedArray(raster.data), raster.width, raster.height));
      }).then(function (res) {
        return { text: (res && res.data && res.data.text) || "", conf: ((res && res.data && res.data.confidence) || 40) / 100 };
      });
    }).catch(function () {
      _wp = null;   // dead worker — retry fresh on the next call
      return { text: "", conf: 0, failed: true };
    });
  });
  _q = call;
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
