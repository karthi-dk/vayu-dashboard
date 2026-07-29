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

    const register = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .catch((err) => {
          console.warn("[vayu] service worker registration failed:", err);
        });
    };

    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
