import { sbServer } from "./supabase";
import { istDate } from "./istDate";

/**
 * Recompute and upsert today's row in nw_daily.
 *
 * WHY THIS EXISTS
 * ---------------
 * `nw_daily` is one-row-per-date. The 2 AM cron writes it once daily, but any
 * write path that mutates a value feeding into total_nw (Groww JSON paste,
 * EPF/NPS updates from Settings, fund holdings resync in principle) must
 * refresh today's row too — otherwise the Overview headline goes stale
 * against the underlying data until the next cron run.
 *
 * WHY IT'S SO DEFENSIVE
 * ---------------------
 * Any of the source tables (nw feeds off 3: fund_holdings, nps_state,
 * epf_state) can legitimately be empty during initial setup. Instead of
 * throwing, we fall back to 0 for whichever slice isn't available yet, so
 * the first Groww paste after a fresh DB still produces a valid nw_daily
 * row instead of failing loudly.
 *
 * MF 1D AUTO-DERIVATION (2026-07-27 fix)
 * --------------------------------------
 * When the caller doesn't pass an explicit `mf_1d_change_inr`, we compute
 * it here from `fund_holdings.one_day_change_inr` — the same per-fund
 * persistent 1D that refresh-mf-nav sums on each NAV rotation. This
 * fixes a bug where logging an MF transaction (e.g., a fresh ₹10K
 * INDmoney purchase via /studio) would leave today's nw_daily row with
 * `mf_1d_change_inr = NULL`, causing the Overview MF card to fall back
 * to a raw snapshot-diff (today_mf_value − yesterday_mf_value) that
 * INCLUDES the ₹10K deposit — reading as "+₹10K market gain" when it
 * was really just money moving in.
 *
 * By deriving the 1D from fund_holdings inside recomputeNwDaily, ANY
 * caller (log-transaction, Settings save, future sync paths) writes a
 * correct NAV-only 1D without needing to know about the 1D contract.
 * The value is the "last known real market move on units held" — same
 * semantic Groww exposes, unaffected by today's inflows.
 *
 * WHY THE OPTIONAL 1D OVERRIDES
 * -----------------------------
 * refresh-mf-nav can pass its own computed values as overrides. They win
 * over the derived value here — belt-and-braces, no behaviour change.
 *
 * /api/refresh-nps-nav computes a proper NPS 1D change as sum of
 * units × (currentNAV - prevNAV) per scheme — more accurate than the
 * snapshot-diff of consecutive nw_daily rows (which can span 2-3 days when
 * an nw_daily row is missing, e.g., on Sundays when the cron doesn't run).
 *
 * NPS 1D AUTO-DERIVATION (2026-07-27 fix — parallel to MF)
 * --------------------------------------------------------
 * Same class of bug that plagued MF also lurked here: logging an NPS
 * payroll credit via /credits mutates `nps_state.scheme_*_units`, which
 * bumps `nps_value` on today's nw_daily row. If today's row's
 * `nps_1d_change_inr` was NULL (because refresh-nps-nav hasn't rotated
 * today — Kotak publishes T+1), the HeadlineNW total 1D chip falls back
 * to `latest.nps_value − prev.nps_value`, silently counting the payroll
 * credit as a market gain.
 *
 * We derive NPS 1D here from `nps_state` using the SAME formula
 * refresh-nps-nav uses:  Σ units × (nav − nav_prev). This uses TODAY's
 * (post-credit) units against yesterday's nav_prev, so it slightly
 * over-attributes the NAV move to freshly-added units — for a ₹5K
 * payroll credit during a 0.5 % NAV day on a ₹6L NPS corpus, the
 * over-count is under ₹100. Rounding error compared to the +₹5K bug
 * we're eliminating. Once refresh-nps-nav rotates, its explicit
 * override wins and the number becomes exact again.
 *
 * Guard: only derive when at least one scheme has a non-null nav_prev
 * (otherwise the DB is freshly seeded and no rotation has ever
 * happened — writing 0 there would misrepresent the state).
 *
 * Undefined / null values in the overrides object are treated as
 * "don't touch — derive it or preserve prior value", not "set to NULL".
 */
