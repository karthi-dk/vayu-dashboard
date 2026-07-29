"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/lib/theme";

/**
 * Header light/dark toggle.
 *
 * Icon convention: shows the target state, not the current one — so in
 * dark mode you see a Sun (meaning "click to go light"), and in light
 * mode you see a Moon (meaning "click to go dark"). This makes the
 * button's action discoverable without a label.
 *
 * Rendered inside a server component (TopNav), so it lives in its own
 * client-component file to avoid marking the whole header as client.
 * A neutral placeholder is rendered while `ready` is false so the
 * server-rendered HTML (always "dark") never differs from the first
 * client render (which may resolve to "light" from localStorage) —
 * that's the classic React 18 hydration-mismatch trap for theme togglers.
 */
export function ThemeToggle() {
  const { theme, toggle, ready } = useTheme();

  return (
    <button
      onClick={toggle}
      aria-label={
        !ready
          ? "Toggle theme"
          : theme === "dark"
            ? "Switch to light mode"
            : "Switch to dark mode"
      }
      className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {ready ? (
        theme === "dark" ? (
          <Sun size={14} />
        ) : (
          <Moon size={14} />
        )
      ) : (
        // Placeholder while hydrating — keeps the button width stable and
        // avoids the "server rendered Moon, client wants Sun" mismatch.
        <span className="h-[14px] w-[14px]" aria-hidden />
      )}
    </button>
  );
}
