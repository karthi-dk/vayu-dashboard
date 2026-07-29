"use client";

import { useMemo } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card } from "@/components/ui/Card";
import { RangeSelector } from "@/components/ui/RangeSelector";
import { cn, fmtCompactINR } from "@/lib/utils";
import { filterByRange, useChartRange } from "@/lib/useChartRange";
import type { MfDailyRow } from "@/lib/queries";

/**
 * MF Growth breakdown — the single visual for the MF overview.
 * Mirror of NpsGrowthBreakdown. Superseded three earlier surfaces:
 * `Mutual Funds · Value vs Invested`, `MF Growth: Deposits vs Market
 * Return`, and `MF Wealth Build-up`. The first two encoded the same
 * MfDailyRow data with different visual grammars; the Wealth Build-up
 * card duplicated the tail-of-series arithmetic (deposits + market =
 * net change) that the range-aware SummaryStrip below now shows
 * in-place. Merging them here removed the "how do these three
 * surfaces relate?" mental step and lets the summary numbers track
 * the chart's range picker — pick 1Y and both hero and math reflect
 * the year's delta, not all-time.
 *
 * Anatomy
 * ───────
 * SummaryStrip (top):
 *   • Hero: "Your MF value moved by +/−₹X"
 *   • Arithmetic strip: deposits + market = net change
 *   • Both read the LAST row of `series[]` so they update in
 *     lockstep with the range selector.
 * Stacked areas:
 *   • Deposits (blue, always ≥ 0)   → your cumulative money in
 *   • Market return positive (green) OR negative (red carve-out of deposits)
 * Overlaid solid line:
 *   • Total value = deposits + market return
 *
 * Deposits source
 * ───────────────
 * • Prefer `mf_deposits_ledger` — cumulative net deposits sourced from
 *   `mf_contributions` + `mf_transactions`. True historical curve.
 * • Fall back to `mf_invested` (fund_holdings snapshot delta) on
 *   bootstrap installs / legacy rows where the enrichment field is
 *   undefined.
 *
 * Anchoring
 * ─────────
 * Cumulative sums are anchored to the state ONE ROW BEFORE the
 * filtered window (or (0, 0) if the window includes the very first
 * row of history — the "before-tracking" state). Same convention as
 * NpsGrowthBreakdown so both charts tell an internally-consistent
 * arithmetic story. NOTE: for MF, the ALL-range chart's day-1 will
 * show cumulative pre-tracking deposits as a vertical jump up to the
 * current cost basis. That's the honest "here's what already existed
 * when tracking started" reading; if you want "since window start"
 * instead, pick a shorter range.
 */

const STORAGE_KEY = "vayu:mf-growth-breakdown-range";

const MONTHS = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

type Row = {
  date: string;
  cumDeposits: number;
  cumMarket: number;
  cumMarketPos: number;
  cumMarketNeg: number;
  cumTotal: number;
  /**
   * Portfolio-scale return % for the window as of this row.
   * Formula: `cumMarket / max(anchor.value, cumDeposits) × 100`.
   * The max() picks whichever is a meaningful denominator per range:
   *   • Short windows on an existing corpus → anchor.value dominates,
   *     so this reads as a standard time-weighted return on starting
   *     capital (industry convention).
   *   • ALL range from inception → anchor.value = 0, so denominator
   *     collapses to cumDeposits — same as the earlier formula, so
   *     ALL-range behavior is unchanged.
   * `null` when the denominator is ≤ 0 (day-1 of ALL range with no
   * deposits yet). Prevents the earlier bug where large windows on a
   * mature portfolio produced |return| > 100% because the numerator
   * scaled with the whole corpus while the denominator only captured
   * window-fresh contributions.
   */
  returnPct: number | null;
  isReconstructed: boolean;
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
  // Return % is precomputed in the series builder so the denominator
  // matches the anchor logic exactly (see Row.returnPct docstring for
  // the full rationale). Tooltip just displays.
  //
  // Label choice: "Net change" instead of "Total value" — the number
  // is the cumulative Δ against the window anchor (r.mf_value −
  // anchor.value), not the current absolute MF value. On a mid-window
  // market dip this can go NEGATIVE, which used to look like "your
  // MF is worth −₹X" under the old label. The new label makes the
  // delta semantics explicit and lines up with the Deposits / Market
  // return rows above it, which are also window-relative.
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 shadow-md">
      <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
        {p.isReconstructed && (
          <span className="rounded bg-muted/40 px-1 py-0.5 text-[9px] font-medium normal-case text-muted-foreground">
            reconstructed
          </span>
        )}
      </div>
      <TooltipRow
        swatch="hsl(var(--primary))"
        label="Deposits"
        value={p.cumDeposits}
      />
      <TooltipRow
        swatch={
          p.cumMarket >= 0 ? "hsl(var(--success))" : "hsl(var(--danger))"
        }
        label="Market return"
        value={p.cumMarket}
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

/**
 * Percent-return row appended under the Total value line. Indented to
 * align with the Total value label (14px left pad = h-2 w-2 swatch +
 * gap-1.5). Keeps the "arithmetic story" reading top-down:
 *   Deposits + Market return  →  Total value  →  Return %
 * Colored red/green by sign — matches the Market return row's palette
 * so a user glancing at the tooltip gets the same signal from both.
 */
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
          bold && "font-semibold",
          bold
            ? "text-foreground"
            : value !== 0 &&
                (positive
                  ? "text-[hsl(var(--success))]"
                  : "text-[hsl(var(--danger))]")
        )}
      >
        {value === 0 || bold ? "" : positive ? "+" : ""}
        {fmtCompactINR(value)}
      </span>
    </div>
  );
}

