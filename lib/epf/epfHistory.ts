import {
  EPF_HISTORY,
  EPF_TOTALS,
  EPF_HISTORY_META,
} from "./epfHistory.generated";

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

export { EPF_TOTALS, EPF_HISTORY_META };
