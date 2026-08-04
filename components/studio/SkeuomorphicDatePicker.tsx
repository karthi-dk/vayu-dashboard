"use client";

import { useEffect, useRef, useState } from "react";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";

const sk = {
  input: {
    background: "linear-gradient(180deg, #fdf8ee 0%, #f3e6cf 100%)",
    border: "1px solid #b29871",
    boxShadow: [
      "inset 0 2px 4px rgba(95, 66, 35, 0.16)",
      "inset 0 1px 0 rgba(255, 255, 255, 0.65)",
    ].join(", "),
  },
  panel: {
    background: "linear-gradient(180deg, #f6efdf 0%, #eadcc2 100%)",
    border: "1px solid #bda47f",
    boxShadow: [
      "0 20px 34px -12px rgba(72, 48, 24, 0.34)",
      "0 5px 10px -3px rgba(72, 48, 24, 0.22)",
      "inset 0 1px 0 rgba(255, 255, 255, 0.7)",
    ].join(", "),
  },
  chip: {
    background: "linear-gradient(180deg, #f3e8d2 0%, #e3d2b2 100%)",
    border: "1px solid #af9166",
    boxShadow: [
      "0 4px 8px rgba(81, 56, 29, 0.20)",
      "inset 0 1px 0 rgba(255, 255, 255, 0.70)",
    ].join(", "),
  },
  selectedDay: {
    background: "linear-gradient(180deg, #8a6332 0%, #6e4c24 100%)",
    border: "1px solid #5f3f1d",
    boxShadow: [
      "0 8px 14px -4px rgba(74, 48, 19, 0.52)",
      "inset 0 1px 0 rgba(255, 233, 197, 0.28)",
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

export function SkeuomorphicDatePicker({
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
        className="relative w-full appearance-none rounded-2xl px-4 py-3.5 pr-10 text-left text-base font-medium text-[#3f2e1a] outline-none transition-all"
        style={sk.input}
      >
        <span className="block truncate">
          {value ? (
            displayFormat(value)
          ) : (
            <span className="font-normal text-[#806346]">Select date</span>
          )}
        </span>
        <Calendar
          size={16}
          strokeWidth={2.5}
          className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[#7a6242]"
        />
      </button>

      {open && (
        <div
          className="absolute left-0 right-0 top-full z-20 mt-2 min-w-[280px] rounded-2xl p-4"
          style={sk.panel}
        >
          <div className="mb-3 flex items-center justify-between">
            <button
              type="button"
              onClick={prevMonth}
              aria-label="Previous month"
              className="flex h-9 w-9 items-center justify-center rounded-full text-[#4f391f] transition-transform active:scale-95"
              style={sk.chip}
            >
              <ChevronLeft size={16} strokeWidth={2.5} />
            </button>
            <div className="text-sm font-bold tracking-tight text-[#4f391f]">
              {MONTH_NAMES[viewMonth]} {viewYear}
            </div>
            <button
              type="button"
              onClick={nextMonth}
              aria-label="Next month"
              className="flex h-9 w-9 items-center justify-center rounded-full text-[#4f391f] transition-transform active:scale-95"
              style={sk.chip}
            >
              <ChevronRight size={16} strokeWidth={2.5} />
            </button>
          </div>

          <div className="mb-1 grid grid-cols-7 gap-1">
            {WEEKDAY_NAMES.map((w, i) => (
              <div
                key={i}
                className="py-1 text-center text-[10px] font-bold uppercase tracking-wider text-[#8a7050]"
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
                ? "text-[#fff7e8] font-bold"
                : isToday && cell.inMonth
                  ? "text-[#7a5427] font-bold bg-[#e8d5b5]"
                  : cell.inMonth
                    ? "text-[#4f391f] hover:bg-[#ecdcc2] font-medium"
                    : "text-[#a1845e] font-medium";
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
                  style={isSelected ? sk.selectedDay : undefined}
                >
                  {label}
                </button>
              );
            })}
          </div>

          <div className="mt-3 flex items-center justify-between border-t border-[#d8c6a8] pt-2">
            <button
              type="button"
              onClick={clear}
              className="rounded-lg px-2 py-1 text-xs font-semibold text-[#7a6242] transition-colors hover:text-[#4f391f]"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={goToToday}
              className="rounded-lg px-2 py-1 text-xs font-bold text-[#6e4c24] transition-colors hover:text-[#5b3e1b]"
            >
              Today
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
