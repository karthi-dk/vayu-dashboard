"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * Top progress bar for App Router navigations.
 *
 * Soft navigations keep the current page painted until the RSC
 * payload is ready — without feedback, taps feel dead. This bar
 * starts on same-origin <a> clicks.
 *
 * Mobile / iPhone notes
 * --------------------
 * • With `loading.tsx`, Next often updates the URL *before* the new
 *   page paints. Stopping on any pathname change cancelled the bar
 *   instantly — so users never saw it. We track the clicked target
 *   and keep the bar up until that path lands (min ~280ms).
 * • `top: 0` sits under the status bar / notch in standalone PWA.
 *   We pin below `env(safe-area-inset-top)` and, when TopNav is
 *   present, below the 56px header so the bar is on-screen.
 */
export function NavigationProgress() {
  const pathname = usePathname();
  const [pending, setPending] = useState(false);
  const targetPathnameRef = useRef<string | null>(null);
  const safetyRef = useRef<number | null>(null);
  const minVisibleRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);

  const clearTimers = () => {
    if (safetyRef.current != null) {
      window.clearTimeout(safetyRef.current);
      safetyRef.current = null;
    }
    if (minVisibleRef.current != null) {
      window.clearTimeout(minVisibleRef.current);
      minVisibleRef.current = null;
    }
  };

  const stop = () => {
    clearTimers();
    targetPathnameRef.current = null;
    setPending(false);
  };

  const start = (nextPathname: string) => {
    clearTimers();
    targetPathnameRef.current = nextPathname;
    startedAtRef.current = Date.now();
    setPending(true);
    safetyRef.current = window.setTimeout(stop, 12_000);
  };

  // Finish when the navigated pathname matches the click target.
  useEffect(() => {
    const target = targetPathnameRef.current;
    if (!target || !pending) return;
    if (pathname !== target) return;

    const elapsed = Date.now() - startedAtRef.current;
    const remain = Math.max(0, 280 - elapsed);
    minVisibleRef.current = window.setTimeout(stop, remain);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, pending]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      if (event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }

      const anchor = (event.target as Element | null)?.closest("a");
      if (!anchor) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;

      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      if (href.startsWith("mailto:") || href.startsWith("tel:")) return;

      let url: URL;
      try {
        url = new URL(href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) {
        return;
      }

      start(url.pathname);
    };

    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      clearTimers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!pending) return null;

  const chromeHidden =
    pathname === "/login" ||
    pathname === "/studio" ||
    pathname.startsWith("/studio/");

  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-[200] h-1 overflow-hidden bg-[hsl(var(--primary)/0.15)]"
      style={{
        top: chromeHidden
          ? "env(safe-area-inset-top, 0px)"
          : "calc(env(safe-area-inset-top, 0px) + 3.5rem)",
      }}
      role="progressbar"
      aria-valuetext="Loading page"
    >
      <div className="h-full w-full origin-left animate-nav-progress bg-[hsl(var(--primary))] shadow-[0_0_10px_hsl(var(--primary)/0.65)]" />
    </div>
  );
}
