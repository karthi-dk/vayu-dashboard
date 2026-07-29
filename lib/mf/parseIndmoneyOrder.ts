/**
 * lib/mf/parseIndmoneyOrder.ts
 *
 * Extracts a purchase/redemption's key facts (fund, amount, order date,
 * NAV date, folio, payment mode) out of INDmoney's order-status ("txn
 * status") page payload — the response you get by opening a specific
 * order's detail screen.
 *
 * WHY THIS IS A LABEL-MATCHING PARSER, NOT A SCHEMA PARSER
 * ──────────────────────────────────────────────────────────
 * INDmoney's payload is a server-driven-UI (SDUI) widget tree meant to
 * render their own app screen — colors, fonts, CTA configs, bottomsheet
 * definitions, nav bars — none of that is a stable data contract. The
 * one genuinely useful part is a `field_list` array of
 * `{ label: { text }, value: { text } }` rows deep inside a
 * `transaction_status_widget_v2` widget, e.g.:
 *
 *   { label: { text: "NAV Date" }, value: { text: "23 Jul 2026" } }
 *
 * Rather than hardcoding the exact widget path (which INDmoney can
 * reshuffle in any app update without notice — it's UI layout, not
 * an API version they owe stability on), this walks the ENTIRE JSON
 * tree looking for anything matching that { label, value } shape and
 * indexes it by the label's *text* — a human-facing string ("NAV Date",
 * "Buy Amount", "Folio"...) that's far more likely to stay stable than
 * a widgetId or nesting depth, since changing it would also change what
 * INDmoney's own users see on screen.
 *
 * VERIFIED 2026-07-24 against a real order-detail payload (Edelweiss
 * Mid Cap, order 74974058) — see chat log for the full JSON this was
 * built against.
 */

import {
  parseIndmoneyDate,
  parseIndmoneyAmount,
  matchFundCode,
} from "@/lib/mf/indmoneyShared";

export type ParsedIndmoneyOrder = {
  fund_code: string | null; // null if no confident keyword match — caller must ask user to pick
  fund_name_raw: string | null;
  tx_type: "purchase" | "redemption";
  gross_amount: number | null; // "Buy Amount" / "Sell Amount" — pre-stamp-duty
  order_date: string | null; // YYYY-MM-DD
  nav_date: string | null; // YYYY-MM-DD
  nav_date_differs: boolean; // true if nav_date !== order_date
  folio: string | null;
  payment_mode: string | null;
  order_id: string | null;
  holding_type: string | null; // "Physical" (SOA) or "Demat"
  /** Labels we recognized but couldn't confidently use — surfaced so the
   *  UI can show "found X, Y, Z but couldn't determine <thing>" instead
   *  of a flat failure. */
  warnings: string[];
};

/** A field_list row shape: { label: { text }, value: { text } }. */
type LabelValueRow = { label?: { text?: unknown }; value?: { text?: unknown } };

function isLabelValueRow(node: unknown): node is LabelValueRow {
  if (node == null || typeof node !== "object") return false;
  const obj = node as Record<string, unknown>;
  const label = obj.label as { text?: unknown } | undefined;
  const value = obj.value as { text?: unknown } | undefined;
  return (
    !!label &&
    typeof label === "object" &&
    typeof label.text === "string" &&
    !!value &&
    typeof value === "object" &&
    typeof value.text === "string"
  );
}

/** Recursively walks the entire payload collecting every { label, value }
 *  row found anywhere, keyed by lowercased label text. Later matches for
 *  the same label overwrite earlier ones — fine here since a well-formed
 *  order-detail payload only has one field_list. */
function collectFieldList(node: unknown, out: Map<string, string>): void {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectFieldList(item, out);
    return;
  }
  if (isLabelValueRow(node)) {
    out.set(
      String(node.label!.text).trim().toLowerCase(),
      String(node.value!.text).trim()
    );
  }
  for (const key of Object.keys(node as Record<string, unknown>)) {
    collectFieldList((node as Record<string, unknown>)[key], out);
  }
}

/** Best-effort search for the fund's display name, independent of the
 *  field_list rows (fund name lives in page_event_props.fund_name, or in
 *  a widget's title text — neither is a field_list row). Tries the
 *  known, stable top-level location first, then falls back to scanning
 *  every string in the payload for a fund-keyword match. */
