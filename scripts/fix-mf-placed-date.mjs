// Fix a specific mf_transactions row's tx_date / placed_date
// ==========================================================
//
// Companion to migration 2026-07-24-mf-transactions-placed-date.sql.
//
// The INDmoney bulk-list Subtitle1 conflates two dates that the ledger
// UI now separates cleanly:
//   • placedDate — when the user clicked Buy (local-time date).
//   • tx_date    — the NAV DATE (day whose NAV was applied). A post-
//                    3 PM cutoff order rolls to the next trading day.
//
// Pre-fix ingest wrote Subtitle1 into tx_date directly, which for
// post-cutoff orders yielded the wrong NAV date. This script corrects
// one already-ingested row so its ledger display matches reality.
//
// Usage
// -----
//   # Inspect only — prints current + proposed state, does not write
//   node scripts/fix-mf-placed-date.mjs \
//     --fund EDEL_MID --source-ref 74974058 --dry-run
//
//   # Apply the correction (defaults derived from --nav lookup, or
//   # explicit --tx-date + --placed-date can be passed)
//   node scripts/fix-mf-placed-date.mjs \
//     --fund EDEL_MID --source-ref 74974058 \
//     --tx-date 2026-07-23 --placed-date 2026-07-22
//
// Contract
// --------
// • Matches on (fund_code, source, source_ref) — the strong-key
//   identity for INDmoney-sourced rows introduced in migration
//   2026-07-24-mf-transactions-source-ref.sql. Won't touch anything
//   without a source_ref.
// • Updates tx_date + placed_date only. Does NOT recompute tx_hash
//   (hash includes tx_date; changing it in place would strand the
//   stored hash), but that's fine because source_ref is now the
//   authoritative dedup key — future re-pastes of the same TxnID
//   short-circuit before tx_hash is even computed. See the
//   source_ref early-return in logMfTransaction (app/actions.ts).
//
// Notes
// -----
// • The 2026-07-24-mf-transactions-placed-date.sql migration MUST be
//   applied first; this script's PATCH will 400 otherwise with a
//   "column placed_date does not exist" error.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 && i < args.length - 1 ? args[i + 1] : null;
}
const isDryRun = args.includes("--dry-run");
const fundCode = argValue("--fund");
const sourceRef = argValue("--source-ref");
const overrideTxDate = argValue("--tx-date");
const overridePlacedDate = argValue("--placed-date");

if (!fundCode || !sourceRef) {
  console.error(
    "Usage: node scripts/fix-mf-placed-date.mjs --fund <CODE> --source-ref <TXN_ID> [--tx-date YYYY-MM-DD] [--placed-date YYYY-MM-DD] [--dry-run]"
  );
  process.exit(1);
}

// ── Load env (same parsing as set-cap-override.mjs) ─────────────
const envText = readFileSync(".env.local", "utf8");
const env = Object.fromEntries(
  envText
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [
        l.slice(0, i).trim(),
        l
          .slice(i + 1)
          .trim()
          .replace(/^"|"$/g, ""),
      ];
    })
);
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!SB_URL || !SB_KEY) throw new Error("Missing Supabase env vars");

function curl(method, url, bodyJson) {
  const parts = [
    "curl",
    "-s",
    "-X",
    method,
    `"${url}"`,
    "-H",
    `"apikey: ${SB_KEY}"`,
    "-H",
    `"Authorization: Bearer ${SB_KEY}"`,
    "-H",
    `'Content-Type: application/json'`,
    "-H",
    `'Prefer: return=representation'`,
  ];
  if (bodyJson) parts.push("-d", `'${JSON.stringify(bodyJson)}'`);
  return execSync(parts.join(" "), { encoding: "utf8" });
}

// ── Preflight: read current row + NAV context ───────────────────
// SELECT list omits placed_date so we can inspect rows on a pre-
// migration DB (dry-run before applying 2026-07-24-mf-transactions-
// placed-date.sql). The PATCH later will 400 if the column doesn't
// exist yet — that's the intended surface for "apply the migration
// first" feedback.
const rowUrl =
  `${SB_URL}/rest/v1/mf_transactions` +
  `?fund_code=eq.${encodeURIComponent(fundCode)}` +
  `&source_ref=eq.${encodeURIComponent(sourceRef)}` +
  `&select=tx_hash,tx_date,fund_code,nav,units,amount,source,source_ref`;
const beforeRaw = curl("GET", rowUrl);
let before;
try {
  before = JSON.parse(beforeRaw);
} catch {
  console.error("Could not parse preflight response:", beforeRaw.slice(0, 400));
  process.exit(1);
}
if (!Array.isArray(before) || before.length === 0) {
  console.error(
    `No row found for fund_code=${fundCode} source_ref=${sourceRef}. ` +
      `Nothing to fix.`
  );
  process.exit(1);
}
if (before.length > 1) {
  console.error(
    `Multiple rows matched (${before.length}) — that shouldn't happen ` +
      `with (source, source_ref) unique. Aborting to be safe.`
  );
  process.exit(1);
}
const row = { placed_date: null, ...before[0] };

