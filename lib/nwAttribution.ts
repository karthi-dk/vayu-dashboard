import type { NwRow, RetirementCredit, CreditSource, CreditType } from "./queries";

/**
 * Net-worth-level attribution — rolls up MF + NPS + EPF into a single
 * "contributions vs growth" story for the total NW.
 *
 * Extracted from lib/queries.ts (formerly server-only) into its own
 * module so the range-aware SummaryStrip inside NWTrendChart can call
 * it directly on the client and recompute per selected window. The
 * math is pure and side-effect-free, so shipping it to the browser is
 * safe and small (~1 KB gzipped).
 *
 * As of 2026-07-16 this is FULLY ledger-driven:
 *   • MF component: exact, from nw_daily.mf_invested (Groww persists
 *     mf_invested per day)
 *   • NPS/EPF components: exact, summed from retirement_credits ledger
 *     filtered by (source, credit_type, credit_date ∈ window)
 *
 * Historical caveat: rows in nw_daily older than the ledger cutover
 * (before this feature shipped) may not have matching ledger events. The
 * attribution surface degrades gracefully — contributions show 0 and the
 * residual leaks into "growth". Backfilling missing historical events
 * via /credits fully restores accuracy.
 *
 * Growth bucket combines two conceptually different sources:
 *   • Market moves on MF and NPS corpus (variable, can be negative)
 *   • EPF interest at guaranteed 8.25% (positive, credited annually)
 * UI copy labels this explicitly so users understand what's lumped.
 */
export type NwAttribution = {
  startDate: string;
  endDate: string;
  daysCovered: number;
  mfDeposits: number;
  npsDeposits: number;
  epfDeposits: number;
  totalContributions: number;
  mfMarket: number;
  npsMarket: number;
  epfInterest: number;
  totalGrowth: number;
  totalNwChange: number;
  hasMissingCreditsData: boolean;
};

/**
 * Sum ledger credits matching (source, credit_type) within [startDate,
 * endDate] inclusive. Zero when no matching rows — attribution treats
 * "no ledger event" as "no contribution" which is the correct behavior
 * for periods before the user started using /credits.
 */
function sumCreditsInWindow(
  credits: RetirementCredit[],
  source: CreditSource,
  creditType: CreditType,
  startDate: string,
  endDate: string
): number {
  return credits
    .filter(
      (c) =>
        c.source === source &&
        c.credit_type === creditType &&
        c.credit_date >= startDate &&
        c.credit_date <= endDate
    )
    .reduce((sum, c) => sum + Number(c.amount_inr), 0);
}

/**
 * Compute attribution over an arbitrary window of nw_daily history.
 * Caller controls the window by slicing `history` — the function reads
 * the first and last rows of the passed array as its endpoints. This
 * lets the same function serve both the whole-history case (pass the
 * full history) and the range-picker case (pass filterByRange output).
 *
 * Returns null on <2 rows (fresh install) or when everything is
 * essentially zero (pathological input).
 */
export function computeNwAttribution(
  history: NwRow[],
  credits: RetirementCredit[]
): NwAttribution | null {
  if (history.length < 2) return null;
  const first = history[0];
  const latest = history[history.length - 1];
  const daysCovered = Math.round(
    (new Date(latest.date).getTime() - new Date(first.date).getTime()) / 86400000
  );

  const mfDeposits = latest.mf_invested - first.mf_invested;

  const npsDeposits = sumCreditsInWindow(credits, "NPS", "payroll", first.date, latest.date);
  const epfDeposits = sumCreditsInWindow(credits, "EPF", "payroll", first.date, latest.date);
  const epfInterestLedger = sumCreditsInWindow(credits, "EPF", "interest", first.date, latest.date);

  const totalContributions = mfDeposits + npsDeposits + epfDeposits;

  const mfMarket = latest.mf_value - first.mf_value - mfDeposits;
  const npsMarket = latest.nps_value - first.nps_value - npsDeposits;

  // EPF growth for the window has two possible sources:
  //   (a) The ledger's 'interest' events sum inside this window.
  //   (b) Residual = observed EPF delta − ledger deposits − ledger
  //       interest. This catches drift from ledger-missing events
  //       (older data, manual passbook-verify jumps, etc.) so the
  //       attribution math still reconciles against total_nw.
  const epfObservedDelta = latest.epf_estimate - first.epf_estimate;
  const epfResidual = epfObservedDelta - epfDeposits - epfInterestLedger;
  const epfInterest = epfInterestLedger + epfResidual;

  const totalGrowth = mfMarket + npsMarket + epfInterest;
  const totalNwChange = latest.total_nw - first.total_nw;

  if (Math.abs(totalNwChange) < 100 && Math.abs(totalContributions) < 100) {
    return null;
  }

  // Missing-credits hint: a meaningful residual on the EPF side that
  // the ledger doesn't explain. ₹500 threshold filters out rounding
  // noise (typical monthly is ₹35K, so ₹500 = <2% drift).
  const hasMissingCreditsData = Math.abs(epfResidual) > 500;

  return {
    startDate: first.date,
    endDate: latest.date,
    daysCovered,
    mfDeposits,
    npsDeposits,
    epfDeposits,
    totalContributions,
    mfMarket,
    npsMarket,
    epfInterest,
    totalGrowth,
    totalNwChange,
    hasMissingCreditsData,
  };
}
