"use client";

import { useEffect, useRef, useState } from "react";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";

/**
 * NeumorphicDatePicker — themed calendar for the /studio/neumorphic
 * prototype route.
 *
 * Same problem as NeumorphicSelect: <input type="date"> pops an
 * OS/browser-rendered picker that CSS can't reach — bright white
 * card with system-blue selection strip, breaks the pastel
 * illusion instantly (see screenshot from 2026-07-26). To evaluate
 * the neumorphic direction properly the picker has to sit in the
 * same visual language as the rest of the form.
 *
 * Trade-offs vs native
 * --------------------
 *   • Loses OS-level date pickers (iOS scrolling wheels, Android
 *     material dialogs). Real UX cost on mobile that we'd revisit
 *     with a coarse-pointer media-query if the design ships.
 *   • ~200 LoC of grid math + keyboard/click handling. Reasonable
 *     for prototype scope, not a substitute for react-day-picker
 *     if we ever ship this at scale.
 *   • Only supports single-date selection (which is all /studio
 *     needs — the entry form logs a single NAV date). No range,
 *     no multi-select, no time.
 *
 * Date handling
 * -------------
 * Values are `YYYY-MM-DD` strings (matches native <input type="date">
 * and the shape logMfTransaction expects). All Date construction
 * uses UTC anchors — the calendar grid is purely calendrical, so
 * getting caught by DST or timezone offsets would flip
 * neighbouring days on the boundary hour. UTC keeps the arithmetic
 * deterministic; the user's local timezone doesn't affect which
 * day appears where in the grid.
 *
 * "Today" jumps to today in IST (matches the /studio "yesterday"
 * anchor and Vayu's overall India-first date convention).
 */

// Duplicated neumorphic shadow tokens for component isolation.
// See NeumorphicOrderEntryLanding / NeumorphicSelect for the same
// pattern; a shared lib/neumorphic module is the extraction point
// if the design gets promoted out of prototype.
const nm = {
  raisedMd: { boxShadow: "-8px -8px 16px #ffffff, 8px 8px 16px #a3b1c6" },
  raisedSm: { boxShadow: "-4px -4px 8px #ffffff, 4px 4px 8px #a3b1c6" },
  inset: {
    boxShadow: "inset 4px 4px 8px #a3b1c6, inset -4px -4px 8px #ffffff",
  },
  selectedDay: {
    // Colored variant of raisedSm — same depth cue, indigo instead
    // of the surface bg. Selected day floats on the calendar grid.
    boxShadow: "-2px -2px 6px #8a99e8, 2px 2px 6px #5a6dc9",
  },
} as const;

// Strict YYYY-MM-DD parser. Returns null for anything that doesn't
// match — we never want a Date.parse() surprise (which happily
// coerces "abc" or "2026-13-99" into weird dates).
function parseISODate(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const [, y, mo, d] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
}

