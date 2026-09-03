"use client";

import { useEffect, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { fmtL } from "@/lib/utils";

// A currency-denominated fund's INR value = USD NAV × FX. Those multiply,
// so this is a rebased-to-100 line overlay (not a stacked area): each line
// is that component's cumulative move since your entry, and the INR line is
// the product of the other two. The series is on the daily FX grid with NAV
// carried forward, so it grows one point per trading day.
const MIN_POINTS = 2;

const COLORS = {
  value: "hsl(var(--primary))", // Your value (INR)
  nav: "hsl(210 80% 60%)", // Fund (USD NAV)
  fx: "hsl(var(--warning))", // FX (USD→INR)
} as const;

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const dmy = (iso: string) => {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
};

type Point = {
  date: string;
  navUsd: number;
  fx: number;
  valueInr: number;
  navIdx: number;
  fxIdx: number;
  valueIdx: number;
};
type Resp = {
  ok: boolean;
  fund_code: string;
  fund_name?: string;
  entry_date?: string;
  count: number;
  points: Point[];
};
// Return-contribution form: navRet + fxRet == totalRet (they stack to the total).
type ChartPoint = Point & { navRet: number; fxRet: number; totalRet: number };

function Header({ title, entryDate }: { title: string; entryDate?: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Your INR return since the {entryDate ? dmy(entryDate) : "inception"}{" "}
          NAV, split into the fund&apos;s USD NAV vs the USD→INR move (they add
          up). Excludes your one-time entry / FX-conversion cost, so it
          won&apos;t match the card&apos;s return vs cost.
        </p>
      </div>
      <Badge variant="muted">Since inception</Badge>
    </div>
  );
}

function ChartTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload: ChartPoint }[];
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const cls = (v: number) =>
    v >= 0
      ? "font-semibold text-[hsl(var(--success))]"
      : "font-semibold text-[hsl(var(--danger))]";
  const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  const dot = (c: string) => (
    <span
      aria-hidden
      className="inline-block h-2 w-2 rounded-sm"
      style={{ background: c }}
    />
  );
  return (
    <div className="min-w-[210px] rounded-lg border border-border bg-card px-3 py-2 shadow-lg">
      <div className="kicker mb-2">
        {new Date(p.date).toLocaleDateString("en-IN", {
          day: "2-digit",
          month: "short",
          year: "numeric",
        })}
      </div>
      <div className="flex flex-col gap-1 text-[11px]">
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            {dot(COLORS.value)} Total (INR)
          </span>
          <span className="font-medium text-foreground">
            {fmtL(p.valueInr)}{" "}
            <span className={cls(p.totalRet)}>{pct(p.totalRet)}</span>
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            {dot(COLORS.nav)} Fund · ${p.navUsd.toFixed(4)}
          </span>
          <span className={cls(p.navRet)}>{pct(p.navRet)}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            {dot(COLORS.fx)} FX · ₹{p.fx.toFixed(2)}
          </span>
          <span className={cls(p.fxRet)}>{pct(p.fxRet)}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Per-fund NAV-vs-FX growth chart for an International (USD) fund.
 * Fetches /api/intl-nav-series client-side. Until the fund has published
 * at least MIN_POINTS NAVs it shows a "collecting data" state (a
 * days-old fund has 2 dots, not a chart), then the overlay switches on.
 */
export function IntlFundGrowthChart({
  fundCode = "HDFC_INTL_DM",
  title = "International fund · NAV vs FX growth",
}: {
  fundCode?: string;
  title?: string;
}) {
  const [data, setData] = useState<Resp | null>(null);
  const [state, setState] = useState<"loading" | "error" | "ready">("loading");

  useEffect(() => {
    let alive = true;
    fetch(`/api/intl-nav-series?fund=${encodeURIComponent(fundCode)}`)
      .then((r) => r.json())
      .then((j: Resp) => {
        if (!alive) return;
        if (j.ok) {
          setData(j);
          setState("ready");
        } else setState("error");
      })
      .catch(() => alive && setState("error"));
    return () => {
      alive = false;
    };
  }, [fundCode]);

  if (state === "loading") {
    return (
      <Card className="p-5">
        <div className="h-4 w-56 animate-pulse rounded bg-muted/50" />
        <div className="mt-4 h-48 animate-pulse rounded bg-muted/30" />
      </Card>
    );
  }
  if (state === "error" || !data) return null; // fail quietly — optional card

  if (data.count < MIN_POINTS) {
    return (
      <Card className="p-5">
        <Header title={title} entryDate={data.entry_date} />
        <div className="mt-4 flex h-40 flex-col items-center justify-center rounded-lg border border-dashed border-border text-center">
          <p className="text-sm font-medium text-foreground">
            Just getting started — {data.count} data point
            {data.count === 1 ? "" : "s"}
          </p>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            The chart needs at least {MIN_POINTS} daily points to draw a line;
            it fills in one per trading day.
          </p>
        </div>
      </Card>
    );
  }

  const chartData: ChartPoint[] = data.points.map((p) => {
    const navRet = p.navIdx - 100;
    const totalRet = p.valueIdx - 100;
    // Assign the tiny multiplicative cross-term to FX so nav + fx == total exactly.
    return { ...p, navRet, fxRet: totalRet - navRet, totalRet };
  });
  const spread = chartData.flatMap((d) => [0, d.navRet, d.fxRet, d.totalRet]);
  const yMin = Math.min(...spread) - 0.3;
  const yMax = Math.max(...spread) + 0.3;

  return (
    <Card className="p-5">
      <Header title={title} entryDate={data.entry_date} />
      <div className="mt-4 h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
            <defs>
              <linearGradient id="intlNavGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLORS.nav} stopOpacity={0.45} />
                <stop offset="100%" stopColor={COLORS.nav} stopOpacity={0.08} />
              </linearGradient>
              <linearGradient id="intlFxGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLORS.fx} stopOpacity={0.45} />
                <stop offset="100%" stopColor={COLORS.fx} stopOpacity={0.08} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={dmy}
              tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
              tickLine={false}
              axisLine={false}
              minTickGap={24}
            />
            <YAxis
              tickFormatter={(v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}%`}
              tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
              tickLine={false}
              axisLine={false}
              width={48}
              domain={[yMin, yMax]}
              allowDecimals
            />
            <ReferenceLine y={0} stroke="hsl(var(--border))" strokeDasharray="4 4" />
            <Tooltip content={<ChartTooltip />} />
            <Legend iconType="plainline" wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
            <Area
              type="linear"
              dataKey="navRet"
              stackId="c"
              name="Fund (USD NAV)"
              stroke={COLORS.nav}
              strokeWidth={1.5}
              fill="url(#intlNavGrad)"
            />
            <Area
              type="linear"
              dataKey="fxRet"
              stackId="c"
              name="FX (USD→INR)"
              stroke={COLORS.fx}
              strokeWidth={1.5}
              fill="url(#intlFxGrad)"
            />
            <Line
              type="linear"
              dataKey="totalRet"
              name="Total (INR)"
              stroke={COLORS.value}
              strokeWidth={2.5}
              dot={{ r: 2 }}
              activeDot={{ r: 4 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Fund contribution + FX contribution = your total INR return. Fund NAV is
        carried forward between HDFC&apos;s publishes; your value re-marks daily
        on FX.
      </p>
    </Card>
  );
}
