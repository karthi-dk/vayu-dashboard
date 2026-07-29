"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronUp, ChevronDown } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { cn, fmtDateShort, fmtINR, fmtPct } from "@/lib/utils";
import type { CapType, Fund, FundHoldingDetail } from "@/lib/queries";
import { FundDetailsModal } from "@/components/sync/FundDetailsModal";

type FilterKey = "all" | CapType;

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "large", label: "Large" },
  { key: "mid", label: "Mid" },
  { key: "small", label: "Small" },
  { key: "intl", label: "Intl" },
  { key: "debt", label: "Debt" },
];

/**
 * Sort keys for the fund table. Kept as a discriminated union rather
 * than a free-string so any typo in column headers gets caught at
 * type-check time. `null` on any column = user hasn't clicked anything
 * yet, so we fall through to the default sort (current desc).
 */
type SortKey =
  | "current"
  | "invested"
  | "one_day"
  | "gain_inr"
  | "gain_pct"
  | "pct_of_nw"
  | "nav_date";

type SortState = { key: SortKey; dir: "asc" | "desc" } | null;

const DEFAULT_SORT: SortState = { key: "current", dir: "desc" };

/**
 * Fund holdings table
 * ===================
 *
 * 2026-07-17 additions on top of the original layout:
 *
 *   1. Sortable columns (D) — click any header to sort by that column.
 *      Header text becomes a button, chevron indicator on the active
 *      column. Sorting is client-side because the dataset is small
 *      (~10 funds) and it keeps the URL clean.
 *
 *   2. "% of NW" column (C) — quick "how big is this fund vs. my entire
 *      net worth?" scan. Positioned after Current so the two values
 *      read together: "₹6.4 L (10.2% of NW)".
 *
 *   3. 2026-07-18: Row click now opens FundDetailsModal (the same
 *      modal used by Fetch fund holdings on the Sync page) instead of
 *      inline-expanding a top-holdings preview. The modal exposes
 *      substantially more info (114 holdings, sectors, cap breakdown,
 *      sync diagnostics) than the old top-5 preview and matches how
 *      the user already inspects funds elsewhere. The Cap breakdown
 *      section inside the modal shows the same L:M:S:Debt:REIT split
 *      the user asked to see per-fund.
 *
 * Sort respects the active filter — the "N funds" subtitle updates.
 * `topHoldingsByFund` is still accepted (unused) so the existing page
 * call-site keeps type-checking; can be dropped in a follow-up cleanup.
 */
