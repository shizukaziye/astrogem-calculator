(function () {
  "use strict";
  // Client-side access gate for the Worker-backed actions (Grader loadout pulls + the
  // Leaderboard fetch). The password is NEVER stored in source: only the SHA-256 of
  // (salt + password) is embedded, and we hash the user's typed input to compare. A
  // correct unlock is remembered for the browser session (sessionStorage). This is a
  // traffic deterrent for casual / shared-link visitors, not a hardened security
  // boundary — a purely client-side gate can always be bypassed by a determined user.
  var SALT = "ag-gate::v1::";
  var HASH = "6104928cd0cc5374f5330e63e6a834f99aef7579db15c77d9d154932bf7a8ced";
  var FLAG = "ag_gate_ok";

  function toHex(buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (b) {
      return ("0" + b.toString(16)).slice(-2);
    }).join("");
  }
  function sha256Hex(str) {
    var data = new TextEncoder().encode(str);
    return crypto.subtle.digest("SHA-256", data).then(toHex);
  }

  function isUnlocked() {
    try { if (sessionStorage.getItem(FLAG) === "1") return true; } catch (e) {}
    return window.__agGateOk === true;
  }
  function remember() {
    try { sessionStorage.setItem(FLAG, "1"); } catch (e) {}
    window.__agGateOk = true;
  }

  // Resolve true iff access is allowed: already unlocked, or the user types the right
  // password now. A cancelled / empty / wrong prompt resolves false (caller aborts).
  function ensureUnlocked() {
    if (isUnlocked()) return Promise.resolve(true);
    if (!(window.crypto && crypto.subtle)) return Promise.resolve(false);
    var entry;
    try { entry = window.prompt("This site is access-limited.\nEnter the password to use this feature:"); }
    catch (e) { entry = null; }
    if (entry == null || entry === "") return Promise.resolve(false);
    return sha256Hex(SALT + entry).then(function (h) {
      if (h === HASH) { remember(); return true; }
      try { window.alert("Incorrect password."); } catch (e) {}
      return false;
    }).catch(function () { return false; });
  }

  // Access token the app sends to the Worker (?k=) once unlocked. The Worker rejects requests
  // without it, so un-refreshed pre-gate clients are blocked server-side. It's the embedded
  // hash (never the plaintext), and "" while locked so a locked client can't reach the Worker.
  function token() { return isUnlocked() ? HASH : ""; }

  // Parse-record collection is deliberately NOT password-gated (Shizu 2026-07-18: "only the
  // AI-powered parsing should be password locked" — training data must always flow). The
  // worker still wants ?k= to stop blind endpoint scans, and since this hash ships in the
  // page source anyway, sending it unconditionally for collect gives up nothing. The real
  // quota protection is the data worker's own daily write cap.
  function collectToken() { return HASH; }

  window.astrogemGate = { ensureUnlocked: ensureUnlocked, isUnlocked: isUnlocked, token: token, collectToken: collectToken };
})();