function toISODate(d: Date): string {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

// Indian display convention (DD/MM/YYYY) — matches the format the
// native <input type="date"> was rendering on the user's device.
function displayFormat(iso: string): string {
  const d = parseISODate(iso);
  if (!d) return "";
  const day = String(d.getUTCDate()).padStart(2, "0");
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const y = d.getUTCFullYear();
  return `${day}/${mo}/${y}`;
}

function todayISO_IST(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${d}`;
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
// Sunday-first (matches Indian convention & the native picker in
// the user's screenshot).
const WEEKDAY_NAMES = ["S", "M", "T", "W", "T", "F", "S"];

export function NeumorphicDatePicker({
  value,
  onChange,
  className = "",
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  // Anchor is the month currently DISPLAYED in the grid. Kept
  // separate from `value` so the user can browse forward/back
  // without committing a selection.
  const [viewYear, setViewYear] = useState<number>(() => {
    const d = parseISODate(value) ?? parseISODate(todayISO_IST())!;
    return d.getUTCFullYear();
  });
  const [viewMonth, setViewMonth] = useState<number>(() => {
    const d = parseISODate(value) ?? parseISODate(todayISO_IST())!;
    return d.getUTCMonth();
  });
  const rootRef = useRef<HTMLDivElement>(null);

  // On open, jump the calendar to the month of the currently-
  // selected value (or today if empty). Without this, opening
  // after browsing away leaves the grid on the wrong month.
  useEffect(() => {
    if (open) {
      const d = parseISODate(value) ?? parseISODate(todayISO_IST())!;
      setViewYear(d.getUTCFullYear());
      setViewMonth(d.getUTCMonth());
    }
  }, [open, value]);

  // Click-outside → close. Same mousedown timing rationale as
  // NeumorphicSelect (immediate response before any adjacent
  // click handler fires).
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear(viewYear - 1);
    } else {
      setViewMonth(viewMonth - 1);
    }
  };

  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear(viewYear + 1);
    } else {
      setViewMonth(viewMonth + 1);
    }
  };

  const goToToday = () => {
    const today = todayISO_IST();
    onChange(today);
    setOpen(false);
  };

  const clear = () => {
    onChange("");
    setOpen(false);
  };

  // Grid math — 6 rows × 7 cols = 42 cells with prev/next-month
  // spillover for a stable panel height (no jumps between 4-row
  // and 6-row months).
  const firstOfMonth = new Date(Date.UTC(viewYear, viewMonth, 1));
  const startWeekday = firstOfMonth.getUTCDay();
  const daysInMonth = new Date(
    Date.UTC(viewYear, viewMonth + 1, 0),
  ).getUTCDate();
  const daysInPrevMonth = new Date(
    Date.UTC(viewYear, viewMonth, 0),
  ).getUTCDate();

  const cells: { date: Date; inMonth: boolean }[] = [];
  for (let i = startWeekday - 1; i >= 0; i--) {
    cells.push({
      date: new Date(Date.UTC(viewYear, viewMonth - 1, daysInPrevMonth - i)),
      inMonth: false,
    });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({
      date: new Date(Date.UTC(viewYear, viewMonth, d)),
      inMonth: true,
    });
  }
  const trailing = 42 - cells.length;
  for (let d = 1; d <= trailing; d++) {
    cells.push({
      date: new Date(Date.UTC(viewYear, viewMonth + 1, d)),
      inMonth: false,
    });
  }

  const todayIso = todayISO_IST();
  const selectedIso = value;

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        className="relative w-full appearance-none rounded-2xl bg-[#e0e5ec] px-4 py-3 pr-10 text-left text-base text-[#4a5568] outline-none transition-all"
        style={nm.inset}
      >
        <span className="block truncate">
          {value ? (
            displayFormat(value)
          ) : (
            <span className="text-[#a6b0c0]">Select date</span>
          )}
        </span>
        <Calendar
          size={14}
          className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[#8a94a7]"
        />
      </button>

      {open && (
        // Panel sits directly below the trigger. min-width floors
        // the day grid at a comfortable 7-column layout even when
        // the trigger is narrow (e.g. inside a flex-1 sibling).
        // On the standard NAV date field the trigger is full
        // width, so the panel matches the trigger width.
        <div
          className="absolute left-0 right-0 top-full z-20 mt-2 min-w-[280px] rounded-2xl bg-[#e0e5ec] p-4"
          style={nm.raisedMd}
        >
          {/* Month / year nav */}
          <div className="mb-3 flex items-center justify-between">
            <button
              type="button"
              onClick={prevMonth}
              aria-label="Previous month"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-[#e0e5ec] text-[#4a5568] transition-colors"
              style={nm.raisedSm}
            >
              <ChevronLeft size={14} />
            </button>
            <div className="text-sm font-semibold tracking-tight text-[#4a5568]">
              {MONTH_NAMES[viewMonth]} {viewYear}
            </div>
            <button
              type="button"
              onClick={nextMonth}
              aria-label="Next month"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-[#e0e5ec] text-[#4a5568] transition-colors"
              style={nm.raisedSm}
            >
              <ChevronRight size={14} />
            </button>
          </div>

          {/* Weekday header */}
          <div className="mb-1 grid grid-cols-7 gap-1">
            {WEEKDAY_NAMES.map((w, i) => (
              <div
                key={i}
                className="py-1 text-center text-[10px] font-semibold uppercase tracking-wider text-[#8a94a7]"
              >
                {w}
              </div>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7 gap-1">
            {cells.map((cell, i) => {
              const iso = toISODate(cell.date);
              const isSelected = iso === selectedIso;
              const isToday = iso === todayIso;
              const label = String(cell.date.getUTCDate());
              // Priority: selected wins (indigo raised chip). Then
              // today (indigo text on transparent bg). Then
              // in-month vs spillover (primary vs muted text).
              const chipCls = isSelected
                ? "bg-[#6c7fdd] text-white font-semibold"
                : isToday && cell.inMonth
                  ? "text-[#6c7fdd] font-semibold"
                  : cell.inMonth
                    ? "text-[#4a5568]"
                    : "text-[#a6b0c0]";
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    onChange(iso);
                    setOpen(false);
                  }}
                  aria-selected={isSelected}
                  className={`flex h-8 w-full items-center justify-center rounded-lg text-xs tabular-nums transition-all ${chipCls}`}
                  style={isSelected ? nm.selectedDay : undefined}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {/* Bottom actions — mirrors the "Clear / Today" affordances
              from Vayu's native picker screenshot, restyled to
              the neumorphic muted / accent language. */}
          <div className="mt-3 flex items-center justify-between border-t border-[#c9d0d9] pt-2">
            <button
              type="button"
              onClick={clear}
              className="rounded-md px-2 py-1 text-xs text-[#8a94a7] transition-colors hover:text-[#4a5568]"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={goToToday}
              className="rounded-md px-2 py-1 text-xs font-medium text-[#6c7fdd] transition-colors hover:text-[#5a6dc9]"
            >
              Today
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
