"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn, fmtINR } from "@/lib/utils";
import type { LookthroughStock } from "@/lib/queries";
import {
  SortableHeaderCell,
  type LookthroughSortState,
  sortLookthroughStocks,
} from "@/components/portfolio/lookthroughSort";

/**
 * Sector-drill modal
 * ==================
 *
 * Opens when the user clicks a sector tile in SectorExposure. Shows
 * every stock in that sector with the same columns as the Cross-fund
 * overlap table, PLUS a "% of Sector" column — the piece that only
 * makes sense inside a sector-filtered view.
 *
 * Layout mirrors FundDetailsModal (backdrop, ESC-to-close, click-
 * outside dismiss, body scroll lock) so the two modals share one
 * dismiss idiom. The stocks list is passed in fully-formed from the
 * parent so this component stays pure/presentational and avoids a
 * client-side fetch.
 *
 * "% of Sector" formula: stock.effective_inr / Σ (stock.effective_inr
 * for all stocks in this sector) × 100. Computed here (not on the
 * server) because the client already has every stock in the sector
 * — sending the sum separately would just add serialization cost.
 */
export function SectorDetailModal({
  sector,
  stocks,
  mfTotal,
  onClose,
}: {
  sector: string | null;
  stocks: LookthroughStock[];
  mfTotal: number;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // ESC to close + scroll lock, only active while modal is open.
  useEffect(() => {
    if (!sector) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [sector, onClose]);

  const [sort, setSort] = useState<LookthroughSortState>({
    key: "effective_inr",
    dir: "desc",
  });

  const sectorTotalInr = useMemo(
    () => stocks.reduce((s, x) => s + x.effective_inr, 0),
    [stocks]
  );
  const sectorPctOfMf =
    mfTotal > 0 ? (sectorTotalInr / mfTotal) * 100 : 0;

  const sortedStocks = useMemo(
    () => sortLookthroughStocks(stocks, sort),
    [stocks, sort]
  );

  // Compute the max effective_inr independently of sort so the "% of
  // Sector" bar scale stays stable when the user flips direction.
  // Previously this used stocks[0] which assumed a desc-by-value list.
  const maxEffectiveInr = useMemo(
    () => stocks.reduce((m, x) => (x.effective_inr > m ? x.effective_inr : m), 0),
    [stocks]
  );
  const maxPctOfSector =
    sectorTotalInr > 0 ? (maxEffectiveInr / sectorTotalInr) * 100 : 0;

  if (!sector) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={(e) => {
        // Only close when the click hits the backdrop, not any dialog
        // content. Prevents a drag-select ending outside from
        // accidentally dismissing the modal.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sector-modal-title"
        className="relative flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      >
        <button
          onClick={onClose}
          aria-label="Close sector details"
          className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X size={16} />
        </button>

        {/* Header */}
        <div className="border-b border-border p-5 pr-14">
          <div className="kicker mb-1">Sector drill-down</div>
          <h2
            id="sector-modal-title"
            className="text-xl font-bold tracking-tight text-foreground"
          >
            {sector}
          </h2>
          <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
            <StatChip
              kicker="% of MF"
              value={`${sectorPctOfMf.toFixed(1)}%`}
              accent={sectorPctOfMf > 25 ? "warning" : "default"}
            />
            <StatChip kicker="Effective ₹" value={fmtINR(sectorTotalInr)} />
            <StatChip
              kicker="Companies"
              value={`${stocks.length}`}
            />
          </div>
        </div>

        {/* Companies table */}
        {stocks.length === 0 ? (
          <div className="p-10 text-center">
            <div className="text-sm font-medium text-foreground">
              No look-through data for this sector yet
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              Populate <code className="font-mono">fund_holdings_detail</code>{" "}
              via the Sync page.
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b border-border">
                  {/* whitespace-nowrap on every header so "% of MF"
                      and "% of Sector" don't wrap onto two lines when
                      the column is narrow — kicker tracking makes
                      wrapping look messy. */}
                  <th className="kicker whitespace-nowrap px-4 py-3 text-left">Company</th>
                  <th className="kicker whitespace-nowrap px-4 py-3 text-left">Cap</th>
                  <th className="kicker whitespace-nowrap px-4 py-3 text-right">#&nbsp;Funds</th>
                  <th className="kicker whitespace-nowrap px-4 py-3 text-left">Held in</th>
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
                  {/* The whole reason this modal exists — % of Sector
                      is what tells you "within this bucket, which
                      names dominate?" without the mfTotal denominator
                      washing everything out. */}
                  <th className="kicker whitespace-nowrap px-4 py-3 text-right">% of Sector</th>
                </tr>
              </thead>
              <tbody>
                {sortedStocks.map((stock) => (
                  <SectorStockRow
                    key={stock.isin}
                    stock={stock}
                    sectorTotalInr={sectorTotalInr}
                    // Bars scale relative to the biggest slice in the
                    // sector so a diversified sector (12 stocks each
                    // ~8%) still reads visually. Max is computed once
                    // above from the unsorted list, so bar widths stay
                    // stable regardless of the active sort direction.
                    maxPctOfSector={maxPctOfSector}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function StatChip({
  kicker,
  value,
  accent = "default",
}: {
  kicker: string;
  value: string;
  accent?: "default" | "warning";
}) {
  return (
    <div className="flex flex-col">
      <span className="kicker">{kicker}</span>
      <span
        className={cn(
          "text-base font-semibold tabular-nums",
          accent === "warning"
            ? "text-[hsl(var(--warning))]"
            : "text-foreground"
        )}
      >
        {value}
      </span>
    </div>
  );
}

function SectorStockRow({
  stock,
  sectorTotalInr,
  maxPctOfSector,
}: {
  stock: LookthroughStock;
  sectorTotalInr: number;
  maxPctOfSector: number;
}) {
  const capVariant = capToBadgeVariant(stock.cap_type);
  const pctOfSector =
    sectorTotalInr > 0 ? (stock.effective_inr / sectorTotalInr) * 100 : 0;

  const nFundsColor =
    stock.n_funds >= 5
      ? "text-[hsl(var(--danger))]"
      : stock.n_funds >= 4
        ? "text-[hsl(var(--warning))]"
        : stock.n_funds >= 2
          ? "text-foreground"
          : "text-muted-foreground";

  // Up to 3 fund chips inline, rest hidden behind a "+N more" pill
  // with a hover tooltip carrying the full list. Same pattern as the
  // Cross-fund overlap table so users learn one interaction.
  const inline = stock.fund_codes.slice(0, 3);
  const remaining = stock.fund_codes.length - inline.length;

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
          {inline.map((code) => (
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
      {/* % of Sector — the new signal.
          Rendered with a light bar accent to reinforce that this is
          the "dominance within sector" column, not a global measure.
          Bar width is scaled by the *biggest* pct in the sector (not
          100), so a diversified sector (12 stocks each ~8%) still
          reads visually. Half-bar = half the top holding, full bar
          = the biggest name. */}
      <td className="px-4 py-3 text-right">
        <div className="flex flex-col items-end gap-1">
          <span className="font-semibold tabular-nums text-foreground">
            {pctOfSector.toFixed(1)}%
          </span>
          <div className="h-1 w-16 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-[hsl(var(--primary))]"
              style={{
                width: `${
                  maxPctOfSector > 0
                    ? Math.min(100, (pctOfSector / maxPctOfSector) * 100)
                    : 0
                }%`,
              }}
            />
          </div>
        </div>
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
