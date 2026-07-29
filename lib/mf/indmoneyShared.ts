/**
 * lib/mf/indmoneyShared.ts
 *
 * Small parsing primitives shared between INDmoney's two JSON shapes:
 *   • parseIndmoneyOrder.ts            — single order-detail (txnStatus) payload
 *   • parseIndmoneyTransactionsList.ts — bulk order-history list payload
 *
 * Split out on 2026-07-24 when the list parser needed the exact same
 * date parsing and fund-name matching the single-order parser already
 * had — keeping one copy means a fund added to FUND_ISIN only needs a
 * keyword entry added in one place.
 */

import { FUND_ISIN } from "@/lib/fundIsin";

const MONTH_MAP: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

/** Parses "23 Jul 2026" or "23 Jul 2026  02:50 AM" → "2026-07-23".
 *  Returns null if the string doesn't match the expected shape. */
export function parseIndmoneyDate(raw: string): string | null {
  const m = /^(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4})/.exec(raw.trim());
  if (!m) return null;
  const [, day, monAbbr, year] = m;
  const mon = MONTH_MAP[monAbbr.toLowerCase()];
  if (!mon) return null;
  return `${year}-${mon}-${day.padStart(2, "0")}`;
}

/** Parses "₹10,000" / "₹9999.50" / "₹0.50000" → 10000 / 9999.5 / 0.5.
 *  Returns null on anything that doesn't reduce to a finite number.
 *  NOT for the abbreviated "₹10K"/"₹2L" form used in the transactions
 *  list — see parseIndmoneyAbbreviatedAmount in parseIndmoneyTransactionsList.ts
 *  for that. */
export function parseIndmoneyAmount(raw: string): number | null {
  const cleaned = raw.replace(/[₹,\s]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Keyword fragments (lowercased) matched against INDmoney's free-text
 * fund name via substring search. Order-independent — verified no
 * fragment is a substring of another fund's fragment, so iteration
 * order doesn't matter today; keep that invariant in mind if a new
 * fund is ever added with an overlapping name (e.g. anything with
 * "nifty 50" in it needs to be checked against the NN50 fragment).
 */
export const FUND_NAME_KEYWORDS: Record<string, string[]> = {
  ICICI_NASDAQ: ["nasdaq"],
  PPFAS_FC: ["parag parikh flexi", "ppfas flexi"],
  PPFAS_CH: ["parag parikh conservative", "conservative hybrid"],
  HDFC_FC: ["hdfc flexi"],
  HDFC_SC: ["hdfc small cap"],
  HDFC_STD: ["hdfc short term"],
  UTI_N50: ["uti nifty 50"],
  UTI_NN50: ["nifty next 50"],
  NIPPON_MID: ["nippon", "growth mid cap"],
  EDEL_MID: ["edelweiss mid"],
};

export function matchFundCode(fundNameRaw: string): string | null {
  const norm = fundNameRaw.toLowerCase();
  for (const [code, keywords] of Object.entries(FUND_NAME_KEYWORDS)) {
    if (!FUND_ISIN[code]) continue; // guards against a stale keyword entry
    if (keywords.some((kw) => norm.includes(kw))) return code;
  }
  return null;
}
