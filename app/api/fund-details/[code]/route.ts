/**
 * GET /api/fund-details/[code]
 *
 * Returns everything needed to power the FundDetailsModal on the Sync page —
 * fund meta, ordered holdings, non-security breakdown, and sector aggregation.
 *
 * Kept as a client-fetched route rather than server-rendered into
 * getSyncData() so the ~150-row holdings payload per fund only loads when the
 * user actually opens a modal. Sync page initial load stays lean.
 */
import { NextResponse } from "next/server";
import { sbServer as sb } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type MasterRow = {
  isin: string;
  macro_economic_sector: string | null;
  mcap_classification: string | null;
  region: string | null;
  source: string | null;
};

/**
 * Per-fund cap breakdown returned to the FundDetailsModal.
 *
 * NN50 convention (2026-07-27): Nifty Next 50 stocks count as 100 %
 * Large — same treatment as Nifty 50. Previously a 75:25 (large:mid)
 * blend was applied; kept aligned with getPortfolioData()'s look-
 * through so per-fund and portfolio-total numbers still reconcile.
 *
 * Six buckets, in display order:
 *   large  — mcap=Large (includes both N50 and NN50 rows)
 *   mid    — mcap=Mid
 *   small  — mcap=Small ∪ Micro ∪ Nano
 *   intl   — region=US/International, or mcap=US
 *   debt   — Bonds (security_type=Debt) + Cash & Equivalents (from
 *            fund_non_security_holdings). Grouped because both are
 *            "fixed-income-ish, not equity" from the user's POV.
 *   reit   — security_type=REIT
 *   other  — Derivative/Hedge, Fund-of-Funds, Regulatory Reserve, and
 *            unclassified equity residuals. Only shown if > 0.5% so
 *            it doesn't clutter well-behaved funds.
 *
 * Values are weighting_pct — they sum to (approximately) the fund's
 * total coverage, which is usually close to 100%. `totalCoverage`
 * on the response is the actual sum; a value < 95% means there's
 * unmapped holdings the classification refresh should fix.
 */
type CapBreakdown = {
  large: number;
  mid: number;
  small: number;
  intl: number;
  debt: number;
  reit: number;
  other: number;
  totalCoverage: number;
  /**
   * Sub-splits inside the composite Debt bucket — surfaced so the
   * tooltip / detail row can show "Bonds 4.2% · Cash 1.1%" without a
   * second query.
   */
  bondsPct: number;
  cashPct: number;
};

/**
 * One row of the lot-level transaction ledger returned to the modal.
 * Union of `mf_contributions` (Groww) and `mf_transactions` (CAS).
 *
 * Common shape kept intentionally small — only what the modal renders.
 * Sortable by date; ties broken by source (CAS first, since it's the
 * settled/authoritative event on a given day).
 */
type FundTransactionRow = {
  id: string;              // order_id or tx_hash
  source: "groww" | "cas";
  date: string;            // YYYY-MM-DD
  type: string | null;     // Normalised uppercase order_type
  amount_inr: number | null;
  units: number | null;    // Signed: negative for redemption/switch_out
  nav: number | null;
  folio_number: string | null;
  status: string | null;   // Groww-only; null for CAS (implicit COMPLETED)
  description: string | null; // CAS raw description; null for Groww
};

/** Map CAS `tx_type` values to the Groww `order_type` vocabulary. Same
 *  logic as `lib/queries.ts:casTxTypeToOrderType` — kept local to
 *  avoid pulling `queries.ts` into an API route (it's already heavy
 *  with server-only imports; the route needs a lean footprint). */
