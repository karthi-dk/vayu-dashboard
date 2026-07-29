// Delete Studio TEST-MODE MF transactions
// ========================================
//
// When NEXT_PUBLIC_FUNDS_TEST_MODE=true, submissions from /studio (and
// its style-prototype siblings /studio/neumorphic, /studio/glassmorphic,
// /studio/claymorphic) land in `mf_transactions` with `platform='test'`
// so the tester can verify the exact payload that WOULD land in
// production. logMfTransaction() explicitly SKIPS the fund_holdings +
// nw_daily bump for those rows (see the `isTestRow` guard in
// app/actions.ts), so they are safe to accumulate — they never affect
// the MF headline card, XIRR, allocation, or 1D chip.
//
// The only downstream surface where test rows leak visibly is the
// MfContributionsLog on /credits: group totals like "July 2026 · 41
// orders · +₹4,01,482" include test rows in the count/sum, which
// clutters the display during a rehearsal-heavy session.
//
// This script deletes every `platform='test'` row from mf_transactions.
// Because those rows never propagated to fund_holdings / nw_daily /
// mf_daily_reconstructed, DELETION IS A NO-OP FOR HEADLINE MATH.
// Nothing else needs to be recomputed.
//
// Idempotent by design — running twice is safe (second run deletes 0
// rows). Dry-run by default; pass --apply to actually delete.
//
// Usage
// -----
//   node scripts/delete-test-mf-transactions.mjs           # dry-run (count only)
//   node scripts/delete-test-mf-transactions.mjs --apply   # actually delete

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const APPLY = process.argv.includes("--apply");

// ── Env ──────────────────────────────────────────────────────────
// Same .env.local parse pattern as scripts/backfill-mf-reconstruction.mjs
// so we don't need dotenv as a dev dep.
const __dirname = dirname(fileURLToPath(import.meta.url));
const envRaw = readFileSync(join(__dirname, "..", ".env.local"), "utf8");
const env = Object.fromEntries(
  envRaw
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [
        l.slice(0, i).trim(),
        l.slice(i + 1).trim().replace(/^"|"$/g, ""),
      ];
    })
);
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_KEY;
if (!SB_URL || !SB_KEY) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_KEY");
}

// ── Curl helpers ─────────────────────────────────────────────────
function sbGet(path) {
  const raw = execSync(
    `curl -sf "${SB_URL}/rest/v1/${path}" ` +
      `-H "apikey: ${SB_KEY}" -H "Authorization: Bearer ${SB_KEY}"`,
    { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }
  );
  return JSON.parse(raw);
}

function sbDelete(path) {
  // Prefer: return=representation asks PostgREST to return the deleted
  // rows so we can print exactly what went away (auditability).
  const raw = execSync(
    `curl -sf -X DELETE "${SB_URL}/rest/v1/${path}" ` +
      `-H "apikey: ${SB_KEY}" -H "Authorization: Bearer ${SB_KEY}" ` +
      `-H "Prefer: return=representation"`,
    { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }
  );
  return raw.trim() === "" ? [] : JSON.parse(raw);
}

function fmtInr(n) {
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log(
    `── Delete test-mode MF transactions ${APPLY ? "(APPLY)" : "(dry-run)"} ──`
  );

  // Fetch all test rows first so we can print a rich summary. Using
  // `select=*` gives us tx_date, fund_code, tx_type, amount, units,
  // platform, source, source_ref — everything a tester would want to
  // see confirmed before deletion.
  const testRows = sbGet(
    "mf_transactions?select=id,tx_date,fund_code,tx_type,amount,units,platform,source&platform=eq.test&order=tx_date.asc"
  );

  if (testRows.length === 0) {
    console.log("No platform='test' rows found. Nothing to delete.");
    return;
  }

  // Group by fund + tx_date for a compact rehearsal-count summary.
  const byFund = new Map();
  let totalAmount = 0;
  let totalUnits = 0;
  for (const r of testRows) {
    const amount = Number(r.amount ?? 0);
    const units = Number(r.units ?? 0);
    totalAmount += amount;
    totalUnits += units;
    const key = r.fund_code;
    const cur = byFund.get(key) ?? { count: 0, amount: 0, units: 0 };
    cur.count += 1;
    cur.amount += amount;
    cur.units += units;
    byFund.set(key, cur);
  }

  console.log(`Found ${testRows.length} test rows across ${byFund.size} funds:`);
  const fundLines = [...byFund.entries()]
    .sort((a, b) => b[1].amount - a[1].amount)
    .map(
      ([fund, s]) =>
        `  ${fund.padEnd(14)} ${String(s.count).padStart(3)} rows  ` +
        `${fmtInr(s.amount).padStart(12)}  ${s.units.toFixed(4)} units`
    );
  fundLines.forEach((line) => console.log(line));
  console.log(
    `  ${"TOTAL".padEnd(14)} ${String(testRows.length).padStart(3)} rows  ` +
      `${fmtInr(totalAmount).padStart(12)}  ${totalUnits.toFixed(4)} units`
  );

  console.log(
    `\nDate range: ${testRows[0].tx_date} → ${testRows[testRows.length - 1].tx_date}`
  );

  if (!APPLY) {
    console.log(
      "\n[dry-run] Re-run with --apply to actually delete these rows."
    );
    return;
  }

  console.log("\nDeleting…");
  const deleted = sbDelete("mf_transactions?platform=eq.test");
  console.log(`✔ Deleted ${deleted.length} rows.`);

  // Sanity check: re-count to confirm zero test rows remain.
  const remaining = sbGet(
    "mf_transactions?select=id&platform=eq.test&limit=1"
  );
  if (remaining.length > 0) {
    console.error(
      "✗ Unexpected: some test rows still remain. Check RLS and delete permissions."
    );
    process.exit(1);
  }
  console.log("✔ Verified: 0 platform='test' rows remain in mf_transactions.");
  console.log(
    "\nNo downstream recompute needed — test rows never touched fund_holdings, nw_daily, or mf_daily_reconstructed."
  );
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
