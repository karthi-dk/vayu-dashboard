// One-time backfill for master_security_classification
// =====================================================
//
// Seeds every NSE-listed equity (EQ + BE + BZ series) from
// EQUITY_L.csv into master_security_classification if the ISIN
// isn't already there. Cap-classifies each new row on the way in:
//
//   In Nifty 100          → Large  (should be ~0 new — already seeded)
//   In Nifty Midcap 150   → Mid    (should be ~0 new)
//   In Nifty Smallcap 250 → Small  (should be ~0 new)
//   In Nifty Microcap 250 → Micro  (should be ~0 new)
//   Rest of EQUITY_L      → Nano   (the bulk — ~1,600 rows)
//
// This is a one-shot backfill, not tied to the /api/refresh-cap-
// classifications button. The button updates existing rows; this
// script INSERTS missing rows. Both can run independently.
//
// Idempotent: uses `Prefer: resolution=ignore-duplicates`, so
// re-runs are safe. Useful for periodic IPO backfills (e.g., after
// a batch of new listings, just re-run this and the new ISINs get
// added as Nano).
//
// Usage
// -----
//   node scripts/backfill-nse-stocks.mjs           # dry-run only
//   node scripts/backfill-nse-stocks.mjs --apply   # actually insert

import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const APPLY = process.argv.includes("--apply");

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
const SB_KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!SB_URL || !SB_KEY) throw new Error("Missing Supabase env vars");

// ── Curl helpers ─────────────────────────────────────────────────
// Node's fetch chokes on the corporate proxy's self-signed cert
// chain, so we shell out to curl for everything.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function curlGet(url, headers = "") {
  return execSync(
    `curl -sf -H "User-Agent: ${UA}" ${headers} "${url}"`,
    { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }
  );
}

// ── CSV parsing ──────────────────────────────────────────────────
// NIFTY index CSVs share the schema:
//   Company Name, Industry, Symbol, Series, ISIN Code
function parseNiftyCsv(csv) {
  const map = new Map();
  const lines = csv.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cols = line.split(",");
    const isin = cols[4]?.trim();
    if (!isValidIsin(isin)) continue;
    map.set(isin, {
      name: (cols[0] ?? "").trim(),
      industry: (cols[1] ?? "").trim(),
      symbol: (cols[2] ?? "").trim(),
    });
  }
  return map;
}

// EQUITY_L.csv schema:
//   SYMBOL, NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE,
//   MARKET LOT, ISIN NUMBER, FACE VALUE
function parseEquityL(csv) {
  const map = new Map();
  const lines = csv.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cols = line.split(",");
    const isin = cols[6]?.trim();
    if (!isValidIsin(isin)) continue;
    const series = (cols[2] ?? "").trim();
    // Skip anything that isn't tradable equity. The user asked for
    // "all NSE stocks" but derivative/preference/warrant series
    // aren't meaningful for portfolio cap classification.
    if (series !== "EQ" && series !== "BE" && series !== "BZ") continue;
    map.set(isin, {
      symbol: (cols[0] ?? "").trim(),
      name: (cols[1] ?? "").trim(),
      series,
    });
  }
  return map;
}

function isValidIsin(v) {
  return v && v.length === 12 && /^[A-Z0-9]+$/.test(v);
}

