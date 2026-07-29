"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  STUDIO_THEMES,
  isStudioThemeActive,
} from "@/lib/studio/themes";
import { cn } from "@/lib/utils";

/**
 * Compact theme switcher for Studio routes.
 *
 * TopNav is hidden on /studio* for recording. This pill sits top-right
 * so it stays out of the middle of the frame while still giving
 * one-tap deep links across Classic / Clay / Glass / Soft.
 */
export function StudioThemeSwitch() {
  const pathname = usePathname();
  if (!(pathname === "/studio" || pathname.startsWith("/studio/"))) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed right-3 top-3 z-50 sm:right-5">
      <nav
        aria-label="Studio themes"
        className="pointer-events-auto flex items-center gap-0.5 rounded-full border border-black/10 bg-white/75 p-1 shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-black/45"
      >
        {STUDIO_THEMES.map((theme) => {
          const active = isStudioThemeActive(pathname, theme.href);
          return (
            <Link
              key={theme.href}
              href={theme.href}
              title={theme.hint}
              className={cn(
                "rounded-full px-2.5 py-1 text-[11px] font-medium tracking-wide transition-colors sm:px-3 sm:text-xs",
                active
                  ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] shadow-sm"
                  : "text-black/55 hover:bg-black/5 hover:text-black/85 dark:text-white/55 dark:hover:bg-white/10 dark:hover:text-white/90"
              )}
            >
              {theme.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
