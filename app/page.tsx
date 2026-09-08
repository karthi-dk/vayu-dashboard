import { HeadlineNW } from "@/components/overview/HeadlineNW";
import { StatCard } from "@/components/overview/StatCard";
import { EquityDebtCard } from "@/components/overview/EquityDebtCard";
import { LiquidityCard } from "@/components/overview/LiquidityCard";
import { WealthCompositionCard } from "@/components/overview/WealthCompositionCard";
import { NWTrendChart } from "@/components/overview/NWTrendChart";
import { NWCompositionChart } from "@/components/overview/NWCompositionChart";
import { MFGrowthBreakdown } from "@/components/overview/MFGrowthBreakdown";
import { MfDeltasCard } from "@/components/overview/MfDeltasCard";
import { InternationalCard } from "@/components/overview/InternationalCard";
import { IntlGrowthBreakdown } from "@/components/overview/IntlGrowthBreakdown";
import { IntlFundGrowthChart } from "@/components/overview/IntlFundGrowthChart";
import { NpsGrowthBreakdown } from "@/components/overview/NpsGrowthBreakdown";
import { EpfGrowthBreakdown } from "@/components/overview/EpfGrowthBreakdown";
import { IndexHighsCard } from "@/components/overview/IndexHighsCard";
import { Tooltip } from "@/components/ui/Tooltip";
import { getOverviewData } from "@/lib/queries";
import { withTransientRetry } from "@/lib/transientRetry";
import { fmtCompactINR, fmtDateShort, fmtL } from "@/lib/utils";

