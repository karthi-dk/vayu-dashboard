"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card } from "@/components/ui/Card";
import { fmtL, fmtINR } from "@/lib/utils";
import type { ItrReturn } from "@/lib/filings-types";

/**
 * "How the tax got paid" — a stacked bar per AY showing the mix of
 * TDS + Advance Tax + Self-Assessment Tax. Complements TaxRateChart:
 * that one shows how MUCH tax, this one shows HOW IT WAS FUNDED.
 *
 * A large SAT component reads as "TDS didn't cover the year's
 * liability, I had to top up at filing time" — a fixable pattern
 * (advance tax payments spread across quarters avoid 234B/C interest).
 * A green refund overlay marks years where TDS OVERPAID, i.e. money
 * the CBDT temporarily held.
 *
 * Stacked bars are the right grammar here because:
 *   • Each component adds to a total (unlike Tax vs Refund)
 *   • The user cares about the SHAPE of the stack across years
 *     (is SAT growing? Is advance tax being paid at all?)
 */
export function TaxCompositionChart({ returns }: { returns: ItrReturn[] }) {
  const revisedAys = new Set(
    returns.filter((r) => r.is_revised).map((r) => r.assessment_year)
  );
  const canonical = returns
    .filter((r) => r.is_revised || !revisedAys.has(r.assessment_year))
    .sort((a, b) => (a.assessment_year < b.assessment_year ? -1 : 1));

  const data = canonical.map((r) => ({
    ay: r.assessment_year,
    TDS: r.tds_salary + r.tds_other,
    "Advance Tax": r.advance_tax,
    SAT: r.self_assessment_tax,
    TCS: r.tcs,
    Refund: r.refund_due,
    liability: r.total_tax_liability,
  }));

  if (data.length === 0) return null;

  // Only render bars/legend swatches for categories with actual data.
  // Keeps the legend focused: if the user has never paid advance tax
  // or had TCS, no reason to reserve legend real estate for them.
  const anyTds = data.some((d) => d.TDS > 0);
  const anyAdvance = data.some((d) => d["Advance Tax"] > 0);
  const anySat = data.some((d) => d.SAT > 0);
  const anyTcs = data.some((d) => d.TCS > 0);

  return (
    <Card className="p-5">
      <div className="mb-1 flex items-baseline justify-between">
        <h2 className="text-base font-semibold text-foreground">
          How the tax got paid
        </h2>
        <span className="text-xs text-muted-foreground">
          {[
            anyTds && "TDS",
            anyAdvance && "Advance Tax",
            anySat && "SAT",
            anyTcs && "TCS",
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        A large SAT stripe means TDS under-withheld — pay quarterly
        advance tax to avoid 234B/234C interest.
      </p>
      <div style={{ width: "100%", height: 300 }}>
        <ResponsiveContainer>
          <BarChart data={data} margin={{ top: 10, right: 20, bottom: 8, left: 4 }}>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="ay"
              tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: "hsl(var(--border))" }}
            />
            <YAxis
              tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
              tickFormatter={(v: number) => `${(v / 1e5).toFixed(0)}L`}
              tickLine={false}
              axisLine={{ stroke: "hsl(var(--border))" }}
            />
            <Tooltip
              content={<CompositionTooltip />}
              cursor={{ fill: "hsl(var(--muted-foreground) / 0.08)" }}
            />
            <Legend
              wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
              iconType="square"
            />
            {anyTds && (
              <Bar
                dataKey="TDS"
                stackId="paid"
                fill="hsl(var(--primary))"
                maxBarSize={50}
              />
            )}
            {anyAdvance && (
              <Bar
                dataKey="Advance Tax"
                stackId="paid"
                fill="hsl(var(--muted-foreground) / 0.4)"
                maxBarSize={50}
              />
            )}
            {anySat && (
              <Bar
                dataKey="SAT"
                stackId="paid"
                fill="hsl(var(--warning))"
                maxBarSize={50}
                radius={anyTcs ? undefined : [4, 4, 0, 0]}
              />
            )}
            {anyTcs && (
              <Bar
                dataKey="TCS"
                stackId="paid"
                fill="hsl(var(--muted-foreground) / 0.7)"
                maxBarSize={50}
                radius={[4, 4, 0, 0]}
              />
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

type Row = {
  ay: string;
  TDS: number;
  "Advance Tax": number;
  SAT: number;
  TCS: number;
  Refund: number;
  liability: number;
};

function CompositionTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: Row }>;
}) {
  if (!active || !payload?.length) return null;
  const r = payload[0].payload;
  const totalPaid = r.TDS + r["Advance Tax"] + r.SAT + r.TCS;
  return (
    <div className="min-w-[220px] rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="mb-1.5 font-semibold text-foreground">AY {r.ay}</div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 tabular-nums">
        <span className="text-muted-foreground">TDS</span>
        <span className="text-right text-foreground">{fmtL(r.TDS)}</span>
        {r["Advance Tax"] > 0 && (
          <>
            <span className="text-muted-foreground">Advance Tax</span>
            <span className="text-right text-foreground">{fmtINR(r["Advance Tax"])}</span>
          </>
        )}
        {r.SAT > 0 && (
          <>
            <span className="text-muted-foreground">Self-Assessment</span>
            <span className="text-right text-[hsl(var(--warning))]">{fmtINR(r.SAT)}</span>
          </>
        )}
        {r.TCS > 0 && (
          <>
            <span className="text-muted-foreground">TCS</span>
            <span className="text-right text-foreground">{fmtINR(r.TCS)}</span>
          </>
        )}
        <span className="mt-1 border-t border-border pt-1 text-muted-foreground">Total paid</span>
        <span className="mt-1 border-t border-border pt-1 text-right font-semibold text-foreground">
          {fmtL(totalPaid)}
        </span>
        <span className="text-muted-foreground">Liability</span>
        <span className="text-right text-foreground">{fmtL(r.liability)}</span>
        {r.Refund > 0 && (
          <>
            <span className="text-muted-foreground">Refund due</span>
            <span className="text-right text-[hsl(var(--success))]">{fmtINR(r.Refund)}</span>
          </>
        )}
      </div>
    </div>
  );
}