export function MFGrowthBreakdown({ history }: { history: MfDailyRow[] }) {
  const { range, setRange } = useChartRange(STORAGE_KEY, "ALL");

  // Use ledger deposits when EVERY visible row has it — a mixed window
  // (some ledger, some snapshot) would produce misleading jumps at the
  // handoff point. All-or-nothing keeps the curve continuous.
  const useLedger = useMemo(() => {
    const filtered = filterByRange(history, range);
    if (filtered.length < 2) return false;
    return filtered.every((r) => r.mf_deposits_ledger !== undefined);
  }, [history, range]);

  const series = useMemo<Row[]>(() => {
    const filtered = filterByRange(history, range);
    if (filtered.length < 2) return [];

    // Same anchor logic as NpsGrowthBreakdown — one row before the
    // window, or (0, 0) if the window includes the very first day
    // of history. Ensures deposits that land ON the window's first
    // day are counted inside the window rather than silently
    // absorbed into the anchor.
    const firstFilteredIdx = history.indexOf(filtered[0]);
    const rowDeposits = (r: MfDailyRow) =>
      useLedger ? (r.mf_deposits_ledger as number) : r.mf_invested;
    const anchor =
      firstFilteredIdx > 0
        ? {
            deposits: rowDeposits(history[firstFilteredIdx - 1]),
            value: history[firstFilteredIdx - 1].mf_value,
          }
        : { deposits: 0, value: 0 };

    return filtered.map((r) => {
      const cumDeposits = rowDeposits(r) - anchor.deposits;
      // Market attribution: (mf_value[t] − anchor.value) − cumDeposits.
      // Whatever's left of the value change after subtracting deposits
      // must be market movement, definitionally.
      const cumMarket = r.mf_value - anchor.value - cumDeposits;
      // Portfolio-scale return %: use whichever is larger between the
      // pre-window corpus and the deposits made inside the window. See
      // the Row.returnPct docstring for why this beats the earlier
      // deposits-only denominator (which produced |return| > 100% on
      // volatile windows anchored to a mature portfolio).
      const denominator = Math.max(anchor.value, cumDeposits);
      const returnPct =
        denominator > 0 ? (cumMarket / denominator) * 100 : null;
      return {
        date: r.date,
        cumDeposits,
        cumMarket,
        cumMarketPos: cumMarket > 0 ? cumMarket : 0,
        cumMarketNeg: cumMarket < 0 ? cumMarket : 0,
        cumTotal: r.mf_value - anchor.value,
        returnPct,
        isReconstructed: r.is_reconstructed,
      };
    });
  }, [history, range, useLedger]);

  const reconstructedCount = useMemo(
    () => series.filter((r) => r.isReconstructed).length,
    [series]
  );
  const reconstructedBoundary = useMemo(() => {
    const firstObserved = series.find((r) => !r.isReconstructed);
    return firstObserved?.date ?? null;
  }, [series]);

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
    if (series.length === 1) return "Building history · 1 snapshot";
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
    return `Deposits + market = value · ${span}`;
  }, [series]);

  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">
              MF · Growth breakdown
            </h2>
            {series.length > 1 && useLedger && (
              <span
                className="rounded bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                title="Deposits sourced from the MF ledger (Groww orders + MFCentral CAS) — reflects true purchase / redemption events per day"
              >
                ledger-based
              </span>
            )}
            {reconstructedCount > 0 && (
              <span
                className="rounded bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                title={
                  reconstructedBoundary
                    ? `Pre-${reconstructedBoundary} values reconstructed from mf_transactions × mfapi.in NAV history. Observed daily snapshots start ${reconstructedBoundary}.`
                    : "All visible values reconstructed from mf_transactions × mfapi.in NAV history."
                }
              >
                reconstructed pre-{reconstructedBoundary?.slice(0, 7) ?? "tracking"}
              </span>
            )}
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
            The chart will build one point per day. Come back tomorrow to
            see the first segment, and check back in a month for a real
            story.
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
                  <linearGradient id="mfgb-dep" x1="0" y1="0" x2="0" y2="1">
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
                  <linearGradient id="mfgb-mkt-pos" x1="0" y1="0" x2="0" y2="1">
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
                  <linearGradient id="mfgb-mkt-neg" x1="0" y1="1" x2="0" y2="0">
                    <stop
                      offset="0%"
                      stopColor="hsl(var(--danger))"
                      stopOpacity={0.4}
                    />
                    <stop
                      offset="100%"
                      stopColor="hsl(var(--danger))"
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
                <ReferenceLine
                  y={0}
                  stroke="hsl(var(--border))"
                  strokeWidth={1.5}
                />
                {reconstructedBoundary && reconstructedCount > 0 && (
                  <ReferenceLine
                    x={reconstructedBoundary}
                    stroke="hsl(var(--muted-foreground))"
                    strokeOpacity={0.4}
                    strokeDasharray="2 3"
                    label={{
                      value: "tracking start",
                      position: "insideTopRight",
                      fill: "hsl(var(--muted-foreground))",
                      fontSize: 9,
                    }}
                  />
                )}
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
                  dataKey="cumDeposits"
                  stackId="1"
                  stroke="hsl(var(--primary))"
                  strokeWidth={1.5}
                  fill="url(#mfgb-dep)"
                  isAnimationActive={false}
                />
                <Area
                  type="monotone"
                  dataKey="cumMarketPos"
                  stackId="1"
                  stroke="hsl(var(--success))"
                  strokeWidth={1}
                  fill="url(#mfgb-mkt-pos)"
                  isAnimationActive={false}
                />
                <Area
                  type="monotone"
                  dataKey="cumMarketNeg"
                  stackId="1"
                  stroke="hsl(var(--danger))"
                  strokeWidth={1}
                  fill="url(#mfgb-mkt-neg)"
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
              label="Deposits (your money in)"
            />
            <LegendChip
              swatch="hsl(var(--success))"
              label="Market gain"
            />
            <LegendChip
              swatch="hsl(var(--danger))"
              label="Market loss"
            />
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
 * Hero + arithmetic strip. Superseded a standalone MfAttributionCard
 * ("MF Wealth Build-up") that duplicated this arithmetic at a fixed
 * all-time window. Folded here so the summary and the trend live
 * together and update in lockstep as the range selector changes —
 * pick "1Y" and both the hero total and the math strip reflect the
 * year's delta, not the all-time total.
 *
 * Reads the LAST row of the already-computed series so we don't
 * recompute anything — the tail of series[] is by construction the
 * "as of the right edge of the chart" cumulative state.
 */