export function HoldingsTable({
  funds,
  totalNw,
}: {
  funds: Fund[];
  totalNw: number;
  /** Deprecated: modal now fetches its own holdings. Prop kept for
   *  backward-compat with the current page.tsx call site; can be
   *  removed once the page is updated. */
  topHoldingsByFund?: Record<string, FundHoldingDetail[]>;
}) {
  const [filter, setFilter] = useState<FilterKey>("all");
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  // Modal state: null = closed, otherwise the fund_code of the
  // currently-open modal. Deep-linking via `#fund-<code>` opens the
  // modal (was: expanded inline row) via the hashchange effect below.
  const [selectedFund, setSelectedFund] = useState<string | null>(null);

  useEffect(() => {
    function handleHash() {
      const hash = window.location.hash;
      if (!hash.startsWith("#fund-")) return;
      const fundCode = decodeURIComponent(hash.slice(6));
      const fund = funds.find((f) => f.fund_code === fundCode);
      if (!fund) return;
      setFilter("all");
      setSelectedFund(fundCode);
      setTimeout(() => {
        document
          .getElementById(`fund-${fundCode}`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 100);
    }
    handleHash();
    window.addEventListener("hashchange", handleHash);
    return () => window.removeEventListener("hashchange", handleHash);
  }, [funds]);

  // Filter first, then sort. Order matters: sorting a filtered subset
  // is fast enough that reversing (sort then filter) offers no gain.
  const filtered = useMemo(
    () =>
      filter === "all"
        ? funds
        : funds.filter((f) => f.cap_type === filter),
    [funds, filter]
  );

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    // Copy so we don't mutate the memoized filtered slice.
    const copy = [...filtered];
    copy.sort((a, b) => cmp(a, b, sort.key, sort.dir));
    return copy;
  }, [filtered, sort]);

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-5">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            Fund holdings
          </h2>
          <p className="mt-0.5 kicker">
            {sort
              ? `Sorted by ${labelFor(sort.key)} ${sort.dir === "desc" ? "↓" : "↑"}`
              : `Sorted by current value`}{" "}
            · {filtered.length}{" "}
            {filter === "all"
              ? `of ${funds.length} funds`
              : `${filter} funds`}
          </p>
        </div>
        <div className="flex items-center gap-0.5 rounded-md border border-border bg-muted/30 p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                "rounded px-2.5 py-1 text-[11px] font-medium transition-colors",
                filter === f.key
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <HeaderCell label="Fund" align="left" />
              <HeaderCell label="Bucket" align="left" />
              <HeaderCell
                label="Current"
                align="right"
                sortKey="current"
                sort={sort}
                onSort={setSort}
              />
              <HeaderCell
                label="% of NW"
                align="right"
                sortKey="pct_of_nw"
                sort={sort}
                onSort={setSort}
              />
              <HeaderCell
                label="Invested"
                align="right"
                sortKey="invested"
                sort={sort}
                onSort={setSort}
              />
              <HeaderCell
                label="1D change"
                align="right"
                sortKey="one_day"
                sort={sort}
                onSort={setSort}
              />
              <HeaderCell
                label="Gain ₹"
                align="right"
                sortKey="gain_inr"
                sort={sort}
                onSort={setSort}
              />
              <HeaderCell
                label="Gain %"
                align="right"
                sortKey="gain_pct"
                sort={sort}
                onSort={setSort}
              />
              <HeaderCell
                label="NAV date"
                align="right"
                sortKey="nav_date"
                sort={sort}
                onSort={setSort}
              />
            </tr>
          </thead>
          <tbody>
            {sorted.map((f) => {
              const gain = f.current_value_inr - f.invested_inr;
              const gainPct = f.invested_inr
                ? (gain / f.invested_inr) * 100
                : 0;
              const pctOfNw =
                totalNw > 0 ? (f.current_value_inr / totalNw) * 100 : 0;
              return (
                <tr
                  key={f.fund_code}
                  id={`fund-${f.fund_code}`}
                  className="scroll-mt-24 cursor-pointer border-b border-border transition-colors hover:bg-muted/30"
                  onClick={() => setSelectedFund(f.fund_code)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedFund(f.fund_code);
                    }
                  }}
                >
                    <td className="px-6 py-3">
                      <div>
                        <div className="font-medium text-foreground">
                          {f.fund_name}
                        </div>
                        <div className="mt-0.5 font-mono text-[10px] uppercase text-muted-foreground">
                          {f.fund_code}
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-3">
                      <Badge variant={f.cap_type}>{f.cap_type}</Badge>
                    </td>
                    <td className="px-6 py-3 text-right font-medium text-foreground tabular-nums">
                      {fmtINR(f.current_value_inr)}
                    </td>
                    <td className="px-6 py-3 text-right text-muted-foreground tabular-nums">
                      {pctOfNw.toFixed(2)}%
                    </td>
                    <td className="px-6 py-3 text-right text-muted-foreground tabular-nums">
                      {fmtINR(f.invested_inr)}
                    </td>
                    <td className="px-6 py-3 text-right">
                      {f.one_day_change_inr != null ? (
                        <div
                          className={cn(
                            "font-medium tabular-nums",
                            f.one_day_change_inr >= 0
                              ? "text-[hsl(var(--success))]"
                              : "text-[hsl(var(--danger))]"
                          )}
                        >
                          {/* whitespace-nowrap: the ₹ glyph (U+20B9) has
                              Unicode line-break class PR, so browsers
                              can wrap between the "+" sign and "₹" when
                              the column narrows. Force the sign + value
                              to stay glued. */}
                          <div className="whitespace-nowrap">
                            {f.one_day_change_inr >= 0 ? "+" : ""}
                            {fmtINR(f.one_day_change_inr)}
                          </div>
                          {f.one_day_change_pct != null && (
                            <div className="mt-0.5 whitespace-nowrap text-[10px] opacity-80">
                              {f.one_day_change_pct >= 0 ? "+" : ""}
                              {f.one_day_change_pct.toFixed(2)}%
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td
                      className={cn(
                        "whitespace-nowrap px-6 py-3 text-right font-medium tabular-nums",
                        gain >= 0
                          ? "text-[hsl(var(--success))]"
                          : "text-[hsl(var(--danger))]"
                      )}
                    >
                      {gain >= 0 ? "+" : ""}
                      {fmtINR(gain)}
                    </td>
                    <td
                      className={cn(
                        "whitespace-nowrap px-6 py-3 text-right font-medium tabular-nums",
                        gainPct >= 0
                          ? "text-[hsl(var(--success))]"
                          : "text-[hsl(var(--danger))]"
                      )}
                    >
                      {fmtPct(gainPct, { sign: true })}
                    </td>
                    <td className="px-6 py-3 text-right text-muted-foreground tabular-nums">
                      {fmtDateShort(f.nav_date)}
                    </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Fund detail modal — same component used by Fetch fund holdings
          on the Sync page. Renders nothing when selectedFund is null. */}
      <FundDetailsModal
        fundCode={selectedFund}
        onClose={() => setSelectedFund(null)}
      />
    </Card>
  );
}

/**
 * Sortable header cell. `sortKey` is optional — omit it for columns
 * that don't make sense to sort (Fund name, Bucket badge). When
 * present, clicking cycles through: initial-desc → asc → desc → asc.
 * We don't offer an "unsorted" state because the default fallback is
 * `current desc` anyway; toggling back to unsorted would just repeat
 * that visually.
 */
function HeaderCell({
  label,
  align,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  align: "left" | "right";
  sortKey?: SortKey;
  sort?: SortState;
  onSort?: (next: SortState) => void;
}) {
  const isActive = sort?.key === sortKey && sortKey != null;
  const dir = isActive ? sort?.dir : undefined;

  if (!sortKey) {
    return (
      <th
        className={cn(
          "kicker px-6 py-3",
          align === "right" ? "text-right" : "text-left"
        )}
      >
        {label}
      </th>
    );
  }

  return (
    <th
      className={cn(
        "kicker px-6 py-3",
        align === "right" ? "text-right" : "text-left"
      )}
    >
      <button
        type="button"
        onClick={() => {
          if (!onSort) return;
          // First click on an inactive column: default to desc for
          // numeric columns (bigger-first), asc for date (older/newer
          // symmetric — pick desc so latest NAV date is on top).
          if (!isActive) {
            onSort({ key: sortKey, dir: "desc" });
            return;
          }
          // Toggle direction on subsequent clicks.
          onSort({ key: sortKey, dir: dir === "desc" ? "asc" : "desc" });
        }}
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground",
          align === "right" && "flex-row-reverse",
          isActive && "text-foreground"
        )}
      >
        <span>{label}</span>
        {isActive &&
          (dir === "desc" ? (
            <ChevronDown size={10} aria-hidden />
          ) : (
            <ChevronUp size={10} aria-hidden />
          ))}
      </button>
    </th>
  );
}

/**
 * Comparator for two funds. Null-safe: null/undefined values sort to
 * the bottom regardless of direction so an unpopulated 1D change
 * doesn't push the row to the wrong end of the list. Dates compare
 * lexically because they're already ISO strings.
 */
function cmp(
  a: Fund,
  b: Fund,
  key: SortKey,
  dir: "asc" | "desc"
): number {
  const sign = dir === "desc" ? -1 : 1;
  switch (key) {
    case "current":
      return sign * (a.current_value_inr - b.current_value_inr);
    case "invested":
      return sign * (a.invested_inr - b.invested_inr);
    case "one_day": {
      const av = a.one_day_change_inr;
      const bv = b.one_day_change_inr;
      // Null-sink: nulls always end up at the bottom
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return sign * (av - bv);
    }
    case "gain_inr": {
      const ag = a.current_value_inr - a.invested_inr;
      const bg = b.current_value_inr - b.invested_inr;
      return sign * (ag - bg);
    }
    case "gain_pct": {
      const ap = a.invested_inr
        ? (a.current_value_inr - a.invested_inr) / a.invested_inr
        : 0;
      const bp = b.invested_inr
        ? (b.current_value_inr - b.invested_inr) / b.invested_inr
        : 0;
      return sign * (ap - bp);
    }
    case "pct_of_nw":
      // pct_of_nw is monotonic with current_value_inr since the
      // denominator (totalNw) is the same for every row. Sort by
      // current_value_inr — same order, saves the division.
      return sign * (a.current_value_inr - b.current_value_inr);
    case "nav_date": {
      const ad = a.nav_date;
      const bd = b.nav_date;
      if (ad == null && bd == null) return 0;
      if (ad == null) return 1;
      if (bd == null) return -1;
      return sign * ad.localeCompare(bd);
    }
    default:
      return 0;
  }
}

function labelFor(key: SortKey): string {
  switch (key) {
    case "current":
      return "current value";
    case "invested":
      return "invested amount";
    case "one_day":
      return "1D change";
    case "gain_inr":
      return "gain ₹";
    case "gain_pct":
      return "gain %";
    case "pct_of_nw":
      return "% of NW";
    case "nav_date":
      return "NAV date";
  }
}
