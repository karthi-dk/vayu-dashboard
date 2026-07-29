/**
 * lib/mf/parseIndmoneyTransactionsList.ts
 *
 * Parses INDmoney's bulk order-history payload — the response behind
 * the "Order History" / "Transactions" screen, listing every order
 * with its current status. Distinct from parseIndmoneyOrder.ts, which
 * parses ONE order's detail (txnStatus) screen.
 *
 * WHY THIS PARSER EXISTS SEPARATELY FROM THE ORDER-DETAIL ONE
 * ─────────────────────────────────────────────────────────────
 * Originally assumed (2026-07-24, earlier same day) that this list
 * payload was useless for ledger purposes because units always showed
 * as the placeholder "--". That's only true for orders still
 * IN-PROGRESS. Once an order settles, the SAME list entry updates to
 * something like:
 *
 *   "Subtitle2": "79.24 (Nav 126.20)"
 *
 * — i.e. exact units AND the NAV used, for every completed order, in
 * ONE bulk paste. That's a much better ingestion path than opening
 * each order's detail page individually (parseIndmoneyOrder.ts),
 * which remains useful for IN-PROGRESS orders where you want folio /
 * payment-mode detail before allotment completes.
 *
 * WHY THE "AMOUNT" FIELD HERE IS NOT TRUSTED AS THE LEDGER AMOUNT
 * ─────────────────────────────────────────────────────────────
 * `mf_transactions.tx_hash` is deterministic on
 * (fund_code, tx_date, tx_type, NET amount) — see lib/mf/logMfTx.ts.
 * Units are deliberately EXCLUDED from the hash because AMC-reported
 * units carry more decimal precision than any display ever shows, so
 * two independently-rounded unit figures for the same real trade would
 * hash differently and defeat dedup.
 *
 * This list's "Amount" field (Subtitle3) is abbreviated for display —
 * "₹10K", "₹2K" — which is lossy in the OTHER direction: a real order
 * of ₹9,876 could just as easily round-display as "₹10K". Meanwhile
 * units×NAV (79.24 × 126.20 ≈ ₹9,999.69) is close to the true net
 * amount but ALSO imprecise, because the units figure itself is
 * display-rounded to 2dp (verified: for order 74974058, the order-
 * detail screen's exact net-buy-amount was ₹9,999.50, while this
 * list's rounded units×NAV back-computes to ₹9,999.69 — a ~₹0.19
 * drift purely from 2dp rounding, nothing wrong on either side).
 *
 * Feeding either number blindly into the SAME hash formula the order-
 * detail path uses risks silently creating a SECOND ledger row for a
 * trade you already logged via the detail-page path (or vice versa),
 * since the hash would differ by a few paise. So this parser reports
 * BOTH numbers (parsedAmount from the abbreviation, netFromUnits from
 * units×NAV) and leaves the FINAL amount as an editable field in the
 * UI — a human confirms it once, using whichever of the two looks
 * more precise for that row (or their own memory of the real amount),
 * rather than the parser silently guessing.
 */

import { parseIndmoneyDate, matchFundCode } from "@/lib/mf/indmoneyShared";

export type IndmoneyListOutcome =
  | "successful"
  | "cancelled"
  | "failed"
  | "in_progress"
  | "unknown";

export type ParsedIndmoneyListItem = {
  txn_id: string | null;
  fund_code: string | null;
  fund_name_raw: string;
  order_date: string | null; // YYYY-MM-DD
  tx_type: "purchase" | "redemption";
  outcome: IndmoneyListOutcome;
  raw_status: string;
  units: number | null; // null until allotted (in-progress) or unparseable
  nav: number | null;
  /** Best-effort exact reading of the abbreviated "Amount" field —
   *  null if the suffix wasn't a recognized K/L/Cr form. */
  parsed_amount: number | null;
  /** units × nav, rounded to paise — an approximation of the NET
   *  (post-stamp-duty) amount, only available once units/nav are known. */
  net_from_units: number | null;
};

export type ParseListResult =
  | { ok: true; items: ParsedIndmoneyListItem[] }
  | { ok: false; error: string };

