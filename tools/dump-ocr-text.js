#!/usr/bin/env node
/**
 * tools/dump-ocr-text.js — print the RAW Tesseract text for each samples/ image.
 * Diagnostic companion to eval-ocr.js: eval tells you the score, this tells you WHY.
 * Usage: node tools/dump-ocr-text.js [name-substring]
 */
"use strict";
var fs = require("fs");
var path = require("path");
var ROOT = path.resolve(__dirname, "..");
var SAMPLES = path.join(ROOT, "samples");
var filter = process.argv[2] || "";

var Tesseract = require("tesseract.js");

(async () => {
  var imgs = fs.readdirSync(SAMPLES)
    .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
    .filter(f => f.indexOf(filter) !== -1);
  if (!imgs.length) { console.log("no images in samples/" + (filter ? " matching " + filter : "")); return; }

  var worker = await Tesseract.createWorker("eng", 1, { logger: () => {} });
  await worker.setParameters({ tessedit_pageseg_mode: "6" });
  for (var img of imgs) {
    var res = await worker.recognize(path.join(SAMPLES, img));
    console.log("\n=============== " + img + " ===============");
    console.log("mean confidence: " + (res.data.confidence != null ? res.data.confidence.toFixed(1) : "?"));
    console.log("--- raw text ---");
    console.log(res.data.text.replace(/\n{2,}/g, "\n").trim());
  }
  await worker.terminate();
})();
