/**
 * scripts/verify-cams-parser.ts
 *
 * Ad-hoc verification runner for the CAMS parser + diff engine. Not
 * shipped as part of the app; kept in scripts/ so it can be re-run
 * whenever CAMS changes their CSV format.
 *
 * Usage:
 *   npx tsx scripts/verify-cams-parser.ts <path-to-csv>
 *
 * Prints:
 *   • Parser output (subscriber, summary, scheme rows, contributions)
 *   • Diff engine output against a MOCK nps_state + ledger snapshot,
 *     specifically the one described in the chat (post-POP-correction
 *     migration): POP variant, one Jul 8 payroll credit already in the
 *     ledger. That snapshot reproduces the near_duplicate case (Jul 6
 *     CSV vs Jul 8 ledger) so we can see the classifier at work. Real
 *     PRAN kept out of the repo — the CSV you pass at runtime supplies
 *     it; the mock below just uses a synthetic placeholder that
 *     satisfies the 12-digit format check.
 */

import { readFileSync } from "fs";
import { parseCamsCsv } from "../lib/nps/camsParser";
import {
  diffCas,
  type LedgerRowSnapshot,
  type NpsStateSnapshot,
} from "../lib/nps/casDiff";

const path = process.argv[2];
if (!path) {
  console.error("Usage: npx tsx scripts/verify-cams-parser.ts <path-to-csv>");
  process.exit(1);
}

const csv = readFileSync(path, "utf-8");

console.log("=== PARSER OUTPUT ===\n");
const parsed = parseCamsCsv(csv);
console.log("Subscriber:", parsed.subscriber);
console.log("Investment summary:", parsed.investmentSummary);
console.log("Scheme summary:");
for (const s of parsed.schemeSummary) {
  console.log(
    `  ${s.assetClass} · ${s.variant} · Tier ${s.tier} · units=${s.units.toFixed(4)} · nav=${s.nav.toFixed(4)} · value=₹${s.value.toFixed(2)}`
  );
}
console.log("Contributions (categorized):");
for (const c of parsed.contributions) {
  console.log(
    `  ${c.dateIso} · [${c.category}] · ₹${c.total.toFixed(2)} · ${c.particulars.slice(0, 60)}`
  );
}
console.log("Computed:", parsed.computed);

console.log("\n=== DIFF ENGINE (against reproduction snapshot) ===\n");

// Reproduce the current DB state per the summary + POP-correction
// migration. Ledger has exactly one NPS payroll row (Jul 8), and
// nps_state pran is already seeded (so pran validation fires). Real
// PRAN never lives in the repo — a synthetic 12-digit placeholder is
// enough for the format check inside diffCas().
const mockState: NpsStateSnapshot = {
  pran: "000000000000",
  scheme_e_units: 6572.2886,
  scheme_c_units: 2611.0761,
  scheme_g_units: 765.2724,
  scheme_e_nav: 67.9376,
  scheme_c_nav: 44.5198,
  scheme_g_nav: 38.4474,
  total_invested_inr: 555354.28,
  nav_date: "2026-07-16",
};

const mockLedger: LedgerRowSnapshot[] = [
  {
    id: 42,
    credit_date: "2026-07-08",
    credit_type: "payroll",
    amount_inr: 15076.0,
    note: "Jun-26 dues, credited early per Kotak CAS on 8 Jul 2026",
  },
];

const diff = diffCas(parsed, mockState, mockLedger);
console.log("PRAN:", diff.parsed.pran);
console.log("Statement date (audit):", diff.parsed.statementDate);
console.log("NAV date (goes into nps_state.nav_date):", diff.parsed.navDate);
console.log("Fatal:", diff.fatal, diff.fatalReasons);
console.log("Validation:", diff.validation);
console.log("State diff summary:");
console.log("  anyChanged:", diff.stateDiff.anyChanged);
console.log("  scheme_e_units:", diff.stateDiff.scheme_e_units);
console.log("  scheme_c_units:", diff.stateDiff.scheme_c_units);
console.log("  scheme_g_units:", diff.stateDiff.scheme_g_units);
console.log("  total_invested_inr:", diff.stateDiff.total_invested_inr);
console.log("  nav_date:", diff.stateDiff.nav_date);
console.log("Event summary:", diff.summary);
console.log("Events:");
for (const e of diff.events) {
  console.log(
    `  ${e.status.padEnd(20)} · ${e.csv.dateIso} · ₹${e.csv.amountInr.toFixed(2).padStart(10)} · ${e.reason}`
  );
}

console.log("\n=== 2ND-PASTE SIMULATION (idempotency check) ===\n");
// Feed the same CSV through diff, but with the state already reconciled
// AND the ledger updated to have all 4 payroll rows (as if the first
// paste had been applied). Expected: 0 new events, all 4 exact_duplicate,
// state diff anyChanged = false.
const postApplyLedger: LedgerRowSnapshot[] = [
  { id: 42, credit_date: "2026-07-06", credit_type: "payroll", amount_inr: 15076.0, note: "" },
  { id: 43, credit_date: "2026-06-05", credit_type: "payroll", amount_inr: 15076.0, note: "" },
  { id: 44, credit_date: "2026-05-07", credit_type: "payroll", amount_inr: 15076.0, note: "" },
  { id: 45, credit_date: "2026-04-09", credit_type: "payroll", amount_inr: 15076.0, note: "" },
];
const postApplyState: NpsStateSnapshot = {
  ...mockState,
  // Post-apply nav_date reflects the NAV date the CAS said the NAVs
  // correspond to (Jul 16 for a Jul 17 statement), not the statement
  // date itself — see casDiff.ts nav_date semantics.
  nav_date:
    parsed.schemeSummary[0]?.navDateIso ?? parsed.subscriber.statementDateIso,
};
const diff2 = diffCas(parsed, postApplyState, postApplyLedger);
console.log("Fatal:", diff2.fatal);
console.log("State anyChanged:", diff2.stateDiff.anyChanged);
console.log("Event summary:", diff2.summary);