function SummaryStrip({ series }: { series: Row[] }) {
  const last = series[series.length - 1];
  const total = last.cumTotal;
  const deposits = last.cumDeposits;
  const market = last.cumMarket;

  const totalPositive = total >= 0;
  const depositsPositive = deposits >= 0;
  const marketPositive = market >= 0;

  return (
    <div className="mb-3">
      <div className="text-xs font-medium text-muted-foreground">
        Your MF value moved by
      </div>
      <div className="mt-0.5 flex items-baseline gap-3">
        <div
          className={cn(
            "text-2xl font-bold tabular-nums sm:text-3xl",
            totalPositive
              ? "text-[hsl(var(--success))]"
              : "text-[hsl(var(--danger))]"
          )}
        >
          {totalPositive ? "+" : ""}
          {fmtCompactINR(total)}
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md bg-muted/25 px-2.5 py-1.5 text-[11px] tabular-nums">
        <span
          className={cn(
            "font-semibold",
            depositsPositive
              ? "text-[hsl(var(--primary))]"
              : "text-[hsl(var(--danger))]"
          )}
        >
          {depositsPositive ? "+" : ""}
          {fmtCompactINR(deposits)}
        </span>
        <span className="text-muted-foreground">deposits</span>
        <span className="text-muted-foreground">{marketPositive ? "+" : "−"}</span>
        <span
          className={cn(
            "font-semibold",
            marketPositive
              ? "text-[hsl(var(--success))]"
              : "text-[hsl(var(--danger))]"
          )}
        >
          {fmtCompactINR(Math.abs(market))}
        </span>
        <span className="text-muted-foreground">market</span>
        <span className="text-muted-foreground">=</span>
        <span
          className={cn(
            "font-semibold",
            totalPositive
              ? "text-[hsl(var(--success))]"
              : "text-[hsl(var(--danger))]"
          )}
        >
          {totalPositive ? "+" : ""}
          {fmtCompactINR(total)}
        </span>
        <span className="text-muted-foreground">net change</span>
      </div>
    </div>
  );
}
