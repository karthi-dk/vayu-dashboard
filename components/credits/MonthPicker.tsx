"use client";

import { useMemo } from "react";

/**
 * Compact "show older month" picker used by both CreditsLog and
 * MfContributionsLog. Sits inline in the section header next to any
 * other filters (e.g. the MF section's "All funds" dropdown).
 *
 * Two-tier picker:
 *   • Year rollups — "Show 2026 (47)" reveals every older month in
 *     that year in a single click. The "(47)" is the total entry count
 *     across every month the rollup will reveal — useful when the user
 *     wants a whole-year audit trail and doesn't want to pick 12
 *     months one by one. Callers that don't wire counts get the legacy
 *     "Show 2026 (4 months)" scope hint instead (see PickerOption).
 *   • Individual months — the original behaviour, kept as
 *     progressive-disclosure below each year rollup inside a native
 *     <optgroup>. Also shows "(N)" per month when counts are wired,
 *     so the user can eyeball activity before revealing anything.
 *
 * The picker is always rendered, even when there are no older
 * months to reveal — on a fresh account with only 1–3 months of
 * data it stays disabled and reads "No older months" so:
 *
 *   • the affordance is discoverable from day one — the user sees
 *     the control exists and understands what it will do later,
 *   • the header layout doesn't shift as data accumulates (avoids
 *     the "why did a new dropdown just appear?" surprise),
 *   • it advertises the 3-month default view rule to anyone
 *     inspecting the UI without reading the intro copy.
 *
 * The value stays "" on the `<select>` after each pick so the user
 * can reveal multiple older months / years in a row without
 * resetting first.
 */

// Value prefix used to distinguish year rollups from individual month
// picks inside the same <select>. We reuse ':' because YYYY-MM keys
// never contain it, keeping parsing trivial.
const YEAR_PREFIX = "__year__:";

/**
 * A single "reveal me" option in the picker. `count` is optional so the
 * picker degrades cleanly for callers that haven't wired counts yet — a
 * missing count just suppresses the "(N)" suffix rather than rendering
 * "(undefined)" or "(0)" (both misleading).
 *
 * Convention when counts ARE present:
 *   • Month option → "(N)" where N = entries in THAT month.
 *   • Year rollup  → "(N)" where N = SUM of entries across all months
 *                    revealed by that rollup. Same shape as the month
 *                    option so the eye scans consistently; the "N months"
 *                    scope hint is dropped since the individual months
 *                    are listed right below inside the same <optgroup>.
 */
type PickerOption = { key: string; label: string; count?: number };

export function MonthPicker({
  olderOptions,
  yearTotals,
  hasExtras,
  onPick,
  onReset,
}: {
  olderOptions: PickerOption[];
  /**
   * YYYY → total entries in that year across ALL months (both the
   * currently-visible ones and the ones sitting in `olderOptions`).
   * Optional so callers that don't wire counts still work — a missing
   * entry falls back to the older-only sum (which is what the picker
   * did before this prop existed).
   *
   * WHY THIS EXISTS
   * ───────────────
   * Without it, "Show 2026" summed only olderOptions, so a user with
   * 172 entries where 87 were already visible in the log saw
   * "Show 2026 (85)" — matching the delta the click would reveal but
   * not matching the "All funds (172)" filter chip. The mismatch
   * looked like a data bug. With yearTotals we render "(85 of 172)":
   * 85 = what the click will reveal, 172 = what the year actually
   * contains.
   */
  yearTotals?: Record<string, number>;
  hasExtras: boolean;
  onPick: (keys: string[]) => void;
  onReset: () => void;
}) {
  const isEmpty = olderOptions.length === 0;

  // Group the older options by their YYYY prefix. Insertion order is
  // preserved (Map guarantees this), and olderOptions already arrives
  // sorted descending by key, so years and months both land newest-first
  // without a separate sort step.
  const groupedByYear = useMemo(() => {
    const groups = new Map<string, PickerOption[]>();
    for (const opt of olderOptions) {
      const year = opt.key.slice(0, 4);
      const list = groups.get(year);
      if (list) list.push(opt);
      else groups.set(year, [opt]);
    }
    return Array.from(groups.entries()); // [year, months[]][]
  }, [olderOptions]);

  // Sum counts for a year rollup. Returns null when NO month in the
  // year carries a count (so we can fall back to the legacy "(N months)"
  // hint instead of rendering "(0)" against a year that actually has
  // data — that would look like an off-by-one bug).
  function sumYearCount(months: PickerOption[]): number | null {
    let total = 0;
    let sawCount = false;
    for (const m of months) {
      if (m.count != null) {
        total += m.count;
        sawCount = true;
      }
    }
    return sawCount ? total : null;
  }

  return (
    <div className="flex items-center gap-2">
      <select
        disabled={isEmpty}
        value=""
        onChange={(e) => {
          const v = e.target.value;
          if (!v) return;
          if (v.startsWith(YEAR_PREFIX)) {
            const year = v.slice(YEAR_PREFIX.length);
            const monthKeys = olderOptions
              .filter((o) => o.key.startsWith(`${year}-`))
              .map((o) => o.key);
            onPick(monthKeys);
          } else {
            onPick([v]);
          }
        }}
        className="rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
        title={
          isEmpty
            ? "No months older than the last 3 to show — pickers turn on once you accumulate more history."
            : undefined
        }
      >
        <option value="">
          {isEmpty ? "No older months" : "Show older month…"}
        </option>
        {groupedByYear.map(([year, months]) => {
          const olderInYear = sumYearCount(months);
          const totalInYear = yearTotals?.[year];
          // Year-rollup label priority:
          //   1. Both older-sum AND year-total known, AND they differ:
          //      "Show 2026 (85 of 172)" — 85 will be revealed, 172 is
          //      the year's true total (some months already visible in
          //      the log). This is the case that used to look like a
          //      data bug ("Show 2026 (85)" alongside "All funds (172)").
          //   2. Both known and equal (nothing already visible in that
          //      year, e.g. a fully-old year): "Show 2025 (28)" — no
          //      need to say "28 of 28".
          //   3. Only older-sum known (yearTotals not wired): "(85)".
          //   4. Neither known: fall back to legacy "N months" scope
          //      hint, or empty for a lone-month rollup.
          let yearSuffix = "";
          if (olderInYear != null && totalInYear != null) {
            yearSuffix =
              totalInYear > olderInYear
                ? ` (${olderInYear} of ${totalInYear})`
                : ` (${totalInYear})`;
          } else if (olderInYear != null) {
            yearSuffix = ` (${olderInYear})`;
          } else if (months.length > 1) {
            yearSuffix = ` (${months.length} months)`;
          }
          return (
            <optgroup key={year} label={year}>
              <option value={`${YEAR_PREFIX}${year}`}>
                Show {year}
                {yearSuffix}
              </option>
              {months.map((b) => (
                <option key={b.key} value={b.key}>
                  {b.label}
                  {b.count != null ? ` (${b.count})` : ""}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
      {hasExtras && (
        <button
          type="button"
          onClick={onReset}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Reset
        </button>
      )}
    </div>
  );
}
