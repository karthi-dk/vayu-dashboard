import { HeadlineNW } from "@/components/overview/HeadlineNW";
import { StatCard } from "@/components/overview/StatCard";
import { EquityDebtCard } from "@/components/overview/EquityDebtCard";
import { LiquidityCard } from "@/components/overview/LiquidityCard";
import { WealthCompositionCard } from "@/components/overview/WealthCompositionCard";
import { NWTrendChart } from "@/components/overview/NWTrendChart";
import { NWCompositionChart } from "@/components/overview/NWCompositionChart";
import { MFGrowthBreakdown } from "@/components/overview/MFGrowthBreakdown";
import { NpsGrowthBreakdown } from "@/components/overview/NpsGrowthBreakdown";
import { IndexHighsCard } from "@/components/overview/IndexHighsCard";
import { getOverviewData } from "@/lib/queries";
import { fmtDateShort, fmtL } from "@/lib/utils";

// Force fresh reads on every visit — this is a personal dashboard, no caching
// benefits and the underlying data changes hourly.
export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const {
    latest,
    prev,
    history,
    mfHistory,
    npsHistory,
    npsXirr,
    nps,
    epf,
    fundCount,
    assetSplit,
    nwDeltas,
    liquiditySplit,
    credits,
    wealthComposition,
    indexLevels,
  } = await getOverviewData();

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
  // EPF has no transaction-level reconstruction (no per-contribution
  // ledger), so it uses the full nw_daily range — best we have. That
  // means EPF's sparkline covers a shorter window (since tracking
  // start) while MF/NPS cover their entire tracked lifespan. Each
  // sparkline honestly reflects the data available for that asset.
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
  const epfSpark = history.map((r) => ({ v: r.epf_estimate }));

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
    latest?.mf_1d_change_inr != null && latest?.mf_1d_change_pct != null
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

  return (
    <div className="flex flex-col gap-8">
      <HeadlineNW latest={latest} prev={prev} deltas={nwDeltas} />

      {latest ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <StatCard
            label="Mutual Funds"
            meta={`${fundCount} holdings`}
            value={latest.mf_value}
            subline={
              <>
                <span className="text-[hsl(var(--success))]">
                  +{(latest.mf_gain_pct ?? 0).toFixed(2)}%
                </span>{" "}
                vs invested {fmtL(latest.mf_invested)}
              </>
            }
            pctOfNw={total > 0 ? (latest.mf_value / total) * 100 : 0}
            sparkData={mfSpark}
            dayChange={mfDayChange}
            dayChangeSince={prevDateShort}
            dayChangeTitle={
              latest.mf_1d_change_inr != null
                ? "Groww 1D returns — fund-level NAV move (matches Groww exactly, excludes new investments and NAV publish timing lag)"
                : undefined
            }
          />
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
          />
          <StatCard
            label="EPF"
            meta={epf ? `${epf.interest_rate_pct}% interest` : "EPF"}
            value={latest.epf_estimate}
            subline={
              // Was previously "+₹X/mo contribution" — retired when cron
              // auto-adds were replaced by the /credits ledger (Jul 16, 2026).
              // Replaced with the last-verified stamp so the user can see at
              // a glance how stale the balance is vs the EPFO passbook.
              epf?.last_verified_date ? (
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
      <NWCompositionChart history={history} />

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

      <NWTrendChart history={history} credits={credits} />
      <MFGrowthBreakdown history={mfHistory} />
      <NpsGrowthBreakdown history={npsHistory} xirr={npsXirr} />

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
