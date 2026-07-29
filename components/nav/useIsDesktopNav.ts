"use client";

import { useEffect, useState } from "react";

/** Desktop nav breakpoint — keep in sync with MobileNav / NavLinks. */
export const NAV_DESKTOP_MIN_WIDTH_PX = 1024;

/**
 * `true` when viewport is desktop-wide enough for the full TopNav
 * link row. `null` during SSR / before mount — treat as mobile
 * (hamburger) so phones never flash the overflowing desktop links.
 *
 * Why JS instead of only `lg:flex`
 * --------------------------------
 * Production CSS once shipped without `md:flex` / `lg:flex` (Tailwind
 * purge), so `hidden lg:flex` never flipped to flex on any viewport.
 * Toggling base `hidden` / `flex` via matchMedia does not depend on
 * those responsive utilities being present in the stylesheet.
 */
export function useIsDesktopNav(): boolean | null {
  const [isDesktop, setIsDesktop] = useState<boolean | null>(null);

  useEffect(() => {
    const mq = window.matchMedia(
      `(min-width: ${NAV_DESKTOP_MIN_WIDTH_PX}px)`
    );
    const sync = () => setIsDesktop(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  return isDesktop;
}
