/**
 * lib/mf/logMfTx.ts
 *
 * Helper for the "Log MF transaction" flow — used when an MF purchase
 * happens OUTSIDE Groww (e.g., an ICICI Prudential direct-AMC SIP into
 * ICICI_NASDAQ, or any other AMC's own app) and therefore doesn't show
 * up in `mf_contributions` (Groww ledger).
 *
 * The manual entry writes directly to `mf_transactions` — the same
 * table CAS ingestion writes to — so the dashboard's fetch-time
 * dedup (CAS wins over Groww) still works when the CAS eventually
 * reflects the same transaction on a later re-paste.
 *
 * ── ALIGNMENT WITH FUTURE CAS RE-PASTES ────────────────────────────
 * The `tx_hash` here is deterministic on a natural fingerprint
 * (fund_code, tx_date, tx_type, amount rounded to paisa, units rounded
 * to 4 dp). Any future CAS parser that uses the same formula will
 * produce the same hash for the same trade — the DB upsert on
 * `tx_hash` then collapses the manual row and the CAS row into one.
 *
 * IMPORTANT: If the historical CAS parser is ever restored, it MUST
 * use `computeMfTxHash` from this file (not a locally reinvented
 * formula) or add a "delete rows in date window before upsert" step,
 * or manual rows will sit alongside CAS rows for the same trade.
 * See lib/queries.ts fetchMfLedger dedup logic for the safety-net
 * that catches this at read time even if the DB isn't perfectly
 * merged.
 */

import { createHash } from "node:crypto";

/**
 * Fund-catalog helpers used to live here directly. Extracted to
 * lib/mf/fundCatalog.ts (which has zero node imports) so client
 * components can consume them without dragging node:crypto into
 * the browser bundle. Re-exported here so every server-side call
 * site that used `import { knownFundCodes } from "@/lib/mf/logMfTx"`
 * still works unchanged.
 */
export { schemeCodeForFund, knownFundCodes } from "@/lib/mf/fundCatalog";

/** Marker in `mf_transactions.source` for user-logged rows. Distinct
 * from `mfcentral_cas` so a future CAS ingest can identify (and
 * optionally sweep) manual rows if it decides to. */
export const MANUAL_TX_SOURCE = "manual";

/** SEBI 2020 stamp-duty rate on MF purchases: 0.005% of purchase
 * value. Applied to purchase and switch_in only; NOT redemption or
 * switch_out. Rounds to nearest paisa. */
const STAMP_DUTY_RATE = 0.00005;

/**
 * Deterministic idempotency hash for an MF transaction row.
 *
 * Canonical form (no source_ref):
 *   `fund_code|tx_date|tx_type|amount_paise`
 *
 * Extended form (source_ref present):
 *   `fund_code|tx_date|tx_type|amount_paise|source_ref`
 *
 * The extended form is used whenever the caller has an upstream unique
 * identifier for the trade — INDmoney TxnID today, potentially any
 * future broker or AMC platform that carries a per-order ID. Rows
 * without an upstream ID (hand-typed manual entries, CAS ingest) use
 * the short 4-tuple form so cross-source dedup between manual and
 * CAS still works (both would produce the same hash for the same
 * real-world trade).
 *
 * WHY UNITS ARE INTENTIONALLY EXCLUDED
 * ────────────────────────────────────
 * The AMC's actual allotted units differ from a naive `amount / nav`
 * calculation by ~1 milli-unit because the AMC's internal NAV
 * precision extends beyond CAS's 4-dp reporting (verified 2026-07-22
 * against existing ICICI_NASDAQ CAS rows: our computed 411.1173 vs
 * CAS-reported 411.118 for the same 2 Jul 2026 SIP). Hashing on units
 * would make a manual row and its eventual CAS counterpart produce
 * different hashes for the same real-world trade — defeating the
 * whole point of the deterministic hash.
 *
 * WHY SOURCE_REF IS CONDITIONALLY INCLUDED
 * ────────────────────────────────────────
 * Two DISTINCT INDmoney orders on the same day for the same fund at
 * the same rupee amount are legitimate (a lumpsum stacked on top of
 * a recurring instalment, for instance). Both come from INDmoney with
 * their own TxnIDs, so both belong in the ledger as separate rows.
 * Under the pre-fix 4-tuple hash they collapsed to one row via the
 * (source, tx_hash) unique constraint; the second upsert would
 * silently overwrite the first, losing one order's identity.
 *
 * Including source_ref in the hash when present makes the two
 * hashes differ (different TxnIDs → different hashes → both rows
 * survive). At the same time it preserves:
 *   • Re-paste idempotency — same TxnID → same hash → collapses.
 *     Plus the (source, source_ref) unique index catches this even
 *     earlier, in the strong-key check before hash computation.
 *   • Cross-source CAS↔manual dedup — CAS rows have no source_ref
 *     so they use the short form; hand-typed manual entries also
 *     omit source_ref by convention. Both hash identically for the
 *     same trade → collapse via upsert as before. The (source,
 *     tx_hash) constraint is compound with source, so a CAS row
 *     (source='mfcentral_cas') and a manual row (source='manual')
 *     never collide directly at write time regardless — that fold
 *     happens in the read-time fingerprint dedup in fetchMfLedger.
 *
 * Backwards compatibility: existing rows keep their old (short-
 * form) hashes on disk. Re-pastes of already-ingested INDmoney
 * orders short-circuit via the source_ref strong-key check BEFORE
 * hash computation, so the recomputed extended-form hash never
 * gets compared against the on-disk short-form hash.
 *
 * Rounding:
 *   • amount → paise (integer, no float drift)
 */
