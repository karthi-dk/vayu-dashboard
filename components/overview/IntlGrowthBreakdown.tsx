import { MFGrowthBreakdown } from "@/components/overview/MFGrowthBreakdown";
import type { IntlDailyRow, MfDailyRow } from "@/lib/queries";

/**
 * International growth breakdown — the same deposits + market = value chart
 * as MFGrowthBreakdown, fed the International daily curve (reconstructed
 * ICICI back to Feb + observed nw_daily.intl_value). We map the intl series
 * onto the MfDailyRow shape the chart consumes (only value / deposits /
 * is_reconstructed are read). Intl deposits are the fund cost basis, not an
 * MF ledger, so the "ledger-based" tag is hidden.
 */
export function IntlGrowthBreakdown({ history }: { history: IntlDailyRow[] }) {
  if (history.length < 2) return null;
  const mapped: MfDailyRow[] = history.map((r) => ({
    date: r.date,
    mf_value: r.intl_value,
    mf_invested: r.intl_invested,
    mf_deposits_ledger: r.intl_invested,
    is_reconstructed: r.is_reconstructed,
    mf_equity_inr: null,
    mf_debt_inr: null,
    mf_gain_pct: null,
    mf_1d_change_inr: null,
    mf_1d_change_pct: null,
  }));
  return (
    <MFGrowthBreakdown
      history={mapped}
      title="International · Growth breakdown"
      noun="International"
      storageKey="vayu:intl-growth-breakdown-range"
      showLedgerTag={false}
    />
  );
}
