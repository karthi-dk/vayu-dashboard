"use client";

import { cn } from "@/lib/utils";
import { CHART_RANGES, type ChartRange } from "@/lib/useChartRange";

/**
 * Compact range picker: pill of 7 buttons (1M, 6M, 1Y, 2Y, 3Y, 5Y, ALL).
 *
 * Rendered top-right of each chart card. Behavior:
 *   - `value`   controls which button is highlighted (uses primary bg)
 *   - `onChange` fires with the clicked range
 *
 * The list of ranges comes from CHART_RANGES so adding/removing buttons
 * is a one-line change in useChartRange.ts and every selector updates
 * automatically. All-caps + narrow padding keeps the 7-button pill
 * compact enough to fit the card header on desktop widths.
 */
export function RangeSelector({
  value,
  onChange,
}: {
  value: ChartRange;
  onChange: (r: ChartRange) => void;
}) {
  return (
    <div className="flex gap-1 rounded-md border border-border p-0.5">
      {CHART_RANGES.map((r) => (
        <button
          key={r}
          onClick={() => onChange(r)}
          className={cn(
            "rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-colors",
            value === r
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {r}
        </button>
      ))}
    </div>
  );
}
