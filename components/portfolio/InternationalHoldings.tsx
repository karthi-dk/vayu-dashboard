import { Card } from "@/components/ui/Card";
import { cn, fmtINR, fmtPct } from "@/lib/utils";
import type { Fund } from "@/lib/queries";

/**
 * Compact International holdings strip for the Portfolio page.
 *
 * International is a separate asset class (ICICI Nasdaq + HDFC GIFT
 * City), so it is deliberately NOT in the MF `HoldingsTable`. This is a
 * trimmed table — no Bucket, no Index NAV / vs Index, no My-avg-NAV —
 * because those columns are either meaningless (both funds are "Intl")
 * or currency-mixed (HDFC's NAV is USD, ICICI's is INR). Every ₹ column
 * here is the INR repatriation value; the USD/FX/exit-today mechanics
 * live in the Overview page's InternationalCard.
 */
export function InternationalHoldings({
  funds,
  intlTotal,
}: {
  funds: Fund[];
  intlTotal: number;
}) {
  if (funds.length === 0) return null;

  const rows = [...funds].sort(
    (a, b) => b.current_value_inr - a.current_value_inr
  );

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-border p-5">
        <h2 className="text-sm font-semibold text-foreground">
          International holdings
        </h2>
        <p className="mt-0.5 kicker">
          Sorted by current value · {rows.length}{" "}
          {rows.length === 1 ? "fund" : "funds"}
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <Th label="Fund" align="left" />
              <Th label="Current" align="right" />
              <Th
                label="% of Intl"
                align="right"
                title="This fund's share of your total International value."
              />
              <Th label="Invested" align="right" />
              <Th label="1D change" align="right" />
              <Th label="Gain" align="right" />
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => {
              const gain = f.current_value_inr - f.invested_inr;
              const gainPct = f.invested_inr
                ? (gain / f.invested_inr) * 100
                : 0;
              const pctOfIntl =
                intlTotal > 0 ? (f.current_value_inr / intlTotal) * 100 : 0;
              const oneDay = f.one_day_change_inr;
              const oneDayPct =
                oneDay != null && f.current_value_inr - oneDay > 0
                  ? (oneDay / (f.current_value_inr - oneDay)) * 100
                  : null;
              return (
                <tr
                  key={f.fund_code}
                  className="border-b border-border last:border-0"
                >
                  <td className="px-6 py-3">
                    <div className="font-medium text-foreground">
                      {f.fund_name}
                    </div>
                    <div className="mt-0.5 font-mono text-[10px] uppercase text-muted-foreground">
                      {f.fund_code}
                    </div>
                  </td>
                  <td className="px-6 py-3 text-right font-medium text-foreground tabular-nums">
                    {fmtINR(f.current_value_inr)}
                  </td>
                  <td className="px-6 py-3 text-right text-muted-foreground tabular-nums">
                    {pctOfIntl.toFixed(2)}%
                  </td>
                  <td className="px-6 py-3 text-right text-muted-foreground tabular-nums">
                    {fmtINR(f.invested_inr)}
                  </td>
                  <td className="px-6 py-3 text-right tabular-nums">
                    {oneDay != null ? (
                      <DeltaCell inr={oneDay} pct={oneDayPct} />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-6 py-3 text-right tabular-nums">
                    <DeltaCell inr={gain} pct={gainPct} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Th({
  label,
  align,
  title,
}: {
  label: string;
  align: "left" | "right";
  title?: string;
}) {
  return (
    <th
      title={title}
      className={cn(
        "px-6 py-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground",
        align === "right" ? "text-right" : "text-left"
      )}
    >
      {label}
    </th>
  );
}

function DeltaCell({ inr, pct }: { inr: number; pct: number | null }) {
  const positive = inr >= 0;
  const color = positive
    ? "text-[hsl(var(--success))]"
    : "text-[hsl(var(--danger))]";
  return (
    <div className={cn("flex flex-col items-end", color)}>
      <span className="font-medium">
        {positive ? "+" : ""}
        {fmtINR(inr)}
      </span>
      {pct != null && (
        <span className="text-[11px]">{fmtPct(pct, { sign: true })}</span>
      )}
    </div>
  );
}
