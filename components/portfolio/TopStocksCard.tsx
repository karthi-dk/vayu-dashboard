"use client";

import { useMemo, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Tooltip } from "@/components/ui/Tooltip";
import { fmtINR, cn } from "@/lib/utils";
import type { LookthroughStock } from "@/lib/queries";
import {
  SortableHeaderCell,
  type LookthroughSortState,
  sortLookthroughStocks,
} from "@/components/portfolio/lookthroughSort";

/**
 * Top 10 stocks portfolio-wide (aggregated look-through)
 * ======================================================
 *
 * Answers "what are my actual biggest stock bets?" — a question the
 * fund-level top-5 in the HoldingsTable can't answer because a stock
 * held via 3 funds shows up 3 times there without being aggregated.
 *
 * Example: Reliance Industries held at 5% in HDFC_FC, 6% in PPFAS_FC,
 * and 8% in UTI_N50. The per-fund top-5 shows it three times as a
 * mid-sized position. This aggregated view shows it as your single
 * largest holding at ~₹X L / Y% of MF portfolio.
 *
 * Columns:
 *   Rank · Company · Cap · Sector · Held via · Effective ₹ · % of MF
 *
 * The "Held via" column shows the count (e.g. "3 funds") with the fund
 * codes surfaced in a tooltip on hover — full list would be too wide
 * for the row on mobile. Companies in 3+ funds are visually flagged
 * (amber count badge) because that signals the same insight as the
 * cross-fund overlap card below.
 *
 * Sort: default is Effective ₹ desc (matches the "top-10 by size"
 * intent). Effective ₹ and % of MF headers are click-to-sort — same
 * interaction pattern as HoldingsTable. Rank column re-numbers
 * against the sorted order so "#1" always reflects the current sort.
 */
export function TopStocksCard({ stocks }: { stocks: LookthroughStock[] }) {
  const [sort, setSort] = useState<LookthroughSortState>({
    key: "effective_inr",
    dir: "desc",
  });

  const sorted = useMemo(
    () => sortLookthroughStocks(stocks, sort),
    [stocks, sort]
  );

  if (!stocks.length) {
    return (
      <Card className="p-5">
        <h2 className="text-sm font-semibold text-foreground">
          Top 10 stocks (look-through)
        </h2>
        <p className="mt-2 text-xs text-muted-foreground">
          No look-through data yet. Populate{" "}
          <code className="font-mono">fund_holdings_detail</code> via the
          Sync page's Fetch fund holdings section.
        </p>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-border p-5">
        <h2 className="text-sm font-semibold text-foreground">
          Top 10 stocks (look-through)
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Your actual biggest positions after seeing through every fund ·
          effective ₹ = Σ (fund value × weighting)
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="kicker w-10 px-4 py-3 text-right">#</th>
              <th className="kicker px-4 py-3 text-left">Company</th>
              <th className="kicker px-4 py-3 text-left">Cap</th>
              <th className="kicker px-4 py-3 text-left">Sector</th>
              <th className="kicker px-4 py-3 text-right">Held via</th>
              <SortableHeaderCell
                label="Effective ₹"
                sortKey="effective_inr"
                sort={sort}
                onSort={setSort}
                align="right"
              />
              <SortableHeaderCell
                label="% of MF"
                sortKey="pct_of_mf"
                sort={sort}
                onSort={setSort}
                align="right"
              />
            </tr>
          </thead>
          <tbody>
            {sorted.map((stock, idx) => (
              <TopStockRow key={stock.isin} stock={stock} rank={idx + 1} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function TopStockRow({
  stock,
  rank,
}: {
  stock: LookthroughStock;
  rank: number;
}) {
  const capVariant = capToBadgeVariant(stock.cap_type);
  const heldViaAmber = stock.n_funds >= 3;

  return (
    <tr className="border-b border-border last:border-b-0 hover:bg-muted/20">
      <td className="px-4 py-3 text-right font-mono text-xs text-muted-foreground">
        {rank}
      </td>
      <td className="px-4 py-3">
        <div className="font-medium text-foreground">{stock.company_name}</div>
        <div className="mt-0.5 font-mono text-[10px] uppercase text-muted-foreground">
          {stock.isin}
        </div>
      </td>
      <td className="px-4 py-3">
        {stock.cap_type ? (
          <Badge variant={capVariant}>{stock.cap_type}</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-xs text-muted-foreground">
        {stock.sector ?? "—"}
      </td>
      <td className="px-4 py-3 text-right">
        <Tooltip
          content={
            <div className="min-w-[180px]">
              <div className="mb-1 opacity-70">Present in:</div>
              <div className="space-y-0.5 font-mono text-[11px]">
                {stock.fund_codes.map((code) => (
                  <div key={code}>{code}</div>
                ))}
              </div>
            </div>
          }
          side="top"
        >
          <span
            className={cn(
              "cursor-help border-b border-dotted text-xs font-medium",
              heldViaAmber
                ? "border-[hsl(var(--warning))] text-[hsl(var(--warning))]"
                : "border-muted-foreground/30 text-muted-foreground"
            )}
          >
            {stock.n_funds} {stock.n_funds === 1 ? "fund" : "funds"}
          </span>
        </Tooltip>
      </td>
      <td className="px-4 py-3 text-right font-medium tabular-nums text-foreground">
        {fmtINR(stock.effective_inr)}
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
        {stock.pct_of_mf.toFixed(2)}%
      </td>
    </tr>
  );
}

/**
 * Map an mcap_classification string to a Badge variant. Uses the same
 * variants as the HoldingsTable's cap badges for visual consistency.
 * Unknown or new values fall back to `muted` so we never crash on a
 * fresh classification code.
 */
function capToBadgeVariant(
  cap: string | null
):
  | "large"
  | "mid"
  | "small"
  | "intl"
  | "debt"
  | "muted" {
  if (!cap) return "muted";
  const lc = cap.toLowerCase();
  if (lc.includes("large")) return "large";
  if (lc.includes("mid")) return "mid";
  if (lc.includes("small") || lc.includes("micro")) return "small";
  if (lc.includes("intl") || lc.includes("international") || lc.includes("us"))
    return "intl";
  if (lc.includes("debt") || lc.includes("bond")) return "debt";
  return "muted";
}
