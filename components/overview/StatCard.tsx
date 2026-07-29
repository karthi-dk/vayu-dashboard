"use client";

import {
  Area,
  AreaChart,
  ResponsiveContainer,
  YAxis,
} from "recharts";
import { TrendingDown, TrendingUp } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { cn, fmtINR, fmtL } from "@/lib/utils";

export function StatCard({
  label,
  meta,
  value,
  subline,
  pctOfNw,
  sparkData,
  dayChange,
  dayChangeSince,
  dayChangeTitle,
}: {
  label: string;
  meta: string;
  value: number;
  subline: React.ReactNode;
  pctOfNw: number;
  sparkData: { v: number }[];
  // 1D chip. Passing null omits the chip.
  dayChange?: { inr: number; pct: number } | null;
  // Human-readable date label of the prior snapshot the diff is against.
  // Used purely for the hover title so the user can tell whether "1D"
  // really means yesterday (=1D) or spans a skipped day (=2D+).
  dayChangeSince?: string | null;
  // Full override for the tooltip text. When set, replaces the default
  // "Change since {date} snapshot" template. Used by the MF card to show
  // "Groww 1D returns …" since Groww's oneDayReturnValue is a fund-level
  // NAV-pair delta, not a snapshot-to-snapshot diff.
  dayChangeTitle?: string;
}) {
  const gradId = `spark-${label.replace(/\s+/g, "-").toLowerCase()}`;
  const changePositive = dayChange ? dayChange.inr >= 0 : true;
  return (
    <Card className="flex flex-col overflow-hidden">
      <div className="p-4 pb-2 sm:p-5 sm:pb-2">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-sm font-semibold text-foreground">{label}</div>
            <div className="mt-0.5 kicker">{meta}</div>
          </div>
          <span className="text-xs font-medium text-muted-foreground">
            {pctOfNw.toFixed(1)}%
          </span>
        </div>
        <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <div className="text-2xl font-bold text-foreground">
            {fmtL(value)}
          </div>
          {dayChange && (
            <span
              className={cn(
                "inline-flex items-center gap-1 text-xs font-medium",
                changePositive
                  ? "text-[hsl(var(--success))]"
                  : "text-[hsl(var(--danger))]"
              )}
              title={
                dayChangeTitle ??
                (dayChangeSince
                  ? `Change since ${dayChangeSince} snapshot`
                  : "Change since previous snapshot")
              }
            >
              {changePositive ? (
                <TrendingUp size={11} />
              ) : (
                <TrendingDown size={11} />
              )}
              {changePositive ? "+" : ""}
              {fmtINR(dayChange.inr)}
              <span className="text-muted-foreground">
                ({changePositive ? "+" : ""}
                {dayChange.pct.toFixed(2)}%)
              </span>
              <span className="text-[10px] uppercase text-muted-foreground">
                1D
              </span>
            </span>
          )}
        </div>
        <div className={cn("mt-1 text-xs text-muted-foreground")}>{subline}</div>
      </div>
      <div className="mt-2 h-14">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={sparkData} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.4} />
                <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            {/* Zoom the vertical axis to the data range so the wave
                actually reads. Default Recharts axis is [0, dataMax],
                which crushes a stat like MF (₹37 L → ₹39 L over 30
                days) into ~5% of the chart height — visually flat.
                dataMin/dataMax + 4 px top/bottom padding gives the
                curve breathing room while keeping the whole span
                on-screen. The hidden axis has no ticks/labels so the
                card still reads as a pure sparkline.

                The Area's fill baseline follows the axis' dataMin
                (Recharts default when baseValue is unset), so the
                filled area shows the shape above the low-water mark
                rather than the whole column down to y=0 — which is
                the point of zooming in the first place. */}
            <YAxis
              hide
              domain={["dataMin", "dataMax"]}
              padding={{ top: 4, bottom: 4 }}
            />
            <Area
              type="monotone"
              dataKey="v"
              stroke="hsl(var(--primary))"
              strokeWidth={1.5}
              fill={`url(#${gradId})`}
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
