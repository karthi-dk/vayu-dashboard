// Ad-hoc verifier for NPS CRA SOT parser.
// Run: npx tsx scripts/verify-nps-sot-parser.ts <path-to-html>
//
// Purpose: parse a SOT HTML file OUTSIDE the API path so we can see
// warnings, counts, and per-scheme reconciliation before enabling the
// UI pipeline. Never writes to the DB.

import { readFileSync } from "node:fs";
import { parseSotHtml } from "../lib/npscra/parseSotHtml";

const htmlPath = process.argv[2];
if (!htmlPath) {
  console.error(
    "Usage: npx tsx scripts/verify-nps-sot-parser.ts <path-to-html>"
  );
  process.exit(1);
}
const html = readFileSync(htmlPath, "utf8");

console.log("=".repeat(70));
console.log("PARSING", htmlPath);
console.log("=".repeat(70));

try {
  const parsed = parseSotHtml(html);
  console.log("\nFY:", parsed.fy);
  console.log("Period:", parsed.period);
  console.log(
    "Warnings:",
    parsed.warnings.length ? parsed.warnings : "none"
  );
  console.log("\n─── Totals ───");
  console.log(parsed.totals);
  console.log("\n─── Per-scheme reconciliation ───");
  for (const s of parsed.schemes) {
    const expected = s.closing_units - s.opening_units;
    const drift = expected - s.net_units_delta;
    console.log(
      `Tier ${s.tier} · Scheme ${s.scheme} · ` +
        `rows=${s.tx_count} · ` +
        `contrib=${s.contribution_count}/₹${s.contribution_amount.toFixed(2)} · ` +
        `billing=${s.billing_count}/₹${s.billing_amount.toFixed(2)} · ` +
        `open=${s.opening_units.toFixed(4)} close=${s.closing_units.toFixed(4)} ` +
        `netΔ=${s.net_units_delta.toFixed(4)} drift=${drift.toFixed(4)}`
    );
  }
  console.log("\n─── Aggregate contribution table ───");
  console.log(`Rows: ${parsed.aggregate_contributions.length}`);
  const aggSum = parsed.aggregate_contributions.reduce(
    (s, r) => s + r.total_amount,
    0
  );
  console.log(
    `Σ total: ₹${aggSum.toFixed(2)} vs Σ per-scheme contrib: ₹${parsed.totals.contribution_amount.toFixed(2)}`
  );

  console.log("\n─── First 5 transactions ───");
  for (const t of parsed.transactions.slice(0, 5)) {
    console.log(
      `[${t.tx_hash.slice(0, 8)}] ${t.tx_date} T${t.tier}-${t.scheme} ${t.tx_type} amt=${t.amount.toFixed(2)} nav=${t.nav} units=${t.units?.toFixed(4)} uploaded_by="${t.uploaded_by ?? ""}" side=${t.contribution_side}`
    );
  }
  console.log("\n─── Last 3 transactions ───");
  for (const t of parsed.transactions.slice(-3)) {
    console.log(
      `[${t.tx_hash.slice(0, 8)}] ${t.tx_date} T${t.tier}-${t.scheme} ${t.tx_type} amt=${t.amount.toFixed(2)} nav=${t.nav} units=${t.units?.toFixed(4)} uploaded_by="${t.uploaded_by ?? ""}"`
    );
  }

  console.log("\n─── Uniqueness check ───");
  const hashes = new Set(parsed.transactions.map((t) => t.tx_hash));
  console.log(
    `${hashes.size} unique tx_hash values from ${parsed.transactions.length} rows — ${hashes.size === parsed.transactions.length ? "OK" : "COLLISIONS!"}`
  );
} catch (err) {
  console.error("PARSE FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
}
