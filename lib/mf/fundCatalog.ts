/**
 * lib/mf/fundCatalog.ts
 *
 * Client-safe catalog helpers for MF funds — the subset of exports
 * that browser code (dropdowns, pickers) needs from the wider MF
 * helper family in `lib/mf/logMfTx.ts`.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * `logMfTx.ts` mixes helpers that are safe on both runtimes (fund
 * code list, scheme-code lookup) with helpers that pull in
 * server-only APIs (`node:crypto` for `computeMfTxHash`,
 * server-side fetch cache semantics in `fetchNavForDate`).
 * Webpack's tree-shaker sees the `node:crypto` import at
 * module-eval time regardless of which named exports the client
 * actually reads, so a client component like OrderEntryLanding
 * pulling `knownFundCodes` from logMfTx.ts fails at build time
 * with `Reading from "node:crypto" is not handled`.
 *
 * The fix is a strict separation: this file has ZERO node imports.
 * Server code that needs the same catalog can import from either
 * this file or logMfTx.ts (logMfTx.ts's copies now re-export
 * from here to keep one source of truth).
 */

import { FUND_ISIN, SCHEME_CODE_TO_FUND } from "@/lib/fundIsin";

const FUND_TO_SCHEME_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(SCHEME_CODE_TO_FUND).map(([code, fund]) => [fund, code])
);

/**
 * Reverse fund_code → AMFI scheme code. Returns null for unknown
 * fund codes so callers can validate before hitting mfapi.in.
 */
export function schemeCodeForFund(fundCode: string): string | null {
  return FUND_TO_SCHEME_CODE[fundCode] ?? null;
}

/** All known fund codes — used to populate manual-entry dropdowns. */
export function knownFundCodes(): string[] {
  return Object.keys(FUND_ISIN).sort();
}
