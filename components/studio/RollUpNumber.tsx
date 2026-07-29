"use client";

import { useEffect, useRef, useState } from "react";

/**
 * RollUpNumber — animated number that eases from 0 → `value` over
 * `duration` ms, formatted via `format`.
 *
 * Why raf (requestAnimationFrame) instead of framer-motion?
 * --------------------------------------------------------
 * Framer-motion's `motion.span` + `animate` primitive would work, but
 * counter-style roll-ups need a specific pattern: we're animating a
 * NUMBER (not a CSS property) and formatting it every frame. Doing
 * this the framer-motion way requires `useMotionValue` + `useTransform`
 * + a `motion.span` that renders the transformed string. That's more
 * moving pieces (pun intended) than a 20-line raf loop, and framer's
 * spring physics would fight easeOutCubic anyway. Raf gives us total
 * control over easing curve and zero framework overhead per frame.
 *
 * When `animate` is false the number renders instantly — this is the
 * SKIP path, where the user tapped past the reveal ceremony and just
 * wants numbers on screen.
 *
 * Reduced-motion respect
 * ----------------------
 * The component honours `prefers-reduced-motion` by short-circuiting
 * to the instant-render path regardless of the `animate` prop. Users
 * with motion sensitivity get the same result as a Skip.
 *
 * Cleanup
 * -------
 * On unmount OR value change, the pending raf and delay-timeout are
 * cancelled so a tab-switch mid-animation doesn't leak or double-
 * fire when the component remounts.
 */

const EASE_OUT_CUBIC = (t: number): number => 1 - Math.pow(1 - t, 3);

/** SSR-safe check — window/matchMedia only exist on client. */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function RollUpNumber({
  value,
  duration = 1200,
  delay = 0,
  animate = true,
  format,
  className,
}: {
  /** Target number to roll up to. */
  value: number;
  /** Total animation time in ms. */
  duration?: number;
  /** Wait this long before starting (used to stagger multiple
   *  roll-ups so they don't all race at once). */
  delay?: number;
  /** Set to false for instant render (Skip path, or a component
   *  that shouldn't animate this time). */
  animate?: boolean;
  /** Formatter — receives the currently-interpolated number, must
   *  return a string. Callers pass fmtCompactINR, percent formatters,
   *  or bare .toFixed(0) for streak-day counters. */
  format: (n: number) => string;
  /** Passed through to the outer span so callers can size / colour
   *  the number to match their layout. */
  className?: string;
}) {
  const [displayed, setDisplayed] = useState<number>(animate ? 0 : value);
  // Keep the latest value in a ref so a target-value change mid-
  // animation restarts from the current display value (not from 0).
  // Without this a rapid refresh sequence would visually "flicker
  // back to zero" every time — jarring on camera.
  const displayedRef = useRef<number>(displayed);
  displayedRef.current = displayed;

  useEffect(() => {
    // Reduced-motion short-circuit — render final value instantly.
    if (!animate || prefersReducedMotion()) {
      setDisplayed(value);
      return;
    }

    let raf: number | null = null;
    let startTs: number | null = null;
    const startValue = displayedRef.current;
    const timeoutId = window.setTimeout(() => {
      const tick = (t: number) => {
        if (startTs == null) startTs = t;
        const elapsed = t - startTs;
        const progress = Math.min(elapsed / duration, 1);
        const eased = EASE_OUT_CUBIC(progress);
        setDisplayed(startValue + (value - startValue) * eased);
        if (progress < 1) {
          raf = requestAnimationFrame(tick);
        }
      };
      raf = requestAnimationFrame(tick);
    }, delay);

    return () => {
      window.clearTimeout(timeoutId);
      if (raf != null) cancelAnimationFrame(raf);
    };
  }, [value, duration, delay, animate]);

  return <span className={className}>{format(displayed)}</span>;
}
