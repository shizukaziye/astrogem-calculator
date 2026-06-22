/**
 * ocr/workersai-engine.js — client wrapper for the Workers AI screenshot engine.
 *
 * POSTs the screenshot to the Cloudflare Worker in worker/astrogem-vision.js (which
 * runs a vision model and returns { config, state, outcomes }), then runs the result
 * through the shared constraintSnap so the Advisor always gets a legal state.
 *
 * SETUP: after `wrangler deploy` (see worker/README.md), paste the printed URL into
 * WORKER_URL below. While WORKER_URL is empty the engine reports itself UNAVAILABLE
 * (gracefully) and the Advisor shows the option disabled; the default Tesseract
 * engine needs no setup at all.
 *
 * Depends on ocr/engine.js being loaded first.
 */
(function (root) {
  "use strict";

  // ===========================================================================
  // PASTE YOUR DEPLOYED WORKER URL HERE (e.g. "https://astrogem-vision.<sub>.workers.dev").
  // Leave as "" to keep the Workers AI engine disabled.
  var WORKER_URL = "";
  // ===========================================================================

  var ENGINE_API = (typeof module !== "undefined" && module.exports)
    ? require("./engine.js")
    : root.OcrEngineAPI;

  var BaseEngine = ENGINE_API.BaseEngine;
  var IS_BROWSER = typeof window !== "undefined" && typeof fetch !== "undefined";

  function WorkersAiEngine(workerUrl) {
    // Allow an override (used by the eval harness in Node).
    this.workerUrl = (workerUrl != null ? workerUrl : WORKER_URL) || "";
  }
  WorkersAiEngine.prototype = Object.create(BaseEngine.prototype);
  WorkersAiEngine.prototype.constructor = WorkersAiEngine;
  WorkersAiEngine.prototype.name = "workersai";
  WorkersAiEngine.prototype.label = "Workers AI (vision, needs deploy)";

  WorkersAiEngine.prototype.isAvailable = function () {
    return !!this.workerUrl && typeof fetch !== "undefined";
  };

  // Reason string for the UI when unavailable.
  WorkersAiEngine.prototype.unavailableReason = function () {
    if (!this.workerUrl) return "Set WORKER_URL in ocr/workersai-engine.js after deploying the Worker (see worker/README.md).";
    if (typeof fetch === "undefined") return "fetch() is unavailable in this environment.";
    return "";
  };

  // Convert a Blob/File/HTMLImageElement/HTMLCanvasElement into a Blob to POST.
  function toBlob(input) {
    if (typeof Blob !== "undefined" && input instanceof Blob) return Promise.resolve(input);
    if (IS_BROWSER && input instanceof HTMLCanvasElement) {
      return new Promise(function (res, rej) {
        input.toBlob(function (b) { b ? res(b) : rej(new Error("canvas toBlob failed")); }, "image/png");
      });
    }
    if (IS_BROWSER && input instanceof HTMLImageElement) {
      // draw to a canvas, then export
      return (input.naturalWidth ? Promise.resolve() : input.decode().catch(function () {})).then(function () {
        var c = document.createElement("canvas");
        c.width = input.naturalWidth || input.width;
        c.height = input.naturalHeight || input.height;
        c.getContext("2d").drawImage(input, 0, 0);
        return new Promise(function (res, rej) {
          c.toBlob(function (b) { b ? res(b) : rej(new Error("image toBlob failed")); }, "image/png");
        });
      });
    }
    return Promise.reject(new Error("Unsupported image input for Workers AI engine."));
  }

  WorkersAiEngine.prototype.parseScreenshot = function (input) {
    var self = this;
    if (!this.isAvailable()) {
      return Promise.reject(new Error("Workers AI engine unavailable: " + this.unavailableReason()));
    }
    return toBlob(input).then(function (blob) {
      return fetch(self.workerUrl, {
        method: "POST",
        headers: { "Content-Type": blob.type || "image/png" },
        body: blob
      });
    }).then(function (resp) {
      if (!resp.ok) {
        return resp.text().then(function (t) {
          throw new Error("Worker returned " + resp.status + ": " + t.slice(0, 300));
        });
      }
      return resp.json();
    }).then(function (data) {
      if (data && data.error && !data.config) {
        throw new Error("Worker could not parse the screenshot: " + data.error +
          (data.raw ? " (model said: " + String(data.raw).slice(0, 200) + ")" : ""));
      }
      // Strict legality is enforced here, regardless of what the model returned.
      return self.constraintSnap({
        config: (data && data.config) || {},
        state: (data && data.state) || {},
        outcomes: (data && data.outcomes) || [],
        rarity: data && data.rarity
      });
    });
  };

  // ---------------- register + export ----------------

  var instance = new WorkersAiEngine();
  if (ENGINE_API.registerEngine) ENGINE_API.registerEngine(instance);

  var EXPORT = { WorkersAiEngine: WorkersAiEngine, instance: instance, WORKER_URL: WORKER_URL };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = EXPORT;
  } else {
    root.WorkersAiEngine = WorkersAiEngine;
    root.workersAiEngine = instance;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
