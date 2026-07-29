"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LookthroughStock } from "@/lib/queries";

/**
 * Shared sort primitives for the two look-through tables on the
 * Portfolio page (TopStocksCard, CrossFundOverlap). Both render the
 * same LookthroughStock rows with the same Effective ₹ / % of MF
 * columns, so click-to-sort behaviour is defined once here rather
 * than duplicated across both tables.
 *
 * Effective ₹ and % of MF are mathematically proportional
 * (pct_of_mf = effective_inr / mfTotal × 100), so sorting by either
 * yields the same row order. The two keys are kept separate so the
 * active-column arrow lands on whichever header the user clicked.
 */
export type LookthroughSortKey = "effective_inr" | "pct_of_mf";
export type LookthroughSortState = {
  key: LookthroughSortKey;
  dir: "asc" | "desc";
};

export function sortLookthroughStocks(
  stocks: LookthroughStock[],
  sort: LookthroughSortState
): LookthroughStock[] {
  const sign = sort.dir === "desc" ? -1 : 1;
  const copy = [...stocks];
  copy.sort((a, b) => {
    const av = a[sort.key];
    const bv = b[sort.key];
    if (av === bv) return 0;
    return av > bv ? sign : -sign;
  });
  return copy;
}

/**
 * Sortable table header cell. Mirrors HoldingsTable's HeaderCell
 * visual (kicker label + chevron on active column) but is scoped to
 * the LookthroughSortKey union so both consuming tables share a
 * single, type-safe API.
 *
 * First click on an inactive column defaults to desc — matches the
 * "bigger-first" expectation for money/percentage columns.
 */
export function SortableHeaderCell({
  label,
  sortKey,
  sort,
  onSort,
  align = "right",
}: {
  label: string;
  sortKey: LookthroughSortKey;
  sort: LookthroughSortState;
  onSort: (next: LookthroughSortState) => void;
  align?: "left" | "right";
}) {
  const isActive = sort.key === sortKey;
  const dir = isActive ? sort.dir : undefined;

  return (
    <th
      className={cn(
        "kicker whitespace-nowrap px-4 py-3",
        align === "right" ? "text-right" : "text-left"
      )}
    >
      <button
        type="button"
        onClick={() => {
          if (!isActive) {
            onSort({ key: sortKey, dir: "desc" });
            return;
          }
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
