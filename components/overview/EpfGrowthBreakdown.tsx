"use client";

import { useMemo } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card } from "@/components/ui/Card";
import { RangeSelector } from "@/components/ui/RangeSelector";
import { cn, fmtCompactINR } from "@/lib/utils";
import { filterByRange, useChartRange } from "@/lib/useChartRange";
import type { EpfDailyRow } from "@/lib/epf/epfHistory";

/**
 * EPF · Growth breakdown — the EPF analogue of NpsGrowthBreakdown /
 * MFGrowthBreakdown. Reconstructed from the EPFO passbook history
 * (lib/epf/epfHistory.ts), Pension (EPS) excluded.
 *
 * Anatomy
 * ───────
 * SummaryStrip (top):
 *   • Hero: "Your EPF grew by +₹X"
 *   • Arithmetic strip: contributions + interest = value
 *   • Both read the LAST row of `series[]` so they update in lockstep
 *     with the range selector.
 * Stacked areas:
 *   • Contributions (blue, always ≥ 0)  → employee + employer money in
 *   • Interest (green, always ≥ 0)      → EPFO interest, credited annually
 * Overlaid solid line:
 *   • Total value = contributions + interest
 *
 * WHY NO NEGATIVE CARVE-OUT (unlike MF/NPS market return)
 * ──────────────────────────────────────────────────────
 * EPF interest is a guaranteed, annually-credited rate — it only ever
 * adds. There are no cash withdrawals in the history (inter-account
 * transfers keep money inside EPF), so both bands are monotonically
 * non-decreasing and the curve never dips. A single green interest
 * area suffices; no red loss band.
 *
 * Anchoring mirrors the sibling charts: cumulative sums are anchored to
 * the row ONE BEFORE the filtered window (or (0,0) if the window
 * includes the very first point), so the SummaryStrip's "grew by" total
 * agrees with the tooltip's Net change at the right edge.
 */

const STORAGE_KEY = "vayu:epf-growth-breakdown-range";

const MONTHS = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

type Row = {
  date: string;
  cumContributions: number;
  cumInterest: number;
  cumTotal: number;
  /**
   * Effective return for the window as of this row:
   * `cumInterest / max(anchor.value, cumContributions) × 100`.
   * On the ALL range (anchor.value = 0) this collapses to
   * interest / contributions — the lifetime interest-on-contributions.
   * `null` when the denominator is ≤ 0.
   */
  returnPct: number | null;
};

function BreakdownTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload: Row }[];
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const d = new Date(p.date);
  const label = `${d.getDate().toString().padStart(2, "0")} ${
    MONTHS[d.getMonth()]
  } ${d.getFullYear()}`;
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 shadow-md">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <TooltipRow
        swatch="hsl(var(--primary))"
        label="Contributions"
        value={p.cumContributions}
      />
      <TooltipRow
        swatch="hsl(var(--success))"
        label="Interest"
        value={p.cumInterest}
      />
      <div className="my-1 h-px bg-border/60" />
      <TooltipRow
        swatch="hsl(var(--foreground))"
        label="Net change"
        value={p.cumTotal}
        bold
      />
      {p.returnPct !== null && <TooltipReturnRow value={p.returnPct} />}
    </div>
  );
}

function TooltipReturnRow({ value }: { value: number }) {
  const positive = value >= 0;
  return (
    <div className="flex items-center justify-between gap-4 pl-3.5 text-[11px]">
      <span className="text-muted-foreground">Return</span>
      <span
        className={cn(
          "font-semibold tabular-nums",
          positive
            ? "text-[hsl(var(--success))]"
            : "text-[hsl(var(--danger))]"
        )}
      >
        {positive ? "+" : ""}
        {value.toFixed(2)}%
      </span>
    </div>
  );
}

function TooltipRow({
  swatch,
  label,
  value,
  bold = false,
}: {
  swatch: string;
  label: string;
  value: number;
  bold?: boolean;
}) {
  const positive = value >= 0;
  return (
    <div className="flex items-center justify-between gap-4 text-[11px]">
      <div className="flex items-center gap-1.5">
        <span
          aria-hidden
          className="inline-block h-2 w-2 rounded-sm"
          style={{ background: swatch }}
        />
        <span className="text-muted-foreground">{label}</span>
      </div>
      <span
        className={cn(
          "tabular-nums",
          bold ? "font-semibold text-foreground" : "text-foreground"
        )}
      >
        {bold ? "" : positive ? "+" : ""}
        {fmtCompactINR(value)}
      </span>
    </div>
  );
}

