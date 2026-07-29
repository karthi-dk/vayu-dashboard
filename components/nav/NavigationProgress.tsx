"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * Thin top-of-viewport progress bar for App Router navigations.
 *
 * Why this exists
 * ---------------
 * Soft navigations keep the current page painted until the next
 * route's RSC payload is ready. Without feedback, a slow Sync /
 * Portfolio fetch looks like a dead click — and users hammer the
 * nav. This bar starts on same-origin <a> clicks and clears when
 * the pathname changes.
 *
 * Design notes
 * ------------
 * • 120ms show-delay so fast (prefetched) transitions never flash.
 * • 12s safety timeout so a cancelled / failed nav can't leave the
 *   bar stuck forever.
 * • Document capture-phase click listener covers TopNav, Studio
 *   theme links, in-page CTAs — anything using next/link or <a>.
 */
export function NavigationProgress() {
  const pathname = usePathname();
  const [pending, setPending] = useState(false);
  const [visible, setVisible] = useState(false);
  const showDelayRef = useRef<number | null>(null);
  const safetyRef = useRef<number | null>(null);

  const clearTimers = () => {
    if (showDelayRef.current != null) {
      window.clearTimeout(showDelayRef.current);
      showDelayRef.current = null;
    }
    if (safetyRef.current != null) {
      window.clearTimeout(safetyRef.current);
      safetyRef.current = null;
    }
  };

  const stop = () => {
    clearTimers();
    setPending(false);
    setVisible(false);
  };

  const start = () => {
    clearTimers();
    setPending(true);
    setVisible(false);
    // Only reveal if navigation is still pending after a short beat —
    // avoids a flicker on instant transitions.
    showDelayRef.current = window.setTimeout(() => {
      setVisible(true);
    }, 120);
    safetyRef.current = window.setTimeout(stop, 12_000);
  };

  // Route committed → done.
  useEffect(() => {
    stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

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

      const nextPath = url.pathname + url.search;
      const currentPath = window.location.pathname + window.location.search;
      if (nextPath === currentPath) return;

      start();
    };

    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      clearTimers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!pending) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-[200] h-[2px] overflow-hidden"
      role="progressbar"
      aria-hidden={!visible}
      aria-valuetext={visible ? "Loading page" : undefined}
    >
      <div
        className={`h-full w-full origin-left bg-[hsl(var(--primary))] shadow-[0_0_8px_hsl(var(--primary)/0.55)] transition-opacity duration-150 ${
          visible ? "opacity-100 animate-nav-progress" : "opacity-0"
        }`}
      />
    </div>
  );
}
