"use client";

import { motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import {
  Area,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { StudioChartPoint } from "@/app/studio/data";
import {
  STUDIO_CHART_HEIGHT_CLASS,
  STUDIO_TIMING,
} from "@/components/studio/RevealDashboard";
import { RollUpNumber } from "@/components/studio/RollUpNumber";
import {
  recordStudioInteraction,
  type StudioTelemetryTheme,
} from "@/lib/studio/recordingTelemetry";
import { cn, fmtCompactINR, fmtDateShortIST, fmtINR } from "@/lib/utils";

/**
 * GrowthChart — the cinematic hero of /studio.
 *
 * Anatomy (top to bottom, front to back):
 *
 *   • Current-value pill  — absolute-positioned top-right, floats
 *                            above the chart. Renders the latest
 *                            value point as "₹15.2L" with a subtle
 *                            gain/loss delta below.
 *
 *   • Value area          — brand-primary line + gradient fill.
 *                            This is the "how much your MF portfolio
 *                            is worth" curve. Bold, coloured, the
 *                            eye's primary anchor.
 *
 *   • Invested line       — dashed, muted. The "how much you put in"
 *                            curve. The visual gap between the two
 *                            curves is the unrealised gain (or loss
 *                            if invested is above value).
 *
 *   • Milestone lines     — dashed horizontal references at ₹10L,
 *                            ₹1Cr, ₹10Cr, ₹100Cr (the 10K→100Cr
 *                            experiment ladder). Only those in the
 *                            visible y-range are rendered — showing
 *                            all four on a linear scale when the
 *                            portfolio is ₹15L would compress the
 *                            actual curve to a flat line at zero.
 *                            "Next target" (the one just above the
 *                            data max) is included as a motivational
 *                            headroom marker.
 *
 *   • Timeframe pills     — 1M / 3M / 6M / 1Y / 3Y / All, defaults to 3M
 *                            (per the briefing). Below the chart so
 *                            the taps don't overlap the chart area
 *                            on portrait phones.
 *
 * X and Y axes are hidden. Recharts still uses them internally for
 * layout math — Y needs a numeric domain, X needs the date field —
 * but the tick labels are suppressed. The tooltip on hover carries
 * the specifics for anyone who wants exact numbers.
 */

// The four milestones from the 10K→100Cr experiment. Used only by
// the value pill's "next milestone" aspiration marker — the chart's
// horizontal reference lines are now computed dynamically from the
// visible y-range (see computeReferenceLines below) so they scale
// with the selected timeframe.
const MILESTONES: Array<{ label: string; value: number }> = [
  { label: "₹10L", value: 1_000_000 },
  { label: "₹1Cr", value: 10_000_000 },
  { label: "₹10Cr", value: 100_000_000 },
  { label: "₹100Cr", value: 1_000_000_000 },
];

/** Compact ₹-line label used only on the chart's horizontal grid.
 *  Differs from `fmtCompactINR` (which always shows 2 decimals like
 *  "₹20.00 L") by dropping trailing zeros for clean whole-number
 *  labels — a line at ₹20,00,000 reads "₹20L", not "₹20.00 L", so
 *  five stacked labels don't visually clutter the chart.
 *
 *  Examples:
 *    500,000       → "₹5L"
 *    1_500_000     → "₹15L"
 *    10_000_000    → "₹1Cr"
 *    15_000_000    → "₹1.5Cr"
 *    100_000_000   → "₹10Cr"
 */
function fmtChartLine(v: number): string {
  if (v >= 1e7) {
    const cr = v / 1e7;
    // Whole numbers: no decimals. Fractional: 1 decimal, trim trailing zero.
    const s = cr % 1 === 0 ? cr.toFixed(0) : cr.toFixed(1).replace(/\.0$/, "");
    return `₹${s}Cr`;
  }
  if (v >= 1e5) {
    const l = v / 1e5;
    const s = l % 1 === 0 ? l.toFixed(0) : l.toFixed(1).replace(/\.0$/, "");
    return `₹${s}L`;
  }
  if (v >= 1e3) return `₹${(v / 1e3).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
}

/** Compute adaptive horizontal reference lines for the chart based
 *  on the visible y-range. Returns 4-6 lines at "nice" round values
 *  (multiples of 1/2/5 × 10^n) covering the range from just above
 *  0 up to yMax.
 *
 *  ALGORITHM ("nice numbers" — same technique used by matplotlib,
 *  d3-scale, and every other charting library):
 *    1. Divide yMax by target division count (~5).
 *    2. Take log10 of the rough step, find the enclosing power of 10.
 *    3. Snap the normalized value to 1 / 2 / 5 / 10.
 *    4. Multiply back by the power of 10 to get the nice step.
 *    5. Generate lines from `niceStep` up to `yMax` in `niceStep`
 *       increments — never at 0 (chart baseline already implies it).
 *
 *  EXAMPLES:
 *    yMax = 45L → step 10L → lines at 10L, 20L, 30L, 40L
 *    yMax = 90L → step 20L → lines at 20L, 40L, 60L, 80L
 *    yMax = 4Cr → step 1Cr → lines at 1Cr, 2Cr, 3Cr, 4Cr
 *    yMax = 25Cr→ step 5Cr → lines at 5Cr, 10Cr, 15Cr, 20Cr, 25Cr
 *
 *  The 3M / 6M / 1Y / 3Y / All timeframe switches produce different
 *  yMax values (a 1-month slice has a much tighter data range than
 *  All-time), so this recomputes and the grid adapts each tap. */
function computeReferenceLines(
  yMax: number
): Array<{ value: number; label: string }> {
  if (yMax <= 0) return [];
  const targetDivisions = 5;
  const roughStep = yMax / targetDivisions;
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const normalized = roughStep / magnitude;
  // Snap to 1 / 2 / 5 / 10 × magnitude — the classic "nice number"
  // set. Cutoffs (1.5 / 3.5 / 7.5) chosen so each snap band is
  // symmetric in log-space.
  let niceStep: number;
  if (normalized < 1.5) niceStep = 1 * magnitude;
  else if (normalized < 3.5) niceStep = 2 * magnitude;
  else if (normalized < 7.5) niceStep = 5 * magnitude;
  else niceStep = 10 * magnitude;

  const lines: Array<{ value: number; label: string }> = [];
  // Small epsilon (yMax * 0.001) protects against floating-point
  // fuzz where a line exactly at yMax would fail the `<=` guard.
  const epsilon = yMax * 0.001;
  for (let v = niceStep; v <= yMax + epsilon; v += niceStep) {
    lines.push({ value: v, label: fmtChartLine(v) });
  }
  return lines;
}

/** Chart timeframes — days back from the last data point. `all`
 *  falls through to no-op (returns full series). Order matters for
 *  render order in the pill row (short → long, "All" always last). */
const TIMEFRAMES = [
  { code: "1M", label: "1M", days: 30 },
  { code: "3M", label: "3M", days: 90 },
  { code: "6M", label: "6M", days: 180 },
  { code: "1Y", label: "1Y", days: 365 },
  { code: "3Y", label: "3Y", days: 365 * 3 },
  { code: "all", label: "All", days: null },
] as const;

type TimeframeCode = (typeof TIMEFRAMES)[number]["code"];

/** Default timeframe on mount — 3 months is the sweet spot for a
 *  daily-recording surface: recent enough to show today's move and
 *  the last few weeks of context, but wide enough that a single
 *  day's contribution doesn't dominate the y-scale. Users can zoom
 *  out to 1Y / 3Y / All with a tap when they want the broader view. */
const DEFAULT_TIMEFRAME: TimeframeCode = "3M";

/** Slice `data` to the last N days (inclusive of the last row). */
function sliceByTimeframe(
  data: StudioChartPoint[],
  days: number | null
): StudioChartPoint[] {
  if (days == null || data.length === 0) return data;
  const lastDate = data[data.length - 1].date;
  const cutoff = new Date(lastDate);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cutoffISO = cutoff.toISOString().slice(0, 10);
  return data.filter((p) => p.date >= cutoffISO);
}

export function GrowthChart({
  data,
  shouldAnimate = false,
  telemetryRunId,
  telemetryTheme = "unknown",
}: {
  data: StudioChartPoint[];
  /** Toggles the full choreography: chart line-draw + pill fade-in
   *  + number roll-ups. Off = instant static render (skip path). */
  shouldAnimate?: boolean;
  /** Shared telemetry run id from RevealDashboard. */
  telemetryRunId?: string;
  /** Theme tag for per-variant consistency metrics. */
  telemetryTheme?: StudioTelemetryTheme;
}) {
  const [timeframe, setTimeframe] = useState<TimeframeCode>(DEFAULT_TIMEFRAME);
  const [chartGlowCycle, setChartGlowCycle] = useState(0);
  // ENTRANCE-ONLY ANIMATION GATE
  // ────────────────────────────
  // Recharts's `isAnimationActive` retriggers the line-draw on
  // every re-render — including timeframe changes, which we
  // explicitly want to feel snappy (tap → new slice, no re-draw
  // ceremony). So we hold isAnimationActive TRUE only for the
  // duration of the entrance sweep, then flip it FALSE.
  //
  // Previous attempt used `hasEntered` flipped by Recharts's
  // `onAnimationEnd` callback + `animationBegin={100}` for a
  // delayed start. That combination silently broke the animation:
  // during the 100ms animationBegin delay, Recharts renders the
  // Area at FINAL state (no clip); by the time the animation
  // "starts" the viewer has already seen the completed chart, and
  // any subsequent draw is imperceptible.
  //
  // Simpler and reliable: a plain setTimeout that flips `entering`
  // off exactly one CHART_DURATION after mount. No animationBegin,
  // no onAnimationEnd race, no dependency on Recharts's internal
  // callback firing behaviour.
  const [entering, setEntering] = useState<boolean>(shouldAnimate);
  useEffect(() => {
    if (!shouldAnimate) return;
    setChartGlowCycle((n) => n + 1);
    const id = window.setTimeout(
      () => setEntering(false),
      STUDIO_TIMING.CHART_DURATION + 200
    );
    return () => window.clearTimeout(id);
    // Effect runs once on mount — shouldAnimate is a prop that
    // doesn't change during the component's lifetime (parent
    // remounts RevealDashboard between reveal cycles instead).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sliced = useMemo(
    () =>
      sliceByTimeframe(
        data,
        TIMEFRAMES.find((t) => t.code === timeframe)?.days ?? null
      ),
    [data, timeframe]
  );

  // Pill anchors to the LAST point that actually has a value (not
  // just the last row of the sliced window). If the user has invested
  // rows extending past the last mf_daily_reconstructed snapshot, we
  // still want the pill to read the most recent KNOWN value rather
  // than "—". Falls back to null when there's no value data at all
  // (fresh account, backfill not run) — the pill silently hides.
  const lastValued = useMemo(() => {
    for (let i = sliced.length - 1; i >= 0; i--) {
      if (sliced[i].value != null) return sliced[i];
    }
    return null;
  }, [sliced]);
  const first = sliced.length > 0 ? sliced[0] : null;
  // `lastRow` is the final row of the sliced window — used for the
  // bottom-right date label ("date range shown by this chart"). It
  // can have a null value (e.g., user has invested rows past the last
  // reconstructed snapshot); the pill still anchors to `lastValued`
  // which walks backwards to the most recent priced day.
  const lastRow = sliced.length > 0 ? sliced[sliced.length - 1] : null;
  const gainInr =
    lastValued && lastValued.value != null
      ? lastValued.value - lastValued.invested
      : 0;
  const gainPct =
    lastValued && lastValued.invested > 0
      ? (gainInr / lastValued.invested) * 100
      : null;

  // Y-domain — tightened to data (data max × 1.15) so the curve fills
  // the frame. Older behaviour extended yMax up to the NEXT milestone
  // above the data (e.g., ₹1Cr for a ~₹40L portfolio), which pushed
  // the curve into the bottom fifth of the chart and looked terrible
  // on camera. The motivational "next target" is now surfaced in the
  // floating pill instead — chart stays cinematic, aspiration
  // preserved.
  // Reduce over both curves. `p.value` is nullable (see
  // StudioChartPoint type comment): treat null as 0 for the yMax
  // calculation so we don't get NaN and the domain stays [0, yMax].
  const dataMax = useMemo(
    () =>
      sliced.reduce(
        (m, p) => Math.max(m, p.value ?? 0, p.invested),
        0
      ),
    [sliced]
  );
  const yMax = useMemo(() => Math.max(dataMax * 1.15, 1), [dataMax]);
  // Reference lines are computed dynamically from yMax using "nice
  // numbers" (multiples of 1/2/5 × 10^n). This means:
  //   • Zoomed in (e.g. 1M slice on a ₹40L portfolio, yMax ≈ 45L):
  //     four lines at ₹10L / ₹20L / ₹30L / ₹40L give real reading
  //     resolution.
  //   • Zoomed out (e.g. All-time with future ₹4Cr portfolio,
  //     yMax ≈ 4.6Cr): four lines at ₹1Cr / ₹2Cr / ₹3Cr / ₹4Cr —
  //     still meaningful, no accidental crowding.
  // Previous implementation used only the four hardcoded aspirational
  // milestones (₹10L / ₹1Cr / ₹10Cr / ₹100Cr) which meant most
  // portfolios saw AT MOST one line on the entire chart. This
  // adaptive scale gives 4-6 reference marks at all zoom levels.
  const referenceLines = useMemo(() => computeReferenceLines(yMax), [yMax]);
  // The first milestone strictly above current value — surfaced in
  // the pill as the aspirational "next" marker. Null once the top
  // milestone (₹100 Cr) is reached.
  const nextMilestone = useMemo(
    () =>
      lastValued && lastValued.value != null
        ? MILESTONES.find((m) => m.value > lastValued.value!) ?? null
        : null,
    [lastValued]
  );

  const selectTimeframe = (next: TimeframeCode): void => {
    if (next === timeframe) return;
    const previous = timeframe;
    setTimeframe(next);
    setChartGlowCycle((n) => n + 1);
    if (!telemetryRunId) return;
    recordStudioInteraction({
      runId: telemetryRunId,
      theme: telemetryTheme,
      name: "chart.timeframe.change",
      metadata: { from: previous, to: next },
    });
  };

  if (sliced.length === 0) {
    return (
      <section
        aria-label="Growth chart"
        className={`flex ${STUDIO_CHART_HEIGHT_CLASS} w-full flex-col items-center justify-center bg-muted/10`}
      >
        <p className="text-sm text-muted-foreground">No portfolio data yet.</p>
        <p className="mt-1 text-[11px] text-muted-foreground/70">
          Log your first order above to see the growth curve.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-label="Growth chart"
      className="relative w-full overflow-hidden"
    >
      {chartGlowCycle > 0 && (
        <motion.div
          key={`chart-glow-${chartGlowCycle}-${timeframe}`}
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-8 left-[-35%] z-[1] w-[45%] rounded-full bg-gradient-to-r from-transparent via-[hsl(var(--primary)/0.22)] to-transparent blur-2xl"
          initial={{ opacity: 0, x: "0%" }}
          animate={{ opacity: [0, 0.55, 0], x: ["0%", "220%"] }}
          transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
        />
      )}

      {/* Current-value pill (top-right, floats over the chart).
          When shouldAnimate=true, the pill fades in at ~1.4s (matched
          to the last third of the chart's line-draw sweep) and the
          value + gain% count up from 0 over 1s. The "next milestone"
          line surfaces the aspiration since the y-axis is now tight
          to the data (no unreachable milestone in view). */}
      {lastValued && lastValued.value != null && (
        <motion.div
          initial={shouldAnimate ? { opacity: 0, y: -6, scale: 0.96 } : false}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{
            delay: shouldAnimate ? STUDIO_TIMING.PILL_BEGIN / 1000 : 0,
            duration: 0.4,
            ease: [0.16, 1, 0.3, 1],
          }}
          className="pointer-events-none absolute left-4 top-4 z-10 rounded-xl border border-border bg-background/70 px-3 py-2 backdrop-blur"
        >
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Value
          </div>
          <div className="text-lg font-semibold tabular-nums text-foreground">
            <RollUpNumber
              value={lastValued.value}
              format={fmtCompactINR}
              animate={shouldAnimate}
              delay={STUDIO_TIMING.PILL_BEGIN}
              duration={STUDIO_TIMING.PILL_DURATION}
              telemetry={
                telemetryRunId
                  ? {
                      runId: telemetryRunId,
                      theme: telemetryTheme,
                      metric: "pill.value",
                    }
                  : undefined
              }
            />
          </div>
          {gainPct != null && (
            <div
              className={cn(
                "text-[10px] font-medium tabular-nums",
                gainInr >= 0
                  ? "text-[hsl(var(--success))]"
                  : "text-[hsl(var(--danger))]"
              )}
            >
              <RollUpNumber
                value={gainPct}
                format={(n) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`}
                animate={shouldAnimate}
                delay={STUDIO_TIMING.PILL_BEGIN}
                duration={STUDIO_TIMING.PILL_DURATION}
                telemetry={
                  telemetryRunId
                    ? {
                        runId: telemetryRunId,
                        theme: telemetryTheme,
                        metric: "pill.gainPct",
                      }
                    : undefined
                }
              />
            </div>
          )}
          {nextMilestone && (
            <div className="mt-1 border-t border-border pt-1 text-[9px] uppercase tracking-wider text-muted-foreground">
              next{" "}
              <span className="font-semibold text-foreground">
                {nextMilestone.label}
              </span>{" "}
              ·{" "}
              <RollUpNumber
                value={(lastValued.value / nextMilestone.value) * 100}
                format={(n) => `${n.toFixed(1)}%`}
                animate={shouldAnimate}
                delay={STUDIO_TIMING.PILL_BEGIN}
                duration={STUDIO_TIMING.PILL_DURATION}
                telemetry={
                  telemetryRunId
                    ? {
                        runId: telemetryRunId,
                        theme: telemetryTheme,
                        metric: "pill.nextMilestonePct",
                      }
                    : undefined
                }
              />
            </div>
          )}
        </motion.div>
      )}

      {/* Parent div owns the height (via the shared dvh class) so
          ResponsiveContainer can measure a real box. Passing
          height={440} to ResponsiveContainer directly worked, but
          ignored the shared STUDIO_CHART_HEIGHT_CLASS constant and
          drifted from the loading skeleton / no-data fallback,
          both of which use CSS classes. */}
      <div className={`w-full ${STUDIO_CHART_HEIGHT_CLASS}`}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={sliced}
            margin={{ top: 24, right: 12, bottom: 8, left: 12 }}
          >
          <defs>
            {/* Gradient for the value area — brand at the top,
                transparent at the bottom, so the top-of-curve reads
                as a bright ridge on a dark or light background. */}
            <linearGradient id="studioValueGrad" x1="0" x2="0" y1="0" y2="1">
              <stop
                offset="0%"
                stopColor="hsl(var(--primary))"
                stopOpacity={0.4}
              />
              <stop
                offset="100%"
                stopColor="hsl(var(--primary))"
                stopOpacity={0.02}
              />
            </linearGradient>
          </defs>
          <YAxis hide domain={[0, yMax]} />
          <XAxis dataKey="date" hide />
          <Tooltip content={<StudioTooltip />} />

          {/* Milestone reference lines — behind the data curves. */}
          {referenceLines.map((line) => (
            <ReferenceLine
              key={line.value}
              y={line.value}
              stroke="hsl(var(--muted-foreground)/0.35)"
              strokeDasharray="2 4"
              label={{
                value: line.label,
                position: "insideRight",
                fill: "hsl(var(--muted-foreground))",
                fontSize: 10,
                offset: 6,
              }}
            />
          ))}

          {/* Value area — the hero curve. Rendered BEFORE the invested
              line so the invested line reads on top. `entering` is
              TRUE for the first CHART_DURATION+200ms after mount and
              FALSE thereafter, so the entrance sweep plays exactly
              once and later timeframe changes snap without re-drawing. */}
          <Area
            dataKey="value"
            type="monotone"
            stroke="hsl(var(--primary))"
            strokeWidth={2.25}
            fill="url(#studioValueGrad)"
            isAnimationActive={entering}
            animationDuration={STUDIO_TIMING.CHART_DURATION}
            animationEasing="ease-out"
            activeDot={{ r: 4 }}
            connectNulls={false}
          />

          {/* Invested line — dashed, muted; the "money you put in"
              reference. Gap between this and value = unrealised gain.
              Draws in parallel with the value area for a coordinated
              two-curve reveal. */}
          <Line
            dataKey="invested"
            type="monotone"
            stroke="hsl(var(--muted-foreground))"
            strokeWidth={1.25}
            strokeDasharray="4 3"
            dot={false}
            isAnimationActive={entering}
            animationDuration={STUDIO_TIMING.CHART_DURATION}
            animationEasing="ease-out"
          />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Timeframe pills — below the chart. Full-width but padded to
          keep tap targets comfortable on mobile. */}
      <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-1">
        {first && (
          <div className="text-[10px] text-muted-foreground">
            {fmtDateShortIST(first.date)}
          </div>
        )}
        <div className="flex gap-1 rounded-md border border-border p-0.5">
          {TIMEFRAMES.map((t) => (
            <button
              key={t.code}
              type="button"
              onClick={() => selectTimeframe(t.code)}
              className={cn(
                "rounded px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors",
                timeframe === t.code
                  ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        {lastRow && (
          <div className="text-[10px] text-muted-foreground">
            {fmtDateShortIST(lastRow.date)}
          </div>
        )}
      </div>
    </section>
  );
}

/** Custom tooltip — dark rounded card with date, value, invested, and
 *  the gain read in the same green/red the pill uses. Kept as a
 *  small internal component so its markup lives right next to the
 *  chart it belongs to. */
function StudioTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value?: number; dataKey?: string }>;
  label?: string | number;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const valuePoint = payload.find((p) => p.dataKey === "value")?.value;
  const investedPoint = payload.find((p) => p.dataKey === "invested")?.value;
  if (investedPoint == null) return null;
  // Value can legitimately be null for the pre-value-data window
  // (invested history predates mf_daily_reconstructed coverage).
  // Show only the invested row in that case — hiding the value/gain
  // lines rather than misreporting them as 0.
  const gain = valuePoint != null ? valuePoint - investedPoint : null;
  const gainPct =
    gain != null && investedPoint > 0 ? (gain / investedPoint) * 100 : null;
  return (
    <div className="rounded-lg border border-border bg-background/95 px-3 py-2 text-xs shadow-lg backdrop-blur">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        {fmtDateShortIST(typeof label === "string" ? label : String(label))}
      </div>
      {valuePoint != null && (
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] text-muted-foreground">Value</span>
          <span className="tabular-nums text-foreground">
            {fmtINR(valuePoint)}
          </span>
        </div>
      )}
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] text-muted-foreground">Invested</span>
        <span className="tabular-nums text-foreground">
          {fmtINR(investedPoint)}
        </span>
      </div>
      {gain != null && gainPct != null && (
        <div
          className={cn(
            "mt-1 flex items-baseline gap-2 text-[10px] font-semibold tabular-nums",
            gain >= 0
              ? "text-[hsl(var(--success))]"
              : "text-[hsl(var(--danger))]"
          )}
        >
          <span>{gain >= 0 ? "▲" : "▼"}</span>
          <span>{fmtINR(Math.abs(gain))}</span>
          <span>· {gain >= 0 ? "+" : "-"}{Math.abs(gainPct).toFixed(2)}%</span>
        </div>
      )}
      {valuePoint == null && (
        <div className="mt-1 text-[9px] italic text-muted-foreground">
          value data starts later
        </div>
      )}
    </div>
  );
}
