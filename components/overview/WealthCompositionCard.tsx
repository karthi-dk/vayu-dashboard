"use client";

import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";
import { HelpCircle } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Tooltip } from "@/components/ui/Tooltip";
import { fmtL, fmtPct, fmtCompactINR, fmtINR } from "@/lib/utils";
import type {
  WealthComposition,
  CompositionBucket,
  CompositionSlice,
} from "@/lib/queries";

/**
 * Wealth composition card — 4 donuts, one per bucket
 * =====================================================
 *
 * ONE card at the top of the Overview page containing four donuts in a
 * responsive grid: NW / MF / NPS / EPF. Each donut answers the question
 * "of the money I currently have here, how much did I put in vs. how
 * much came from market growth or compounded interest?"
 *
 * UNIFIED DONUT MODEL
 * -------------------
 * The two slices in every donut sum to a positive number regardless of
 * whether the bucket is in gain or loss:
 *
 *   Gain ≥ 0:  slice1 = Contributions (primary)
 *              slice2 = Growth        (success/green)
 *              Total = current
 *
 *   Gain < 0:  slice1 = Retained      (primary)
 *              slice2 = Loss          (danger/red)
 *              Total = contributions
 *
 * This lets us keep the same donut geometry across all states. The
 * center label shows the current value and the return %, with color
 * signaling the sign (green pos, red neg). The gain/loss slice makes
 * losing positions impossible to miss.
 *
 * The heavy lifting (slice sizing, gain sign detection, sensible defaults
 * when contributions or current is 0) lives in lib/queries.ts's
 * buildCompositionBucket — this component is a pure renderer.
 *
 * ESTIMATED BUCKETS
 * -----------------
 * When a bucket's contribution data is a best-guess seed rather than an
 * authoritative DB number (currently only EPF, until the user uploads
 * older passbooks), we show a small "?" tooltip trigger next to the
 * title. The NW rollup inherits the "estimated" flag from EPF.
 */
