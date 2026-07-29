/**
 * fund_code → scheme ISIN. Single source of truth for Dhan resync AND
 * for reverse-mapping Groww/mfapi/etc. responses back to our internal
 * fund_code space.
 *
 * Kept in lockstep with scripts/fetch_dhan_funds.py FUND_ISIN.
 */
export const FUND_ISIN: Record<string, string> = {
  PPFAS_FC: "INF879O01027",
  PPFAS_CH: "INF879O01175",
  HDFC_FC: "INF179K01UT0",
  HDFC_SC: "INF179KA1RW5",
  HDFC_STD: "INF179K01YM7",
  UTI_N50: "INF789F01XA0",
  UTI_NN50: "INF789FC12T1",
  NIPPON_MID: "INF204K01E54",
  ICICI_NASDAQ: "INF109KC1U50",
  EDEL_MID: "INF843K01AO4",
};

export const ISIN_TO_FUND: Record<string, string> = Object.fromEntries(
  Object.entries(FUND_ISIN).map(([code, isin]) => [isin, code])
);

/**
 * Groww's numeric scheme_code → our fund_code. Groww uses AMFI's
 * canonical numeric scheme code (same as mfapi.in), so this is
 * effectively an AMFI-code map — the naming just reflects where we
 * first started pulling it from.
 *
 * Used by:
 *   • POST /api/sync-groww  — portfolio holdings sync (GrowwPasteCard)
 *
 * The sync-mf-contributions route (Groww order-history backfill) was
 * retired on 2026-07-24 — INDmoney bulk-list JSON is now the primary
 * new-order ingest path (via LogMfTxCard), which does its own fund
 * matching by name; it doesn't consume this map. Historical Groww
 * order data in mf_contributions still uses these codes for lookups.
 *
 * Keep in sync with FUND_ISIN above — every fund_code here should
 * also appear there. Adding a new fund means adding an entry to both.
 */
export const SCHEME_CODE_TO_FUND: Record<string, string> = {
  "119016": "HDFC_STD",
  "148958": "PPFAS_CH",
  "122639": "PPFAS_FC",
  "118668": "NIPPON_MID",
  "143341": "UTI_NN50",
  "120716": "UTI_N50",
  "149219": "ICICI_NASDAQ",
  "130503": "HDFC_SC",
  "140228": "EDEL_MID",
  "118955": "HDFC_FC",
};

/**
 * Resolve any Groww order (or Dhan holding, or mfapi response) to our
 * internal fund_code using whatever identifier is available. ISIN wins
 * over scheme_code because ISIN is globally unique and stable across
 * AMFI code renumbering. Returns null if neither identifier maps to a
 * known fund — caller decides whether to skip or store as unresolved.
 */
export function resolveFundCode(input: {
  isin?: string | null;
  scheme_code?: string | number | null;
}): string | null {
  if (input.isin && ISIN_TO_FUND[input.isin]) return ISIN_TO_FUND[input.isin];
  if (input.scheme_code != null) {
    const key = String(input.scheme_code);
    if (SCHEME_CODE_TO_FUND[key]) return SCHEME_CODE_TO_FUND[key];
  }
  return null;
}
