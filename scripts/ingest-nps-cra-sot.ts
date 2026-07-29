// One-shot ingester for a Protean CRA NPS "Statement of Transactions"
// HTML page. Complements the /sync UI card by giving a CLI path that
// bypasses the browser entirely — handy when you have the HTML in a
// file and just want the rows in the DB.
//
// Usage
// -----
//   npx tsx scripts/ingest-nps-cra-sot.ts <html-file> [--dry-run]
//
// Contract
// --------
//   • Parses via lib/npscra/parseSotHtml (same code path as the API
//     route), so preview parity is guaranteed.
//   • Upserts on (source='protean_cra_sot', tx_hash) — re-running with
//     the same file is a no-op (Postgres ignores dupes).
//   • Rows classified as `tx_type='other'` are dropped, matching the
//     API route's filter contract.
//   • --dry-run prints the reconciliation view without touching the
//     DB. Useful for sanity-checking a new FY before committing.
//
// Auth
// ----
// Uses SUPABASE_SERVICE_KEY from .env.local — bypasses RLS. Same key
// the Next.js server uses; same trust boundary.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSotHtml, type NpsSotTx } from "../lib/npscra/parseSotHtml";

// Wrapped in a main() because tsx transpiles to CJS which doesn't
// support top-level await on Node 20.
async function main() {
// ── Args ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const htmlPath = args.find((a) => !a.startsWith("--"));
if (!htmlPath) {
  console.error(
    "Usage: npx tsx scripts/ingest-nps-cra-sot.ts <html-file> [--dry-run]"
  );
  process.exit(1);
}

// ── .env.local loader (copies the pattern from set-cap-override.mjs
//    since Next.js env plumbing isn't available in a plain tsx run).
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
        l
          .slice(i + 1)
          .trim()
          .replace(/^"|"$/g, ""),
      ];
    })
);
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_KEY;
if (!SB_URL || !SB_KEY) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_KEY in .env.local"
  );
}
const SOURCE = "protean_cra_sot";

// ── Parse ─────────────────────────────────────────────────────────
const html = readFileSync(htmlPath, "utf8");
const parsed = parseSotHtml(html);
console.log("=".repeat(70));
console.log(`FY ${parsed.fy}  ·  ${parsed.period.from} → ${parsed.period.to}`);
console.log("=".repeat(70));
if (parsed.warnings.length) {
  console.log("Warnings:");
  for (const w of parsed.warnings) console.log("  •", w);
}
console.log(
  `Totals: ${parsed.totals.total_rows} rows  ·  ` +
    `${parsed.totals.contribution_count} contributions ` +
    `₹${parsed.totals.contribution_amount.toFixed(2)}  ·  ` +
    `${parsed.totals.billing_count} billing ` +
    `₹${parsed.totals.billing_amount.toFixed(2)}`
);
for (const s of parsed.schemes) {
  const expected = s.closing_units - s.opening_units;
  const drift = expected - s.net_units_delta;
  const ok = Math.abs(drift) < 0.001;
  console.log(
    `  Tier ${s.tier} · Scheme ${s.scheme}: rows=${s.tx_count} ` +
      `contrib=${s.contribution_count}/₹${s.contribution_amount.toFixed(2)} ` +
      `billing=${s.billing_count}/₹${s.billing_amount.toFixed(2)} ` +
      `unit-drift=${drift.toFixed(4)} ${ok ? "✓" : "✗"}`
  );
}

// ── Filter writable rows ─────────────────────────────────────────
const writable: NpsSotTx[] = parsed.transactions.filter(
  (t) => t.tx_type !== "other"
);
console.log(`\nWritable: ${writable.length} / ${parsed.transactions.length}`);

if (dryRun) {
  console.log("\n[dry-run] Skipping DB write.");
  process.exit(0);
}

// ── Pre-flight: count existing hashes so we can report insert vs
// skip accurately (PostgREST upsert w/ ignore-duplicates hides the split).
const hashes = writable.map((t) => t.tx_hash);
const hashesParam = `(${hashes.map((h) => `"${h}"`).join(",")})`;
const preflightUrl = `${SB_URL}/rest/v1/nps_transactions?select=tx_hash&source=eq.${SOURCE}&tx_hash=in.${encodeURIComponent(hashesParam)}`;
const preflightRes = await fetch(preflightUrl, {
  headers: {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
  },
});
if (!preflightRes.ok) {
  console.error(
    `Pre-flight failed: HTTP ${preflightRes.status}`,
    await preflightRes.text()
  );
  process.exit(1);
}
const existingRows = (await preflightRes.json()) as Array<{ tx_hash: string }>;
const skippedExisting = existingRows.length;

// ── Upsert ────────────────────────────────────────────────────────
const payload = writable.map((t) => ({
  source: SOURCE,
  tx_hash: t.tx_hash,
  tx_date: t.tx_date,
  fy: t.fy,
  tier: t.tier,
  scheme: t.scheme,
  tx_type: t.tx_type,
  amount: t.amount,
  nav: t.nav,
  units: t.units,
  description_raw: t.description_raw,
  uploaded_by: t.uploaded_by,
  contribution_side: t.contribution_side,
  raw: {
    scheme_name_raw: t.scheme_name_raw,
    source_row_idx: t.source_row_idx,
  },
}));

const upsertRes = await fetch(
  `${SB_URL}/rest/v1/nps_transactions?on_conflict=source,tx_hash`,
  {
    method: "POST",
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates,return=minimal",
    },
    body: JSON.stringify(payload),
  }
);
if (!upsertRes.ok) {
  console.error(
    `Upsert failed: HTTP ${upsertRes.status}`,
    await upsertRes.text()
  );
  process.exit(1);
}

const inserted = writable.length - skippedExisting;
console.log(
  `\n✓ Ingested ${inserted} new row(s)` +
    (skippedExisting > 0 ? `, ${skippedExisting} skipped (already present)` : "")
);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
