/**
 * favorites.js — a tiny cookie-backed "saved characters" store, shared by the
 * Grader and Leaderboard tabs. Loaded BEFORE grader.js / leaderboard.js so both
 * can call window.Favorites at init time.
 *
 * Persistence: a single cookie, name `astrogem_favs`, whose value is
 *   encodeURIComponent(JSON.stringify(list))
 * where `list` is an array of { region, name } (region upper-cased, name kept as
 * the user entered it), capped at 12 — the 13th add is rejected. The cookie is
 * written with `path=/; max-age=31536000; SameSite=Lax` (one year), so favorites
 * persist per-browser across reloads and sessions.
 *
 * Identity match (has / add dedupe / remove / toggle): same region
 * (case-insensitive) AND same name (case-insensitive, trimmed).
 *
 * Public API (window.Favorites):
 *   list()                  -> [{region, name}, ...]  (a fresh copy)
 *   has(region, name)       -> bool
 *   add(region, name)       -> bool  (false if full or already present)
 *   remove(region, name)    -> bool  (true if something was removed)
 *   toggle(region, name)    -> bool  (the NEW state: true = now favorited)
 *   count()                 -> number
 *   isFull()                -> bool  (count >= MAX)
 *   onChange(cb)            -> unsubscribe fn; cb runs after every change
 *
 * node-safe: when there's no `document` (e.g. Node import for a sanity check) the
 * store falls back to in-memory only and never touches cookies. It's a browser
 * module in practice.
 */
(function () {
  "use strict";

  var COOKIE = "astrogem_favs";
  var MAX = 12;
  var ONE_YEAR = 31536000; // seconds

  var hasDoc = (typeof document !== "undefined");

  // ---- cookie I/O (guarded so the module is node-safe) ----
  function readCookie() {
    if (!hasDoc) return "";
    var all = document.cookie ? document.cookie.split("; ") : [];
    for (var i = 0; i < all.length; i++) {
      var eq = all[i].indexOf("=");
      var k = eq < 0 ? all[i] : all[i].slice(0, eq);
      if (k === COOKIE) return eq < 0 ? "" : all[i].slice(eq + 1);
    }
    return "";
  }

  function writeCookie(list) {
    if (!hasDoc) return;
    var val = encodeURIComponent(JSON.stringify(list));
    document.cookie = COOKIE + "=" + val +
      "; path=/; max-age=" + ONE_YEAR + "; SameSite=Lax";
  }

  // Parse the cookie into a clean, capped list of {region, name}. Tolerates a
  // missing / malformed cookie and stray entries.
  function loadList() {
    var raw = readCookie();
    if (!raw) return [];
    var parsed;
    try { parsed = JSON.parse(decodeURIComponent(raw)); } catch (e) { return []; }
    if (!Array.isArray(parsed)) return [];
    var out = [];
    for (var i = 0; i < parsed.length && out.length < MAX; i++) {
      var it = parsed[i];
      if (!it || it.name == null) continue;
      var region = String(it.region == null ? "" : it.region).toUpperCase();
      var name = String(it.name);
      // skip dupes that may have crept into a hand-edited cookie
      if (indexOf(out, region, name) === -1) out.push({ region: region, name: name });
    }
    return out;
  }

  // The single in-memory copy, hydrated from the cookie on load.
  var items = loadList();

  // ---- identity (region case-insensitive; name case-insensitive + trimmed) ----
  function norm(s) { return String(s == null ? "" : s).trim().toLowerCase(); }
  function indexOf(arr, region, name) {
    var r = norm(region), n = norm(name);
    for (var i = 0; i < arr.length; i++) {
      if (norm(arr[i].region) === r && norm(arr[i].name) === n) return i;
    }
    return -1;
  }

  // ---- change notification ----
  var listeners = [];
  function notify() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](); } catch (e) { /* a bad subscriber must not break others */ }
    }
  }

  // ---- public API ----
  var Favorites = {
    list: function () {
      // hand back a defensive copy so callers can't mutate internal state
      return items.map(function (it) { return { region: it.region, name: it.name }; });
    },
    has: function (region, name) {
      return indexOf(items, region, name) !== -1;
    },
    count: function () { return items.length; },
    isFull: function () { return items.length >= MAX; },
    add: function (region, name) {
      if (name == null || norm(name) === "") return false;
      if (indexOf(items, region, name) !== -1) return false; // dup
      if (items.length >= MAX) return false;                 // full: reject the 13th
      items.push({ region: String(region == null ? "" : region).toUpperCase(), name: String(name) });
      writeCookie(items);
      notify();
      return true;
    },
    remove: function (region, name) {
      var i = indexOf(items, region, name);
      if (i === -1) return false;
      items.splice(i, 1);
      writeCookie(items);
      notify();
      return true;
    },
    toggle: function (region, name) {
      if (indexOf(items, region, name) !== -1) {
        this.remove(region, name);
        return false; // now not favorited
      }
      return this.add(region, name); // true if it was added, false if full
    },
    onChange: function (cb) {
      if (typeof cb !== "function") return function () {};
      listeners.push(cb);
      return function () {
        var i = listeners.indexOf(cb);
        if (i !== -1) listeners.splice(i, 1);
      };
    },
    MAX: MAX
  };

  if (typeof window !== "undefined") window.Favorites = Favorites;
  // node-safe export for an isolated require() (not used in the browser).
  if (typeof module !== "undefined" && module.exports) module.exports = Favorites;
})();
