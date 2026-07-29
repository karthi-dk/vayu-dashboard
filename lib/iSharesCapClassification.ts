/**
 * US cap-classification source (S&P 500 + Nasdaq 100)
 * ====================================================
 *
 * Fetches two iShares ETFs and builds an ISIN → index-membership map.
 * Every US-equity row in `master_security_classification` gets the same
 * `mcap_classification` value — literally "US" — while the finer-
 * grained SP500 / NASDAQ100 / SP500+NASDAQ100 detail lives in
 * `index_membership`.
 *
 *   IVV     (portfolioId 239726) — iShares Core S&P 500
 *   iShares Nasdaq 100 (351653)  — endpoint the user pointed us at
 *
 * Why "US" as the mcap value (not Large / Mid / SP500 / Nasdaq 100)
 * ----------------------------------------------------------------
 * India uses Large/Mid/Small/Micro/Nano because the user's Indian
 * exposure spans the whole market-cap curve — the 5-way split is
 * genuinely diagnostic. US exposure is much narrower (S&P 500 + a
 * Nasdaq 100 FoF), so a 5-way split would collapse to "Large: 518,
 * everything else empty" anyway. Per user 2026-07-18: "dont specify,
 * call it US, thats it." — one bucket for the "Cap" column, index
 * detail preserved separately for anyone who needs to filter by it.
 *
 * Why iShares, not FMP or Wikipedia
 * ---------------------------------
 * FMP's post-Aug-2025 free tier blocks constituent endpoints (402
 * Payment Required). SlickCharts / Wikipedia give tickers but no
 * ISIN — and our master's join column is ISIN, so ISIN-native sources
 * are strictly preferred. The iShares varnish API is unauthenticated,
 * refreshed daily by BlackRock's ETL, and ships ISIN + ticker + CUSIP
 * + SEDOL + sector + weight in one call.
 */

// ─── Types ────────────────────────────────────────────────────────────────

/**
 * Single-value bucket for US equities. Kept as a string-literal type
 * (not just `string`) so any callsite that switches on bucket values
 * gets exhaustive-check protection from tsc.
 */
export type UsCapBucket = "US";

/** Which index (or both) an ISIN was matched against. Empty if neither. */
export type UsIndexMembership = "" | "SP500" | "NASDAQ100" | "SP500+NASDAQ100";

export type UsClassification = {
  bucket: UsCapBucket;
  indexMembership: UsIndexMembership;
  rawSector: string;
};

export type IsharesUsSource = {
  sp500: Map<string, EtfRow>;
  nasdaq100: Map<string, EtfRow>;
  sourceCounts: {
    sp500: number;
    nasdaq100: number;
  };
  fetchedAt: string;
};

type EtfRow = {
  ticker: string | null;
  sector: string | null;
};

// ─── iShares varnish API ──────────────────────────────────────────────────

const PORTFOLIO_IDS = {
  sp500: 239726, // IVV — Core S&P 500
  nasdaq100: 351653, // iShares Nasdaq 100 (per user's URL)
} as const;

const REQUEST_HEADERS: HeadersInit = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "application/json",
};

function iSharesUrl(portfolioId: number): string {
  const params = new URLSearchParams({
    appSubType: "ISHARES",
    appType: "PRODUCT_PAGE",
    component: "holdings.all",
    locale: "en_US",
    portfolioId: String(portfolioId),
    targetSite: "us-ishares",
    userType: "individual",
    excludeContent: "true",
    includeConfig: "true",
  });
  return `https://www.ishares.com/varnish-api/blk-one01-product-data/product-data/api/v2/get-product-data?${params}`;
}

/**
 * The varnish API returns each holding column as a parallel array.
 * We pull isin + ticker + sectorName + secGroup and iterate them
 * together, dropping any non-EQUITY row (cash, futures, money-market
 * — every US ETF has a small tail of these).
 */
type VarnishResponse = {
  fundName?: string;
  componentsByNameMap?: {
    holdings?: {
      containersByNameMap?: {
        all?: {
          dataPointsByNameMap?: {
            isin?: { value?: (string | null)[] };
            ticker?: { value?: (string | null)[] };
            sectorName?: { value?: (string | null)[] };
            secGroup?: { value?: (string | null)[] };
          };
        };
      };
    };
  };
};

async function fetchEtfMap(portfolioId: number): Promise<Map<string, EtfRow>> {
  const res = await fetch(iSharesUrl(portfolioId), {
    headers: REQUEST_HEADERS,
    // Holdings roll over nightly — no benefit to any caching layer, and
    // no-store also side-steps Next.js/Vercel's fetch cache which would
    // happily serve last week's constituent list.
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`iShares portfolio ${portfolioId} → HTTP ${res.status}`);
  }
  const body = (await res.json()) as VarnishResponse;
  const dp =
    body.componentsByNameMap?.holdings?.containersByNameMap?.all
      ?.dataPointsByNameMap;
  const isins = dp?.isin?.value ?? [];
  const tickers = dp?.ticker?.value ?? [];
  const sectors = dp?.sectorName?.value ?? [];
  const secGroups = dp?.secGroup?.value ?? [];
  if (isins.length === 0) {
    throw new Error(
      `iShares portfolio ${portfolioId} returned no ISIN column — schema may have changed`
    );
  }

  const map = new Map<string, EtfRow>();
  for (let i = 0; i < isins.length; i++) {
    if (secGroups[i] && secGroups[i] !== "EQUITY") continue;
    const isin = isins[i];
    if (!isValidIsin(isin)) continue;
    map.set(isin, {
      ticker: tickers[i] ?? null,
      sector: sectors[i] ?? null,
    });
  }
  return map;
}

function isValidIsin(v: string | null | undefined): v is string {
  return !!v && v.length === 12 && /^[A-Z0-9]+$/.test(v);
}

/**
 * Fetch both indices in parallel. Any single failure aborts — better
 * to fail visibly than partially classify (partial map = every
 * missing constituent silently drops to no-index).
 */
export async function fetchIsharesUsSource(): Promise<IsharesUsSource> {
  const [sp500, nasdaq100] = await Promise.all([
    fetchEtfMap(PORTFOLIO_IDS.sp500),
    fetchEtfMap(PORTFOLIO_IDS.nasdaq100),
  ]);
  return {
    sp500,
    nasdaq100,
    sourceCounts: { sp500: sp500.size, nasdaq100: nasdaq100.size },
    fetchedAt: new Date().toISOString(),
  };
}

// ─── Classification ───────────────────────────────────────────────────────

/**
 * Every US ISIN gets the same bucket ("US"). What differentiates them
 * is `indexMembership` — which of the two target indices (or both, or
 * neither) they appear in. That column is what any UI slicer (e.g.,
 * "show me only my Nasdaq 100 exposure") should filter on.
 *
 * The sector column prefers S&P 500's taxonomy when both hit, because
 * IVV uses standard GICS while the Nasdaq 100 payload sometimes has
 * narrower Nasdaq-specific labels.
 */
export function classifyUsIsin(
  isin: string,
  src: IsharesUsSource
): UsClassification {
  const inSp = src.sp500.get(isin);
  const inNas = src.nasdaq100.get(isin);
  let indexMembership: UsIndexMembership;
  if (inSp && inNas) indexMembership = "SP500+NASDAQ100";
  else if (inSp) indexMembership = "SP500";
  else if (inNas) indexMembership = "NASDAQ100";
  else indexMembership = "";
  return {
    bucket: "US",
    indexMembership,
    rawSector: inSp?.sector ?? inNas?.sector ?? "",
  };
}