export function computeMfTxHash(input: {
  fund_code: string;
  tx_date: string;
  tx_type: string;
  amount: number;
  /** Upstream unique identifier (e.g. INDmoney TxnID). When present,
   *  gets appended to the canonical string so two distinct orders
   *  with otherwise-identical fund/date/type/amount don't collapse. */
  source_ref?: string | null;
}): string {
  const parts = [
    input.fund_code.toUpperCase(),
    input.tx_date,
    input.tx_type.toLowerCase(),
    Math.round(input.amount * 100).toString(),
  ];
  const trimmedRef = input.source_ref?.trim();
  if (trimmedRef != null && trimmedRef !== "") {
    parts.push(trimmedRef);
  }
  return createHash("md5").update(parts.join("|")).digest("hex");
}

/**
 * SEBI stamp duty for a purchase amount. Returns 0 for non-purchase
 * transaction types (redemption / switch_out). Rounded to paisa.
 *
 * For ₹10,000 → ₹0.50. For ₹5,000 → ₹0.25. For ₹1,000 → ₹0.05.
 * Matches the pattern in existing CAS-imported rows where a ₹10,000
 * purchase shows `amount: 9999.50` (net of the ₹0.50 duty).
 */
export function stampDutyForPurchase(
  grossAmount: number,
  txType: string
): number {
  if (txType !== "purchase" && txType !== "switch_in") return 0;
  return Math.round(grossAmount * STAMP_DUTY_RATE * 100) / 100;
}

/** Result of a NAV lookup, or a structured error the caller can
 *  render without leaking network/parse details to the user. */
export type NavLookupResult =
  | {
      ok: true;
      nav: number;
      /** The date the NAV was actually published on. May be earlier
       *  than the requested date if the request landed on a
       *  weekend/holiday — we walk back to the nearest published
       *  NAV, mirroring how CAS/AMC systems record the "NAV that
       *  was applied to your purchase". */
      nav_date: string;
      scheme_name: string;
    }
  | { ok: false; error: string };

/**
 * Fetch the NAV that would have been applied to a purchase on
 * `targetDate`. Uses mfapi.in's full-history endpoint and walks back
 * to the nearest published NAV on or before the target — which is
 * how AMFI/AMC/CAS systems treat weekend/holiday-dated SIPs.
 *
 * Returns a structured result so the API/action layer can surface
 * meaningful failures ("mfapi.in returned no data for this scheme"
 * vs. "no NAV published on or before that date").
 */
export async function fetchNavForDate(
  schemeCode: string,
  targetDate: string
): Promise<NavLookupResult> {
  const url = `https://api.mfapi.in/mf/${schemeCode}`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { "User-Agent": "vayu-dashboard/1.0" },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return {
      ok: false,
      error: `mfapi.in fetch failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  if (!resp.ok) {
    return { ok: false, error: `mfapi.in HTTP ${resp.status}` };
  }
  let payload: unknown;
  try {
    payload = await resp.json();
  } catch (err) {
    return {
      ok: false,
      error: `mfapi.in returned non-JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  const p = payload as {
    status?: string;
    data?: Array<{ date: string; nav: string }>;
    meta?: { scheme_name?: string };
  };
  if (p.status !== "SUCCESS" || !Array.isArray(p.data)) {
    return {
      ok: false,
      error: `mfapi.in returned status="${p.status ?? "unknown"}"`,
    };
  }
  const schemeName = p.meta?.scheme_name ?? "";
  // mfapi.in returns newest-first; walk to find target date or
  // nearest earlier. First hit ≤ target wins.
  for (const row of p.data) {
    const parts = String(row.date).split("-");
    if (parts.length !== 3) continue;
    const [d, m, y] = parts;
    const iso = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    if (iso <= targetDate) {
      const nav = Number(row.nav);
      if (Number.isFinite(nav) && nav > 0) {
        return { ok: true, nav, nav_date: iso, scheme_name: schemeName };
      }
    }
  }
  return {
    ok: false,
    error: `No NAV published on or before ${targetDate}`,
  };
}
