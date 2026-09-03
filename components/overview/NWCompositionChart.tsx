"use client";

import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card } from "@/components/ui/Card";
import { RangeSelector } from "@/components/ui/RangeSelector";
import { fmtL } from "@/lib/utils";
import { filterByRange, useChartRange } from "@/lib/useChartRange";
import type { NwPoint } from "@/lib/nwReconstruct";

// Same localStorage convention as NWTrendChart — separate key so the two
// charts can carry independent last-selected windows.
const STORAGE_KEY = "vayu:nw-composition-range";

const MONTHS = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

// Colors for the three bands — deliberately re-uses the existing token set
// so the palette stays coherent with the rest of the dashboard:
//   MF  → primary (violet)   — matches the MF sparkline / value chart
//   NPS → success (green)    — greenest for the smallest band = easiest to spot
//   EPF → warning (amber)    — earthy/golden = "retirement" reads visually
const COLORS = {
  mf: "hsl(var(--primary))",
  intl: "hsl(280 65% 70%)",
  nps: "hsl(var(--success))",
  epf: "hsl(var(--warning))",
} as const;

function TooltipRow({
  color,
  label,
  value,
  pct,
}: {
  color: string;
  label: string;
  value: number;
  pct: number;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <span
          aria-hidden
          className="inline-block h-2 w-2 rounded-sm"
          style={{ background: color }}
        />
        {label}
      </span>
      <span className="font-medium text-foreground">
        {fmtL(value)}{" "}
        <span className="text-muted-foreground">· {pct.toFixed(1)}%</span>
      </span>
    </div>
  );
}

function CompositionTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload: NwPoint }[];
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const d = new Date(p.date);
  const dateLabel = `${d.getDate().toString().padStart(2, "0")} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  const total = p.total_nw;
  // Guard against total = 0 (would only happen if all three components
  // are simultaneously zero — impossible in real data but cheap safety).
  const pct = (v: number) => (total > 0 ? (v / total) * 100 : 0);
  return (
    <div className="min-w-[180px] rounded-lg border border-border bg-card px-3 py-2 shadow-lg">
      <div className="kicker mb-2">{dateLabel}</div>
      <div className="flex flex-col gap-1 text-[11px]">
        <TooltipRow color={COLORS.mf} label="MF" value={p.mf_value} pct={pct(p.mf_value)} />
        <TooltipRow color={COLORS.intl} label="International" value={p.intl_value} pct={pct(p.intl_value)} />
        <TooltipRow color={COLORS.nps} label="NPS" value={p.nps_value} pct={pct(p.nps_value)} />
        <TooltipRow
          color={COLORS.epf}
          label="EPF"
          value={p.epf_value}
          pct={pct(p.epf_value)}
        />
        <div className="mt-1 flex items-center justify-between gap-4 border-t border-border pt-1">
          <span className="text-muted-foreground">Total</span>
          <span className="text-base font-bold text-foreground">
            {fmtL(total)}
          </span>
        </div>
      </div>
    </div>
  );
}

export function NWCompositionChart({ history }: { history: NwPoint[] }) {
  const { range, setRange } = useChartRange(STORAGE_KEY, "ALL");
  const filtered = filterByRange(history, range);
  const single = filtered.length <= 1;

  // Same adaptive X-axis rule as the sibling charts: switch from
  // "05 Jul" to "JUL 26" only once we've got enough history that
  // day-level ticks would collide. 90-day threshold matches NWTrendChart.
  const spanDays =
    filtered.length > 1
      ? (new Date(filtered[filtered.length - 1].date).getTime() -
          new Date(filtered[0].date).getTime()) /
        (1000 * 60 * 60 * 24)
      : 0;
  const useYearFormat = spanDays >= 90;

  const rangeLabel = useMemo(() => {
    if (!filtered.length) return "No history";
    if (filtered.length === 1)
      return "Building history · 1 snapshot recorded";
    const first = new Date(filtered[0].date);
    const last = new Date(filtered[filtered.length - 1].date);
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
    return `${filtered.length}-point composition · ${span}`;
  }, [filtered]);

  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            Net Worth Composition
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{rangeLabel}</p>
        </div>
        <RangeSelector value={range} onChange={setRange} />
      </div>

      {single ? (
        <div className="flex h-64 flex-col items-center justify-center rounded-md border border-dashed border-border bg-muted/10 text-center">
          <p className="text-sm font-medium text-foreground">
            Not enough history to draw composition yet
          </p>
          <p className="mt-1 max-w-md text-xs text-muted-foreground">
            Composition activates from 2+ nw_daily snapshots. As days
            accumulate, the three bands will show how MF, NPS, and EPF
            each contribute to your total net worth over time.
          </p>
        </div>
      ) : (
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={filtered}
              margin={{ top: 10, right: 8, bottom: 0, left: -8 }}
            >
              <defs>
                <linearGradient id="nw-comp-mf" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={COLORS.mf} stopOpacity={0.75} />
                  <stop offset="100%" stopColor={COLORS.mf} stopOpacity={0.35} />
                </linearGradient>
                <linearGradient id="nw-comp-intl" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={COLORS.intl} stopOpacity={0.75} />
                  <stop offset="100%" stopColor={COLORS.intl} stopOpacity={0.35} />
                </linearGradient>
                <linearGradient id="nw-comp-nps" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={COLORS.nps} stopOpacity={0.75} />
                  <stop offset="100%" stopColor={COLORS.nps} stopOpacity={0.35} />
                </linearGradient>
                <linearGradient id="nw-comp-epf" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={COLORS.epf} stopOpacity={0.75} />
                  <stop offset="100%" stopColor={COLORS.epf} stopOpacity={0.35} />
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
                tickFormatter={(v) => `₹${(v / 1e5).toFixed(0)} L`}
                domain={[0, "auto"]}
                width={50}
              />
              <Tooltip
                content={<CompositionTooltip />}
                cursor={{
                  stroke: "hsl(var(--primary))",
                  strokeOpacity: 0.5,
                  strokeDasharray: "3 3",
                }}
              />
              <Legend
                iconType="square"
                wrapperStyle={{
                  fontSize: 11,
                  paddingTop: 8,
                  color: "hsl(var(--muted-foreground))",
                }}
                verticalAlign="top"
                align="right"
                // Pin legend order (MF · NPS · EPF) independent of the
                // bottom→top stack order so it matches the tooltip.
                payload={[
                  { value: "MF", type: "square", id: "mf", color: COLORS.mf },
                  { value: "International", type: "square", id: "intl", color: COLORS.intl },
                  { value: "NPS", type: "square", id: "nps", color: COLORS.nps },
                  { value: "EPF", type: "square", id: "epf", color: COLORS.epf },
                ]}
              />
              {/* Stack order (bottom → top): EPF, NPS, MF — EPF grounded at
                  the base, MF (largest / most volatile) riding on top. The
                  legend above is pinned to MF · NPS · EPF via an explicit
                  payload so it stays in sync with the tooltip. */}
              <Area
                type="monotone"
                dataKey="epf_value"
                name="EPF"
                stackId="1"
                stroke={COLORS.epf}
                strokeWidth={1.5}
                fill="url(#nw-comp-epf)"
              />
              <Area
                type="monotone"
                dataKey="nps_value"
                name="NPS"
                stackId="1"
                stroke={COLORS.nps}
                strokeWidth={1.5}
                fill="url(#nw-comp-nps)"
              />
              <Area
                type="monotone"
                dataKey="intl_value"
                name="International"
                stackId="1"
                stroke={COLORS.intl}
                strokeWidth={1.5}
                fill="url(#nw-comp-intl)"
              />
              <Area
                type="monotone"
                dataKey="mf_value"
                name="MF"
                stackId="1"
                stroke={COLORS.mf}
                strokeWidth={1.5}
                fill="url(#nw-comp-mf)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}