/**
 * Parses INDmoney's abbreviated amount display: "₹10K", "₹2.5L",
 * "₹1Cr", or a plain "₹12,345" with no suffix. Returns null for
 * anything that doesn't match — deliberately conservative, since a
 * wrong guess here would silently mis-seed the editable amount field.
 */
function parseAbbreviatedAmount(raw: string): number | null {
  const cleaned = raw.replace(/[₹,\s]/g, "");
  const m = /^([\d.]+)(K|L|Cr)?$/i.exec(cleaned);
  if (!m) return null;
  const num = Number(m[1]);
  if (!Number.isFinite(num)) return null;
  const suffix = m[2]?.toUpperCase();
  const multiplier = suffix === "K" ? 1_000 : suffix === "L" ? 100_000 : suffix === "CR" ? 10_000_000 : 1;
  return num * multiplier;
}

/** Parses "79.24 (Nav 126.20)" → { units: 79.24, nav: 126.20 }.
 *  Returns nulls for the placeholder "--" or any unrecognized shape
 *  (e.g. still in-progress, so units aren't allotted yet). */
function parseUnitsAndNav(raw: string): { units: number | null; nav: number | null } {
  const m = /^([\d,]+\.?\d*)\s*\(\s*nav\s*([\d,]+\.?\d*)\s*\)/i.exec(raw.trim());
  if (!m) return { units: null, nav: null };
  const units = Number(m[1].replace(/,/g, ""));
  const nav = Number(m[2].replace(/,/g, ""));
  return {
    units: Number.isFinite(units) ? units : null,
    nav: Number.isFinite(nav) ? nav : null,
  };
}

function classifyOutcome(status: string): IndmoneyListOutcome {
  const s = status.toLowerCase();
  if (s.includes("successful")) return "successful";
  if (s.includes("cancelled")) return "cancelled";
  if (s.includes("failed")) return "failed";
  if (s.includes("progress")) return "in_progress";
  return "unknown";
}

function classifyTxType(status: string): "purchase" | "redemption" {
  return /sell/i.test(status) ? "redemption" : "purchase";
}

type Card = {
  TxnID?: unknown;
  FundName?: unknown;
  Subtitle1?: unknown; // Order Date
  Subtitle2?: unknown; // Units (Nav ...) or "--"
  Subtitle3?: unknown; // Amount (abbreviated)
  Status?: unknown;
};

export function parseIndmoneyTransactionsList(raw: string): ParseListResult {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }

  const txns = (payload as { data?: { transactions?: unknown } })?.data?.transactions;
  if (!Array.isArray(txns)) {
    return { ok: false, error: 'No "data.transactions" array found — is this the order-history list payload?' };
  }

  const items: ParsedIndmoneyListItem[] = [];
  for (const entry of txns) {
    const cards = (entry as { Cards?: unknown })?.Cards;
    if (!Array.isArray(cards)) continue;
    for (const c of cards as Card[]) {
      const fundNameRaw = typeof c.FundName === "string" ? c.FundName : "";
      const status = typeof c.Status === "string" ? c.Status : "";
      const { units, nav } = typeof c.Subtitle2 === "string" ? parseUnitsAndNav(c.Subtitle2) : { units: null, nav: null };
      const netFromUnits = units != null && nav != null ? Math.round(units * nav * 100) / 100 : null;

      items.push({
        txn_id: typeof c.TxnID === "string" ? c.TxnID : null,
        fund_code: fundNameRaw ? matchFundCode(fundNameRaw) : null,
        fund_name_raw: fundNameRaw,
        order_date: typeof c.Subtitle1 === "string" ? parseIndmoneyDate(c.Subtitle1) : null,
        tx_type: classifyTxType(status),
        outcome: classifyOutcome(status),
        raw_status: status,
        units,
        nav,
        parsed_amount: typeof c.Subtitle3 === "string" ? parseAbbreviatedAmount(c.Subtitle3) : null,
        net_from_units: netFromUnits,
      });
    }
  }

  if (items.length === 0) {
    return { ok: false, error: "Found a transactions array but no parseable entries in it." };
  }
  return { ok: true, items };
}
