/**
 * Pure parser for the iShares "get-product-data" holdings.all payload
 * (the JSON behind an ETF's holdings table, e.g. the Core MSCI World UCITS
 * ETF that HDFC GIFT City tracks). Shared by the paste-card API route and
 * the standalone ingest script so the parsing rules live in one place.
 *
 * The payload is COLUMNAR: each field under dataPointsByNameMap is a
 * parallel array (dp.isin.value[i], dp.holdingPercent.value[i], …). Only
 * equity rows with a real ISIN and positive weight are kept — cash, FX,
 * futures, money-market and other non-security lines are dropped (they
 * become the small uncovered residual, never misclassified as a stock).
 */

export type IsharesHolding = {
  isin: string;
  name: string;
  weightPct: number;
  sector: string;
  country: string;
  ticker: string;
};

export type IsharesHoldingsParse = {
  fundName: string | null;
  holdings: IsharesHolding[];
  totalWeightPct: number;
  skippedNonEquity: number;
  skippedNoIsin: number;
};

type DataPoint = { value?: unknown[] };
type Payload = {
  fundName?: unknown;
  componentsByNameMap?: {
    holdings?: {
      containersByNameMap?: {
        all?: { dataPointsByNameMap?: Record<string, DataPoint> };
      };
    };
  };
};

/** Coerce a columnar cell (plain number or `{value}` object) to a number. */
function toNum(v: unknown): number {
  if (typeof v === "object" && v != null) {
    return Number((v as { value?: unknown }).value ?? 0);
  }
  return Number(v ?? 0);
}

export function parseIsharesHoldings(payload: unknown): IsharesHoldingsParse {
  const p = payload as Payload;
  const dp =
    p?.componentsByNameMap?.holdings?.containersByNameMap?.all?.dataPointsByNameMap;
  if (!dp || typeof dp !== "object") {
    throw new Error(
      "This doesn't look like an iShares holdings response — expected " +
        "componentsByNameMap.holdings.containersByNameMap.all.dataPointsByNameMap. " +
        "Paste the full JSON body from the get-product-data (component=holdings.all) call."
    );
  }

  const col = (k: string): unknown[] =>
    Array.isArray(dp[k]?.value) ? (dp[k]!.value as unknown[]) : [];
  const isin = col("isin"),
    name = col("issueName"),
    pct = col("holdingPercent"),
    sec = col("sectorName"),
    ctry = col("countryOfRisk"),
    tkr = col("ticker"),
    ac = col("assetClass");

  const holdings: IsharesHolding[] = [];
  let skippedNonEquity = 0;
  let skippedNoIsin = 0;

  for (let i = 0; i < isin.length; i++) {
    const id = String(isin[i] ?? "").trim();
    if (!id) {
      skippedNoIsin++;
      continue;
    }
    if (String(ac[i] ?? "") !== "Equity") {
      skippedNonEquity++;
      continue;
    }
    const w = toNum(pct[i]);
    if (!(w > 0)) continue;
    holdings.push({
      isin: id,
      name: String(name[i] ?? "").trim(),
      weightPct: w,
      sector: String(sec[i] ?? "").trim(),
      country: String(ctry[i] ?? "").trim(),
      ticker: String(tkr[i] ?? "").trim(),
    });
  }

  const totalWeightPct = holdings.reduce((s, h) => s + h.weightPct, 0);
  return {
    fundName: typeof p.fundName === "string" ? p.fundName : null,
    holdings,
    totalWeightPct,
    skippedNonEquity,
    skippedNoIsin,
  };
}