export function WealthCompositionCard({
  composition,
}: {
  composition: WealthComposition | null;
}) {
  if (!composition) {
    return (
      <Card className="p-4 sm:p-5">
        <Header />
        <p className="text-xs text-muted-foreground">
          Sync your portfolio to see the contributions vs. growth split.
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-4 sm:p-5">
      <Header />
      {/* 2×2 grid on md+; single column on mobile.
          Gap is intentionally large so the 4 donuts breathe — cramming
          them tighter reads as "one busy chart" instead of "four
          related summaries". */}
      <div className="mt-4 grid grid-cols-1 gap-6 sm:grid-cols-2">
        <BucketDonut bucket={composition.nw} />
        <BucketDonut bucket={composition.mf} />
        {composition.intl && <BucketDonut bucket={composition.intl} />}
        <BucketDonut bucket={composition.nps} />
        <BucketDonut bucket={composition.epf} />
      </div>
    </Card>
  );
}

function Header() {
  return (
    <div className="mb-1">
      <h2 className="text-sm font-semibold text-foreground">
        Wealth composition
      </h2>
      <p className="mt-0.5 text-xs text-muted-foreground">
        How much you contributed vs. how much came from growth · per
        bucket
      </p>
    </div>
  );
}

/**
 * Single bucket = one donut with legend below.
 *
 * Layout is vertical (title → donut → legend) rather than
 * side-by-side because the donut needs room and stacking scales
 * nicely to mobile.
 */
function BucketDonut({ bucket }: { bucket: CompositionBucket }) {
  const isLoss = bucket.gainInr < 0;
  const gainColor = isLoss ? "hsl(var(--danger))" : "hsl(var(--success))";

  // Recharts wants an array of {name, value} — one entry per slice.
  // Slice1 is always "the money you put in / retained" (primary tint);
  // slice2 is the delta (green if gain, red if loss). See the module
  // header for the unified model rationale.
  const chartData = bucket.slices.map((s) => ({
    name: s.label,
    value: s.inr,
    role: s.role,
  }));
  const donutTotal = bucket.slices.reduce((s, x) => s + x.inr, 0);

  return (
    <div className="flex flex-col items-center gap-3">
      {/* Title row — title on the left, "?" trigger on the right for
          estimated buckets so the user knows the split is a seed. */}
      <div className="flex w-full items-center justify-center gap-1.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {bucket.label}
        </span>
        {bucket.estimated && (
          <Tooltip
            content={
              bucket.label === "EPF" ? (
                <div className="min-w-[240px] space-y-1">
                  <div className="font-medium">Estimated split</div>
                  <div className="opacity-80">
                    Pre-FY25 opening balance is estimated at 82%
                    contributions / 18% interest — typical of 5–7 years
                    of active EPF plus a dormant passbook compounding.
                  </div>
                  <div className="opacity-60">
                    Will be exact once older EPFO passbooks (FY23-24,
                    FY24-25) are uploaded.
                  </div>
                </div>
              ) : (
                <div className="min-w-[240px] space-y-1">
                  <div className="font-medium">Includes an estimate</div>
                  <div className="opacity-80">
                    Rolls up MF (exact) + NPS (exact) + EPF (estimated).
                    The EPF portion has a rough contribution/interest
                    split; see the EPF donut for details.
                  </div>
                </div>
              )
            }
            side="bottom"
          >
            <HelpCircle
              size={11}
              className="text-muted-foreground/60 hover:text-muted-foreground"
              aria-label="Estimated data"
            />
          </Tooltip>
        )}
      </div>

      {/* Donut with centered hero + return %. Fixed height (180px) with
          ResponsiveContainer for width so the four donuts stay visually
          aligned across the grid regardless of card width. Center
          overlay uses absolute positioning so its layout doesn't
          interfere with the chart's internal padding. */}
      <div className="relative aspect-square w-full max-w-[200px]">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={chartData}
              cx="50%"
              cy="50%"
              innerRadius="70%"
              outerRadius="95%"
              startAngle={90}
              endAngle={-270}
              paddingAngle={
                // Small gap between slices makes the two-slice donut
                // visually parseable even when one slice is very small
                // (e.g., a 2% growth slice). We disable it entirely
                // when a slice is 0 to avoid recharts rendering a
                // 100%-of-one-color donut with a suspicious gap.
                bucket.slices[0].inr > 0 && bucket.slices[1].inr > 0
                  ? 1.5
                  : 0
              }
              dataKey="value"
              isAnimationActive={false} // matches other Overview charts
              stroke="none"
            >
              {chartData.map((entry) => (
                <Cell
                  key={entry.role}
                  fill={colorForRole(entry.role, gainColor)}
                />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>

        {/* Center overlay — current value + return %. Positioned
            absolutely so the chart can size itself without knowing
            about the label.
            
            The parent stays pointer-events-none so hovering over the
            hero label doesn't intercept the pie's own hover state, but
            we opt the return % back in with pointer-events-auto so its
            tooltip is reachable. The dotted underline is the subtle
            signal that says "hover me for context". */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <div className="text-base font-semibold tabular-nums text-foreground sm:text-lg">
            {fmtL(bucket.currentInr)}
          </div>
          {bucket.gainPct === null ? (
            <span className="text-[11px] font-medium tabular-nums text-muted-foreground">
              —
            </span>
          ) : (
            <Tooltip
              content={<ReturnExplainer bucket={bucket} isLoss={isLoss} />}
              side="bottom"
            >
              <span
                className="pointer-events-auto cursor-help border-b border-dotted text-[11px] font-medium tabular-nums"
                style={{ color: gainColor, borderColor: gainColor }}
              >
                {fmtPct(bucket.gainPct, { sign: true, digits: 1 })}
              </span>
            </Tooltip>
          )}
        </div>
      </div>

      {/* Legend — two rows, one per slice. Amount uses fmtCompactINR
          because a 4-donut grid gets crowded fast with full ₹ values;
          "₹12.6 L" scans quicker than "₹12,60,834". Tooltip on hover
          gives the exact number for anyone who wants it. */}
      <div className="w-full space-y-1 text-[11px]">
        {bucket.slices.map((slice, i) => (
          <LegendRow
            key={i}
            slice={slice}
            color={colorForRole(slice.role, gainColor)}
            total={donutTotal}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The tooltip that pops up when you hover the return % in a donut's
 * centre.
 *
 * Goal: kill the "why are there two different percentages on the same
 * donut?" question in one hover. The layout is deliberately walking
 * the user through the story:
 *
 *   1. Headline — "This is your return" / "This is your loss"
 *   2. Concrete arithmetic with your actual numbers
 *   3. The ₹100 analogy — makes the % intuitive
 *   4. A footnote that names the other %, so the confusion is resolved
 *      inline rather than in the user's head
 *
 * We deliberately avoid the word "denominator" and any variation of
 * "return on investment" — the audience isn't a finance person, it's
 * the person who dropped ₹15L into an EPF account over 5 years and
 * wants to know what the numbers mean.
 */
function ReturnExplainer({
  bucket,
  isLoss,
}: {
  bucket: CompositionBucket;
  isLoss: boolean;
}) {
  // Absolute magnitudes so we can format the ± sign in one place
  // rather than sprinkling conditionals across the JSX.
  const absGainInr = Math.abs(bucket.gainInr);
  const absGainPct = Math.abs(bucket.gainPct ?? 0);
  // For-every-100-you-put-in figure. Rounded to whole ₹ because a
  // one-decimal precision here just adds noise ("₹122.4 today" reads
  // messier than "₹122").
  const per100 = Math.round(100 + (bucket.gainPct ?? 0));

  // The "other" % — legend's growth/loss share of the current pile.
  // Computed here (rather than passed in) so the tooltip is self-
  // contained. donutTotal = sum of both slices, which equals current
  // in the gain case and contributions in the loss case (see the
  // unified donut model in this file's header).
  const donutTotal = bucket.slices.reduce((s, x) => s + x.inr, 0);
  const deltaSlice = bucket.slices.find(
    (s) => s.role === "growth" || s.role === "loss"
  );
  const deltaSharePct =
    donutTotal > 0 && deltaSlice ? (deltaSlice.inr / donutTotal) * 100 : 0;

  return (
    <div className="max-w-[260px] space-y-2">
      <div className="text-[12px] font-medium">
        {isLoss ? "This is your loss" : "This is your return"}
      </div>

      <div className="space-y-1 opacity-90">
        <div>
          You put in{" "}
          <span className="font-medium">{fmtINR(bucket.contributionsInr)}</span>
          .
        </div>
        <div>
          Today it&apos;s worth{" "}
          <span className="font-medium">{fmtINR(bucket.currentInr)}</span>.
        </div>
        <div>
          That&apos;s{" "}
          <span className="font-medium">
            {isLoss ? "−" : "+"}
            {fmtINR(absGainInr)}
          </span>{" "}
          — a <span className="font-medium">{absGainPct.toFixed(1)}%</span>{" "}
          {isLoss ? "loss" : "gain"} on what you put in.
        </div>
      </div>

      <div className="rounded bg-black/10 px-2 py-1.5 opacity-90">
        For every <span className="font-medium">₹100</span> you{" "}
        {isLoss ? "invested" : "saved"}, you have{" "}
        <span className="font-medium">₹{per100}</span> today.
      </div>

      {/* Footnote that pre-answers "then what's the other %?". Kept
          intentionally short — anyone who wants the long version can
          go read the legend. */}
      <div className="border-t border-current/20 pt-1.5 text-[10px] opacity-70">
        Not the same as{" "}
        <span className="font-medium">
          {deltaSharePct.toFixed(0)}% below
        </span>{" "}
        — that&apos;s how much of your current pile is{" "}
        {isLoss ? "the loss" : "growth"}. This one is how much your money{" "}
        {isLoss ? "shrank" : "grew"}.
      </div>
    </div>
  );
}

function LegendRow({
  slice,
  color,
  total,
}: {
  slice: CompositionSlice;
  color: string;
  total: number;
}) {
  const pct = total > 0 ? (slice.inr / total) * 100 : 0;
  return (
    <div className="flex items-baseline justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          aria-hidden
          className="inline-block h-2 w-2 shrink-0 rounded-sm"
          style={{ background: color }}
        />
        <span className="truncate text-muted-foreground">{slice.label}</span>
      </div>
      <div className="flex items-baseline gap-1.5 whitespace-nowrap tabular-nums">
        <span className="font-medium text-foreground">
          {fmtCompactINR(slice.inr)}
        </span>
        <span className="text-muted-foreground">({pct.toFixed(0)}%)</span>
      </div>
    </div>
  );
}

/**
 * Map a slice's semantic role to its color.
 *
 * Contribution / Retained → primary (indigo/purple, "your money that's
 *   here"). Uses the theme's --primary so the color auto-swaps
 *   between light and dark modes.
 * Growth → success (green — positive delta)
 * Loss → danger (red — negative delta)
 *
 * We pass the pre-computed `deltaColor` in for growth/loss so the
 * caller doesn't have to keep the isLoss logic in sync with a lookup
 * table here. Everything else falls back to primary.
 */
function colorForRole(
  role: CompositionSlice["role"],
  deltaColor: string
): string {
  switch (role) {
    case "contribution":
    case "retained":
      return "hsl(var(--primary))";
    case "growth":
    case "loss":
      return deltaColor;
    default:
      return "hsl(var(--muted-foreground))";
  }
}