export async function recomputeNwDaily(overrides?: {
  mf_1d_change_inr?: number | null;
  mf_1d_change_pct?: number | null;
  nps_1d_change_inr?: number | null;
  nps_1d_change_pct?: number | null;
}): Promise<void> {
  const [funds, nps, epf] = await Promise.all([
    // cap_type is fetched purely so we can persist the equity/debt breakdown
    // (mf_equity_inr / mf_debt_inr) on the same nw_daily row — see the
    // 2026-07-16-mf-equity-debt-breakdown.sql migration for the reasoning.
    //
    // one_day_change_inr is the per-fund persistent 1D (units × ΔNAV
    // from the last NAV rotation). Summing across funds gives the
    // portfolio-level 1D that Groww / any tracker would show — and
    // because it's NAV-derived, it correctly excludes any inflows
    // from newly-logged transactions (see MF 1D AUTO-DERIVATION note
    // in the header docstring).
    sbServer
      .from("fund_holdings")
      .select(
        "current_value_inr, invested_inr, cap_type, one_day_change_inr, asset_class"
      ),
    sbServer
      .from("nps_state")
      .select(
        "scheme_e_units, scheme_c_units, scheme_g_units, scheme_e_nav, scheme_c_nav, scheme_g_nav, scheme_e_nav_prev, scheme_c_nav_prev, scheme_g_nav_prev"
      )
      .eq("id", 1)
      .maybeSingle(),
    sbServer
      .from("epf_state")
      .select("balance_inr, fy_interest_pending_inr")
      .eq("id", 1)
      .maybeSingle(),
  ]);

  const fundRows = (funds.data ?? []) as Array<{
    current_value_inr: number | null;
    invested_inr: number | null;
    cap_type: string | null;
    one_day_change_inr: number | null;
    asset_class: string | null;
  }>;
  // International (asset_class='intl') is a top-level asset class, NOT part
  // of the MF slice — split so mf_* and intl_* never double-count.
  const mfRows = fundRows.filter((f) => f.asset_class !== "intl");
  const intlRows = fundRows.filter((f) => f.asset_class === "intl");

  const mfValue = mfRows.reduce(
    (s, f) => s + Number(f.current_value_inr ?? 0),
    0
  );
  const mfInvested = mfRows.reduce(
    (s, f) => s + Number(f.invested_inr ?? 0),
    0
  );
  const intlValue = intlRows.reduce(
    (s, f) => s + Number(f.current_value_inr ?? 0),
    0
  );
  const intlInvested = intlRows.reduce(
    (s, f) => s + Number(f.invested_inr ?? 0),
    0
  );
  // Equity/Debt breakdown — same classification rule as the Overview card
  // (cap_type='debt' → Debt, everything else → Equity). Null cap_type is
  // treated as equity for safety: a mis-tagged fund shouldn't silently
  // flip to debt and corrupt the split. MF slice only — intl is excluded.
  const mfEquity = mfRows
    .filter((f) => (f.cap_type ?? "large") !== "debt")
    .reduce((s, f) => s + Number(f.current_value_inr ?? 0), 0);
  const mfDebt = mfRows
    .filter((f) => f.cap_type === "debt")
    .reduce((s, f) => s + Number(f.current_value_inr ?? 0), 0);

  const npsRow = nps.data as {
    scheme_e_units: number;
    scheme_c_units: number;
    scheme_g_units: number;
    scheme_e_nav: number;
    scheme_c_nav: number;
    scheme_g_nav: number;
    scheme_e_nav_prev: number | null;
    scheme_c_nav_prev: number | null;
    scheme_g_nav_prev: number | null;
  } | null;
  const npsValue = npsRow
    ? npsRow.scheme_e_units * npsRow.scheme_e_nav +
      npsRow.scheme_c_units * npsRow.scheme_c_nav +
      npsRow.scheme_g_units * npsRow.scheme_g_nav
    : 0;

  const epfRow = epf.data as {
    balance_inr: number;
    fy_interest_pending_inr: number | null;
  } | null;
  const epfEstimate = epfRow
    ? Number(epfRow.balance_inr) + Number(epfRow.fy_interest_pending_inr ?? 0)
    : 0;

  const totalNw = mfValue + npsValue + epfEstimate + intlValue;
  const mfGainPct = mfInvested > 0 ? ((mfValue - mfInvested) / mfInvested) * 100 : 0;
  const intlGainPct =
    intlInvested > 0 ? ((intlValue - intlInvested) / intlInvested) * 100 : 0;

  const today = istDate();
  // Build the upsert payload — only include 1D fields when a valid number
  // was passed. PostgREST's upsert uses `INSERT ... ON CONFLICT DO UPDATE
  // SET col=excluded.col` for every column present in the payload, so
  // omitting these keys means the previous values (from the last Groww
  // sync) are preserved rather than overwritten with NULL. That's exactly
  // what we want when other write paths (Settings, cron) touch nw_daily.
  const row: Record<string, unknown> = {
    date: today,
    mf_value: Number(mfValue.toFixed(2)),
    mf_invested: Number(mfInvested.toFixed(2)),
    mf_equity_inr: Number(mfEquity.toFixed(2)),
    mf_debt_inr: Number(mfDebt.toFixed(2)),
    nps_value: Number(npsValue.toFixed(2)),
    epf_estimate: Number(epfEstimate.toFixed(2)),
    total_nw: Number(totalNw.toFixed(2)),
    mf_gain_pct: Number(mfGainPct.toFixed(2)),
    intl_value: Number(intlValue.toFixed(2)),
    intl_invested: Number(intlInvested.toFixed(2)),
    intl_gain_pct: Number(intlGainPct.toFixed(2)),
  };
  // MF 1D — prefer explicit override (refresh-mf-nav's post-rotation
  // sum), else derive from fund_holdings.one_day_change_inr.
  //
  // Guard: derive only if AT LEAST ONE fund has a non-null 1D. A totally-
  // null column means the DB was just seeded and no NAV refresh has ever
  // run — in that state we'd rather leave mf_1d_change_inr untouched
  // (preserving whatever was there, typically NULL) than write a
  // misleading 0. Once a NAV refresh runs, subsequent recompute calls
  // will pick up the real per-fund deltas.
  //
  // Formula (matches refresh-mf-nav's post-rotation block ~L459-476):
  //   • INR = Σ one_day_change_inr
  //   • pct = INR / (current_total − INR) × 100
  //         = INR / prev_value  where prev_value is the units-held-today
  //           value at the last-known previous NAV per fund
  const hasAnyFund1D = mfRows.some((f) => f.one_day_change_inr != null);
  const derivedMf1dInr = hasAnyFund1D
    ? mfRows.reduce((s, f) => s + Number(f.one_day_change_inr ?? 0), 0)
    : null;
  const derivedMf1dPct =
    derivedMf1dInr != null && mfValue - derivedMf1dInr > 0
      ? (derivedMf1dInr / (mfValue - derivedMf1dInr)) * 100
      : null;

  if (
    overrides?.mf_1d_change_inr !== undefined &&
    overrides.mf_1d_change_inr !== null &&
    Number.isFinite(overrides.mf_1d_change_inr)
  ) {
    row.mf_1d_change_inr = Number(overrides.mf_1d_change_inr.toFixed(2));
  } else if (derivedMf1dInr != null) {
    row.mf_1d_change_inr = Number(derivedMf1dInr.toFixed(2));
  }
  if (
    overrides?.mf_1d_change_pct !== undefined &&
    overrides.mf_1d_change_pct !== null &&
    Number.isFinite(overrides.mf_1d_change_pct)
  ) {
    row.mf_1d_change_pct = Number(overrides.mf_1d_change_pct.toFixed(4));
  } else if (derivedMf1dPct != null) {
    row.mf_1d_change_pct = Number(derivedMf1dPct.toFixed(4));
  }
  // International 1D — derived from Σ fund_holdings.one_day_change_inr over
  // asset_class='intl' (ICICI's AMFI refresh and HDFC's USD route each stamp
  // it on their own row). Same null-guard + pct formula as the MF slice; no
  // override path since two different routes feed the intl rows.
  const hasAnyIntl1D = intlRows.some((f) => f.one_day_change_inr != null);
  const derivedIntl1dInr = hasAnyIntl1D
    ? intlRows.reduce((s, f) => s + Number(f.one_day_change_inr ?? 0), 0)
    : null;
  const derivedIntl1dPct =
    derivedIntl1dInr != null && intlValue - derivedIntl1dInr > 0
      ? (derivedIntl1dInr / (intlValue - derivedIntl1dInr)) * 100
      : null;
  if (derivedIntl1dInr != null) {
    row.intl_1d_change_inr = Number(derivedIntl1dInr.toFixed(2));
  }
  if (derivedIntl1dPct != null) {
    row.intl_1d_change_pct = Number(derivedIntl1dPct.toFixed(4));
  }
  // NPS 1D — prefer explicit override (refresh-nps-nav's per-rotation
  // number), else derive from nps_state using the same formula:
  //   Σ scheme_units × (scheme_nav − scheme_nav_prev)
  //
  // Guard: derive only when at least one scheme has a non-null nav_prev
  // AND that scheme's units > 0 (otherwise nothing rotated yet since the
  // DB was seeded, and writing 0 would misrepresent the fresh-install
  // state — leave the field NULL so the frontend's history walk fires).
  //
  // Caveat re: contribution days — units used here are TODAY's (post-
  // credit); nav_prev is from the last rotation. So the derived 1D
  // slightly over-attributes the NAV move to units added today. For a
  // ₹5K payroll credit during a 0.5 % NAV day on a ₹6L corpus, that's
  // an ~₹80 overstatement. Massive improvement over the previous bug
  // where the full ₹5K was counted as a market gain.
  let derivedNps1dInr: number | null = null;
  if (npsRow) {
    const schemes: Array<[number, number, number | null]> = [
      [npsRow.scheme_e_units, npsRow.scheme_e_nav, npsRow.scheme_e_nav_prev],
      [npsRow.scheme_c_units, npsRow.scheme_c_nav, npsRow.scheme_c_nav_prev],
      [npsRow.scheme_g_units, npsRow.scheme_g_nav, npsRow.scheme_g_nav_prev],
    ];
    const usable = schemes.filter(
      ([u, , prev]) => u > 0 && prev != null && Number.isFinite(prev)
    );
    if (usable.length > 0) {
      derivedNps1dInr = usable.reduce(
        (sum, [u, nav, prev]) => sum + u * (nav - Number(prev)),
        0
      );
    }
  }
  const derivedNps1dPct =
    derivedNps1dInr != null && npsValue - derivedNps1dInr > 0
      ? (derivedNps1dInr / (npsValue - derivedNps1dInr)) * 100
      : null;

  if (
    overrides?.nps_1d_change_inr !== undefined &&
    overrides.nps_1d_change_inr !== null &&
    Number.isFinite(overrides.nps_1d_change_inr)
  ) {
    row.nps_1d_change_inr = Number(overrides.nps_1d_change_inr.toFixed(2));
  } else if (derivedNps1dInr != null) {
    row.nps_1d_change_inr = Number(derivedNps1dInr.toFixed(2));
  }
  if (
    overrides?.nps_1d_change_pct !== undefined &&
    overrides.nps_1d_change_pct !== null &&
    Number.isFinite(overrides.nps_1d_change_pct)
  ) {
    row.nps_1d_change_pct = Number(overrides.nps_1d_change_pct.toFixed(4));
  } else if (derivedNps1dPct != null) {
    row.nps_1d_change_pct = Number(derivedNps1dPct.toFixed(4));
  }
  const { error } = await sbServer
    .from("nw_daily")
    .upsert(row, { onConflict: "date" });
  if (error) throw error;
}
