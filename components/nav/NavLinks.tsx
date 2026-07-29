"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  STUDIO_THEMES,
  isStudioThemeActive,
} from "@/lib/studio/themes";
import { cn } from "@/lib/utils";
import { NAV_LINKS, studioSectionActive } from "./navConfig";
import { useIsDesktopNav } from "./useIsDesktopNav";

/**
 * Desktop inline nav — Studio dropdown + primary routes.
 * Only mounts when viewport ≥ 1024px (see useIsDesktopNav).
 */
export function NavLinks() {
  const pathname = usePathname();
  const isDesktop = useIsDesktopNav();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const studioActive = studioSectionActive(pathname);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // SSR + phone: render nothing (MobileNav owns chrome).
  if (!isDesktop) return null;

  return (
    <nav className="flex items-center gap-6">
      <div ref={menuRef} className="relative">
        <button
          type="button"
          aria-expanded={open}
          aria-haspopup="menu"
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "inline-flex items-center gap-0.5 text-sm font-medium transition-colors",
            studioActive
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          Studio
          <ChevronDown
            size={14}
            className={cn(
              "opacity-70 transition-transform",
              open && "rotate-180"
            )}
            aria-hidden
          />
        </button>
        {open && (
          <div
            role="menu"
            className="absolute left-0 top-full z-50 mt-2 min-w-[11.5rem] overflow-hidden rounded-lg border border-border bg-background/95 py-1 shadow-lg backdrop-blur"
          >
            {STUDIO_THEMES.map((theme) => {
              const active = isStudioThemeActive(pathname, theme.href);
              return (
                <Link
                  key={theme.href}
                  role="menuitem"
                  href={theme.href}
                  className={cn(
                    "flex flex-col px-3 py-2 transition-colors",
                    active
                      ? "bg-[hsl(var(--primary)/0.1)] text-foreground"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  )}
                >
                  <span className="text-sm font-medium leading-none">
                    {theme.label}
                  </span>
                  <span className="mt-1 text-[10px] leading-none opacity-60">
                    {theme.hint}
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      {NAV_LINKS.map(({ href, label }) => {
        const active =
          href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "text-sm font-medium transition-colors",
              active
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
