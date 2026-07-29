/**
 * NPS CRA transaction-description → normalized tx_type classification.
 *
 * The Protean CRA SOT describes each row with free-text like:
 *   "By Arrear - Regular Contributions March"
 *   "Billing for Q4, 2023-2024"
 *   "One Way Switch Debit"
 * We fold these into a small enum so downstream queries can filter
 * cleanly (e.g., "total contributions in FY25" or "hide billing rows").
 *
 * Per user preference (2026-07-18): the joining-month lumpsum is
 * treated as a regular `contribution` — no special "lumpsum" bucket.
 * If you want to distinguish it visually, use the amount vs the median
 * of the other contribution rows.
 *
 * Order matters: `billing` must test before `contribution` because
 * "Billing for Q4, 2023-2024" contains "2024" but no contribution
 * keyword — safe, but explicit ordering documents the intent.
 */

export type NpsTxType =
  | "contribution"   // regular / arrear / lumpsum / voluntary — any deposit
  | "billing"        // quarterly CRA charges (negative amount / units)
  | "switch_in"      // scheme-preference change credit
  | "switch_out"     // scheme-preference change debit
  | "shifting_in"    // sector shift credit (Corporate → All-Citizen etc.)
  | "shifting_out"   // sector shift debit
  | "withdrawal"     // partial / exit withdrawal (Tier I rare pre-retirement)
  | "other";         // unrecognised — flagged for user review

type Matcher = {
  tx_type: NpsTxType;
  test: (lowerDesc: string, amount: number) => boolean;
};

// Ordered — first match wins. Keep the specific patterns above the
// permissive `contribution` catch-all.
const MATCHERS: Matcher[] = [
  {
    tx_type: "billing",
    // Negative amount + "billing" text — 4× per FY (one per quarter).
    // Amount check guards against a hypothetical positive "billing
    // reversal" row (never seen, but cheap to be defensive).
    test: (d, a) => d.includes("billing") && a < 0,
  },
  {
    // Includes CRA's canonical phrasing for a subscriber-initiated
    // scheme-preference change / rebalance, which produces balancing
    // debit + credit rows across the affected schemes on adjacent days.
    // Row shape (positive amount):
    //   "By Contribution On Account of Subscriber Initiated Scheme
    //    Preference Change"
    // The word "contribution" is present, so this matcher MUST run
    // before the permissive contribution catch-all further down.
    tx_type: "switch_in",
    test: (d, a) =>
      (d.includes("switch") || d.includes("scheme preference change")) &&
      (a > 0 || d.includes("credit")),
  },
  {
    // Row shape (negative amount):
    //   "To Withdrawal On Account of Subscriber Initiated Scheme
    //    Preference Change"
    // The word "withdrawal" is present, so this matcher MUST run
    // before the withdrawal matcher further down.
    tx_type: "switch_out",
    test: (d, a) =>
      (d.includes("switch") || d.includes("scheme preference change")) &&
      (a < 0 || d.includes("debit")),
  },
  {
    tx_type: "shifting_in",
    test: (d, a) =>
      (d.includes("shifting") || d.includes("shift in")) &&
      (a > 0 || d.includes("credit")),
  },
  {
    tx_type: "shifting_out",
    test: (d, a) =>
      (d.includes("shifting") || d.includes("shift out")) &&
      (a < 0 || d.includes("debit")),
  },
  {
    tx_type: "withdrawal",
    test: (d) =>
      d.includes("withdrawal") ||
      d.includes("redemption") ||
      d.includes("wdr "),
  },
  {
    // Permissive catch-all for deposit-side rows. "By Arrear - Regular
    // Contribution[s]" is the canonical Protean phrasing for corporate
    // NPS. "Voluntary" is what eNPS uses for direct user deposits.
    // Amount check filters out zero-amount admin rows (rare but exist
    // during initial account setup).
    tx_type: "contribution",
    test: (d, a) =>
      a > 0 &&
      (d.includes("contribution") ||
        d.includes("contributions") ||
        d.includes("by arrear") ||
        d.includes("voluntary")),
  },
];

export function classifyNpsTxType(
  description: string,
  amount: number
): NpsTxType {
  const lower = (description || "").toLowerCase();
  for (const m of MATCHERS) {
    if (m.test(lower, amount)) return m.tx_type;
  }
  return "other";
}

/**
 * Attribute a contribution row to a funding source.
 *
 * Corporate NPS (the user's setup): the employer wires the full amount
 * (employee salary deduction + employer's own match) as ONE line-item
 * to CRA. CRA logs it under "Employer's Contribution" — the employee's
 * personal share is invisible at this layer. So all corporate rows
 * classify as `employer`.
 *
 * eNPS direct (voluntary top-ups the user does themselves via the
 * eNPS portal): CRA labels these "Voluntary Contribution" and the
 * uploaded_by field carries an eNPS / self-service marker.
 *
 * Billing / switch / shifting rows have no funding side.
 */
export function classifyContributionSide(
  description: string,
  uploadedBy: string | null,
  tx_type: NpsTxType
): "employer" | "employee" | "voluntary" | null {
  // Non-cash rows: no side.
  if (
    tx_type === "billing" ||
    tx_type === "switch_in" ||
    tx_type === "switch_out" ||
    tx_type === "shifting_in" ||
    tx_type === "shifting_out" ||
    tx_type === "withdrawal" ||
    tx_type === "other"
  ) {
    return null;
  }

  const lower = (description || "").toLowerCase();
  const upl = (uploadedBy || "").toLowerCase();

  // Voluntary — user-initiated direct deposit (eNPS portal, D-Remit).
  // Detected either from description ("Voluntary Contribution") or from
  // the uploaded_by containing an eNPS / self-service token. Kotak /
  // HDFC / SBI Corporate NPS uploads never carry these markers.
  if (
    lower.includes("voluntary") ||
    upl.includes("enps") ||
    upl.includes("d-remit") ||
    upl.includes("d remit") ||
    upl.includes("self")
  ) {
    return "voluntary";
  }

  // Rarely, CRA emits a row explicitly tagged "Employee Contribution"
  // (some legacy NPS-Lite setups). Trust the description if present.
  if (lower.includes("employee contribution")) {
    return "employee";
  }

  // Default for corporate NPS: employer routing. This includes the
  // employer's own share AND the salary-deducted employee share (the
  // latter is invisible at the CRA layer for corporate NPS).
  return "employer";
}