function casTxTypeToOrderType(txType: string | null): string | null {
  switch (txType) {
    case "purchase":
      return "PURCHASE";
    case "redemption":
      return "REDEMPTION";
    case "switch_in":
      return "SWITCH_IN";
    case "switch_out":
      return "SWITCH_OUT";
    case "dividend":
      return "DIVIDEND";
    default:
      return null;
  }
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ code: string }> }
) {
  const { code } = await ctx.params;

  const [
    fundRes,
    holdingsRes,
    nonSecRes,
    diagRes,
    mfContribRes,
    mfTxRes,
  ] = await Promise.all([
    sb.from("fund_holdings").select("*").eq("fund_code", code).maybeSingle(),
    // security_type is needed for the cap-breakdown split: Equity vs
    // Debt (Bonds) vs REIT drives which bucket the holding goes into
    // before we even look at mcap.
    sb
      .from("fund_holdings_detail")
      .select("isin,company_name,security_type,weighting_pct,portfolio_date,extracted_at")
      .eq("fund_code", code)
      .order("weighting_pct", { ascending: false }),
    sb
      .from("fund_non_security_holdings")
      .select("category,weighting_pct,portfolio_date")
      .eq("fund_code", code)
      .order("weighting_pct", { ascending: false }),
    // Diagnostics are optional — if the migration hasn't been run yet in a
    // given environment, still return the modal-required fields.
    sb
      .from("fund_sync_diagnostics")
      .select("synced_at,unresolved,unknown_holding_types,data_warnings")
      .eq("fund_code", code)
      .maybeSingle(),
    // Transactions ledger — Groww side. Missing-migration errors
    // handled below by degrading to empty, same pattern as
    // getCreditsData.
    sb
      .from("mf_contributions")
      .select(
        "order_id,order_type,order_status,order_date,placed_at,completion_date,amount_inr,units,nav,folio_number"
      )
      .eq("fund_code", code)
      .order("order_date", { ascending: false }),
    // Transactions ledger — CAS side.
    sb
      .from("mf_transactions")
      .select(
        "tx_hash,tx_date,tx_type,amount,nav,units,folio_number,description_raw"
      )
      .eq("fund_code", code)
      .order("tx_date", { ascending: false }),
  ]);

  if (fundRes.error) return NextResponse.json({ error: fundRes.error.message }, { status: 500 });
  if (holdingsRes.error) return NextResponse.json({ error: holdingsRes.error.message }, { status: 500 });
  if (nonSecRes.error) return NextResponse.json({ error: nonSecRes.error.message }, { status: 500 });
  // diagRes.error is intentionally not thrown — see comment above
  if (diagRes.error) {
    console.warn("[fund-details] fund_sync_diagnostics unavailable:", diagRes.error.message);
  }
  // Ledger tables both degrade to empty on missing migration — they're
  // not required for the modal to render.
  if (mfContribRes.error) {
    const errCode = (mfContribRes.error as { code?: string }).code;
    if (errCode !== "42P01" && errCode !== "PGRST205") {
      return NextResponse.json({ error: mfContribRes.error.message }, { status: 500 });
    }
    console.warn("[fund-details] mf_contributions unavailable:", mfContribRes.error.message);
  }
  if (mfTxRes.error) {
    const errCode = (mfTxRes.error as { code?: string }).code;
    if (errCode !== "42P01" && errCode !== "PGRST205") {
      return NextResponse.json({ error: mfTxRes.error.message }, { status: 500 });
    }
    console.warn("[fund-details] mf_transactions unavailable:", mfTxRes.error.message);
  }
  if (!fundRes.data) return NextResponse.json({ error: `fund ${code} not found` }, { status: 404 });

  const holdings = holdingsRes.data ?? [];
  const nonSecurities = nonSecRes.data ?? [];

  // Sector aggregation: fetch master rows only for ISINs actually held by this
  // fund. Cheaper than pulling all 1630 master rows for every modal open.
  // Same fetch also feeds the new cap breakdown — we need mcap_classification,
  // region and source columns anyway.
  const isins = holdings.map((h) => h.isin);
  let master: MasterRow[] = [];
  if (isins.length > 0) {
    // Supabase caps `.in()` at ~1000 items and the URL length; a single fund's
    // holdings are always well under that, so no pagination needed here.
    const masterRes = await sb
      .from("master_security_classification")
      .select("isin,macro_economic_sector,mcap_classification,region,source")
      .in("isin", isins);
    if (masterRes.error) return NextResponse.json({ error: masterRes.error.message }, { status: 500 });
    master = (masterRes.data ?? []) as MasterRow[];
  }

  const masterByIsin = new Map(master.map((m) => [m.isin, m]));
  const sectorAgg: Record<string, { weighting_pct: number; count: number }> = {};
  let classifiedWeight = 0;
  let unclassifiedWeight = 0;
  for (const h of holdings) {
    const m = masterByIsin.get(h.isin);
    const sector = m?.macro_economic_sector;
    if (!sector) {
      unclassifiedWeight += h.weighting_pct;
      continue;
    }
    if (!sectorAgg[sector]) sectorAgg[sector] = { weighting_pct: 0, count: 0 };
    sectorAgg[sector].weighting_pct += h.weighting_pct;
    sectorAgg[sector].count += 1;
    classifiedWeight += h.weighting_pct;
  }
  const sectors = Object.entries(sectorAgg)
    .map(([name, s]) => ({
      name,
      weighting_pct: s.weighting_pct,
      count: s.count,
    }))
    .sort((a, b) => b.weighting_pct - a.weighting_pct);

  // ── Cap breakdown (L : M : S : Intl : Debt : REIT : Other) ──
  // Rules match the portfolio-wide donut so per-fund numbers roll up
  // cleanly. Applied per holding on this fund only.
  const cap: CapBreakdown = {
    large: 0,
    mid: 0,
    small: 0,
    intl: 0,
    debt: 0,
    reit: 0,
    other: 0,
    totalCoverage: 0,
    bondsPct: 0,
    cashPct: 0,
  };
  for (const h of holdings) {
    const w = h.weighting_pct;
    if (w <= 0) continue;

    // security_type gate: Debt bonds and REITs bypass mcap lookup —
    // they get their own buckets regardless of what master says.
    if (h.security_type === "Debt") {
      cap.debt += w;
      cap.bondsPct += w;
      continue;
    }
    if (h.security_type === "REIT") {
      cap.reit += w;
      continue;
    }

    // Everything else falls through as equity — look up master for
    // mcap classification. Unmapped equity → `other` bucket so it's
    // visible rather than silently dropped.
    const m = masterByIsin.get(h.isin);
    if (!m) {
      cap.other += w;
      continue;
    }
    if (m.region === "US" || m.region === "International" || m.mcap_classification === "US") {
      cap.intl += w;
      continue;
    }
    const mcap = m.mcap_classification;
    if (mcap === "Large") {
      // Both N50 and NN50 rows carry mcap_classification="Large" and
      // are counted 100 % Large here — matches getPortfolioData()'s
      // look-through. (2026-07-27 convention change from 75:25.)
      cap.large += w;
    } else if (mcap === "Mid") {
      cap.mid += w;
    } else if (mcap === "Small" || mcap === "Micro" || mcap === "Nano") {
      cap.small += w;
    } else {
      cap.other += w;
    }
  }
  // Non-security allocation: Cash & Equivalents rolls into Debt so
  // the composite bucket matches the user's "Debt (Bonds, Cash &
  // Equivalents)" definition. Everything else (hedges, FoF, regulatory
  // reserve) goes to Other.
  for (const n of nonSecurities) {
    const w = n.weighting_pct;
    if (w <= 0) continue;
    if (n.category === "Cash & Equivalents") {
      cap.debt += w;
      cap.cashPct += w;
    } else {
      cap.other += w;
    }
  }
  cap.totalCoverage =
    cap.large + cap.mid + cap.small + cap.intl + cap.debt + cap.reit + cap.other;

  // ── Transactions ledger (union of Groww + CAS for this fund) ──
  // Kept as a flat FundTransactionRow[] rather than a nested by-source
  // object because the modal wants a single chronological list.
  const contribRows =
    (mfContribRes.data ?? []) as Array<{
      order_id: string;
      order_type: string | null;
      order_status: string | null;
      order_date: string;
      placed_at: string | null;
      completion_date: string | null;
      amount_inr: number | string | null;
      units: number | string | null;
      nav: number | string | null;
      folio_number: string | null;
    }>;
  const txRows =
    (mfTxRes.data ?? []) as Array<{
      tx_hash: string;
      tx_date: string;
      tx_type: string | null;
      amount: number | string | null;
      nav: number | string | null;
      units: number | string | null;
      folio_number: string | null;
      description_raw: string | null;
    }>;
  const grownTx: FundTransactionRow[] = contribRows.map((r) => ({
    id: r.order_id,
    source: "groww",
    date: r.order_date,
    type: r.order_type,
    amount_inr: r.amount_inr == null ? null : Number(r.amount_inr),
    units: r.units == null ? null : Number(r.units),
    nav: r.nav == null ? null : Number(r.nav),
    folio_number: r.folio_number,
    status: r.order_status,
    description: null,
  }));
  const casTx: FundTransactionRow[] = txRows.map((r) => ({
    id: r.tx_hash,
    source: "cas",
    date: r.tx_date,
    type: casTxTypeToOrderType(r.tx_type),
    amount_inr: r.amount == null ? null : Number(r.amount),
    units: r.units == null ? null : Number(r.units),
    nav: r.nav == null ? null : Number(r.nav),
    folio_number: r.folio_number,
    status: null,
    description: r.description_raw,
  }));
  // Merge + sort DESC by date. Two tables are disjoint by construction
  // (CAS ingest deletes overlapping Groww rows in its window), so no
  // dedup is needed. Ties broken by source (CAS first — those are
  // already settled on their day).
  const transactions: FundTransactionRow[] = [...casTx, ...grownTx].sort(
    (a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      if (a.source !== b.source) return a.source === "cas" ? -1 : 1;
      return 0;
    }
  );

  // Aggregate totals for the modal header line — computed here so the
  // client doesn't have to loop the array. Purchases and redemptions
  // reported gross; net is easily derived by consumers if needed.
  const txStats = transactions.reduce(
    (acc, t) => {
      const amt = Math.abs(Number(t.amount_inr ?? 0));
      if (t.type === "PURCHASE") {
        acc.purchases += amt;
        acc.purchaseCount++;
      } else if (t.type === "REDEMPTION") {
        acc.redemptions += amt;
        acc.redemptionCount++;
      }
      return acc;
    },
    { purchases: 0, redemptions: 0, purchaseCount: 0, redemptionCount: 0 }
  );

  return NextResponse.json({
    fund: fundRes.data,
    holdings,
    nonSecurities,
    sectors,
    classifiedWeight,
    unclassifiedWeight,
    capBreakdown: cap,
    diagnostics: diagRes.data ?? null,
    transactions,
    txStats,
  });
}
