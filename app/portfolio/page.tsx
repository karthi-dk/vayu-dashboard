import { DonutCard } from "@/components/portfolio/DonutCard";
import { HoldingsTable } from "@/components/portfolio/HoldingsTable";
import { SectorExposure } from "@/components/portfolio/SectorExposure";
import { PortfolioHeadline } from "@/components/portfolio/PortfolioHeadline";
import { SectorConcentrationStrip } from "@/components/portfolio/SectorConcentrationStrip";
import { TopStocksCard } from "@/components/portfolio/TopStocksCard";
import { CrossFundOverlap } from "@/components/portfolio/CrossFundOverlap";
import { getPortfolioData } from "@/lib/queries";
import { withTransientRetry } from "@/lib/transientRetry";
import { fmtL } from "@/lib/utils";

export const dynamic = "force-dynamic";

const ASSET_COLORS: Record<string, string> = {
  mf: "hsl(248 85% 72%)",
  epf: "hsl(160 60% 55%)",
  nps: "hsl(200 80% 65%)",
};

// Colours reused across both new donuts. Keeping `large / mid / small`
// palette in sync with the old cap-split donut so returning users
// don't have to relearn what each slice means.
const CAP_COLORS: Record<string, string> = {
  large: "hsl(248 85% 72%)",
  mid: "hsl(150 60% 55%)",
  small: "hsl(350 75% 65%)",
};

// MF composition uses a fresh key namespace: the "Indian equity" slice
// combines Large + Mid + Small into a single roll-up, so it can't
// share the `large` colour without misleading the eye.
const MF_COMPOSITION_COLORS: Record<string, string> = {
  indian_equity: "hsl(248 85% 72%)",
  debt: "hsl(220 15% 55%)",
  intl: "hsl(280 65% 70%)",
};

export default async function PortfolioPage() {
  const {
    funds,
    assetAllocation,
    mfComposition,
    indianEquityCapSplit,
    indianEquityTotal,
    sectorExposure,
    totalNw,
    mfTotal,
    headline,
    topStocks,
    crossFundOverlap,
    sectorConcentration,
    stocksBySector,
  } = await withTransientRetry(() => getPortfolioData());

  return (
    <div className="flex flex-col gap-8">
      {/* Page title — kept as the top-level heading; the headline card
          below carries the actual numeric summary. */}
      <div>
        <div className="kicker mb-3">Portfolio composition</div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">
          Allocation &amp; holdings
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Aggregate view across {fmtL(totalNw)} of tracked assets ·{" "}
          {funds.length} mutual funds, NPS, EPF
        </p>
      </div>

      {/* B — Portfolio-level headline: current value + total gain + 1D.
          Mirrors the Overview page's HeadlineNW so the two pages share
          a visual language. */}
      <PortfolioHeadline data={headline} />

      {/* 15.2 — Sector concentration warning strip. Top-3 sectors with
          amber/red pills when any exceed the comfort threshold. Sits
          near the top because it's a "quick-glance risk check" — full
          sector breakdown lives further down the page. */}
      <SectorConcentrationStrip sectors={sectorConcentration} />

      {/* Donut row — three levels of drill-down, left → right:
          1. Asset allocation:       portfolio → MF vs NPS vs EPF
          2. MF composition:         MF → Indian equity vs Debt vs Intl
          3. Indian equity cap split: Indian equity → Large vs Mid vs Small

          Donuts 2 & 3 replace the old single "Equity cap split" donut
          which grouped funds by SEBI cap_type and got the ratios wrong:
          it counted whole flexi/large-cap funds as one bucket even
          when a slice of their holdings sat in mid/small stocks. Both
          new donuts are look-through per stock, so a "large-cap" fund
          holding US ADRs reports those as International here, not as
          Large. NN50 stocks count as 100% Large in the split (per the
          2026-07-27 convention). */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {assetAllocation.length > 0 && (
          <DonutCard
            title="Asset allocation"
            kicker="MF · NPS · EPF"
            data={assetAllocation}
            colors={ASSET_COLORS}
            total={totalNw}
            totalLabel="Total"
          />
        )}
        {mfComposition.length > 0 && (
          <DonutCard
            title="MF composition"
            kicker="Indian equity · Debt · International"
            data={mfComposition}
            colors={MF_COMPOSITION_COLORS}
            total={mfTotal}
            totalLabel="MF Total"
          />
        )}
        {indianEquityCapSplit.length > 0 && indianEquityTotal > 0 && (
          <DonutCard
            title="Indian equity cap split"
            kicker="Large · Mid · Small (NN50 counted as Large)"
            data={indianEquityCapSplit}
            colors={CAP_COLORS}
            total={indianEquityTotal}
            totalLabel="Indian equity"
          />
        )}
      </div>

      {/* HoldingsTable — sortable columns, "% of NW", and row click
          opens FundDetailsModal (same modal used by Fetch fund
          holdings on the Sync page) with the per-fund cap breakdown. */}
      <HoldingsTable funds={funds} mfTotal={mfTotal} />

      {/* A — Top 10 aggregated look-through positions. Answers "what
          are my actual biggest stock bets?" — a question the per-fund
          top-5 (inside HoldingsTable) can't answer. */}
      <TopStocksCard stocks={topStocks} />

      {/* 15.1 — Cross-fund overlap: which stocks are you holding via
          multiple funds. Interactive filter (2+/3+/4+/5+) with a
          punch-line headline stat above the table. */}
      <CrossFundOverlap stocks={crossFundOverlap} mfTotal={mfTotal} />

      {/* Full sector breakdown (tiled). Anchor id so the concentration
          strip's pill clicks can scroll here. Tiles are now clickable
          — each opens a modal listing every company in that sector
          with a "% of Sector" column. */}
      <div id="sector-exposure">
        <SectorExposure
          sectors={sectorExposure}
          stocksBySector={stocksBySector}
          mfTotal={mfTotal}
        />
      </div>
    </div>
  );
}