export function EpfGrowthBreakdown({ history }: { history: EpfDailyRow[] }) {
  const { range, setRange } = useChartRange(STORAGE_KEY, "ALL");

  const series = useMemo<Row[]>(() => {
    const filtered = filterByRange(history, range);
    if (filtered.length < 2) return [];

    const firstFilteredIdx = history.indexOf(filtered[0]);
    const anchor =
      firstFilteredIdx > 0
        ? {
            contributions: history[firstFilteredIdx - 1].epf_contribution,
            value: history[firstFilteredIdx - 1].epf_value,
          }
        : { contributions: 0, value: 0 };

    return filtered.map((r) => {
      const cumContributions = r.epf_contribution - anchor.contributions;
      // Interest = whatever's left of the value change after contributions.
      // Equivalent to r.epf_interest − anchor interest; both are ≥ 0.
      const cumInterest = r.epf_value - anchor.value - cumContributions;
      const denominator = Math.max(anchor.value, cumContributions);
      const returnPct =
        denominator > 0 ? (cumInterest / denominator) * 100 : null;
      return {
        date: r.date,
        cumContributions,
        cumInterest,
        cumTotal: r.epf_value - anchor.value,
        returnPct,
      };
    });
  }, [history, range]);

  const single = series.length <= 1;

  const spanDays =
    series.length > 1
      ? (new Date(series[series.length - 1].date).getTime() -
          new Date(series[0].date).getTime()) /
        (1000 * 60 * 60 * 24)
      : 0;
  const useYearFormat = spanDays >= 90;

  const rangeLabel = useMemo(() => {
    if (!series.length) return "No history";
    if (series.length === 1) return "Building history · 1 point";
    const first = new Date(series[0].date);
    const last = new Date(series[series.length - 1].date);
    const day = (d: Date) => d.getDate().toString().padStart(2, "0");
    const mon = (d: Date) => d.toLocaleString("en-US", { month: "short" });
    const yr = (d: Date) => d.getFullYear();
    const sameYear = yr(first) === yr(last);
    const sameMonth = sameYear && first.getMonth() === last.getMonth();
    let span: string;
    if (sameMonth) {
      span = `${day(first)} - ${day(last)} ${mon(last)} ${yr(last)}`;
    } else if (sameYear) {
      span = `${day(first)} ${mon(first)} - ${day(last)} ${mon(last)} ${yr(last)}`;
    } else {
      span = `${day(first)} ${mon(first)} ${yr(first)} - ${day(last)} ${mon(last)} ${yr(last)}`;
    }
    return `Contributions + interest = value · ${span}`;
  }, [series]);

  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">
              EPF · Growth breakdown
            </h2>
            <span
              className="rounded bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
              title="Reconstructed from your EPFO member passbooks (employee + employer shares; Pension/EPS excluded). Interest is credited annually at each financial-year end."
            >
              passbook
            </span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{rangeLabel}</p>
        </div>
        <RangeSelector value={range} onChange={setRange} />
      </div>

      {single ? (
        <div className="flex h-64 flex-col items-center justify-center rounded-md border border-dashed border-border bg-muted/10 text-center">
          <p className="text-sm font-medium text-foreground">
            Not enough history to draw a breakdown yet
          </p>
          <p className="mt-1 max-w-md text-xs text-muted-foreground">
            Pick a wider range — the EPF passbook history spans several
            years of monthly contributions and annual interest credits.
          </p>
        </div>
      ) : (
        <>
          <SummaryStrip series={series} />
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={series}
                margin={{ top: 10, right: 8, bottom: 0, left: -8 }}
              >
                <defs>
                  <linearGradient id="epfgb-con" x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="0%"
                      stopColor="hsl(var(--primary))"
                      stopOpacity={0.35}
                    />
                    <stop
                      offset="100%"
                      stopColor="hsl(var(--primary))"
                      stopOpacity={0.08}
                    />
                  </linearGradient>
                  <linearGradient id="epfgb-int" x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="0%"
                      stopColor="hsl(var(--success))"
                      stopOpacity={0.4}
                    />
                    <stop
                      offset="100%"
                      stopColor="hsl(var(--success))"
                      stopOpacity={0.08}
                    />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="hsl(var(--border))"
                  vertical={false}
                />
                <XAxis
                  dataKey="date"
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v) => {
                    const d = new Date(v);
                    if (useYearFormat) {
                      return `${MONTHS[d.getMonth()].slice(0, 3)} ${d
                        .getFullYear()
                        .toString()
                        .slice(-2)}`;
                    }
                    return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
                  }}
                  minTickGap={40}
                />
                <YAxis
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v) => fmtCompactINR(v)}
                  width={56}
                />
                <Tooltip
                  content={<BreakdownTooltip />}
                  cursor={{
                    stroke: "hsl(var(--primary))",
                    strokeOpacity: 0.4,
                    strokeDasharray: "3 3",
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="cumContributions"
                  stackId="1"
                  stroke="hsl(var(--primary))"
                  strokeWidth={1.5}
                  fill="url(#epfgb-con)"
                  isAnimationActive={false}
                />
                <Area
                  type="monotone"
                  dataKey="cumInterest"
                  stackId="1"
                  stroke="hsl(var(--success))"
                  strokeWidth={1}
                  fill="url(#epfgb-int)"
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="cumTotal"
                  stroke="hsl(var(--foreground))"
                  strokeWidth={1.75}
                  dot={false}
                  activeDot={{ r: 3, fill: "hsl(var(--foreground))" }}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
            <LegendChip
              swatch="hsl(var(--primary))"
              label="Contributions (your money in)"
            />
            <LegendChip swatch="hsl(var(--success))" label="Interest earned" />
            <LegendChip
              swatch="hsl(var(--foreground))"
              label="Total value"
              variant="line"
            />
          </div>
        </>
      )}
    </Card>
  );
}

