"use client";

import { useEffect } from "react";

/**
 * Client-side service-worker registration.
 *
 * Mounted once in app/layout.tsx. Registers /sw.js the first time
 * you visit the site in a supporting browser, which then persists
 * across sessions until you clear site data or the SW file itself
 * changes URL.
 *
 * Deliberate design choices
 * -------------------------
 * • Registers AFTER "load" — first paint / interactivity aren't
 *   blocked on this. The install prompt only appears on a second
 *   visit anyway, so slower first-visit registration is a
 *   non-issue.
 * • Failures are logged, never thrown — a failed SW register is
 *   graceful degradation (the site works exactly the same, just
 *   isn't installable). Common causes: private / incognito tabs,
 *   browsers that don't support SW at all (rare in 2026), or
 *   local dev over plain HTTP (`next dev` on http://localhost —
 *   Chrome allows SW on localhost but not on http://192.168.x.x).
 * • Returns null — this component only exists for its side effect.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    // Dev-mode hard guard: stale SW state can serve out-of-date shell
    // assets and trigger missing-chunk / unstyled-page loops while
    // Next's dev runtime is hot-reloading. Keep localhost/dev sessions
    // SW-free by unregistering anything previously installed.
    if (process.env.NODE_ENV !== "production") {
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => Promise.all(regs.map((r) => r.unregister())))
        .catch(() => {});
      if ("caches" in window) {
        caches
          .keys()
          .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
          .catch(() => {});
      }
      return;
    }

    let refreshing = false;
    const onControllerChange = () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    };

    const register = async () => {
      try {
        const reg = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
          updateViaCache: "none",
        });

        // Ask for an update check on every startup so installed PWAs
        // don't sit on a stale worker after a deployment.
        try {
          await reg.update();
        } catch {
          // Non-fatal; browser may throttle update checks.
        }

        // If a newer worker is already waiting, activate it now.
        if (reg.waiting) {
          reg.waiting.postMessage("skip-waiting");
        }

        // Auto-activate newly-installed workers and reload once the
        // controller switches, so users get fresh app code immediately.
        reg.addEventListener("updatefound", () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (
              installing.state === "installed" &&
              navigator.serviceWorker.controller
            ) {
              installing.postMessage("skip-waiting");
            }
          });
        });
      } catch (err) {
        console.warn("[vayu] service worker registration failed:", err);
      }
    };

    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    if (document.readyState === "complete") {
      void register();
      return () => {
        navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      };
    }
    const onLoad = () => {
      void register();
    };
    window.addEventListener("load", onLoad, { once: true });
    return () => {
      window.removeEventListener("load", onLoad);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  return null;
}
