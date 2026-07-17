#!/usr/bin/env node
/**
 * tools/pull-collected.js — download the Advisor's collected parse records.
 *
 * Pulls every record from the astrogem-data worker (R2) into samples/collected/:
 *   <id>.json   the record: { ts, image, parse, final, changed, meta }
 *   <id>.webp   the capture
 * Records whose `changed` list is non-empty are the interesting ones — the user
 * corrected the parser, so `final` is a ground-truth label for that image. Print a
 * digest of correction hotspots so we know what to fix next.
 *
 * Usage:  node tools/pull-collected.js            # incremental (skips existing)
 *         GATE=<token> node tools/pull-collected.js  (defaults to the site token)
 */
"use strict";

var fs = require("fs");
var path = require("path");

var BASE = "https://astrogem-data.shizukaziye.workers.dev";
var GATE = process.env.GATE || "6104928cd0cc5374f5330e63e6a834f99aef7579db15c77d9d154932bf7a8ced";
var OUT = path.join(__dirname, "..", "samples", "collected");

async function get(pathname) {
  var res = await fetch(BASE + pathname + (pathname.indexOf("?") === -1 ? "?" : "&") + "k=" + GATE);
  if (!res.ok) throw new Error(pathname + " -> " + res.status);
  return res;
}

(async function () {
  fs.mkdirSync(OUT, { recursive: true });
  var keys = [], cursor = null;
  do {
    var page = await (await get("/list" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""))).json();
    keys = keys.concat(page.keys.map(function (k) { return k.key; }));
    cursor = page.cursor;
  } while (cursor);

  // KV keys are bare record keys (col/<day>/<id>) — every key is one record
  var jsonKeys = keys;
  console.log(jsonKeys.length + " records");

  var hotspots = {}, corrected = 0, clean = 0, pulled = 0;
  for (var i = 0; i < jsonKeys.length; i++) {
    var key = jsonKeys[i];
    var id = key.split("/").pop();
    var jf = path.join(OUT, id + ".json");
    var rec;
    if (fs.existsSync(jf)) {
      rec = JSON.parse(fs.readFileSync(jf, "utf8"));
    } else {
      rec = await (await get("/obj?key=" + encodeURIComponent(key))).json();
      // split the embedded data-URL image out into a real file
      if (typeof rec.image === "string") {
        var m = rec.image.match(/^data:image\/(webp|png|jpeg);base64,(.+)$/);
        if (m) {
          var ext = m[1] === "jpeg" ? "jpg" : m[1];
          fs.writeFileSync(path.join(OUT, id + "." + ext), Buffer.from(m[2], "base64"));
          rec.image = id + "." + ext;
        }
      }
      fs.writeFileSync(jf, JSON.stringify(rec, null, 2));
      pulled++;
    }
    var ch = rec.changed || [];
    if (ch.length) {
      corrected++;
      ch.forEach(function (c) { hotspots[c.field] = (hotspots[c.field] || 0) + 1; });
    } else clean++;
  }

  console.log("new this pull: " + pulled);
  console.log("records: " + jsonKeys.length + "  clean parses: " + clean + "  user-corrected: " + corrected);
  var hot = Object.keys(hotspots).sort(function (a, b) { return hotspots[b] - hotspots[a]; });
  if (hot.length) {
    console.log("correction hotspots (what to fix next):");
    hot.forEach(function (f) { console.log("  " + f + "  ×" + hotspots[f]); });
  }
  console.log("\nReview corrected records in samples/collected/, then promote good ones into");
  console.log("samples/ as <name>.png + <name>.json pairs (final IS the ground truth) and re-run");
  console.log("tools/build-glyphs.js + npm run eval-gate.");
})().catch(function (e) { console.error(e.message || e); process.exit(1); });