// Force fresh reads on every visit — this is a personal dashboard, no caching
// benefits and the underlying data changes hourly.
export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  let overview;
  try {
    // Retry the transient post-sleep clock-skew handshake (PGRST303
    // "JWT issued at future") so a browser reload after idle hours doesn't
    // hard-fail the landing page on the first request before NTP re-syncs.
    overview = await withTransientRetry(() => getOverviewData());
  } catch (err) {
    // Keep the throw so the route-level error UI still renders, but log
    // full details server-side (Vercel logs) for production diagnosis.
    console.error("[overview] getOverviewData failed", err);
    throw err;
  }

  const {
    latest,
    prev,
    history,
    mfHistory,
    npsHistory,
    epfHistory,
    nwHistory,
    npsXirr,
    npsSchemeBreakdown,
    nps,
    epf,
    fundCount,
    mfNavDate,
    mfStaleCount,
    mfOneDayInr,
    mfOneDayPct,
    assetSplit,
    nwDeltas,
    mfDeltas,
    intlDeltas,
    international,
    intlHistory,
    liquiditySplit,
    credits,
    wealthComposition,
    indexLevels,
  } = overview;

  const total = latest?.total_nw ?? 0;

  // Sparklines
  // ──────────
  // MF and NPS use their reconstructed daily histories (built from
  // transaction ledgers × NAV history) which reach back to the first
  // transaction — long before nw_daily tracking started. This means
  // the sparklines now reflect the multi-year journey (e.g. NPS from
  // ₹0 in 2020 → ₹5.93 L today, MF from ₹0 → ₹39 L across CAS + Groww
  // ingested history), which is the reading users expect once they
  // backfill historical data via scripts/backfill-nps-nav-history.ts
  // and the CAS ingest.
  //
  // EPF now has a passbook-based reconstruction too (lib/epf/epfHistory
  // — monthly contributions + annual interest across all member IDs,
  // pension excluded), so its sparkline reaches back to the first
  // contribution like MF/NPS rather than only the nw_daily window.
  //
  // Falls back to nw_daily's last 30 rows on fresh installs where
  // the reconstruction hasn't populated the historical series yet.
  const mfSpark = (mfHistory.length > 0 ? mfHistory : history.slice(-30)).map(
    (r) => ({ v: r.mf_value })
  );
  const npsSpark = (npsHistory.length > 0
    ? npsHistory
    : history.slice(-30)
  ).map((r) => ({ v: r.nps_value }));
  const epfSpark =
    epfHistory.length > 0
      ? epfHistory.map((r) => ({ v: r.epf_value }))
      : history.slice(-30).map((r) => ({ v: r.epf_estimate }));

  // 1D chip strategy per card
  // -------------------------
  // MF   → Groww's oneDayReturnValue (mf_1d_change_inr) — matches Groww
  //        exactly. It's a fund-by-fund NAV-pair delta and therefore
  //        insulated from snapshot timing lag (some funds publish NAVs
  //        T+1/T+2, so morning-vs-evening syncs capture different NAV
  //        vintages and produce a snapshot diff that quietly drifts from
  //        Groww's number by ~₹1-2K/day on a portfolio our size). Fall
  //        back to snapshot diff only if the Groww chip hasn't been
  //        persisted yet (fresh install).
  // NPS  → stored nps_1d_change_inr (units × ΔNAV, written by
  //        /api/refresh-nps-nav on each real rotation). We now walk
  //        BACKWARD through history to find the last non-zero delta,
  //        so the chip continues showing yesterday's move on days when
  //        NPS hasn't rotated yet (Kotak publishes T+1, ~12–2 AM the
  //        NEXT calendar day — snapshot diff between today and
  //        yesterday's nw_daily rows would be flat ₹0 during that
  //        pre-publication window). Analogous to MF's persistent-per-
  //        fund one_day_change_inr behavior for overseas funds.
  //        Rebaselining risk (2nd refresh in the same day zeros the
  //        delta) is now handled by the value-unchanged guard in
  //        refresh-nps-nav — identical NAVs across two refreshes take
  //        the already_fresh path instead of rotating.
  // EPF  → NO 1D chip. EPF is a step-change asset (monthly payroll on
  //        day 15 + annual interest credit event), not a daily-changing
  //        one. A "1D" label on EPF is misleading by construction — most
  //        days it would either be ₹0 or reflect an interpolation
  //        artifact. Credit events are visible on the Settings card
  //        (last verified / last interest credit) and roll into the
  //        headline delta strip + Total Wealth Build-up card, where
  //        they belong.
  const buildDayChange = (
    latestVal: number,
    prevVal: number | undefined
  ): { inr: number; pct: number } | null => {
    if (prevVal == null || prevVal <= 0) return null;
    const inr = latestVal - prevVal;
    const pct = (inr / prevVal) * 100;
    return { inr, pct };
  };
  // MF: prefer Groww's chip, snapshot diff as fallback for fresh installs.
  const mfSnapshot =
    latest && prev ? buildDayChange(latest.mf_value, prev.mf_value) : null;
  const mfDayChange =
    mfOneDayInr != null && mfOneDayPct != null
      ? { inr: mfOneDayInr, pct: mfOneDayPct }
      : latest?.mf_1d_change_inr != null && latest?.mf_1d_change_pct != null
        ? { inr: latest.mf_1d_change_inr, pct: latest.mf_1d_change_pct }
        : mfSnapshot;
  // NPS: mirror MF's "persistent delta" convention. Prefer the stored
  // `nps_1d_change_inr` (written by the refresh route at each NAV
  // rotation) over a snapshot diff of nps_value between today and
  // yesterday. Why: NPS NAV publishes on T+1 (Kotak posts 12–2 AM the
  // NEXT calendar day), so from midnight-IST until the actual publish,
  // today's nw_daily.nps_value == yesterday's — the snapshot diff
  // yields a flat ₹0 chip that hides the last real move.
  //
  // Because we only have a per-day stored delta (unlike MF's per-fund
  // persistent one_day_change_inr), if today's nps_1d is 0/null we walk
  // BACKWARD through history to find the last row with a real non-zero
  // delta. That row's value = "last known NPS 1D", which is the same
  // information Groww's persistent-per-fund column would give MF on a
  // day when nothing rotated.
  //
  // Snapshot diff remains as the final fallback for the fresh-install
  // case where history is too short to have a stored delta yet.
  const npsSnapshot =
    latest && prev ? buildDayChange(latest.nps_value, prev.nps_value) : null;
  const npsLastRealDelta = (() => {
    // Fast path: latest row has a real (non-zero) delta.
    if (
      latest?.nps_1d_change_inr != null &&
      latest?.nps_1d_change_pct != null &&
      latest.nps_1d_change_inr !== 0
    ) {
      return { inr: latest.nps_1d_change_inr, pct: latest.nps_1d_change_pct };
    }
    // Walk back through history (ascending) to find the most recent
    // non-zero delta. Loop tolerates the "history is short / all zeros"
    // case by returning null and letting the snapshot fallback fire.
    for (let i = history.length - 1; i >= 0; i--) {
      const r = history[i];
      if (
        r.nps_1d_change_inr != null &&
        r.nps_1d_change_pct != null &&
        r.nps_1d_change_inr !== 0
      ) {
        return { inr: r.nps_1d_change_inr, pct: r.nps_1d_change_pct };
      }
    }
    return null;
  })();
  const npsDayChange = npsLastRealDelta ?? npsSnapshot;
  const prevDateShort = prev ? fmtDateShort(prev.date) : null;

  // Ledger-derived NPS gain %. Uses the last row of npsHistory (built
  // from nps_transactions + nps_nav_history in lib/queries.ts) so the
  // headline card and the NPS · Value vs Invested chart / Wealth
  // Build-up card all show consistent numbers. Falls back to null when
  // the ledger isn't yet populated — the card then renders the "NAVs
  // as of ..." subline instead of a fabricated gain %.
  const latestNpsLedger =
    npsHistory.length > 0 ? npsHistory[npsHistory.length - 1] : null;
  const npsGainPct =
    latestNpsLedger && latestNpsLedger.nps_invested > 0
      ? latestNpsLedger.nps_gain_pct
      : null;
  const npsInvested = latestNpsLedger?.nps_invested ?? null;

  // Keep the MF headline card consistent with the MF Growth breakdown
  // chart: prefer ledger-derived net deposits (purchases - redemptions)
  // as the denominator/base when available, else fall back to the
  // legacy invested snapshot fields.
  const mfReferenceBase =
    latest?.mf_deposits_ledger != null && latest.mf_deposits_ledger > 0
      ? latest.mf_deposits_ledger
      : latest?.mf_invested ?? null;
  const mfReferenceLabel =
    latest?.mf_deposits_ledger != null && latest.mf_deposits_ledger > 0
      ? "net deposits"
      : "invested";
  const mfGainPct =
    latest && mfReferenceBase != null && mfReferenceBase > 0
      ? ((latest.mf_value - mfReferenceBase) / mfReferenceBase) * 100
      : latest?.mf_gain_pct ?? 0;
  const mfProfitInr =
    latest && mfReferenceBase != null && mfReferenceBase > 0
      ? latest.mf_value - mfReferenceBase
      : null;

  // EPF invested-vs-return split. Contributed = the hard passbook number
  // (lifetime_contribution_inr); interest = everything above it in the
  // displayed estimate, so it always reconciles to the card's ₹ value.
  const epfContributed = epf?.lifetime_contribution_inr ?? null;
  const epfInterestInr =
    latest && epfContributed != null
      ? latest.epf_estimate - epfContributed
      : null;
  const epfReturnPct =
    epfContributed != null && epfContributed > 0 && epfInterestInr != null
      ? (epfInterestInr / epfContributed) * 100
      : null;

  // International: spark from the reconstructed + observed intl curve (back
  // to ICICI's Feb start), 1D preferring the stored intl_1d over a snapshot.
  const intlSpark = intlHistory.length
    ? intlHistory.map((r) => ({ v: r.intl_value }))
    : history
        .filter((r) => r.intl_value != null)
        .map((r) => ({ v: Number(r.intl_value) }));
  const intlDayChange =
    international?.oneDayInr != null && international?.oneDayPct != null
      ? { inr: international.oneDayInr, pct: international.oneDayPct }
      : international?.oneDayStale
        ? null
        : latest && prev && latest.intl_value != null && prev.intl_value != null
          ? buildDayChange(Number(latest.intl_value), Number(prev.intl_value))
          : null;

  return (
    <div className="flex flex-col gap-8">
      <HeadlineNW latest={latest} prev={prev} deltas={nwDeltas} credits={credits} />

      {latest ? (
        <div
          className={`grid grid-cols-1 gap-4 sm:grid-cols-2 ${
            international ? "lg:grid-cols-4" : "md:grid-cols-3"
          }`}
        >
          <StatCard
            label="Mutual Funds"
            meta={`${fundCount} holdings`}
            value={latest.mf_value}
            subline={
              <>
                <span
                  className={
                    mfGainPct >= 0
                      ? "text-[hsl(var(--success))]"
                      : "text-[hsl(var(--danger))]"
                  }
                >
                  {mfGainPct >= 0 ? "+" : ""}
                  {mfGainPct.toFixed(2)}%
                  {mfProfitInr != null && (
                    <span className="opacity-80">
                      {" "}
                      ({fmtCompactINR(mfProfitInr, { sign: true })})
                    </span>
                  )}
                </span>{" "}
                vs {mfReferenceLabel} {fmtL(mfReferenceBase ?? 0)}
              </>
            }
            pctOfNw={total > 0 ? (latest.mf_value / total) * 100 : 0}
            sparkData={mfSpark}
            dayChange={mfDayChange}
            dayChangeSince={prevDateShort}
            navDate={mfNavDate}
            navStaleCount={mfStaleCount}
            dayChangeTitle={
              latest.mf_1d_change_inr != null
                ? "Groww 1D returns — fund-level NAV move (matches Groww exactly, excludes new investments and NAV publish timing lag)"
                : undefined
            }
          />
          <StatCard
            label="EPF"
            meta={
              epf
                ? `${epf.interest_rate_pct}% interest · verified ${fmtDateShort(
                    epf.last_verified_date
                  )}`
                : "EPF"
            }
            value={latest.epf_estimate}
            subline={
              // Mirrors the MF/NPS gain line: contributed (passbook) vs
              // accrued interest. EPF never loses, so this "return" is
              // lifetime interest ÷ contributions — cumulative, not annualised
              // (tooltip clarifies). Falls back to the verified stamp only
              // before the passbook split is seeded.
              epfContributed != null &&
              epfInterestInr != null &&
              epfReturnPct != null ? (
                <Tooltip
                  align="start"
                  content={
                    <span>
                      Lifetime interest credited ÷ your contributions.
                      Guaranteed {epf?.interest_rate_pct}% p.a. — shown
                      cumulative, not annualised.
                    </span>
                  }
                >
                  <span className="cursor-help">
                    <span
                      className={
                        epfInterestInr >= 0
                          ? "text-[hsl(var(--success))]"
                          : "text-[hsl(var(--danger))]"
                      }
                    >
                      {epfInterestInr >= 0 ? "+" : ""}
                      {epfReturnPct.toFixed(1)}%
                      <span className="opacity-80">
                        {" "}
                        ({fmtCompactINR(epfInterestInr, { sign: true })})
                      </span>
                    </span>{" "}
                    vs contributed {fmtL(epfContributed)}
                  </span>
                </Tooltip>
              ) : epf?.last_verified_date ? (
                <>Verified {fmtDateShort(epf.last_verified_date)}</>
              ) : (
                <span className="text-muted-foreground/70">
                  Not yet verified
                </span>
              )
            }
            pctOfNw={total > 0 ? (latest.epf_estimate / total) * 100 : 0}
            sparkData={epfSpark}
            // EPF is a step-change asset (monthly payroll + annual
            // interest); a "1D" chip on it is misleading — see the
            // 1D-chip-strategy comment above.
            dayChange={null}
            dayChangeSince={null}
          />
          {international && (
            <StatCard
              label="International"
              meta={`${international.funds.length} holdings · USD+INR`}
              value={international.value}
              subline={
                <>
                  <span
                    className={
                      international.gainPct >= 0
                        ? "text-[hsl(var(--success))]"
                        : "text-[hsl(var(--danger))]"
                    }
                  >
                    {international.gainPct >= 0 ? "+" : ""}
                    {international.gainPct.toFixed(2)}%
                    <span className="opacity-80">
                      {" "}
                      ({fmtCompactINR(international.value - international.invested, { sign: true })})
                    </span>
                  </span>{" "}
                  vs invested {fmtL(international.invested)}
                </>
              }
              pctOfNw={total > 0 ? (international.value / total) * 100 : 0}
              sparkData={intlSpark.length ? intlSpark : [{ v: international.value }]}
              dayChange={intlDayChange}
              dayChangeSince={prevDateShort}
              navDate={international.navDate}
              navStaleCount={international.navStaleCount}
              staleDayChange={
                international.oneDayStale ? { navDate: international.navDate } : null
              }
            />
          )}
          <StatCard
            label="NPS"
            meta={
              nps
                ? `Tier-I · ${nps.alloc_e_pct}:${nps.alloc_c_pct}:${nps.alloc_g_pct}`
                : "Tier-I"
            }
            value={latest.nps_value}
            subline={
              // Prefer ledger-derived "+X.XX% vs invested ₹Y.YYL" (matches
              // the MF card format and the NPS · Value vs Invested chart).
              // Falls back to the NAV freshness stamp if the CRA SOT ledger
              // + nps_nav_history aren't populated yet — see the empty
              // state on NpsGrowthBreakdown for the recovery flow.
              npsGainPct != null && npsInvested != null ? (
                <>
                  <span
                    className={
                      npsGainPct >= 0
                        ? "text-[hsl(var(--success))]"
                        : "text-[hsl(var(--danger))]"
                    }
                  >
                    {npsGainPct >= 0 ? "+" : ""}
                    {npsGainPct.toFixed(2)}%
                    <span className="opacity-80">
                      {" "}
                      ({fmtCompactINR(latest.nps_value - npsInvested, { sign: true })})
                    </span>
                  </span>{" "}
                  vs invested {fmtL(npsInvested)}
                </>
              ) : nps?.nav_date ? (
                <>NAVs as of {fmtDateShort(nps.nav_date)}</>
              ) : (
                <span className="text-muted-foreground/70">
                  NAV not refreshed yet
                </span>
              )
            }
            pctOfNw={total > 0 ? (latest.nps_value / total) * 100 : 0}
            sparkData={npsSpark}
            dayChange={npsDayChange}
            dayChangeSince={prevDateShort}
            navDate={nps?.nav_date ?? null}
          />
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border bg-muted/10 p-8 text-center">
          <p className="text-sm font-medium text-foreground">
            No snapshots recorded yet
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Run <code className="font-mono">daily_update.py</code> or paste
            your Groww JSON on the Sync page to write the first{" "}
            <code className="font-mono">nw_daily</code> row.
          </p>
        </div>
      )}

      {/* Net-worth composition — stacked area of MF / NPS / EPF over
          time. Sits directly under the three headline StatCards
          because it's the natural "how has this mix evolved?" follow-up
          to their point-in-time snapshots — before the Asset Allocation
          card, which reframes the same mix as Equity vs Debt. */}
      <NWCompositionChart history={nwHistory} />

      {latest && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <EquityDebtCard split={assetSplit} />
          <LiquidityCard split={liquiditySplit} />
        </div>
      )}

      {/* Wealth composition — 4 donuts (NW / MF / NPS / EPF) showing
          the contributions vs growth split for each source. Sits after
          the allocation cards because it answers a different question
          ("where did the money come from?" vs "where is the money?").
          One card containing four donuts, not four individual cards —
          keeps them visually grouped as a single analytical unit. */}
      {latest && <WealthCompositionCard composition={wealthComposition} />}

      <NWTrendChart history={nwHistory} />
      <MFGrowthBreakdown history={mfHistory} />
      <MfDeltasCard deltas={mfDeltas} />
      <IntlGrowthBreakdown history={intlHistory} />
      <InternationalCard international={international} deltas={intlDeltas} />
      <IntlFundGrowthChart
        fundCode="HDFC_INTL_DM"
        title="HDFC Intl DM · NAV vs FX growth"
      />
      <NpsGrowthBreakdown
        history={npsHistory}
        xirr={npsXirr}
        schemeRows={npsSchemeBreakdown}
      />
      <EpfGrowthBreakdown history={epfHistory} />

      {/* Market-wide reference, not portfolio-derived — deliberately last,
          after every personal-holdings section. Small "how far off the
          peak" table for the six indices used elsewhere in Vayu's cap
          classification (N50/NN50/Mid150/Small250) plus the two overseas
          benchmarks (Nasdaq100/S&P500) users compare their international
          funds against. */}
      <IndexHighsCard rows={indexLevels} />
    </div>
  );
}
