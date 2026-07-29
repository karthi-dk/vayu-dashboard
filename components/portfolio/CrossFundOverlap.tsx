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

type MinFundsFilter = 2 | 3 | 4 | 5;

const FILTERS: { key: MinFundsFilter; label: string }[] = [
  { key: 2, label: "2+" },
  { key: 3, label: "3+" },
  { key: 4, label: "4+" },
  { key: 5, label: "5+" },
];

/**
 * Cross-fund overlap — the "am I paying multiple expense ratios for the
 * same bet?" analytical view.
 *
 * From HANDOVER §15.1: at seed time, Bharat Electronics was held via
 * 5 of 10 funds — 3 mid-cap classify it as Mid, 1 large-cap index calls
 * it Large, and 2 flexi funds hold it too. Five expense ratios for one
 * defence-sector bet. Not visible in any other view on this page.
 *
 * The filter pill (2+ / 3+ / 4+ / 5+) is client-side because the server
 * already ships the full 2+ list. Toggling filters is instant, no
 * round-trip. Default is 3+ per HANDOVER (2+ is too noisy for the
 * headline count).
 *
 * The headline stat above the table is the punch line: "X% of your
 * equity value flows through stocks held via N+ funds". A single-number
 * gut check for diversification. Recomputes with the filter.
 */
export function CrossFundOverlap({
  stocks,
  mfTotal,
}: {
  stocks: LookthroughStock[];
  mfTotal: number;
}) {
  const [minFunds, setMinFunds] = useState<MinFundsFilter>(3);
  const [sort, setSort] = useState<LookthroughSortState>({
    key: "effective_inr",
    dir: "desc",
  });

  const filtered = useMemo(
    () => stocks.filter((s) => s.n_funds >= minFunds),
    [stocks, minFunds]
  );

  const sortedFiltered = useMemo(
    () => sortLookthroughStocks(filtered, sort),
    [filtered, sort]
  );

  const overlapValue = useMemo(
    () => filtered.reduce((s, x) => s + x.effective_inr, 0),
    [filtered]
  );
  const overlapPct = mfTotal > 0 ? (overlapValue / mfTotal) * 100 : 0;

  if (!stocks.length) {
    return (
      <Card className="p-5">
        <h2 className="text-sm font-semibold text-foreground">
          Cross-fund overlap
        </h2>
        <p className="mt-2 text-xs text-muted-foreground">
          No look-through data yet. Populate{" "}
          <code className="font-mono">fund_holdings_detail</code> via the
          Sync page&apos;s Fetch fund holdings section.
        </p>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-5">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            Cross-fund overlap
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Stocks held via multiple funds — where you may be paying
            multiple expense ratios for the same bet
          </p>
        </div>

        {/* Filter pill — same segmented control pattern as the cap
            filter in HoldingsTable so users learn one interaction. */}
        <div className="flex items-center gap-2">
          <span className="kicker">Held via</span>
          <div className="flex items-center gap-0.5 rounded-md border border-border bg-muted/30 p-0.5">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setMinFunds(f.key)}
                className={cn(
                  "rounded px-2.5 py-1 text-[11px] font-medium transition-colors",
                  minFunds === f.key
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Headline stat — the punch line */}
      <div className="border-b border-border bg-muted/10 p-5">
        <div className="text-xs text-muted-foreground">
          Portfolio exposure through stocks held via {minFunds}+ funds
        </div>
        <div className="mt-1 flex items-baseline gap-2">
          <span
            className={cn(
              "text-2xl font-semibold tabular-nums",
              overlapPct >= 30
                ? "text-[hsl(var(--warning))]"
                : "text-foreground"
            )}
          >
            {overlapPct.toFixed(1)}%
          </span>
          <span className="text-sm text-muted-foreground">
            of your MF portfolio · {fmtINR(overlapValue)} · {filtered.length}{" "}
            {filtered.length === 1 ? "stock" : "stocks"}
          </span>
        </div>
      </div>

      {/* Overlap table */}
      {filtered.length === 0 ? (
        <div className="p-8 text-center">
          <div className="text-sm font-medium text-foreground">
            No stocks held via {minFunds}+ funds
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {minFunds > 2
              ? `Try a looser filter (2+ or 3+) to see overlapping positions.`
              : `Your funds don't share holdings at this threshold.`}
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="kicker px-4 py-3 text-left">Company</th>
                <th className="kicker px-4 py-3 text-left">Cap</th>
                <th className="kicker px-4 py-3 text-right">#&nbsp;Funds</th>
                <th className="kicker px-4 py-3 text-left">Held in</th>
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
              {sortedFiltered.map((stock) => (
                <OverlapRow key={stock.isin} stock={stock} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function OverlapRow({ stock }: { stock: LookthroughStock }) {
  const capVariant = capToBadgeVariant(stock.cap_type);
  const nFundsSeverity: "neutral" | "warning" | "alert" =
    stock.n_funds >= 5 ? "alert" : stock.n_funds >= 4 ? "warning" : "neutral";
  const nFundsColor =
    nFundsSeverity === "alert"
      ? "text-[hsl(var(--danger))]"
      : nFundsSeverity === "warning"
        ? "text-[hsl(var(--warning))]"
        : "text-foreground";

  // Show up to 3 fund codes inline, with "+N more" for the rest — the
  // tooltip on hover has the full list so nothing is truly hidden.
  const inlineFundCodes = stock.fund_codes.slice(0, 3);
  const remaining = stock.fund_codes.length - inlineFundCodes.length;

  return (
    <tr className="border-b border-border last:border-b-0 hover:bg-muted/20">
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
      <td className={cn("px-4 py-3 text-right font-semibold tabular-nums", nFundsColor)}>
        {stock.n_funds}
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-1">
          {inlineFundCodes.map((code) => (
            <span
              key={code}
              className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground"
            >
              {code}
            </span>
          ))}
          {remaining > 0 && (
            <Tooltip
              content={
                <div className="min-w-[160px]">
                  <div className="mb-1 opacity-70">Full list:</div>
                  <div className="space-y-0.5 font-mono text-[11px]">
                    {stock.fund_codes.map((code) => (
                      <div key={code}>{code}</div>
                    ))}
                  </div>
                </div>
              }
              side="top"
            >
              <span className="cursor-help rounded border border-dashed border-muted-foreground/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                +{remaining} more
              </span>
            </Tooltip>
          )}
        </div>
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
