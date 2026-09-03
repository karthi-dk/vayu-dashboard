import { GrowwPasteCard } from "@/components/sync/GrowwPasteCard";
import { FundResyncGrid } from "@/components/sync/FundResyncGrid";
import { IntlHoldingsPasteCard } from "@/components/sync/IntlHoldingsPasteCard";
import { RefreshNavsCard } from "@/components/sync/RefreshNavsCard";
import { PasteCasCard } from "@/components/sync/PasteCasCard";
import { CapClassificationCard } from "@/components/sync/CapClassificationCard";
import { LogMfTxCard } from "@/components/sync/LogMfTxCard";
import { LogCreditEventCard } from "@/components/sync/LogCreditEventCard";
import { NpsCraPasteCard } from "@/components/sync/NpsCraPasteCard";
import { RefreshIndexLevelsCard } from "@/components/sync/RefreshIndexLevelsCard";
import { DeleteStudioTestDataCard } from "@/components/sync/DeleteStudioTestDataCard";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { getSyncData } from "@/lib/queries";
import { isTransientJwtFutureError, withTransientRetry } from "@/lib/transientRetry";
import { sbServer } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function SyncPage() {
  const {
    lastSync,
    fundCount,
    totalDetailRows,
    fundResync,
    mf,
    intl,
    nps,
    capClassification,
    epfState,
    npsState,
    indexLevels,
  } = await withTransientRetry(() => getSyncData());

  // Second read lives outside getSyncData, so guard it with the same
  // clock-skew retry. Skew-tolerant like the rest of the page: retry ONLY
  // the transient JWT-future error, otherwise keep the prior behavior of
  // rendering with 0 rather than crashing on this non-critical count.
  const testTxCount = await withTransientRetry(async () => {
    const res = await sbServer
      .from("mf_transactions")
      .select("id", { count: "exact", head: true })
      .eq("platform", "test");
    if (isTransientJwtFutureError(res.error)) throw res.error;
    return res.count ?? 0;
  });

  return (
    <div className="flex flex-col gap-8">
      <div>
        <div className="kicker mb-3">Sync operations</div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">
          Refresh portfolio data
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          mfapi.in for daily MF NAVs · Groww for units & contributions · Dhan
          for holding-level breakdowns · CAMS for NPS reconciliation · Last
          full sync <TimeAgo isoDate={lastSync} /> · {fundCount} funds ·{" "}
          {totalDetailRows} detail rows
        </p>
      </div>

      <RefreshNavsCard mf={mf} intl={intl} nps={nps} indexLevels={indexLevels} />
      <GrowwPasteCard lastSync={lastSync} />
      {/* MF transaction logger — primary path for new orders. Handles
          both INDmoney bulk-list JSON (autofills fund/date/units/NAV,
          resolves post-cutoff NAV dates against mf_nav_history) and
          hand-typed AMC-direct SIPs. Writes to mf_transactions with a
          deterministic hash so a future MFCentral CAS re-paste using
          the same hash formula collapses this row and the CAS row
          into one via DB upsert — no duplicate at read time.
          See lib/mf/logMfTx.ts for hash rationale.
          The historical Groww order-history paste card (which used
          to sit here) was retired on 2026-07-24 — INDmoney is now
          the placement platform, and existing mf_contributions rows
          from prior Groww ingest continue to render in the ledger. */}
      <LogMfTxCard />
      <DeleteStudioTestDataCard testTxCount={testTxCount} />
      <LogCreditEventCard epf={epfState} nps={npsState} />
      {/* NPS CRA SOT reconciliation — the /credits log auto-derives
          per-scheme rows using the current alloc split + nps_nav_history
          for the day, which is close but not exact. This card lets you
          re-sync to authoritative CRA numbers once per FY (or whenever
          Kotak posts a new SOT). Wipes auto-derived rows in the pasted
          period, then upserts CRA rows on (source, tx_hash). */}
      <NpsCraPasteCard />
      <RefreshIndexLevelsCard indexLevels={indexLevels} />
      <PasteCasCard />
      <CapClassificationCard data={capClassification} />
      <FundResyncGrid funds={fundResync} />
      <IntlHoldingsPasteCard />
    </div>
  );
}
