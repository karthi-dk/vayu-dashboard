import {
  EPF_HISTORY,
  EPF_TOTALS,
  EPF_HISTORY_META,
} from "./epfHistory.generated";
import { computeXirr, type CashFlow } from "@/lib/xirr";

/**
 * EPF-only slice of the retirement timeline, analogous to `MfDailyRow` /
 * `NpsDailyRow`. Reconstructed from the EPFO passbook PDFs (see
 * scripts/gen-epf-history.py), Pension (EPS) excluded.
 *
 * EPF has no NAV — value is a running balance: cumulative
 * `epf_contribution` (employee + employer) plus cumulative
 * `epf_interest` (credited annually at each FY-end, 31 Mar). Both are
 * monotonically non-decreasing, so the curve never dips (there are no
 * cash withdrawals — inter-account transfers keep money inside EPF).
 */
export type EpfDailyRow = {
  date: string;
  /** Total EPF value = epf_contribution + epf_interest. */
  epf_value: number;
  /** Cumulative contributions (employee + employer) as of this date. */
  epf_contribution: number;
  /** Cumulative interest (employee + employer) as of this date. */
  epf_interest: number;
};

/**
 * Build the EPF daily series from the generated passbook history. Kept
 * as a seam (rather than importing the raw array everywhere) so a
 * future "seed + live retirement_credits after the passbook cutoff"
 * merge lands in one place.
 */
export function buildEpfHistory(): EpfDailyRow[] {
  return EPF_HISTORY.map((p) => ({
    date: p.date,
    epf_value: p.value,
    epf_contribution: p.cumContribution,
    epf_interest: p.cumInterest,
  }));
}

// Suppress XIRR until the history spans at least a year — annualizing a
// sub-year window wildly exaggerates the rate.
const EPF_XIRR_MIN_DAYS = 365;

/**
 * Lifetime EPF XIRR (annualized, money-weighted) from the passbook
 * contributions plus the current balance: each monthly contribution is
 * an outflow on its credit date; the latest balance is the terminal
 * inflow. Returns null when there's < 1 year of history.
 *
 * CAVEAT: EPF posts interest once a year (FY-end, 31 Mar), so a mid-year
 * figure understates the declared rate (recent contributions haven't
 * earned their interest yet) and steps up each 31 Mar — expected.
 */
export function computeEpfXirr(): number | null {
  const pts = EPF_HISTORY;
  if (pts.length < 2) return null;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const spanDays =
    (new Date(last.date).getTime() - new Date(first.date).getTime()) /
    86_400_000;
  if (spanDays < EPF_XIRR_MIN_DAYS) return null;

  const flows: CashFlow[] = [];
  let prevContribution = 0;
  for (const p of pts) {
    const delta = p.cumContribution - prevContribution;
    if (delta > 0) flows.push({ date: p.date, amount: -delta }); // money in
    prevContribution = p.cumContribution;
  }
  flows.push({ date: last.date, amount: last.value }); // balance today
  return computeXirr(flows);
}

/** Lifetime EPF XIRR as a percent (e.g. 7.02), or null if < 1 year. */
export const EPF_XIRR_PCT: number | null = (() => {
  const r = computeEpfXirr();
  return r == null ? null : r * 100;
})();

export { EPF_TOTALS, EPF_HISTORY_META };
