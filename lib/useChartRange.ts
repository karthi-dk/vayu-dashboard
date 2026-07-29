"use client";

import { useEffect, useState } from "react";

// Chart time-window buttons in reading order (short → long). Used by every
// Overview chart so the selector is uniform. Adding a new option here
// automatically shows up in every RangeSelector without further edits.
export const CHART_RANGES = [
  "1M",
  "3M",
  "6M",
  "1Y",
  "2Y",
  "3Y",
  "5Y",
  "ALL",
] as const;
export type ChartRange = (typeof CHART_RANGES)[number];

/**
 * Filter a date-keyed row list down to the last N months/years.
 *
 * Generic on the row shape so this works for `NwRow[]` and anything else
 * that carries a `date: string` (ISO YYYY-MM-DD) field. Uses the LAST row's
 * date as "now" rather than `new Date()` — this way, when the DB is a day
 * behind (e.g. cron hasn't run yet), the "1M" window still captures a full
 * month of data ending on the last-available snapshot instead of ending on
 * today (and cutting off yesterday's row prematurely).
 */
export function filterByRange<T extends { date: string }>(
  rows: T[],
  range: ChartRange
): T[] {
  if (range === "ALL" || rows.length === 0) return rows;
  const now = new Date(rows[rows.length - 1].date);
  const cutoff = new Date(now);
  if (range === "1M") cutoff.setMonth(now.getMonth() - 1);
  else if (range === "3M") cutoff.setMonth(now.getMonth() - 3);
  else if (range === "6M") cutoff.setMonth(now.getMonth() - 6);
  else if (range === "1Y") cutoff.setFullYear(now.getFullYear() - 1);
  else if (range === "2Y") cutoff.setFullYear(now.getFullYear() - 2);
  else if (range === "3Y") cutoff.setFullYear(now.getFullYear() - 3);
  else if (range === "5Y") cutoff.setFullYear(now.getFullYear() - 5);
  return rows.filter((r) => new Date(r.date) >= cutoff);
}

/**
 * State hook for a chart's selected range, persisted to localStorage.
 *
 * Two-phase persistence pattern:
 *   1. On mount, read from localStorage and hydrate `range`. Meanwhile
 *      `readyForPersist` stays false so we don't immediately clobber the
 *      saved value with the default.
 *   2. After hydration, flip `readyForPersist` and start writing changes.
 *
 * Without step 1's gate, the write-effect would fire on first render with
 * the default "ALL" and overwrite whatever the user previously selected.
 * Same pattern used originally in NWTrendChart; extracted here so all
 * three Overview charts stay in sync.
 *
 * `storageKey` should be unique per chart (e.g. "vayu:nw-trend-range") so
 * separate charts can hold independent windows.
 */
export function useChartRange(
  storageKey: string,
  defaultRange: ChartRange = "ALL"
) {
  const [range, setRange] = useState<ChartRange>(defaultRange);
  const [readyForPersist, setReadyForPersist] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved && (CHART_RANGES as readonly string[]).includes(saved)) {
        setRange(saved as ChartRange);
      }
    } catch {
      // localStorage disabled/blocked (private mode, quotas, etc.) —
      // silently fall through to the default.
    }
    setReadyForPersist(true);
  }, [storageKey]);

  useEffect(() => {
    if (!readyForPersist) return;
    try {
      window.localStorage.setItem(storageKey, range);
    } catch {
      // ignore
    }
  }, [range, readyForPersist, storageKey]);

  return { range, setRange };
}
