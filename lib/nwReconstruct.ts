import type { MfDailyRow, NpsDailyRow, IntlDailyRow } from "./queries";
import type { EpfDailyRow } from "./epf/epfHistory";

/**
 * Unified multi-year net-worth timeline, reconstructed by summing the
 * three per-asset histories (MF + NPS + EPF) at every date they cover —
 * reaching back to day 1 (the first contribution to any asset), long
 * before nw_daily tracking started.
 *
 * Each asset carries both its VALUE and its cumulative CONTRIBUTIONS as
 * of the date, so attribution (contributions vs growth) is exact for any
 * window — `growth = Δvalue − Δcontributions`, per asset — with no
 * ledger lookup and no residual. By construction:
 *   totalContributions + totalGrowth === Δtotal_nw.
 *
 * The right edge equals today's nw_daily total (MF/NPS histories carry
 * the observed rows; EPF's last passbook value is the current balance),
 * so the trend chart's endpoint matches the headline NW card exactly.
 */
export type NwPoint = {
  date: string;
  mf_value: number;
  nps_value: number;
  epf_value: number;
  intl_value: number;
  total_nw: number;
  /** Cumulative MF net deposits (ledger, test excluded), ₹. */
  mf_contribution: number;
  /** Cumulative NPS contributions, ₹. */
  nps_contribution: number;
  /** Cumulative EPF contributions (employee + employer), ₹. */
  epf_contribution: number;
  /** Cumulative International net deposits, ₹. */
  intl_contribution: number;
  total_contribution: number;
};

/**
 * NW-level "contributions vs growth" decomposition over a window. Kept
 * field-compatible with the previous ledger-based version so the
 * NWTrendChart SummaryStrip and the queries.ts re-export are unchanged.
 * `hasMissingCreditsData` is retained but always false now — the
 * reconstruction is exact, so there's no residual to flag.
 */
export type NwAttribution = {
  startDate: string;
  endDate: string;
  daysCovered: number;
  mfDeposits: number;
  npsDeposits: number;
  epfDeposits: number;
  intlDeposits: number;
  totalContributions: number;
  mfMarket: number;
  npsMarket: number;
  epfInterest: number;
  intlMarket: number;
  totalGrowth: number;
  totalNwChange: number;
  hasMissingCreditsData: boolean;
};

function dayBefore(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Build the unified NW timeline by forward-filling each asset's value +
 * cumulative contributions across the union of all dates. An asset
 * reads 0 before its first data point (it didn't exist yet). A synthetic
 * ₹0 "inception" point is prepended one day before the earliest date so
 * the ALL-range view (and its attribution) starts from a true zero — the
 * honest "wealth built from nothing" baseline.
 */
export function buildNwHistory(input: {
  mfHistory: MfDailyRow[];
  npsHistory: NpsDailyRow[];
  epfHistory: EpfDailyRow[];
  intlHistory: IntlDailyRow[];
}): NwPoint[] {
  const byDate = (a: { date: string }, b: { date: string }) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  const mf = [...input.mfHistory].sort(byDate);
  const nps = [...input.npsHistory].sort(byDate);
  const epf = [...input.epfHistory].sort(byDate);
  const intl = [...input.intlHistory].sort(byDate);

  const allDates = Array.from(
    new Set([
      ...mf.map((r) => r.date),
      ...nps.map((r) => r.date),
      ...epf.map((r) => r.date),
      ...intl.map((r) => r.date),
    ])
  ).sort();
  if (allDates.length === 0) return [];

  const zero: NwPoint = {
    date: dayBefore(allDates[0]),
    mf_value: 0,
    nps_value: 0,
    epf_value: 0,
    intl_value: 0,
    total_nw: 0,
    mf_contribution: 0,
    nps_contribution: 0,
    epf_contribution: 0,
    intl_contribution: 0,
    total_contribution: 0,
  };
  const points: NwPoint[] = [zero];

  // Forward-fill via advancing pointers (series are sorted ascending).
  let mi = -1;
  let ni = -1;
  let ei = -1;
  let ii = -1;
  for (const d of allDates) {
    while (mi + 1 < mf.length && mf[mi + 1].date <= d) mi++;
    while (ni + 1 < nps.length && nps[ni + 1].date <= d) ni++;
    while (ei + 1 < epf.length && epf[ei + 1].date <= d) ei++;
    while (ii + 1 < intl.length && intl[ii + 1].date <= d) ii++;

    const mfRow = mi >= 0 ? mf[mi] : null;
    const npsRow = ni >= 0 ? nps[ni] : null;
    const epfRow = ei >= 0 ? epf[ei] : null;
    const intlRow = ii >= 0 ? intl[ii] : null;

    const mf_value = mfRow?.mf_value ?? 0;
    // Prefer ledger net deposits (test excluded); fall back to the
    // snapshot cost basis on bootstrap rows without ledger enrichment.
    const mf_contribution = mfRow
      ? mfRow.mf_deposits_ledger ?? mfRow.mf_invested
      : 0;
    const nps_value = npsRow?.nps_value ?? 0;
    const nps_contribution = npsRow?.nps_invested ?? 0;
    const epf_value = epfRow?.epf_value ?? 0;
    const epf_contribution = epfRow?.epf_contribution ?? 0;
    const intl_value = intlRow?.intl_value ?? 0;
    const intl_contribution = intlRow?.intl_invested ?? 0;

    points.push({
      date: d,
      mf_value,
      nps_value,
      epf_value,
      intl_value,
      total_nw: mf_value + nps_value + epf_value + intl_value,
      mf_contribution,
      nps_contribution,
      epf_contribution,
      intl_contribution,
      total_contribution:
        mf_contribution + nps_contribution + epf_contribution + intl_contribution,
    });
  }

  return points;
}

/**
 * Exact contributions-vs-growth attribution over a window (the caller
 * passes the range-filtered slice; endpoints are `window[0]` and the
 * last row). Per asset: deposits = Δcumulative-contribution, growth =
 * Δvalue − deposits. Sums reconcile to Δtotal_nw by construction.
 */
export function computeNwAttribution(window: NwPoint[]): NwAttribution | null {
  if (window.length < 2) return null;
  const first = window[0];
  const last = window[window.length - 1];

  const mfDeposits = last.mf_contribution - first.mf_contribution;
  const npsDeposits = last.nps_contribution - first.nps_contribution;
  const epfDeposits = last.epf_contribution - first.epf_contribution;
  const intlDeposits = last.intl_contribution - first.intl_contribution;
  const totalContributions = mfDeposits + npsDeposits + epfDeposits + intlDeposits;

  const mfMarket = last.mf_value - first.mf_value - mfDeposits;
  const npsMarket = last.nps_value - first.nps_value - npsDeposits;
  const epfInterest = last.epf_value - first.epf_value - epfDeposits;
  const intlMarket = last.intl_value - first.intl_value - intlDeposits;
  const totalGrowth = mfMarket + npsMarket + epfInterest + intlMarket;

  const totalNwChange = last.total_nw - first.total_nw;
  if (Math.abs(totalNwChange) < 100 && Math.abs(totalContributions) < 100) {
    return null;
  }

  return {
    startDate: first.date,
    endDate: last.date,
    daysCovered: Math.round(
      (new Date(last.date).getTime() - new Date(first.date).getTime()) /
        86400000
    ),
    mfDeposits,
    npsDeposits,
    epfDeposits,
    intlDeposits,
    totalContributions,
    mfMarket,
    npsMarket,
    epfInterest,
    intlMarket,
    totalGrowth,
    totalNwChange,
    hasMissingCreditsData: false,
  };
}
