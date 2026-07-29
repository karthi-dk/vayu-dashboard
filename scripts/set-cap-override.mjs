// Manual cap-classification override CLI
// ======================================
//
// Pins one or more ISINs in master_security_classification so they
// SURVIVE the NSE refresh sweep (/api/refresh-cap-classifications).
// This is the escape hatch for demerger entities, spin-offs, and any
// stock whose "correct" cap tier isn't reflected in NSE's official
// index CSVs yet.
//
// Contract
// --------
// The refresh route treats a row as sticky if its `confidence` column
// contains the substring "manual" (case-insensitive). This script
// writes `confidence = 'isin-verified-manual-override'`, matching the
// existing convention used for bond CDs.
//
// The script optionally updates `mcap_classification` and `source`
// in the same PATCH so you can "correct + pin" in one shot.
//
// Usage
// -----
//   node scripts/set-cap-override.mjs \
//     --isin INE1CDF01017 \
//     --isin INE1CLE01013 \
//     --mcap Large \
//     --source nse-niftynext50 \
//     [--dry-run]
//
//   # Pin only (don't touch mcap/source):
//   node scripts/set-cap-override.mjs --isin INExxxxxxx
//
//   # Clear an override (reverts to auto-refresh eligibility):
//   node scripts/set-cap-override.mjs --isin INExxxxxxx --clear
//
// Notes
// -----
// • --isin can be repeated any number of times.
// • --mcap must be one of: Large, Mid, Small, Micro, Nano, US.
// • --source is the string written to the `source` column; typically
//   nse-nifty50 | nse-niftynext50 | nse-midcap150 | nse-smallcap250 |
//   nse-microcap250 | nse-equity-l | manual-verified.
// • --clear resets confidence to "isin-verified" (safe default for
//   any equity row) — the refresh will then reclassify normally.
// • Default is APPLY. Pass --dry-run to preview without writing.

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── Args ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const isins = [];
let mcap = null;
let source = null;
let dryRun = false;
let clear = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--isin") isins.push(args[++i]);
  else if (a === "--mcap") mcap = args[++i];
  else if (a === "--source") source = args[++i];
  else if (a === "--dry-run") dryRun = true;
  else if (a === "--clear") clear = true;
  else {
    console.error(`Unknown flag: ${a}`);
    process.exit(1);
  }
}
if (isins.length === 0) {
  console.error("Usage: node scripts/set-cap-override.mjs --isin ISIN [--isin ...] [--mcap X] [--source Y] [--clear] [--dry-run]");
  process.exit(1);
}
const VALID_MCAP = ["Large", "Mid", "Small", "Micro", "Nano", "US", ""];
if (mcap !== null && !VALID_MCAP.includes(mcap)) {
  console.error(`--mcap must be one of: ${VALID_MCAP.filter(Boolean).join(", ")}`);
  process.exit(1);
}
if (clear && (mcap !== null || source !== null)) {
  console.error("--clear cannot be combined with --mcap or --source");
  process.exit(1);
}

// ── Env ──────────────────────────────────────────────────────────
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
// Prefer the service_role key when available — master_security_classification
// has RLS enforced, so the anon key can neither read nor patch these rows.
// Falls back to anon for backwards compatibility with older .env.local files.
const SB_KEY = env.SUPABASE_SERVICE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!SB_URL || !SB_KEY) throw new Error("Missing Supabase env vars");

// ── Curl helper (matches the pattern used by other scripts here;
//    Node's native fetch trips over the corporate proxy's self-signed
//    cert chain, so we shell out to curl for consistency).
function curl(method, url, bodyJson) {
  const parts = [
    "curl", "-s", "-X", method,
    `"${url}"`,
    "-H", `"apikey: ${SB_KEY}"`,
    "-H", `"Authorization: Bearer ${SB_KEY}"`,
    "-H", `'Content-Type: application/json'`,
    "-H", `'Prefer: return=representation'`,
  ];
  if (bodyJson) parts.push("-d", `'${JSON.stringify(bodyJson)}'`);
  return execSync(parts.join(" "), { encoding: "utf8" });
}

// ── Preflight: read the current state of these ISINs ─────────────
const inList = isins.map((s) => encodeURIComponent(s)).join(",");
const readUrl =
  `${SB_URL}/rest/v1/master_security_classification` +
  `?isin=in.(${inList})` +
  `&select=isin,company_name,mcap_classification,source,confidence`;
const beforeRaw = curl("GET", readUrl);
let before;
try {
  before = JSON.parse(beforeRaw);
} catch {
  console.error("Could not parse preflight response:", beforeRaw.slice(0, 200));
  process.exit(1);
}
if (!Array.isArray(before) || before.length === 0) {
  console.error("No matching rows found. ISINs given:");
  isins.forEach((i) => console.error(`  ${i}`));
  process.exit(1);
}

// ── Plan the patch ───────────────────────────────────────────────
const patch = {};
if (clear) {
  // Reset to a neutral confidence so the refresh will treat this row
  // like any other. We use "isin-verified" (the majority baseline)
  // rather than nulling out — a null confidence would suggest the
  // ISIN itself is untrusted, which is a different signal.
  patch.confidence = "isin-verified";
} else {
  patch.confidence = "isin-verified-manual-override";
  if (mcap !== null) patch.mcap_classification = mcap;
  if (source !== null) patch.source = source;
}

// ── Print the diff plan ──────────────────────────────────────────
console.log(
  `${dryRun ? "[DRY RUN] " : ""}Planning override for ${before.length} row(s):`
);
console.log();
console.log(
  ["ISIN", "Company", "Before mcap", "→", "After mcap", "Before confidence", "→", "After confidence"].join(" | ")
);
console.log("-".repeat(120));
for (const r of before) {
  const afterMcap = patch.mcap_classification ?? r.mcap_classification ?? "";
  const afterConf = patch.confidence;
  console.log(
    [
      r.isin,
      (r.company_name ?? "").slice(0, 34),
      r.mcap_classification ?? "",
      "→",
      afterMcap,
      r.confidence ?? "",
      "→",
      afterConf,
    ].join(" | ")
  );
}
console.log();

if (dryRun) {
  console.log("Dry run — no changes written. Re-run without --dry-run to apply.");
  process.exit(0);
}

// ── Apply ────────────────────────────────────────────────────────
const patchUrl =
  `${SB_URL}/rest/v1/master_security_classification?isin=in.(${inList})`;
const afterRaw = curl("PATCH", patchUrl, patch);
let after;
try {
  after = JSON.parse(afterRaw);
} catch {
  console.error("PATCH failed. Response:", afterRaw.slice(0, 500));
  process.exit(1);
}
if (!Array.isArray(after)) {
  console.error("Unexpected PATCH response:", afterRaw.slice(0, 500));
  process.exit(1);
}

console.log(`Applied. ${after.length} row(s) updated:`);
for (const r of after) {
  console.log(
    `  ${r.isin}  mcap=${r.mcap_classification ?? ""}  source=${r.source ?? ""}  confidence=${r.confidence}`
  );
}
console.log();
console.log(
  clear
    ? "Cleared. These rows will now be reclassified by the next NSE refresh."
    : "Pinned. These rows will now SURVIVE future NSE refreshes."
);
