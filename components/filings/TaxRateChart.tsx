"use client";

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card } from "@/components/ui/Card";
import { fmtL } from "@/lib/utils";
import type { ItrReturn } from "@/lib/filings-types";
import { effectiveRatePct } from "@/lib/filings-types";

/**
 * The primary chart for the Filings page — answers "of every ₹100 I
 * earned, how much went to tax" over the last N years, alongside the
 * gross earned each year so the rate has context.
 *
 * Composite of two visuals sharing one X axis:
 *   • Bars: gross earned (salary + other income) per year — grey/muted
 *     to keep the eye on the line above
 *   • Line: effective tax rate — the star of the chart, danger-toned
 *     so it reads as "your tax burden"
 *
 * Right-hand Y axis is a %; left-hand is ₹. Two axes are unavoidable
 * here — the alternative (normalizing both to a shared scale) hides
 * that a ₹40 L year at 22% is much heavier than a ₹17 L year at 15%.
 *
 * We de-dup revised returns: if AY 22-23 has both an original and a
 * revised, the revised replaces the original in the series. The
 * caller passes ALL rows; we pick the canonical one per AY here.
 */
export function TaxRateChart({ returns }: { returns: ItrReturn[] }) {
  const revisedAys = new Set(
    returns.filter((r) => r.is_revised).map((r) => r.assessment_year)
  );
  const canonical = returns
    .filter((r) => r.is_revised || !revisedAys.has(r.assessment_year))
    .sort((a, b) => (a.assessment_year < b.assessment_year ? -1 : 1));

  const data = canonical.map((r) => ({
    ay: r.assessment_year,
    gross: r.gross_salary + r.income_other_sources,
    tax: r.total_tax_liability,
    ratePct: Number(effectiveRatePct(r).toFixed(2)),
    kept: Number((100 - effectiveRatePct(r)).toFixed(2)),
    regime: r.regime,
  }));

  if (data.length === 0) return null;

  return (
    <Card className="p-5">
      <div className="mb-1 flex items-baseline justify-between">
        <h2 className="text-base font-semibold text-foreground">
          Tax rate over time
        </h2>
        <span className="text-xs text-muted-foreground">
          Grey bars: gross earned · Red line: ₹ per ₹100 earned that went to tax
        </span>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        Denominator = gross salary + other-source income (pre-deduction).
      </p>
      <div style={{ width: "100%", height: 320 }}>
        <ResponsiveContainer>
          <ComposedChart data={data} margin={{ top: 10, right: 20, bottom: 8, left: 4 }}>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="ay"
              tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: "hsl(var(--border))" }}
            />
            <YAxis
              yAxisId="inr"
              orientation="left"
              tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
              tickFormatter={(v: number) => `${(v / 1e5).toFixed(0)}L`}
              tickLine={false}
              axisLine={{ stroke: "hsl(var(--border))" }}
              label={{
                value: "Gross earned",
                angle: -90,
                position: "insideLeft",
                offset: 12,
                style: { fill: "hsl(var(--muted-foreground))", fontSize: 10 },
              }}
            />
            <YAxis
              yAxisId="pct"
              orientation="right"
              tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
              tickFormatter={(v: number) => `₹${v}`}
              tickLine={false}
              axisLine={{ stroke: "hsl(var(--border))" }}
              domain={[0, 30]}
              label={{
                value: "Tax per ₹100",
                angle: 90,
                position: "insideRight",
                offset: 12,
                style: { fill: "hsl(var(--muted-foreground))", fontSize: 10 },
              }}
            />
            <Tooltip content={<RateTooltip />} />
            <Bar
              yAxisId="inr"
              dataKey="gross"
              fill="hsl(var(--muted-foreground) / 0.25)"
              radius={[4, 4, 0, 0]}
              maxBarSize={50}
            />
            <Line
              yAxisId="pct"
              type="monotone"
              dataKey="ratePct"
              stroke="hsl(var(--danger))"
              strokeWidth={2.5}
              dot={{ r: 5, fill: "hsl(var(--danger))" }}
              activeDot={{ r: 7 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

type Row = {
  ay: string;
  gross: number;
  tax: number;
  ratePct: number;
  kept: number;
  regime: "new" | "old";
};

function RateTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: Row }>;
}) {
  if (!active || !payload?.length) return null;
  const r = payload[0].payload;
  return (
    <div className="min-w-[220px] rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="mb-1.5 flex items-baseline gap-2 text-muted-foreground">
        <span className="font-semibold text-foreground">AY {r.ay}</span>
        <span className="text-[10px] uppercase tracking-wider">{r.regime}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 tabular-nums">
        <span className="text-muted-foreground">Gross earned</span>
        <span className="text-right text-foreground">{fmtL(r.gross)}</span>
        <span className="text-muted-foreground">Tax paid</span>
        <span className="text-right text-foreground">{fmtL(r.tax)}</span>
        <span className="text-muted-foreground">To tax</span>
        <span className="text-right font-semibold text-[hsl(var(--danger))]">
          ₹{r.ratePct.toFixed(2)} / ₹100
        </span>
        <span className="text-muted-foreground">Kept</span>
        <span className="text-right font-semibold text-[hsl(var(--success))]">
          ₹{r.kept.toFixed(2)} / ₹100
        </span>
      </div>
    </div>
  );
}
