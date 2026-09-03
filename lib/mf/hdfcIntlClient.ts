/**
 * lib/mf/hdfcIntlClient.ts
 *
 * Client for HDFC International (GIFT City / IFSC) USD funds — the
 * "invest globally" product line whose NAVs are published in US
 * Dollars, not INR. Powers the International asset class (see the
 * 2026-09-02-international-asset-class.sql migration).
 *
 * DATA SOURCE
 * -----------
 * A Drupal REST backend at cms.hdfcinternational.com. We use two
 * endpoints (reverse-engineered 2026-09-02):
 *
 *   • getHistoricalNavs (POST, multipart FormData) — the authoritative
 *     per-fund daily series. Returns EVERY published day in the range
 *     with all three NAV figures, so one call gives us both the latest
 *     mark AND the history for the period grid. This is the only
 *     endpoint we need — getNavs returns just the latest and is
 *     redundant.
 *
 * THE plan_type GOTCHA
 * --------------------
 * getHistoricalNavs requires fund_name + from_date + to_date + a field
 * confusingly named `plan_type` that actually holds the UNIT CLASS
 * ("Class A" / "Class B"), NOT "direct"/"regular". Passing "direct"
 * returns an empty (but HTTP 200) navs array; omitting any of the four
 * returns {code:400,"Missing required parameters"}. The fund_name must
 * match exactly, en-dash (U+2013) included.
 *
 * THREE NAVs
 * ----------
 * Each row carries purchase (subscription), redemption-long-term, and
 * redemption-short-term. We mark holdings at the PURCHASE NAV — the fund's
 * headline/subscription NAV, which is also the price your units were allotted
 * at (so invested_usd = units × purchase), giving a clean NAV-only USD return
 * with no bid/offer-spread artifact and matching the platform's stated
 * holding value. redemption-short-term is surfaced separately as the "exit
 * today" value (it embeds the ≤2% exit load that lapses 24 months after
 * allotment). For a days-old fund all three are currently equal; they diverge
 * once the fund seasons.
 *
 * CURRENCY
 * --------
 * This client returns USD figures only. USD→INR conversion (option A:
 * live/historical market rate) happens in the refresh route via lib/fx.
 */

import { istDate } from "@/lib/istDate";

const HISTORICAL_URL =
  "https://cms.hdfcinternational.com/hdfc/api/v1/investGlobally/getHistoricalNavs";

/**
 * Browser-shaped headers. The API isn't fingerprint-gated like Kotak's,
 * but the origin/referer pair keeps us aligned with how the real site
 * calls it. (The static offer-doc PDFs on the same host ARE Akamai-
 * blocked to non-browser clients; these /api endpoints are not.)
 */
const HDFC_HEADERS: Record<string, string> = {
  accept: "application/json",
  origin: "https://www.hdfcinternational.com",
  referer: "https://www.hdfcinternational.com/",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
};

/** One published day for a fund/class. All NAVs are in USD. */
export type HdfcIntlNavRow = {
  navDate: string; // ISO YYYY-MM-DD
  purchaseUsd: number; // subscription NAV — the mark (matches cost basis)
  redeemLongUsd: number; // gross redemption NAV (no exit load)
  redeemShortUsd: number; // exit-today NAV — embeds current exit load
};

/** A fund/class we track, keyed by our fund_holdings.fund_code. */
export type HdfcIntlFund = {
  fundCode: string;
  apiFundName: string; // exact getHistoricalNavs `fund_name`
  unitClass: string; // getHistoricalNavs `plan_type`: "Class A" (=Direct) / "Class B" (=Regular). API-only — the UI shows the Direct/Regular label.
  inceptionDate: string; // NFO/allotment date — the from_date floor
};

/**
 * Catalog of HDFC International holdings. Keyed by fund_code so the
 * refresh route can resolve a fund_holdings row → its API identity.
 * getFilters confirms HDFC Intl has exactly two funds, each Class A/B.
 */
export const HDFC_INTL_FUNDS: Record<string, HdfcIntlFund> = {
  HDFC_INTL_DM: {
    fundCode: "HDFC_INTL_DM",
    apiFundName: "HDFC International \u2013 Developed Markets Equity Fund",
    unitClass: "Class A", // = Direct plan (fund_holdings.fund_name shows "Direct")
    inceptionDate: "2026-08-27",
  },
};

type RawNav = {
  fund_name?: string;
  plan_type?: string;
  nav_date?: string;
  purchase_nav?: string | number;
  redemption_nav_long_term?: string | number;
  redemption_nav_short_term?: string | number;
};

/**
 * Fetch the daily USD NAV series for a fund/class between two ISO dates
 * (inclusive). Returns rows sorted ascending by date. An empty array
 * means the endpoint had no published days in the range (expected for a
 * brand-new fund) — that's not an error. Throws only on transport /
 * shape failures so the caller can decide whether to abort the refresh.
 */
export async function fetchHdfcIntlSeries(
  fund: HdfcIntlFund,
  fromDate: string,
  toDate: string
): Promise<HdfcIntlNavRow[]> {
  const fd = new FormData();
  fd.append("fund_name", fund.apiFundName);
  fd.append("plan_type", fund.unitClass); // ← the class, not direct/regular
  fd.append("from_date", fromDate);
  fd.append("to_date", toDate);

  const res = await fetch(HISTORICAL_URL, {
    method: "POST",
    headers: HDFC_HEADERS,
    body: fd,
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`getHistoricalNavs HTTP ${res.status} for ${fund.fundCode}`);
  }

  const json = (await res.json()) as {
    data?: { code?: number; message?: string; navs?: RawNav[] };
    code?: number;
  };
  const inner = json.data;
  if (!inner || inner.code !== 200) {
    // code 400 = "Missing required parameters" (a param-name regression).
    throw new Error(
      `getHistoricalNavs error for ${fund.fundCode}: ${inner?.message ?? "unexpected shape"}`
    );
  }

  const rows: HdfcIntlNavRow[] = [];
  for (const n of inner.navs ?? []) {
    const navDate = String(n.nav_date ?? "").slice(0, 10);
    const redeemLong = Number(n.redemption_nav_long_term);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(navDate) || !Number.isFinite(redeemLong) || redeemLong <= 0) {
      continue; // skip malformed rows rather than poison the series
    }
    const purchase = Number(n.purchase_nav);
    const redeemShort = Number(n.redemption_nav_short_term);
    rows.push({
      navDate,
      purchaseUsd: Number.isFinite(purchase) ? purchase : redeemLong,
      redeemLongUsd: redeemLong,
      // Fall back to the gross NAV when short-term isn't published — it
      // means no exit-load differential is being quoted yet.
      redeemShortUsd: Number.isFinite(redeemShort) && redeemShort > 0 ? redeemShort : redeemLong,
    });
  }

  rows.sort((a, b) => a.navDate.localeCompare(b.navDate));
  return rows;
}

/** The most recent row in a series (max nav_date), or null if empty. */
export function latestHdfcIntlNav(rows: HdfcIntlNavRow[]): HdfcIntlNavRow | null {
  return rows.length ? rows[rows.length - 1] : null;
}

/**
 * Convenience: pull a fund's full series from inception through today
 * (IST). Used by the refresh route; the wide range is cheap because the
 * fund only has a handful of published days.
 */
export function fetchHdfcIntlFull(fund: HdfcIntlFund): Promise<HdfcIntlNavRow[]> {
  return fetchHdfcIntlSeries(fund, fund.inceptionDate, istDate());
}
