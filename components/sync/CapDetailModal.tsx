"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { X, ExternalLink, Search } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Tooltip } from "@/components/ui/Tooltip";
import type { CapStock } from "@/lib/queries";

/**
 * Cap-detail drill-down modal
 * ============================
 *
 * Opens when a tile on the Cap Classifications card is clicked. Shows
 * every stock in that bucket from `master_security_classification`.
 * Mirrors SectorDetailModal's shell (backdrop, ESC-to-close, click-
 * outside dismiss, body scroll lock) so both modals feel like the
 * same interaction.
 *
 * Columns per row:
 *   Symbol (external link) · Company · Sector · Source badge
 *
 * The "Source" column is contextual:
 *   India buckets → shows the NSE list the stock was drawn from
 *                   (`nse-nifty100`, `nse-midcap150`, `nse-equity-l`…).
 *   US bucket    → shows `SP500`, `NASDAQ100`, `SP500+NASDAQ100`, or
 *                   `—` for the 2 not-indexed rows (INSM, ZS).
 * That's the piece the modal exists to show — the tile itself only
 * gives you the count.
 *
 * A search box on top lets the user filter by symbol / company /
 * sector — Nano has 1600 rows which is unusable without one.
 */
export function CapDetailModal({
  bucket,
  stocks,
  onClose,
}: {
  bucket: CapBucketDescriptor | null;
  stocks: CapStock[];
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");

  // ESC to close + scroll lock — only active while modal is open.
  useEffect(() => {
    if (!bucket) return;
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
  }, [bucket, onClose]);

  // Reset the search box every time a different bucket opens, so a
  // stale "AAPL" query from the US modal doesn't zero out the Large
  // list on next click.
  useEffect(() => {
    setQuery("");
  }, [bucket?.key]);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return stocks;
    return stocks.filter(
      (s) =>
        (s.symbol ?? "").toUpperCase().includes(q) ||
        s.company_name.toUpperCase().includes(q) ||
        (s.raw_sector ?? "").toUpperCase().includes(q) ||
        (s.index_membership ?? "").toUpperCase().includes(q)
    );
  }, [stocks, query]);

  if (!bucket) return null;

  return (
    // items-start (not items-center) + pt-[5vh] anchors the modal to a
    // fixed top offset. Without this the whole modal vertically re-
    // centers as rows fade in/out during search — so typing "re" (16
    // rows) shows a tall modal near the top, then typing "rel" (1 row)
    // shrinks the modal AND slides it down to the viewport center,
    // yanking the search input under the cursor. Anchoring to top-5vh
    // keeps the header/search box in a stable position regardless of
    // filter state.
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 pt-[5vh] backdrop-blur-sm"
      onClick={(e) => {
        // Only close when the click hits the backdrop — same guard as
        // SectorDetailModal so a drag-select ending outside doesn't
        // accidentally dismiss the modal.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cap-modal-title"
        // min-h prevents the box from collapsing to header-only when a
        // search zero-matches, keeping the empty-state message in a
        // predictable spot; max-h caps growth on tall buckets so the
        // body scrolls internally rather than pushing the whole modal
        // past the viewport. min-h < max-h — the box grows within
        // that band based on content.
        className="relative flex max-h-[85vh] min-h-[50vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      >
        <button
          onClick={onClose}
          aria-label="Close cap details"
          className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X size={16} />
        </button>

        {/* Header */}
        <div className="border-b border-border p-5 pr-14">
          <div className="kicker mb-1">{bucket.kicker}</div>
          <div className="flex items-baseline gap-3">
            <h2
              id="cap-modal-title"
              className="text-xl font-bold tracking-tight text-foreground"
            >
              {bucket.title}
            </h2>
            <span className="text-sm text-muted-foreground">
              {stocks.length}{" "}
              {stocks.length === 1 ? "stock" : "stocks"}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {bucket.description}
          </p>

          {/* Search — critical for Nano (1600 rows). Kept inside the
             header block so it stays visible above the scrolled table. */}
          <div className="relative mt-4">
            <Search
              size={12}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${stocks.length} ${bucket.title.toLowerCase()} stocks…`}
              className="w-full rounded-md border border-border bg-muted/20 py-1.5 pl-7 pr-8 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
              autoFocus
            />
            {query && (
              <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
                {filtered.length} match{filtered.length === 1 ? "" : "es"}
              </span>
            )}
          </div>
        </div>

        {/* Table */}
        {stocks.length === 0 ? (
          <div className="p-10 text-center">
            <div className="text-sm font-medium text-foreground">
              No stocks in this bucket
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              Run the Refresh button to populate from NSE.
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            {/* table-fixed + explicit <colgroup> widths keep the layout
               stable while the user types in the search box. Without
               this, `table-layout: auto` recomputes column widths
               against the *visible* rows only — so typing "Rel" and
               dropping to 1 row causes the SYMBOL / COMPANY / SECTOR
               columns to widen dramatically. Percentages sum to
               100% and were tuned to fit the longest realistic
               values in each column (COMPANY carries the widest
               content — "Motilal Oswal Nasdaq 100 FoF" etc.). */}
            <table className="w-full table-fixed text-sm">
              <colgroup>
                <col className="w-[16%]" />
                <col className="w-[42%]" />
                <col className="w-[24%]" />
                <col className="w-[18%]" />
              </colgroup>
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b border-border">
                  <th className="kicker whitespace-nowrap px-4 py-3 text-left">Symbol</th>
                  <th className="kicker whitespace-nowrap px-4 py-3 text-left">Company</th>
                  <th className="kicker whitespace-nowrap px-4 py-3 text-left">Sector</th>
                  <th className="kicker whitespace-nowrap px-4 py-3 text-left">
                    {bucket.region === "US" ? "Index" : "Source"}
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((stock) => (
                  <CapStockRow
                    key={stock.isin}
                    stock={stock}
                    region={bucket.region}
                  />
                ))}
                {filtered.length === 0 && query && (
                  <tr>
                    <td
                      colSpan={4}
                      className="px-4 py-8 text-center text-xs text-muted-foreground"
                    >
                      No stocks match &quot;{query}&quot;
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Descriptor passed by the card to identify which tile was clicked.
 * `region` drives per-region formatting (source label, external link
 * target) without the modal needing to know about India-vs-US.
 */
export type CapBucketDescriptor = {
  key:
    | "LargeN50"
    | "LargeNN50"
    | "LargeOverride"
    | "Mid"
    | "Small"
    | "Micro"
    | "Nano"
    | "US";
  title: string;
  kicker: string;
  description: string;
  region: "India" | "US";
};

function CapStockRow({
  stock,
  region,
}: {
  stock: CapStock;
  region: "India" | "US";
}) {
  const symbol = stock.symbol ?? "—";
  // NSE for India, Yahoo Finance for US (works across NYSE/Nasdaq/etc.).
  // Yahoo lets you paste any ticker and it resolves the primary listing,
  // whereas Google Finance forces you to include the exchange suffix.
  const externalUrl = stock.symbol
    ? region === "US"
      ? `https://finance.yahoo.com/quote/${encodeURIComponent(stock.symbol)}`
      : `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(stock.symbol)}`
    : null;

  return (
    <tr className="border-b border-border last:border-b-0 hover:bg-muted/20">
      <td className="px-4 py-3">
        {externalUrl ? (
          <a
            href={externalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="group inline-flex items-center gap-1 font-mono text-xs font-medium text-foreground hover:underline"
          >
            {symbol}
            <ExternalLink
              size={10}
              className="text-muted-foreground/40 transition-colors group-hover:text-muted-foreground"
            />
          </a>
        ) : (
          <span className="font-mono text-xs text-muted-foreground">
            {symbol}
          </span>
        )}
      </td>
      <td className="px-4 py-3">
        <div className="font-medium text-foreground">{stock.company_name}</div>
        <div className="mt-0.5 font-mono text-[10px] uppercase text-muted-foreground">
          {stock.isin}
        </div>
      </td>
      <td className="px-4 py-3">
        {stock.raw_sector ? (
          <span className="text-xs text-muted-foreground">
            {stock.raw_sector}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground/50">—</span>
        )}
      </td>
      <td className="px-4 py-3">
        <SourceCell stock={stock} region={region} />
      </td>
    </tr>
  );
}

/**
 * Source column renders:
 *   • US w/ index      → coloured index_membership badge (green/blue/purple)
 *   • US w/o index     → muted "—" (INSM, ZS)
 *   • India NSE-sourced → muted badge with the short list name
 *                         ("nifty100", "midcap150" …) parsed off the
 *                         `source` string.
 *   • India non-sourced → nothing (rows never touched by the classifier;
 *                          usually pre-migration ETFs / bonds).
 */
function SourceCell({
  stock,
  region,
}: {
  stock: CapStock;
  region: "India" | "US";
}) {
  if (region === "US") {
    const idx = stock.index_membership ?? "";
    if (!idx) {
      return (
        <Tooltip
          content="Not in S&P 500 or Nasdaq 100 — held via broader international fund."
          side="top"
        >
          <span className="cursor-help text-xs text-muted-foreground/50">
            —
          </span>
        </Tooltip>
      );
    }
    return (
      <Badge variant={indexToBadgeVariant(idx)}>
        {indexToLabel(idx)}
      </Badge>
    );
  }

  // India — parse the short tag off `source`. Format is "nse-<tag>"
  // per bucketToSourceTag() in the refresh route.
  const src = stock.source ?? "";
  if (!src) {
    return <span className="text-xs text-muted-foreground/50">—</span>;
  }
  const tag = src.startsWith("nse-") ? src.slice(4) : src;
  return (
    <span className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
      {tag}
    </span>
  );
}

function indexToLabel(idx: string): string {
  if (idx === "SP500") return "S&P 500";
  if (idx === "NASDAQ100") return "Nasdaq 100";
  if (idx === "SP500+NASDAQ100") return "S&P 500 · Nasdaq 100";
  return idx;
}

// SP500 → green, Nasdaq 100 → primary, both → purple. Keeps the two
// primary indices visually distinct at a glance without needing to
// read the label.
function indexToBadgeVariant(
  idx: string
): "success" | "primary" | "intl" | "muted" {
  if (idx === "SP500") return "success";
  if (idx === "NASDAQ100") return "primary";
  if (idx === "SP500+NASDAQ100") return "intl";
  return "muted";
}
