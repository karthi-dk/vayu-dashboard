"use client";

import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";
import { Card } from "@/components/ui/Card";
import { fmtL } from "@/lib/utils";

type Slice = { name: string; value: number; key: string };

export function DonutCard({
  title,
  kicker,
  data,
  colors,
  total,
  totalLabel,
}: {
  title: string;
  kicker: string;
  data: Slice[];
  colors: Record<string, string>;
  total: number;
  totalLabel?: string;
}) {
  const rows = data.map((s) => ({
    ...s,
    pct: (s.value / total) * 100,
  }));

  return (
    <Card className="p-5">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <p className="mt-0.5 kicker">{kicker}</p>
      </div>
      {/* Stacked layout: donut centered on top, legend spans the full
          card width below. Previously the donut + legend sat in a
          [180px _ 1fr] grid which cramped the legend at 3-across on
          lg viewports — "₹38.60 L" would break between the number
          and the "L" suffix (space is a wrap-opportunity) and long
          slice names like "Mutual Funds" or "Indian equity" would
          split across two lines. The stacked layout gives the legend
          the full ~280px card width so both stay on one line. */}
      <div className="flex flex-col items-center gap-4">
        <div className="relative h-[160px] w-[160px] shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={rows}
                cx="50%"
                cy="50%"
                innerRadius={52}
                outerRadius={74}
                dataKey="value"
                stroke="hsl(var(--card))"
                strokeWidth={2}
                startAngle={90}
                endAngle={-270}
                isAnimationActive={false}
              >
                {rows.map((s) => (
                  <Cell key={s.key} fill={colors[s.key] ?? "hsl(var(--muted))"} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-2 text-center">
            {totalLabel && (
              <span className="kicker mb-0.5 whitespace-nowrap">{totalLabel}</span>
            )}
            <span className="whitespace-nowrap text-base font-bold text-foreground">
              {fmtL(total)}
            </span>
          </div>
        </div>

        <ul className="w-full space-y-1.5">
          {rows.map((s) => (
            <li
              key={s.key}
              className="flex items-center justify-between gap-2 text-sm"
            >
              {/* min-w-0 lets the name column shrink if legend gets
                  cramped; without it the flex parent honours the
                  natural width of the text and forces the row to
                  overflow horizontally. `truncate` then cuts long
                  slice names ("International" is the longest in this
                  page's data) with an ellipsis. */}
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: colors[s.key] ?? "hsl(var(--muted))" }}
                />
                <span className="truncate text-muted-foreground">
                  {s.name}
                </span>
              </span>
              {/* whitespace-nowrap on the value block keeps
                  "₹38.60 L" glued together — fmtL emits a literal
                  space between the number and "L" which browsers
                  otherwise treat as a break opportunity. */}
              <span className="flex shrink-0 items-baseline gap-2 whitespace-nowrap">
                <span className="font-medium tabular-nums text-foreground">
                  {fmtL(s.value)}
                </span>
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {s.pct.toFixed(1)}%
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
