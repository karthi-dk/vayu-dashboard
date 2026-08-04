"use client";

import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card } from "@/components/ui/Card";
import { RangeSelector } from "@/components/ui/RangeSelector";
import { cn, fmtCompactINR, fmtDateShort, fmtL } from "@/lib/utils";
import { filterByRange, useChartRange } from "@/lib/useChartRange";
import type { NwPoint, NwAttribution } from "@/lib/nwReconstruct";
import { computeNwAttribution } from "@/lib/nwReconstruct";

// Enriched row that carries a "delta since reference" figure alongside
// the raw NW value. The reference is the first snapshot we have in the
// current year (which for a fresh dashboard means "first snapshot ever").
// isTrueYtd flips only when the reference is genuinely close to Jan 1 —
// otherwise we render "since {date}" instead of the misleading "YTD".
type EnrichedNwRow = NwPoint & {
  deltaSinceStart: number;
  deltaStartDate: string | null;
  isTrueYtd: boolean;
};

// Key for persisting the last-selected time-window across page reloads.
// Namespaced with "vayu:" so we don't collide with future features that
// also want to use localStorage.
const STORAGE_KEY = "vayu:nw-trend-range";

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function TrendTooltip({ active, payload }: {
  active?: boolean;
  payload?: { payload: EnrichedNwRow }[];
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const d = new Date(p.date);
  const dateLabel = `${d.getDate().toString().padStart(2, "0")} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  const showDelta = p.deltaSinceStart !== 0 && p.deltaStartDate;
  // Honest label: "YTD" only when the reference is actually near start
  // of year. For a fresh dashboard (history starts mid-year), we show
  // "since 13 Jul" so the tooltip doesn't overstate the timeframe.
  const deltaLabel = p.isTrueYtd
    ? "YTD"
    : p.deltaStartDate
      ? `since ${fmtDateShort(p.deltaStartDate)}`
      : "";
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 shadow-lg">
      <div className="kicker mb-1">{dateLabel}</div>
      <div className="text-base font-bold text-foreground">{fmtL(p.total_nw)}</div>
      {showDelta && (
        <div
          className={cn(
            "mt-0.5 text-[11px] font-medium",
            p.deltaSinceStart >= 0
              ? "text-[hsl(var(--success))]"
              : "text-[hsl(var(--danger))]"
          )}
        >
          {p.deltaSinceStart >= 0 ? "+" : ""}
          {fmtL(p.deltaSinceStart)} {deltaLabel}
        </div>
      )}
    </div>
  );
}

/**
 * Net-worth trend chart. Since 2026-07-19 also carries the wealth-
 * build-up "moved by" summary (hero + math + per-product chips) that
 * used to live in NwAttributionCard. Merging them here means the
 * summary numbers track the range picker — pick 1M and both hero
 * and math reflect the last month's delta, not all-time.
 *
 * Attribution is recomputed on every range change from the filtered
 * slice of the reconstructed history (exact — contributions vs growth
 * from cumulative-contribution deltas). See lib/nwReconstruct.
 */
export function NWTrendChart({
  history,
}: {
  history: NwPoint[];
}) {
  const { range, setRange } = useChartRange(STORAGE_KEY, "ALL");

  const rowsWithYtd = useMemo<EnrichedNwRow[]>(() => {
    return history.map((r) => {
      const y = new Date(r.date).getFullYear();
      const startOfYear = history.find(
        (x) => new Date(x.date).getFullYear() === y
      );
      if (!startOfYear) {
        return { ...r, deltaSinceStart: 0, deltaStartDate: null, isTrueYtd: false };
      }
      const startDate = new Date(startOfYear.date);
      // Only label as "YTD" when the reference point is genuinely close
      // to Jan 1 of the current year. For a dashboard whose history
      // begins mid-year (like ours today: first row = Jul 13), the
      // reference is Jul 13 — not Jan 1 — so calling that "YTD" would
      // overstate the timeframe. Threshold of Jan 7 is generous enough
      // to cover the first workweek's typical cron start date.
      const isTrueYtd =
        startDate.getMonth() === 0 && startDate.getDate() <= 7;
      return {
        ...r,
        deltaSinceStart: r.total_nw - startOfYear.total_nw,
        deltaStartDate: startOfYear.date,
        isTrueYtd,
      };
    });
  }, [history]);

  const filtered = filterByRange(rowsWithYtd, range);
  const single = filtered.length <= 1;

  // Adaptive x-axis label format. When the visible window spans less than
  // ~3 months, "JUL 26 / JUL 26 / JUL 26" collapses into identical strings,
  // so switch to "13 Jul" style until we have enough history to differentiate
  // by month/year. Threshold of 90 days keeps 1M range on day+month and
  // 6M/1Y/ALL (with sufficient history) on month+year.
  const spanDays =
    filtered.length > 1
      ? (new Date(filtered[filtered.length - 1].date).getTime() -
          new Date(filtered[0].date).getTime()) /
        (1000 * 60 * 60 * 24)
      : 0;
  const useYearFormat = spanDays >= 90;

  // Range-aware attribution. Recomputed on every range change from
  // the raw filtered history (not rowsWithYtd — but EnrichedNwRow
  // extends NwRow so the fields we care about are present).
  const attribution = useMemo(
    () => computeNwAttribution(filtered),
    [filtered]
  );

  const rangeLabel = useMemo(() => {
    if (!filtered.length) return "No history";
    if (filtered.length === 1)
      return "Building history · 1 snapshot recorded";
    // Adaptive span format so short windows read naturally:
    //   same month:   "13 - 15 Jul 2026"
    //   same year:    "05 Jan - 15 Jul 2026"
    //   cross-year:   "15 Aug 2025 - 15 Jul 2026"
    // The old "Jul 2026 - Jul 2026" format looked redundant when start
    // and end fell in the same month (common when history is fresh).
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
      span = `${day(first)} ${mon(first)} - ${day(last)} ${mon(last)} ${yr(
        last
      )}`;
    } else {
      span = `${day(first)} ${mon(first)} ${yr(first)} - ${day(last)} ${mon(
        last
      )} ${yr(last)}`;
    }
    return `${filtered.length}-point trajectory · ${span}`;
  }, [filtered]);

  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Net Worth Trend</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{rangeLabel}</p>
        </div>
        <RangeSelector value={range} onChange={setRange} />
      </div>

      {attribution && <SummaryStrip attribution={attribution} />}

      {single ? (
        <div className="flex h-64 flex-col items-center justify-center rounded-md border border-dashed border-border bg-muted/10 text-center">
          <p className="text-sm font-medium text-foreground">
            Not enough history to draw a trend line yet
          </p>
          <p className="mt-1 max-w-md text-xs text-muted-foreground">
            The chart populates one point per day from the 2 AM cron. As
            snapshots accumulate, the trend line will build here. First
            snapshot is already recorded.
          </p>
        </div>
      ) : (
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={filtered} margin={{ top: 10, right: 8, bottom: 0, left: -8 }}>
              <defs>
                <linearGradient id="nw-trend-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
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
                domain={["auto", "auto"]}
                width={50}
              />
              <Tooltip
                content={<TrendTooltip />}
                cursor={{ stroke: "hsl(var(--primary))", strokeOpacity: 0.5, strokeDasharray: "3 3" }}
              />
              <Area
                type="monotone"
                dataKey="total_nw"
                stroke="hsl(var(--primary))"
                strokeWidth={2}
                fill="url(#nw-trend-fill)"
                activeDot={{ r: 4, fill: "hsl(var(--primary))", stroke: "hsl(var(--card))", strokeWidth: 2 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

/**
 * Hero + arithmetic strip + per-product breakdown. Superseded a
 * standalone NwAttributionCard ("Total Wealth Build-up") that pinned
 * this arithmetic to an all-time window. Folded here so the summary
 * tracks the range picker — pick 1M and both hero and math reflect
 * the last month's delta.
 *
 * Kept richer than the MF/NPS chart strips because NW rolls up three
 * products: the per-product chips (MF · NPS · EPF) are the only
 * surface that lets users see, for example, that this month's growth
 * came mostly from EPF interest rather than MF market moves.
 */
function SummaryStrip({ attribution }: { attribution: NwAttribution }) {
  const {
    mfDeposits,
    npsDeposits,
    epfDeposits,
    totalContributions,
    mfMarket,
    npsMarket,
    epfInterest,
    totalGrowth,
    totalNwChange,
    hasMissingCreditsData,
  } = attribution;

  const netPositive = totalNwChange >= 0;
  const contribPositive = totalContributions >= 0;
  const growthPositive = totalGrowth >= 0;

  const contribChips: Chip[] = [
    { label: "MF", value: mfDeposits },
    { label: "NPS", value: npsDeposits },
    { label: "EPF", value: epfDeposits },
  ].filter((c) => Math.abs(c.value) >= 1);

  const growthChips: Chip[] = [
    { label: "MF", value: mfMarket },
    { label: "NPS", value: npsMarket },
    { label: "EPF", value: epfInterest },
  ].filter((c) => Math.abs(c.value) >= 1);

  return (
    <div className="mb-4">
      <div className="text-xs font-medium text-muted-foreground">
        Your net worth moved by
      </div>
      <div className="mt-0.5 flex items-baseline gap-3">
        <div
          className={cn(
            "text-2xl font-bold tabular-nums sm:text-3xl",
            netPositive
              ? "text-[hsl(var(--success))]"
              : "text-[hsl(var(--danger))]"
          )}
        >
          {netPositive ? "+" : ""}
          {fmtCompactINR(totalNwChange)}
        </div>
      </div>

      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md bg-muted/25 px-2.5 py-1.5 text-[11px] tabular-nums">
        <span
          className={cn(
            "font-semibold",
            contribPositive
              ? "text-[hsl(var(--primary))]"
              : "text-[hsl(var(--danger))]"
          )}
        >
          {contribPositive ? "+" : ""}
          {fmtCompactINR(totalContributions)}
        </span>
        <span className="text-muted-foreground">contributions</span>
        <span className="text-muted-foreground">{growthPositive ? "+" : "−"}</span>
        <span
          className={cn(
            "font-semibold",
            growthPositive
              ? "text-[hsl(var(--success))]"
              : "text-[hsl(var(--danger))]"
          )}
        >
          {fmtCompactINR(Math.abs(totalGrowth))}
        </span>
        <span className="text-muted-foreground">growth</span>
        <span className="text-muted-foreground">=</span>
        <span
          className={cn(
            "font-semibold",
            netPositive
              ? "text-[hsl(var(--success))]"
              : "text-[hsl(var(--danger))]"
          )}
        >
          {netPositive ? "+" : ""}
          {fmtCompactINR(totalNwChange)}
        </span>
        <span className="text-muted-foreground">net change</span>
      </div>

      {(contribChips.length > 0 || growthChips.length > 0) && (
        <div className="mt-2 flex flex-col gap-1 text-[10px] tabular-nums text-muted-foreground">
          {contribChips.length > 0 && (
            <ChipRow label="Contributions" chips={contribChips} />
          )}
          {growthChips.length > 0 && (
            <ChipRow label="Growth" chips={growthChips} />
          )}
        </div>
      )}

      {hasMissingCreditsData && (
        <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground/70">
          EPF residual is non-zero — some credit events for this window
          are missing from the ledger. Log them via /credits for accurate
          attribution.
        </p>
      )}
    </div>
  );
}

type Chip = { label: string; value: number };

function ChipRow({ label, chips }: { label: string; chips: Chip[] }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3">
      <span className="uppercase tracking-wider text-muted-foreground/70">
        {label}
      </span>
      {chips.map((c) => (
        <span key={c.label} className="inline-flex items-baseline gap-1">
          <span>{c.label}</span>
          <span
            className={cn(
              "font-medium",
              c.value >= 0
                ? "text-[hsl(var(--success))]"
                : "text-[hsl(var(--danger))]"
            )}
          >
            {c.value >= 0 ? "+" : ""}
            {fmtCompactINR(c.value)}
          </span>
        </span>
      ))}
    </div>
  );
}
