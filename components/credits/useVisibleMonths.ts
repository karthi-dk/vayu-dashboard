import { useMemo, useState } from "react";

/**
 * Shared "rolling N months + picker for older" behaviour used by both
 * CreditsLog (retirement corpus) and MfContributionsLog (Groww orders).
 *
 * Design intent:
 *   • The default view is always the N most recent buckets (typically
 *     3) so page load stays fast and scanable even with years of
 *     history in the underlying tables.
 *   • Older months don't disappear — they live in `olderOptions`,
 *     ready to be surfaced one at a time via a `<select>` picker.
 *   • Adding a month is additive (`addMonth`). Removing individual
 *     months isn't offered because a full `reset()` is a friendlier
 *     out for "I got what I needed, hide the noise" without asking
 *     the user to remember which extras they added.
 *
 * The input `buckets` MUST be pre-sorted descending by month key —
 * this hook trusts the caller for that ordering because the buckets
 * are already computed and sorted once for other purposes (headers,
 * totals). Re-sorting here would just duplicate that work.
 */
export function useVisibleMonths<T extends { key: string }>(
  buckets: T[],
  defaultVisibleCount = 3
): {
  visible: T[];
  olderOptions: T[];
  extraKeys: Set<string>;
  addMonths: (keys: string[]) => void;
  reset: () => void;
} {
  const [extraKeys, setExtraKeys] = useState<Set<string>>(new Set());

  // The top-N buckets are "default visible" — always shown even if
  // the user hasn't picked anything.
  const defaultKeys = useMemo(
    () => new Set(buckets.slice(0, defaultVisibleCount).map((b) => b.key)),
    [buckets, defaultVisibleCount]
  );

  // Combined visible set = default union user-picked. Filtering
  // through the original array preserves descending order without a
  // separate sort.
  const visible = useMemo(
    () =>
      buckets.filter((b) => defaultKeys.has(b.key) || extraKeys.has(b.key)),
    [buckets, defaultKeys, extraKeys]
  );

  // Picker options = every bucket NOT currently visible. When the
  // user picks one it moves from this list into `visible` on the
  // next render (React state update triggers re-derivation).
  const olderOptions = useMemo(
    () =>
      buckets.filter(
        (b) => !defaultKeys.has(b.key) && !extraKeys.has(b.key)
      ),
    [buckets, defaultKeys, extraKeys]
  );

  // Bulk add — a "Show 2026" year rollup in the picker reveals every
  // older month in that year at once. Doing this as a single state
  // update (vs. calling addMonth in a loop) means React re-renders
  // once with all newly-revealed months instead of once per month,
  // which matters when a full year (12 months) opens simultaneously.
  function addMonths(keys: string[]) {
    if (keys.length === 0) return;
    setExtraKeys((prev) => {
      const next = new Set(prev);
      for (const k of keys) next.add(k);
      return next;
    });
  }

  function reset() {
    setExtraKeys(new Set());
  }

  return { visible, olderOptions, extraKeys, addMonths, reset };
}

/**
 * Client-side "current calendar month" key in the same YYYY-MM format
 * that our bucket helpers use. Uses the browser's local calendar so
 * an IST user sees "2026-07" while it's July in India, regardless of
 * where the server runs. Kept as a plain util (not a hook) so it's
 * cheap to call from both log components' initial state.
 */
export function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}
