import { cn, fmtINR } from "@/lib/utils";
import type { ForeignHolding } from "@/lib/queries";

/**
 * Shared ranked table for foreign holdings — used by both the cross-fund
 * ForeignLookthroughCard and the per-country drill-down modal. The only
 * thing that varies is the percentage column (of-foreign vs of-country),
 * passed in via `pctLabel` + `pctFor`.
 */
export function ForeignHoldingsTable({
  stocks,
  pctLabel,
  pctFor,
}: {
  stocks: ForeignHolding[];
  pctLabel: string;
  pctFor: (s: ForeignHolding) => number;
}) {
  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 z-10 bg-card">
        <tr className="border-b border-border">
          <Th label="Company" align="left" />
          <Th label="Effective ₹" align="right" />
          <Th label={pctLabel} align="right" />
          <Th label="Held via" align="left" />
        </tr>
      </thead>
      <tbody>
        {stocks.map((s, i) => (
          <tr key={s.name} className="border-b border-border last:border-0">
            <td className="px-5 py-2.5">
              <div className="flex items-baseline gap-2">
                <span className="w-5 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                  {i + 1}
                </span>
                <div>
                  <div className="font-medium text-foreground">{s.name}</div>
                  {s.sector && (
                    <div className="mt-0.5 text-[10px] text-muted-foreground">
                      {s.sector}
                    </div>
                  )}
                </div>
              </div>
            </td>
            <td className="px-5 py-2.5 text-right font-medium text-foreground tabular-nums">
              {fmtINR(s.effective_inr)}
            </td>
            <td className="px-5 py-2.5 text-right text-muted-foreground tabular-nums">
              {pctFor(s).toFixed(2)}%
            </td>
            <td className="px-5 py-2.5">
              <div className="flex flex-wrap gap-1">
                {s.held_via.map((v) => (
                  <span
                    key={v.fund_code}
                    title={`${v.fund_name}: ${fmtINR(v.inr)}`}
                    className="inline-flex items-center gap-1 rounded bg-muted/40 px-1.5 py-0.5 text-[10px] tabular-nums"
                  >
                    <span className="font-mono uppercase text-muted-foreground">
                      {v.fund_code}
                    </span>
                    <span className="text-foreground">{fmtINR(v.inr)}</span>
                  </span>
                ))}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Th({ label, align }: { label: string; align: "left" | "right" }) {
  return (
    <th
      className={cn(
        "px-5 py-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground",
        align === "right" ? "text-right" : "text-left"
      )}
    >
      {label}
    </th>
  );
}
