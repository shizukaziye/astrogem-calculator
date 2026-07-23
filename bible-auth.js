/**
 * bible-auth.js — "Sign in with lostark.bible" for the Grader's pull mode.
 *
 * lostark.bible gates character pages behind `Authorization: Bearer <token>`. Rather than ship a
 * shared key, the user signs in with their own lostark.bible account (OAuth, `identify` scope) and
 * we fetch pages on their behalf — so every upstream request is attributable to a consenting human.
 *
 * The page NEVER holds their lostark.bible token. The Worker runs the whole OAuth flow and redirects
 * back with an opaque SESSION id in the URL fragment; we stash that in localStorage and send it as
 * `?s=` on Worker lookups. The Worker swaps the session for the real token server-side.
 *
 * Fragments are used deliberately: they are not sent to servers, so the session id stays out of
 * access logs and Referer headers. We strip it from the address bar right after reading it.
 */
(function (root) {
  "use strict";

  var KEY = "astrogem_bible_session";
  var lastError = "";

  function workerBase() {
    var w = (root.LoadoutEcon && root.LoadoutEcon.WORKER_URL) || "https://astrogem-bible.shizukaziye.workers.dev";
    return String(w).replace(/\/+$/, "");
  }
  function get() { try { return localStorage.getItem(KEY) || ""; } catch (e) { return ""; } }
  function set(v) {
    try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch (e) {}
  }

  // The Worker sends us back to #ags_session=<id> on success, or #ags_error=<code> on failure.
  function captureFragment() {
    var h = String(root.location.hash || "");
    if (h.indexOf("ags_session=") === -1 && h.indexOf("ags_error=") === -1) return;
    var mS = h.match(/[#&]ags_session=([^&]+)/);
    var mE = h.match(/[#&]ags_error=([^&]+)/);
    if (mS) { try { set(decodeURIComponent(mS[1])); } catch (e) { set(mS[1]); } }
    if (mE) { try { lastError = decodeURIComponent(mE[1]); } catch (e) { lastError = mE[1]; } }
    // Drop our params from the URL so the session id doesn't linger in the bar or in history.
    var rest = h.replace(/[#&]ags_(session|error)=[^&]*/g, "").replace(/^#&?/, "");
    try {
      root.history.replaceState(null, "", root.location.pathname + root.location.search + (rest ? "#" + rest : ""));
    } catch (e) { /* non-fatal: the id just stays visible */ }
  }
  captureFragment();

  function login() {
    // Come back to this exact page — the Worker only honours allow-listed return targets.
    var ret = root.location.origin + root.location.pathname;
    root.location.href = workerBase() + "/oauth/start?ret=" + encodeURIComponent(ret);
  }

  function logout() {
    var s = get();
    set("");
    lastError = "";
    if (!s) return Promise.resolve();
    return fetch(workerBase() + "/oauth/logout?s=" + encodeURIComponent(s), { method: "POST" })
      .catch(function () { /* session is already gone locally; upstream token will expire */ });
  }

  function isSignedIn() { return !!get(); }

  // Confirm with the Worker that the session is still good — it can lapse (90-day token, no
  // refresh) or be revoked by the user from lostark.bible at any time. Clears a dead session.
  function verify() {
    var s = get();
    if (!s) return Promise.resolve(false);
    return fetch(workerBase() + "/oauth/me?s=" + encodeURIComponent(s))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var ok = !!(j && j.loggedIn);
        if (!ok) set("");
        return ok;
      })
      .catch(function () { return false; });   // network blip: keep the session, assume ok
  }

  // Query-string fragment to append to Worker lookups ("" when signed out).
  function param() {
    var s = get();
    return s ? "&s=" + encodeURIComponent(s) : "";
  }

  root.bibleAuth = {
    login: login,
    logout: logout,
    isSignedIn: isSignedIn,
    verify: verify,
    session: get,
    param: param,
    lastError: function () { return lastError; }
  };
})(window);
