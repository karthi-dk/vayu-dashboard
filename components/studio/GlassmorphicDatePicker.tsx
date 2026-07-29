"use client";

import { useEffect, useRef, useState } from "react";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";

/**
 * GlassmorphicDatePicker — themed calendar for the
 * /studio/glassmorphic prototype route. Same purpose as
 * NeumorphicDatePicker (avoid the un-styleable native
 * <input type="date"> popup) with glass surfaces layered over
 * the aurora backdrop instead of soft-pastel extrusion.
 *
 * Date arithmetic (UTC-anchored, YYYY-MM-DD in/out) is identical
 * to the neumorphic variant — only the visual layer differs.
 */

const gm = {
  input: {
    background: "rgba(255, 255, 255, 0.08)",
    backdropFilter: "blur(12px) saturate(180%)",
    WebkitBackdropFilter: "blur(12px) saturate(180%)",
    border: "1px solid rgba(255, 255, 255, 0.15)",
  },
  // Popover panel — see the iteration history in
  // GlassmorphicSelect.tsx's panel comment. Same layered
  // approach: ~92% opaque slate base + subtle aurora-tint
  // wash + backdrop blur, tuned to occlude the form fields
  // beneath while preserving the glass character at the edges.
  panel: {
    background:
      "linear-gradient(rgba(139, 92, 246, 0.08), rgba(59, 130, 246, 0.08)), rgba(15, 15, 30, 0.92)",
    backdropFilter: "blur(30px) saturate(180%)",
    WebkitBackdropFilter: "blur(30px) saturate(180%)",
    border: "1px solid rgba(255, 255, 255, 0.20)",
    boxShadow: "0 20px 50px 0 rgba(0, 0, 0, 0.55)",
  },
  chip: {
    background: "rgba(255, 255, 255, 0.10)",
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)",
    border: "1px solid rgba(255, 255, 255, 0.18)",
  },
  // Selected-day accent — fuchsia glass with a bright glow
  selectedDay: {
    background:
      "linear-gradient(135deg, rgba(240, 171, 252, 0.85), rgba(192, 132, 252, 0.85))",
    border: "1px solid rgba(255, 255, 255, 0.4)",
    boxShadow: "0 4px 16px 0 rgba(240, 171, 252, 0.4)",
  },
} as const;

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
const WEEKDAY_NAMES = ["S", "M", "T", "W", "T", "F", "S"];

export function GlassmorphicDatePicker({
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
  const [viewYear, setViewYear] = useState<number>(() => {
    const d = parseISODate(value) ?? parseISODate(todayISO_IST())!;
    return d.getUTCFullYear();
  });
  const [viewMonth, setViewMonth] = useState<number>(() => {
    const d = parseISODate(value) ?? parseISODate(todayISO_IST())!;
    return d.getUTCMonth();
  });
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      const d = parseISODate(value) ?? parseISODate(todayISO_IST())!;
      setViewYear(d.getUTCFullYear());
      setViewMonth(d.getUTCMonth());
    }
  }, [open, value]);

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
    onChange(todayISO_IST());
    setOpen(false);
  };
  const clear = () => {
    onChange("");
    setOpen(false);
  };

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
        className="relative w-full appearance-none rounded-2xl px-4 py-3 pr-10 text-left text-base text-white outline-none transition-all"
        style={gm.input}
      >
        <span className="block truncate">
          {value ? (
            displayFormat(value)
          ) : (
            <span className="text-white/40">Select date</span>
          )}
        </span>
        <Calendar
          size={14}
          className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-white/60"
        />
      </button>

      {open && (
        <div
          className="absolute left-0 right-0 top-full z-20 mt-2 min-w-[280px] rounded-2xl p-4"
          style={gm.panel}
        >
          <div className="mb-3 flex items-center justify-between">
            <button
              type="button"
              onClick={prevMonth}
              aria-label="Previous month"
              className="flex h-8 w-8 items-center justify-center rounded-full text-white transition-colors hover:bg-white/10"
              style={gm.chip}
            >
              <ChevronLeft size={14} />
            </button>
            <div className="text-sm font-semibold tracking-tight text-white">
              {MONTH_NAMES[viewMonth]} {viewYear}
            </div>
            <button
              type="button"
              onClick={nextMonth}
              aria-label="Next month"
              className="flex h-8 w-8 items-center justify-center rounded-full text-white transition-colors hover:bg-white/10"
              style={gm.chip}
            >
              <ChevronRight size={14} />
            </button>
          </div>

          <div className="mb-1 grid grid-cols-7 gap-1">
            {WEEKDAY_NAMES.map((w, i) => (
              <div
                key={i}
                className="py-1 text-center text-[10px] font-semibold uppercase tracking-wider text-white/50"
              >
                {w}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-1">
            {cells.map((cell, i) => {
              const iso = toISODate(cell.date);
              const isSelected = iso === selectedIso;
              const isToday = iso === todayIso;
              const label = String(cell.date.getUTCDate());
              const chipCls = isSelected
                ? "text-white font-semibold"
                : isToday && cell.inMonth
                  ? "text-fuchsia-200 font-semibold ring-1 ring-fuchsia-300/50 ring-inset"
                  : cell.inMonth
                    ? "text-white/85 hover:bg-white/10"
                    : "text-white/25";
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    onChange(iso);
                    setOpen(false);
                  }}
                  aria-selected={isSelected}
                  className={`flex h-8 w-full items-center justify-center rounded-lg text-xs tabular-nums transition-colors ${chipCls}`}
                  style={isSelected ? gm.selectedDay : undefined}
                >
                  {label}
                </button>
              );
            })}
          </div>

          <div className="mt-3 flex items-center justify-between border-t border-white/10 pt-2">
            <button
              type="button"
              onClick={clear}
              className="rounded-md px-2 py-1 text-xs text-white/60 transition-colors hover:text-white/90"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={goToToday}
              className="rounded-md px-2 py-1 text-xs font-medium text-fuchsia-200 transition-colors hover:text-fuchsia-100"
            >
              Today
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
