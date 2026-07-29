"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { Menu, X } from "lucide-react";
import {
  STUDIO_THEMES,
  isStudioThemeActive,
} from "@/lib/studio/themes";
import { cn } from "@/lib/utils";
import { NAV_LINKS, studioSectionActive } from "./navConfig";
import { ThemeToggle } from "./ThemeToggle";
import { SignOutButton } from "./SignOutButton";

/**
 * Mobile chrome companion to NavLinks.
 *
 * Below `md`, TopNav only keeps brand + freshness + refresh; this
 * hamburger opens a full-viewport sheet with every destination,
 * Studio themes, theme toggle, and sign out — so the header never
 * overflows the phone viewport.
 *
 * The sheet is portaled to document.body. TopNav uses backdrop-blur
 * (and overflow-x-hidden), which creates a containing block for
 * position:fixed descendants — without a portal, inset-0 only covers
 * the ~56px header and the menu list is clipped/invisible.
 */
export function MobileNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const titleId = useId();
  const studioActive = studioSectionActive(pathname);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  const sheet =
    open && mounted
      ? createPortal(
          <div
            id="mobile-nav-sheet"
            className="fixed inset-0 z-[60] md:hidden"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
          >
            <button
              type="button"
              aria-label="Close menu"
              className="absolute inset-0 bg-black/45"
              onClick={() => setOpen(false)}
            />
            <div className="absolute inset-0 flex h-[100dvh] flex-col bg-background shadow-lg">
              <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
                <p
                  id={titleId}
                  className="text-sm font-semibold text-foreground"
                >
                  Menu
                </p>
                <button
                  type="button"
                  aria-label="Close menu"
                  onClick={() => setOpen(false)}
                  className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <X size={16} aria-hidden />
                </button>
              </div>

              <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
                <p className="px-2 pb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Studio
                  {studioActive ? (
                    <span className="ml-1.5 normal-case tracking-normal text-[hsl(var(--primary))]">
                      · open
                    </span>
                  ) : null}
                </p>
                <ul className="mb-4 space-y-0.5">
                  {STUDIO_THEMES.map((theme) => {
                    const active = isStudioThemeActive(pathname, theme.href);
                    return (
                      <li key={theme.href}>
                        <Link
                          href={theme.href}
                          className={cn(
                            "flex flex-col rounded-lg px-3 py-2.5 transition-colors",
                            active
                              ? "bg-[hsl(var(--primary)/0.12)] text-foreground"
                              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                          )}
                        >
                          <span className="text-sm font-medium leading-none">
                            {theme.label}
                          </span>
                          <span className="mt-1 text-[11px] leading-none opacity-60">
                            {theme.hint}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>

                <p className="px-2 pb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  App
                </p>
                <ul className="space-y-0.5">
                  {NAV_LINKS.map(({ href, label }) => {
                    const active =
                      href === "/"
                        ? pathname === "/"
                        : pathname.startsWith(href);
                    return (
                      <li key={href}>
                        <Link
                          href={href}
                          className={cn(
                            "block rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                            active
                              ? "bg-[hsl(var(--primary)/0.12)] text-foreground"
                              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                          )}
                        >
                          {label}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </nav>

              <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
                <span className="text-xs text-muted-foreground">Appearance</span>
                <div className="flex items-center gap-2">
                  <ThemeToggle />
                  <SignOutButton />
                </div>
              </div>
            </div>
          </div>,
          document.body
        )
      : null;

  return (
    <div className="md:hidden">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="mobile-nav-sheet"
        aria-label={open ? "Close menu" : "Open menu"}
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        {open ? <X size={16} aria-hidden /> : <Menu size={16} aria-hidden />}
      </button>
      {sheet}
    </div>
  );
}