// ── Derive NAV date from mf_nav_history if not supplied ────────
// Same logic as the app-side resolveNavDate() server action but
// runnable offline. Looks up trading days where the stored NAV
// (rounded to 2dp) equals the row's NAV, within a ±4-day window
// around the current tx_date, prefers dates >= tx_date (post-cutoff
// orders always resolve forward, never backward).
let derivedTxDate = overrideTxDate;
if (!derivedTxDate) {
  const anchor = row.tx_date;
  const dayMs = 86_400_000;
  const anchorTs = Date.parse(anchor);
  const fromDate = new Date(anchorTs - 4 * dayMs).toISOString().slice(0, 10);
  const toDate = new Date(anchorTs + 4 * dayMs).toISOString().slice(0, 10);
  const navUrl =
    `${SB_URL}/rest/v1/mf_nav_history` +
    `?fund_code=eq.${encodeURIComponent(fundCode)}` +
    `&nav_date=gte.${fromDate}` +
    `&nav_date=lte.${toDate}` +
    `&select=nav_date,nav`;
  const navRaw = curl("GET", navUrl);
  let navRows;
  try {
    navRows = JSON.parse(navRaw);
  } catch {
    navRows = [];
  }
  const target = Math.round(Number(row.nav) * 100) / 100;
  const matches = (navRows ?? [])
    .filter(
      (n) => Math.round(Number(n.nav) * 100) / 100 === target
    )
    .sort((a, b) => {
      const aTs = Date.parse(a.nav_date);
      const bTs = Date.parse(b.nav_date);
      const aFuture = aTs >= anchorTs;
      const bFuture = bTs >= anchorTs;
      if (aFuture !== bFuture) return aFuture ? -1 : 1;
      return Math.abs(aTs - anchorTs) - Math.abs(bTs - anchorTs);
    });
  if (matches.length > 0) derivedTxDate = matches[0].nav_date;
}

const proposedTxDate = derivedTxDate ?? row.tx_date;
const proposedPlacedDate =
  overridePlacedDate ??
  // Fall back to the current tx_date if it looks like the "click"
  // date (i.e. the pre-fix pattern where we wrote Subtitle1 into
  // tx_date). Only meaningful when we're actually correcting the
  // NAV date to something later — if there's no derivation, we
  // don't invent a placed_date either.
  (proposedTxDate !== row.tx_date ? row.tx_date : null);

console.log("Current state:");
console.log(`  fund_code   : ${row.fund_code}`);
console.log(`  source_ref  : ${row.source_ref}`);
console.log(`  tx_hash     : ${row.tx_hash}`);
console.log(`  tx_date     : ${row.tx_date}`);
console.log(`  placed_date : ${row.placed_date ?? "(null)"}`);
console.log(`  nav         : ${row.nav}`);
console.log(`  units       : ${row.units}`);
console.log(`  amount      : ${row.amount}`);
console.log("");
console.log("Proposed:");
console.log(
  `  tx_date     : ${proposedTxDate}${
    proposedTxDate === row.tx_date ? " (unchanged)" : " ← changed"
  }`
);
console.log(
  `  placed_date : ${proposedPlacedDate ?? "(null)"}${
    proposedPlacedDate === row.placed_date ? " (unchanged)" : " ← changed"
  }`
);

if (isDryRun) {
  console.log("\n--dry-run: no write performed.");
  process.exit(0);
}
if (
  proposedTxDate === row.tx_date &&
  proposedPlacedDate === row.placed_date
) {
  console.log("\nNothing to change.");
  process.exit(0);
}

const patchUrl =
  `${SB_URL}/rest/v1/mf_transactions` +
  `?fund_code=eq.${encodeURIComponent(fundCode)}` +
  `&source_ref=eq.${encodeURIComponent(sourceRef)}`;
const patchBody = {
  tx_date: proposedTxDate,
  placed_date: proposedPlacedDate,
};
const afterRaw = curl("PATCH", patchUrl, patchBody);
let after;
try {
  after = JSON.parse(afterRaw);
} catch {
  console.error("Could not parse PATCH response:", afterRaw.slice(0, 400));
  process.exit(1);
}
if (!Array.isArray(after) || after.length === 0) {
  console.error("PATCH returned no rows:", afterRaw.slice(0, 400));
  process.exit(1);
}
console.log("\nUpdated row:");
console.log(`  tx_date     : ${after[0].tx_date}`);
console.log(`  placed_date : ${after[0].placed_date}`);