function LegendChip({
  swatch,
  label,
  variant = "area",
}: {
  swatch: string;
  label: string;
  variant?: "area" | "line";
}) {
  return (
    <div className="flex items-center gap-1.5">
      {variant === "line" ? (
        <span
          aria-hidden
          className="inline-block h-0.5 w-3 rounded"
          style={{ background: swatch }}
        />
      ) : (
        <span
          aria-hidden
          className="inline-block h-2 w-2 rounded-sm"
          style={{ background: swatch }}
        />
      )}
      <span className="text-muted-foreground">{label}</span>
    </div>
  );
}

/**
 * Hero + arithmetic strip. Reads the LAST row of the already-computed
 * series so it updates in lockstep with the range selector — pick "1Y"
 * and both the hero and the math strip reflect the year's delta.
 */
function SummaryStrip({ series }: { series: Row[] }) {
  const last = series[series.length - 1];
  const total = last.cumTotal;
  const contributions = last.cumContributions;
  const interest = last.cumInterest;

  return (
    <div className="mb-3">
      <div className="text-xs font-medium text-muted-foreground">
        Your EPF grew by
      </div>
      <div className="mt-0.5 flex items-baseline gap-3">
        <div className="text-2xl font-bold tabular-nums text-[hsl(var(--success))] sm:text-3xl">
          +{fmtCompactINR(total)}
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md bg-muted/25 px-2.5 py-1.5 text-[11px] tabular-nums">
        <span className="font-semibold text-[hsl(var(--primary))]">
          +{fmtCompactINR(contributions)}
        </span>
        <span className="text-muted-foreground">contributions</span>
        <span className="text-muted-foreground">+</span>
        <span className="font-semibold text-[hsl(var(--success))]">
          {fmtCompactINR(interest)}
        </span>
        <span className="text-muted-foreground">interest</span>
        <span className="text-muted-foreground">=</span>
        <span className="font-semibold text-[hsl(var(--success))]">
          +{fmtCompactINR(total)}
        </span>
        <span className="text-muted-foreground">value</span>
      </div>
    </div>
  );
}