function findFundNameRaw(payload: unknown): string | null {
  const asObj = payload as { data?: { page_event_props?: { fund_name?: unknown } } };
  const direct = asObj?.data?.page_event_props?.fund_name;
  if (typeof direct === "string" && direct.trim() !== "") return direct;

  // Fallback: walk every string value in the tree, return the first one
  // that matches a known fund keyword. Deliberately last-resort — this
  // is O(payload size) and can false-positive on an unrelated string
  // that happens to contain a keyword (e.g. a help-article title).
  let found: string | null = null;
  function walk(node: unknown) {
    if (found || node == null) return;
    if (typeof node === "string") {
      if (matchFundCode(node)) found = node;
      return;
    }
    if (typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    for (const key of Object.keys(node as Record<string, unknown>)) {
      walk((node as Record<string, unknown>)[key]);
    }
  }
  walk(payload);
  return found;
}

export function parseIndmoneyOrderJson(raw: string): ParsedIndmoneyOrder {
  const warnings: string[] = [];

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    return {
      fund_code: null,
      fund_name_raw: null,
      tx_type: "purchase",
      gross_amount: null,
      order_date: null,
      nav_date: null,
      nav_date_differs: false,
      folio: null,
      payment_mode: null,
      order_id: null,
      holding_type: null,
      warnings: [
        `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
      ],
    };
  }

  const fields = new Map<string, string>();
  collectFieldList(payload, fields);

  const fundNameRaw = findFundNameRaw(payload);
  const fundCode = fundNameRaw ? matchFundCode(fundNameRaw) : null;
  if (fundNameRaw && !fundCode) {
    warnings.push(
      `Couldn't match fund name "${fundNameRaw}" to a known fund_code — select it manually.`
    );
  } else if (!fundNameRaw) {
    warnings.push("Couldn't find a fund name anywhere in the payload.");
  }

  let txType: "purchase" | "redemption" = "purchase";
  let grossAmount: number | null = null;
  for (const [label, value] of fields) {
    if (label.startsWith("buy amount")) {
      txType = "purchase";
      grossAmount = parseIndmoneyAmount(value);
    } else if (label.startsWith("sell amount") || label.startsWith("redeem amount")) {
      txType = "redemption";
      grossAmount = parseIndmoneyAmount(value);
    }
  }
  if (grossAmount == null) {
    warnings.push('No "Buy Amount" / "Sell Amount" row found.');
  }

  let orderDateRaw: string | null = null;
  let navDateRaw: string | null = null;
  let folio: string | null = null;
  let paymentMode: string | null = null;
  let orderId: string | null = null;
  let holdingType: string | null = null;
  for (const [label, value] of fields) {
    if (label.startsWith("order date")) orderDateRaw = value;
    else if (label.startsWith("nav date")) navDateRaw = value;
    else if (label.startsWith("folio")) folio = value;
    else if (label.startsWith("payment mode")) paymentMode = value;
    else if (label.startsWith("order id")) orderId = value;
    else if (label.startsWith("holding type")) holdingType = value;
  }

  const orderDate = orderDateRaw ? parseIndmoneyDate(orderDateRaw) : null;
  const navDate = navDateRaw ? parseIndmoneyDate(navDateRaw) : null;
  if (orderDateRaw && !orderDate) {
    warnings.push(`Found "Order Date" but couldn't parse "${orderDateRaw}".`);
  }
  if (navDateRaw && !navDate) {
    warnings.push(`Found "NAV Date" but couldn't parse "${navDateRaw}".`);
  }
  if (!orderDate) warnings.push('No "Order Date" row found.');
  if (!navDate) warnings.push('No "NAV Date" row found.');

  return {
    fund_code: fundCode,
    fund_name_raw: fundNameRaw,
    tx_type: txType,
    gross_amount: grossAmount,
    order_date: orderDate,
    nav_date: navDate,
    nav_date_differs: !!orderDate && !!navDate && orderDate !== navDate,
    folio,
    payment_mode: paymentMode,
    order_id: orderId,
    holding_type: holdingType,
    warnings,
  };
}
