"use client";

import { useEffect, useState } from "react";

export type Theme = "dark" | "light";

// Persisted under a namespaced key so we don't collide with future
// features that also want localStorage.
export const THEME_STORAGE_KEY = "vayu:theme";

/**
 * useTheme — manages the light/dark toggle.
 *
 * How the pieces fit together:
 *
 *   1. Pre-hydration script in <head> (see layout.tsx) reads localStorage
 *      synchronously and sets `data-theme` on <html> BEFORE first paint.
 *      Prevents FOUC (page rendering in dark → flipping to light after JS
 *      hydrates).
 *   2. This hook re-reads localStorage on mount to sync React state with
 *      the DOM. Without this step, React would think theme = "dark"
 *      (initialState default) even when the DOM already has data-theme=
 *      "light" — the button would show the wrong icon until first click.
 *   3. `setTheme` writes to state, DOM attr, and localStorage in one
 *      atomic call so all three stay consistent.
 *
 * `ready` starts false during SSR/first-render and flips true after the
 * mount effect runs. Consumers should render a neutral placeholder while
 * !ready to avoid hydration mismatches (server always renders "dark"
 * default, client may resolve to "light" from localStorage).
 */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>("dark");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (saved === "dark" || saved === "light") {
        setThemeState(saved);
      } else {
        // No saved preference — respect the OS setting on first ever load.
        // Only runs once because the else-branch is unreachable after we
        // save any explicit choice (via setTheme below).
        const prefersLight = window.matchMedia?.(
          "(prefers-color-scheme: light)"
        ).matches;
        if (prefersLight) {
          setThemeState("light");
          document.documentElement.setAttribute("data-theme", "light");
        }
      }
    } catch {
      // localStorage disabled/blocked — silently keep the default dark.
    }
    setReady(true);
  }, []);

  const setTheme = (t: Theme) => {
    setThemeState(t);
    document.documentElement.setAttribute("data-theme", t);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, t);
    } catch {
      // ignore
    }
  };

  const toggle = () => setTheme(theme === "dark" ? "light" : "dark");

  return { theme, setTheme, toggle, ready };
}
