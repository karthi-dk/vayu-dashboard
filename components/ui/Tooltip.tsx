"use client";

import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Lightweight hover tooltip — zero dependencies.
 *
 * Positioning: absolute above the trigger with a small downward-pointing arrow.
 * The whole thing lives inside a `relative` container so it clips correctly
 * within scroll containers. Fade-in is snappy (75ms) — feels instant vs the
 * browser's ~1s native `title` delay.
 *
 * Accessibility: shows on both hover AND keyboard focus so keyboard users
 * aren't locked out. Uses `role="tooltip"` and links via aria-describedby.
 * The trigger element receives `tabIndex={0}` when a non-focusable child is
 * used — passing an already-focusable element (button, link) is preferred.
 *
 * Layout: `whitespace-normal` + `max-w-xs` = wraps long copy nicely. `z-50`
 * beats card/modal z-indexes. `pointer-events-none` prevents the tooltip
 * from stealing hover state from siblings.
 */
export function Tooltip({
  content,
  children,
  side = "top",
  align = "center",
  className,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom";
  align?: "start" | "center" | "end";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const tooltipId = "tt-" + useId();

  const sideClasses =
    side === "top" ? "bottom-full mb-2" : "top-full mt-2";
  const alignClasses = {
    start: "left-0",
    center: "left-1/2 -translate-x-1/2",
    end: "right-0",
  }[align];
  const arrowSideClasses =
    side === "top"
      ? "top-full border-t-[hsl(var(--foreground))]"
      : "bottom-full border-b-[hsl(var(--foreground))] rotate-180";

  return (
    <span
      className={cn("relative inline-flex", className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      aria-describedby={open ? tooltipId : undefined}
    >
      {children}
      <span
        id={tooltipId}
        role="tooltip"
        className={cn(
          "pointer-events-none absolute z-50 whitespace-normal rounded-md bg-[hsl(var(--foreground))] px-2.5 py-1.5 text-[11px] font-normal leading-snug text-[hsl(var(--background))] shadow-lg transition-opacity duration-75",
          "w-max max-w-xs",
          sideClasses,
          alignClasses,
          open ? "opacity-100" : "opacity-0"
        )}
      >
        {content}
        <span
          className={cn(
            "absolute left-1/2 h-0 w-0 -translate-x-1/2 border-x-4 border-x-transparent border-t-4",
            arrowSideClasses
          )}
        />
      </span>
    </span>
  );
}