// Turns "20 Microns Limited" → "20-microns-limited"
// Same format as existing master rows' stock_search_id.
function slugify(name) {
  return (name || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[.,'’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ── Fetch sources ────────────────────────────────────────────────
//
// Fetching Nifty 50 and Nifty Next 50 separately (their union == Nifty
// 100) so we can tag N50 vs NN50 sub-classification on the way in.
// Matches the refresh route's classifyIsinDetailed contract — see
// lib/nseCapClassification.ts for the reasoning.
console.log("Fetching 6 CSVs from NSE…");
const n50Map = parseNiftyCsv(
  curlGet("https://www.niftyindices.com/IndexConstituent/ind_nifty50list.csv")
);
const nn50Map = parseNiftyCsv(
  curlGet(
    "https://www.niftyindices.com/IndexConstituent/ind_niftynext50list.csv"
  )
);
const midMap = parseNiftyCsv(
  curlGet(
    "https://www.niftyindices.com/IndexConstituent/ind_niftymidcap150list.csv"
  )
);
const smallMap = parseNiftyCsv(
  curlGet(
    "https://www.niftyindices.com/IndexConstituent/ind_niftysmallcap250list.csv"
  )
);
const microMap = parseNiftyCsv(
  curlGet(
    "https://www.niftyindices.com/IndexConstituent/ind_niftymicrocap250_list.csv"
  )
);
const universeMap = parseEquityL(
  curlGet("https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv")
);

console.log(
  `Sources → N50 ${n50Map.size} · NN50 ${nn50Map.size} · Mid ${midMap.size} · Small ${smallMap.size} · Micro ${microMap.size} · Universe ${universeMap.size}`
);

// ── Load existing ISINs from master ──────────────────────────────
console.log("\nLoading existing India-equity ISINs from master…");
const existingJson = execSync(
  `curl -sf "${SB_URL}/rest/v1/master_security_classification?region=eq.India&security_type=eq.Equity&select=isin" ` +
    `-H "apikey: ${SB_KEY}" -H "Authorization: Bearer ${SB_KEY}" ` +
    `-H "Range-Unit: items" -H "Range: 0-9999"`,
  { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }
);
const existing = new Set(JSON.parse(existingJson).map((r) => r.isin));
console.log(`Existing India-equity rows: ${existing.size}`);

// ── Compute new rows ─────────────────────────────────────────────
const newIsins = [...universeMap.keys()].filter((isin) => !existing.has(isin));
const today = new Date().toISOString().slice(0, 10);
const rows = [];
// Sub-tally for Large so a dry-run shows the N50/NN50 split even for
// backfilled-fresh rows (typically zero — Large-cap ISINs are usually
// already in master — but zero prints better than "N50 present but
// silent").
const byBucket = { Large: 0, LargeN50: 0, LargeNN50: 0, Mid: 0, Small: 0, Micro: 0, Nano: 0 };
const bySeries = { EQ: 0, BE: 0, BZ: 0 };

for (const isin of newIsins) {
  const u = universeMap.get(isin);
  let mcap = "Nano";
  let indexMembership = "";
  // Source uses the same canonical `nse-*` tags as the refresh route
  // (lib/nseCapClassification.ts::sourceTagFor). Keeps DB values
  // stable across tool boundaries — a stock classified by this
  // backfill and later re-classified by Refresh always ends up
  // with the same source string for its bucket.
  let source = "nse-equity-l";
  let rawSector = "";

  // Precedence matches classifyIsinDetailed: N50 → NN50 → Mid →
  // Small → Micro → Nano. Every new NSE stock should already NOT be
  // in master (that's what makes it "new"), but if a Nifty-indexed
  // stock somehow leaks in, this classifies it correctly rather
  // than defaulting to Nano.
  let ix;
  if ((ix = n50Map.get(isin))) {
    mcap = "Large";
    indexMembership = "N50";
    source = "nse-nifty50";
    rawSector = ix.industry;
    byBucket.LargeN50++;
  } else if ((ix = nn50Map.get(isin))) {
    mcap = "Large";
    indexMembership = "NN50";
    source = "nse-niftynext50";
    rawSector = ix.industry;
    byBucket.LargeNN50++;
  } else if ((ix = midMap.get(isin))) {
    mcap = "Mid";
    indexMembership = "Midcap150";
    source = "nse-midcap150";
    rawSector = ix.industry;
  } else if ((ix = smallMap.get(isin))) {
    mcap = "Small";
    indexMembership = "Smallcap250";
    source = "nse-smallcap250";
    rawSector = ix.industry;
  } else if ((ix = microMap.get(isin))) {
    mcap = "Micro";
    indexMembership = "Micro250";
    source = "nse-microcap250";
    rawSector = ix.industry;
  }
  byBucket[mcap]++;
  bySeries[u.series] = (bySeries[u.series] ?? 0) + 1;

  // Series annotation for non-standard listings — helps future
  // filtering ("show me only tradable stocks, no surveillance").
  let notes = "";
  if (u.series === "BE") notes = "series=BE (trade-to-trade)";
  else if (u.series === "BZ") notes = "series=BZ (surveillance)";

  rows.push({
    isin,
    company_name: u.name,
    security_type: "Equity",
    holding_level: "Individual",
    mcap_classification: mcap,
    region: "India",
    index_membership: indexMembership,
    symbol: u.symbol,
    morningstar_secid: "",
    groww_slugs: "",
    raw_sector: rawSector,
    raw_industry: "",
    macro_economic_sector: "",
    macro_economic_sector_code: "",
    taxonomy_sector: "",
    taxonomy_sector_code: "",
    stock_search_id: slugify(u.name),
    confidence: "nse-csv-derived",
    source,
    notes,
    last_updated: today,
  });
}

console.log(`\nNew rows to insert: ${rows.length}`);
console.log(`By bucket:`);
for (const [k, v] of Object.entries(byBucket)) console.log(`  ${k}: ${v}`);
console.log(`By series:`);
for (const [k, v] of Object.entries(bySeries)) console.log(`  ${k}: ${v}`);

if (rows.length === 0) {
  console.log("\nNothing to insert. Master already covers all NSE-listed EQ/BE/BZ stocks.");
  process.exit(0);
}

console.log("\nFirst 5 sample rows:");
for (const r of rows.slice(0, 5)) {
  console.log(
    `  ${r.symbol.padEnd(14)} ${r.mcap_classification.padEnd(6)} ${(r.company_name ?? "").slice(0, 40)}`
  );
}

if (!APPLY) {
  console.log("\n[DRY RUN] Nothing written. Re-run with --apply to insert.");
  process.exit(0);
}

// ── Batch insert ─────────────────────────────────────────────────
console.log("\nInserting in chunks of 500…");
const CHUNK_SIZE = 500;
let inserted = 0;
for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
  const chunk = rows.slice(i, i + CHUNK_SIZE);
  const tmpPath = `/tmp/nse-backfill-chunk-${i}.json`;
  writeFileSync(tmpPath, JSON.stringify(chunk));
  try {
    execSync(
      `curl -sfS -X POST "${SB_URL}/rest/v1/master_security_classification" ` +
        `-H "apikey: ${SB_KEY}" -H "Authorization: Bearer ${SB_KEY}" ` +
        `-H "Content-Type: application/json" ` +
        `-H "Prefer: resolution=ignore-duplicates,return=minimal" ` +
        `-d @${tmpPath}`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    inserted += chunk.length;
    console.log(`  Chunk ${i / CHUNK_SIZE + 1}: ${inserted}/${rows.length} inserted`);
  } catch (err) {
    console.error(`  Chunk ${i / CHUNK_SIZE + 1} failed:`, err.stderr?.toString() ?? err.message);
    process.exit(1);
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {}
  }
}

console.log("\nDone!");
