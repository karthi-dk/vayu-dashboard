/**
 * POST /api/ingest-intl-holdings
 *
 * Ingests a pasted iShares Core MSCI World UCITS ETF holdings payload as
 * HDFC_INTL_DM's look-through — the "resync" this foreign fund can't get from
 * Dhan (Akamai-gated endpoint, can't be called server-side; see the paste
 * card for why). Matches ISINs against master_security_classification, inserts
 * any NEW constituents (auto-classified as foreign equity with their iShares
 * sector), then rewrites HDFC's fund_holdings_detail.
 *
 * Gated by the auth middleware like every other /api route.
 */
import { NextResponse } from "next/server";
import { sbServer } from "@/lib/supabase";
import { istDate } from "@/lib/istDate";
import { parseIsharesHoldings } from "@/lib/intl/isharesHoldings";

export const dynamic = "force-dynamic";

const FUND_CODE = "HDFC_INTL_DM";
const SOURCE = "ishares-msci-world";
// The pasted fund MUST be the MSCI World ETF HDFC DM tracks — guards against
// overwriting HDFC's look-through with some other ETF's holdings.
const EXPECTED_FUND_HINT = "MSCI World";
const CHUNK = 200;

export async function POST(req: Request) {
  const raw = await req.text();
  if (!raw.trim()) {
    return NextResponse.json(
      { ok: false, error: "Nothing pasted — paste the iShares holdings JSON." },
      { status: 400 }
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json(
      { ok: false, error: "That isn't valid JSON. Paste the full API response body." },
      { status: 400 }
    );
  }

  let parsed;
  try {
    parsed = parseIsharesHoldings(payload);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
  const { fundName, holdings, totalWeightPct, skippedNonEquity } = parsed;

  // ── Guards: wrong fund, or a partial/implausible payload ──
  if (!fundName || !fundName.includes(EXPECTED_FUND_HINT)) {
    return NextResponse.json(
      {
        ok: false,
        error: `Expected the ${EXPECTED_FUND_HINT} ETF, but this payload is "${fundName ?? "unknown"}". Aborted so HDFC's look-through isn't overwritten with the wrong fund.`,
      },
      { status: 400 }
    );
  }
  if (holdings.length < 100 || totalWeightPct < 50) {
    return NextResponse.json(
      {
        ok: false,
        error: `Only ${holdings.length} holdings / ${totalWeightPct.toFixed(1)}% weight parsed — looks partial or wrong. Aborted (nothing written).`,
      },
      { status: 400 }
    );
  }

  const asOf = istDate();

  // ── 1) Which ISINs already exist in master ──
  const uniqIsins = [...new Set(holdings.map((h) => h.isin))];
  const existing = new Set<string>();
  for (let i = 0; i < uniqIsins.length; i += CHUNK) {
    const { data, error } = await sbServer
      .from("master_security_classification")
      .select("isin")
      .in("isin", uniqIsins.slice(i, i + CHUNK));
    if (error) {
      return NextResponse.json({ ok: false, error: `master read failed: ${error.message}` }, { status: 500 });
    }
    (data ?? []).forEach((r: { isin: string }) => existing.add(r.isin));
  }

  // ── 2) Insert NEW constituents (dedupe by ISIN, ignore-duplicates on conflict) ──
  const newByIsin = new Map<string, IsharesRow>();
  for (const h of holdings) {
    if (existing.has(h.isin)) continue;
    const prev = newByIsin.get(h.isin);
    if (!prev || h.weightPct > prev.weightPct) newByIsin.set(h.isin, h);
  }
  const newRows = [...newByIsin.values()].map((h) => ({
    isin: h.isin,
    company_name: h.name,
    symbol: h.ticker || null,
    security_type: "Equity",
    holding_level: "Individual",
    // App models foreign equity via the region/mcap 'US' bucket (the fund modal
    // buckets Intl on region==='US' || mcap==='US'). True country is in notes;
    // these rows are excluded from the US cap tile by source in getSyncData.
    mcap_classification: "US",
    region: h.country === "United States" ? "US" : "International",
    country: h.country || null,
    index_membership: "MSCI World",
    raw_sector: h.sector || null,
    macro_economic_sector: h.sector || null,
    morningstar_secid: "",
    groww_slugs: "",
    confidence: "ishares-derived",
    source: SOURCE,
    notes: `MSCI World UCITS constituent (${h.country}); ingested ${asOf}`,
    last_updated: asOf,
  }));
  for (let i = 0; i < newRows.length; i += CHUNK) {
    const { error } = await sbServer
      .from("master_security_classification")
      .upsert(newRows.slice(i, i + CHUNK), { onConflict: "isin", ignoreDuplicates: true });
    if (error) {
      return NextResponse.json({ ok: false, error: `master insert failed: ${error.message}` }, { status: 500 });
    }
  }

  // ── 3) Rewrite HDFC's fund_holdings_detail (delete then insert) ──
  const detailRows = holdings.map((h) => ({
    fund_code: FUND_CODE,
    isin: h.isin,
    company_name: h.name,
    security_type: "Equity",
    weighting_pct: h.weightPct,
    portfolio_date: asOf,
    extracted_at: new Date().toISOString(),
  }));
  const del = await sbServer.from("fund_holdings_detail").delete().eq("fund_code", FUND_CODE);
  if (del.error) {
    return NextResponse.json({ ok: false, error: `detail delete failed: ${del.error.message}` }, { status: 500 });
  }
  for (let i = 0; i < detailRows.length; i += CHUNK) {
    const { error } = await sbServer.from("fund_holdings_detail").insert(detailRows.slice(i, i + CHUNK));
    if (error) {
      return NextResponse.json(
        { ok: false, error: `detail insert failed (HDFC detail now partial — re-run to fix): ${error.message}` },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({
    ok: true,
    fundName,
    asOf,
    equityHoldings: holdings.length,
    coveragePct: Number(totalWeightPct.toFixed(2)),
    existingMatched: existing.size,
    newMasterRows: newRows.length,
    skippedNonEquity,
  });
}

type IsharesRow = {
  isin: string;
  name: string;
  weightPct: number;
  sector: string;
  country: string;
  ticker: string;
};
