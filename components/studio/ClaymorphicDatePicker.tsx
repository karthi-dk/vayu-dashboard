"use client";

import { useEffect, useRef, useState } from "react";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";

/**
 * ClaymorphicDatePicker — themed calendar for the
 * /studio/claymorphic prototype route. Same purpose as the
 * Neumorphic / Glassmorphic variants (avoid the un-styleable
 * native <input type="date"> popup) with clay-language surfaces
 * layered on the periwinkle page shell.
 *
 * Date arithmetic (UTC-anchored, YYYY-MM-DD in/out) is identical
 * to the sibling pickers — only the visual layer differs.
 */

const cm = {
  input: {
    background: "#f0f2fa",
    boxShadow: [
      "inset 0 4px 8px 0 rgba(60, 60, 100, 0.12)",
      "inset 0 -1px 2px 0 rgba(255, 255, 255, 0.7)",
    ].join(", "),
  },
  panel: {
    background: "#ffffff",
    boxShadow: [
      "0 30px 50px -10px rgba(60, 60, 100, 0.30)",
      "0 12px 20px -4px rgba(60, 60, 100, 0.12)",
      "inset 0 8px 12px -4px rgba(255, 255, 255, 1)",
      "inset 0 -6px 10px -4px rgba(60, 60, 100, 0.06)",
    ].join(", "),
  },
  chip: {
    background: "#ffffff",
    boxShadow: [
      "0 6px 12px -3px rgba(60, 60, 100, 0.14)",
      "inset 0 2px 4px -1px rgba(255, 255, 255, 1)",
      "inset 0 -2px 4px -1px rgba(60, 60, 100, 0.05)",
    ].join(", "),
  },
  selectedDay: {
    background: "linear-gradient(180deg, #a78bfa 0%, #7c3aed 100%)",
    boxShadow: [
      "0 10px 18px -4px rgba(124, 58, 237, 0.50)",
      "inset 0 2px 4px -1px rgba(255, 255, 255, 0.40)",
      "inset 0 -2px 4px -1px rgba(0, 0, 0, 0.18)",
    ].join(", "),
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

export function ClaymorphicDatePicker({
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
        className="relative w-full appearance-none rounded-2xl px-4 py-3.5 pr-10 text-left text-base font-medium text-slate-800 outline-none transition-all"
        style={cm.input}
      >
        <span className="block truncate">
          {value ? (
            displayFormat(value)
          ) : (
            <span className="font-normal text-slate-400">Select date</span>
          )}
        </span>
        <Calendar
          size={16}
          strokeWidth={2.5}
          className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-slate-400"
        />
      </button>

      {open && (
        <div
          className="absolute left-0 right-0 top-full z-20 mt-2 min-w-[280px] rounded-3xl p-4"
          style={cm.panel}
        >
          <div className="mb-3 flex items-center justify-between">
            <button
              type="button"
              onClick={prevMonth}
              aria-label="Previous month"
              className="flex h-9 w-9 items-center justify-center rounded-full text-slate-700 transition-transform active:scale-95"
              style={cm.chip}
            >
              <ChevronLeft size={16} strokeWidth={2.5} />
            </button>
            <div className="text-sm font-bold tracking-tight text-slate-800">
              {MONTH_NAMES[viewMonth]} {viewYear}
            </div>
            <button
              type="button"
              onClick={nextMonth}
              aria-label="Next month"
              className="flex h-9 w-9 items-center justify-center rounded-full text-slate-700 transition-transform active:scale-95"
              style={cm.chip}
            >
              <ChevronRight size={16} strokeWidth={2.5} />
            </button>
          </div>

          <div className="mb-1 grid grid-cols-7 gap-1">
            {WEEKDAY_NAMES.map((w, i) => (
              <div
                key={i}
                className="py-1 text-center text-[10px] font-bold uppercase tracking-wider text-slate-400"
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
                ? "text-white font-bold"
                : isToday && cell.inMonth
                  ? "text-violet-700 font-bold bg-violet-100"
                  : cell.inMonth
                    ? "text-slate-700 hover:bg-slate-100 font-medium"
                    : "text-slate-300 font-medium";
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    onChange(iso);
                    setOpen(false);
                  }}
                  aria-selected={isSelected}
                  className={`flex h-9 w-full items-center justify-center rounded-xl text-xs tabular-nums transition-all ${chipCls}`}
                  style={isSelected ? cm.selectedDay : undefined}
                >
                  {label}
                </button>
              );
            })}
          </div>

          <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-2">
            <button
              type="button"
              onClick={clear}
              className="rounded-lg px-2 py-1 text-xs font-semibold text-slate-500 transition-colors hover:text-slate-700"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={goToToday}
              className="rounded-lg px-2 py-1 text-xs font-bold text-violet-600 transition-colors hover:text-violet-700"
            >
              Today
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
