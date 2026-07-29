import { createHash } from "crypto";

/**
 * Derives 3 nps_transactions rows (one each for scheme E/C/G) from a
 * single retirement_credits NPS payroll event, so the NPS Growth
 * breakdown chart can update the moment the user logs a monthly
 * contribution on /credits — WITHOUT waiting for the next Protean CRA
 * SOT paste.
 *
 * Data sources
 * ────────────
 *   • Amount split → nps_state.alloc_e/c/g_pct
 *       Assumes the user hasn't changed their alloc since the credit
 *       date. In practice alloc changes ~once per fiscal year, so this
 *       is close enough for a monthly ingest.
 *
 *   • NAV per scheme → nps_nav_history for the credit_date, walking
 *       backward to the nearest prior trading day if the credit lands
 *       on a weekend / holiday (typical: payroll dated on the 15th
 *       when NAV is only published Mon-Fri).
 *
 *   • Units per scheme → amount_scheme / nav_scheme
 *       Not exact — CRA reports units rounded to 4 dp and uses NAV
 *       from the settlement date (which can lag credit_date by 1–3
 *       days). Typical drift < 0.1 units per scheme. Reconciles to
 *       zero on subsequent CRA paste ingest (see sync-nps-cra route:
 *       it wipes source='auto_credits' rows in the paste's date range
 *       before inserting the exact CRA rows).
 *
 * Idempotency
 * ───────────
 * tx_hash = md5(`auto|${credit_date}|${credit_type}|${scheme}`).
 * Deterministic per (date, credit_type, scheme). Since retirement_
 * credits enforces UNIQUE(source, credit_date, credit_type), we can
 * never have two NPS payroll credits on the same date, so this hash
 * is unique per credit event per scheme. Re-running the derive after
 * a retryable failure is a no-op (Postgres unique-violation on
 * (source, tx_hash) is caught by upsert w/ ignore-duplicates).
 *
 * Fingerprint deliberately excludes the amount / nav / units so that
 * a subsequent alloc-percentage change or NAV backfill would UPDATE
 * the existing auto row rather than create a duplicate. To make
 * updates actually happen we'd need `resolution=merge-duplicates`
 * on the API insert; the current implementation uses ignore-
 * duplicates because the value drift is small and the paste-based
 * reconciliation path is the authoritative correction lever.
 */

export type AutoTxSource = "auto_credits";
export const AUTO_TX_SOURCE: AutoTxSource = "auto_credits";

export type NpsSchemeCode = "E" | "C" | "G";

export type AutoTxNavLookup = (
  scheme: NpsSchemeCode,
  onOrBefore: string
) => number | null;

export type NpsAllocPcts = {
  alloc_e_pct: number;
  alloc_c_pct: number;
  alloc_g_pct: number;
};

export type AutoTxRow = {
  source: AutoTxSource;
  tx_hash: string;
  tx_date: string;
  fy: string;
  tier: "I";
  scheme: NpsSchemeCode;
  tx_type: "contribution";
  amount: number;
  nav: number;
  units: number;
  contribution_side: "employer" | "employee" | "voluntary";
  description_raw: string;
  uploaded_by: null;
  raw: Record<string, unknown>;
};

/**
 * Compute an Indian financial year label ("YYYY-YY") for a given
 * YYYY-MM-DD date. FY runs Apr 1 → Mar 31.
 */
export function fyForDate(iso: string): string {
  const [y, m] = iso.split("-").map((s) => Number(s));
  const startYear = m >= 4 ? y : y - 1;
  const endYear = (startYear + 1) % 100;
  return `${startYear}-${endYear.toString().padStart(2, "0")}`;
}

function computeAutoTxHash(input: {
  tx_date: string;
  credit_type: string;
  scheme: NpsSchemeCode;
}): string {
  const key = `auto|${input.tx_date}|${input.credit_type}|${input.scheme}`;
  return createHash("md5").update(key).digest("hex");
}

/**
 * Round to 4 decimal places to match the precision the CRA statement
 * publishes. Prevents float-serialisation surprises like 0.19999999
 * showing up in the DB.
 */
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Build 3 auto-derived nps_transactions rows for a payroll credit.
 * Returns null when any scheme's NAV is missing — the caller (server
 * action) should skip the auto insert entirely in that case so the
 * user isn't left with a partial (E-only, or 2-of-3) contribution
 * shown on the chart. The retirement_credits row still lands; only
 * the chart-side mirror is skipped.
 */
export function deriveAutoTxRows(input: {
  credit_date: string;
  credit_type: "payroll";
  credit_amount: number;
  alloc: NpsAllocPcts;
  navLookup: AutoTxNavLookup;
  contribution_side?: "employer" | "employee" | "voluntary";
}): AutoTxRow[] | null {
  const {
    credit_date,
    credit_type,
    credit_amount,
    alloc,
    navLookup,
    contribution_side = "employer",
  } = input;

  const schemes: Array<{ code: NpsSchemeCode; pct: number }> = [
    { code: "E", pct: alloc.alloc_e_pct },
    { code: "C", pct: alloc.alloc_c_pct },
    { code: "G", pct: alloc.alloc_g_pct },
  ];

  const totalPct = schemes.reduce((s, x) => s + x.pct, 0);
  if (Math.abs(totalPct - 100) > 0.01) {
    // Bad alloc data — sum doesn't approach 100%. Refuse to derive.
    return null;
  }

  const fy = fyForDate(credit_date);
  const rows: AutoTxRow[] = [];
  for (const { code, pct } of schemes) {
    const nav = navLookup(code, credit_date);
    if (nav == null || nav <= 0) {
      // NAV missing for this scheme on/before the credit date.
      // Bail out entirely rather than emit a partial split.
      return null;
    }
    const amount = round2((credit_amount * pct) / 100);
    const units = round4(amount / nav);
    rows.push({
      source: AUTO_TX_SOURCE,
      tx_hash: computeAutoTxHash({ tx_date: credit_date, credit_type, scheme: code }),
      tx_date: credit_date,
      fy,
      tier: "I",
      scheme: code,
      tx_type: "contribution",
      amount,
      nav,
      units,
      contribution_side,
      description_raw: `Auto-derived from /credits log · ${code} ${pct.toFixed(2)}%`,
      uploaded_by: null,
      raw: {
        derived_at: new Date().toISOString(),
        alloc_pct: pct,
        credit_amount,
      },
    });
  }

  return rows;
}
