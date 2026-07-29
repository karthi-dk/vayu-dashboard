// One-shot backfill for US-equity cap classifications
// ====================================================
//
// Rewrites master_security_classification for every region='US',
// security_type='Equity' row:
//
//   mcap_classification = "US"          (one flat bucket for all)
//   index_membership    = "SP500" | "NASDAQ100" | "SP500+NASDAQ100" | ""
//   raw_sector          = from iShares payload (only if empty)
//
// The mcap column is intentionally a single "US" value — India's 5-way
// Large/Mid/Small/Micro/Nano split is diagnostic because Indian
// holdings span the full curve, but the user's US exposure is
// concentrated in S&P 500 + Nasdaq 100 (518 of 520 rows), so a size
// split would collapse to "Large: 518, everything else empty". Index
// membership is what actually distinguishes the tiers here.
//
// Per user (2026-07-18): "dont specify, call it US, thats it."
//
// One-shot semantics:
//   • Not wired into the Sync-page Refresh button.
//   • Not on any cron.
//   • Idempotent — safe to re-run whenever S&P/Nasdaq rebalance
//     (roughly annually). Will only touch rows whose classification
//     or index membership genuinely changed since last run.
//
// Usage
// -----
//   node scripts/backfill-us-cap-classifications.mjs           # dry-run
//   node scripts/backfill-us-cap-classifications.mjs --apply   # writes

import { readFileSync } from "node:fs";
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
        l
          .slice(i + 1)
          .trim()
          .replace(/^"|"$/g, ""),
      ];
    })
);
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!SB_URL || !SB_KEY) throw new Error("Missing Supabase env vars");

// ── iShares varnish API ──────────────────────────────────────────
// Same portfolio IDs and column-array shape used by lib/iSharesCapClassification.ts
// — duplicated here so this script can run standalone without the
// Next.js build. Any change to the JSON shape must be mirrored in both.
const PORTFOLIO_IDS = {
  sp500: 239726, // IVV — Core S&P 500
  nasdaq100: 351653, // iShares Nasdaq 100 (per user's URL)
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function iSharesUrl(portfolioId) {
  const params = new URLSearchParams({
    appSubType: "ISHARES",
    appType: "PRODUCT_PAGE",
    component: "holdings.all",
    locale: "en_US",
    portfolioId: String(portfolioId),
    targetSite: "us-ishares",
    userType: "individual",
    excludeContent: "true",
    includeConfig: "true",
  });
  return `https://www.ishares.com/varnish-api/blk-one01-product-data/product-data/api/v2/get-product-data?${params}`;
}

// Node's fetch trips over the corporate proxy's self-signed cert chain,
// same problem as the NSE backfill. curl doesn't care, so we shell out
// for every network call.
function curlJson(url) {
  const raw = execSync(`curl -sf -H "User-Agent: ${UA}" "${url}"`, {
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

function extractEtfMap(varnishJson) {
  const dp =
    varnishJson?.componentsByNameMap?.holdings?.containersByNameMap?.all
      ?.dataPointsByNameMap;
  const isins = dp?.isin?.value ?? [];
  const tickers = dp?.ticker?.value ?? [];
  const sectors = dp?.sectorName?.value ?? [];
  const secGroups = dp?.secGroup?.value ?? [];
  const map = new Map();
  for (let i = 0; i < isins.length; i++) {
    if (secGroups[i] && secGroups[i] !== "EQUITY") continue;
    const isin = isins[i];
    if (!isin || isin.length !== 12) continue;
    map.set(isin, {
      ticker: tickers[i] ?? null,
      sector: sectors[i] ?? "",
    });
  }
  return map;
}

console.log("Fetching iShares constituent data…");
const sp500Json = curlJson(iSharesUrl(PORTFOLIO_IDS.sp500));
const nas100Json = curlJson(iSharesUrl(PORTFOLIO_IDS.nasdaq100));
const sp500 = extractEtfMap(sp500Json);
const nas100 = extractEtfMap(nas100Json);
console.log(
  `Sources → S&P 500: ${sp500.size} ISINs · Nasdaq 100: ${nas100.size} ISINs`
);
console.log(
  `Fund names → ${sp500Json.fundName} · ${nas100Json.fundName}`
);

function classify(isin) {
  const inSp = sp500.get(isin);
  const inNas = nas100.get(isin);
  let indexMembership;
  if (inSp && inNas) indexMembership = "SP500+NASDAQ100";
  else if (inSp) indexMembership = "SP500";
  else if (inNas) indexMembership = "NASDAQ100";
  else indexMembership = "";
  return {
    // Same bucket for every US row — per user, mcap should just say "US".
    // Index detail is preserved in indexMembership for slicing.
    bucket: "US",
    indexMembership,
    rawSector: inSp?.sector ?? inNas?.sector ?? "",
  };
}

// ── Load current US equity rows from master ──────────────────────
console.log("\nLoading US equity rows from master…");
const master = [];
for (let offset = 0; ; offset += 1000) {
  const chunk = execSync(
    `curl -sf "${SB_URL}/rest/v1/master_security_classification?region=eq.US&security_type=eq.Equity&select=isin,symbol,company_name,mcap_classification,index_membership,raw_sector" ` +
      `-H "apikey: ${SB_KEY}" -H "Authorization: Bearer ${SB_KEY}" ` +
      `-H "Range-Unit: items" -H "Range: ${offset}-${offset + 999}"`,
    { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }
  );
  const rows = JSON.parse(chunk);
  master.push(...rows);
  if (rows.length < 1000) break;
}
console.log(`Loaded ${master.length} US equity rows`);

// ── Build update plan ────────────────────────────────────────────
const moves = [];
// Every row lands in the same "US" bucket; the interesting dimension
// is index membership, which is what the by-tier tally reflects.
const byBucket = { US: 0 };
const byIndex = { SP500: 0, NASDAQ100: 0, "SP500+NASDAQ100": 0, "": 0 };
const updates = []; // { isin, mcap, indexMembership, sector }

for (const row of master) {
  const c = classify(row.isin);
  byBucket[c.bucket]++;
  byIndex[c.indexMembership]++;

  const prevMcap = (row.mcap_classification ?? "").trim() || null;
  const prevIdx = (row.index_membership ?? "").trim() || null;
  const changed =
    prevMcap !== c.bucket ||
    prevIdx !== (c.indexMembership || null) ||
    // Only backfill sector when we have real data AND master is empty —
    // never overwrite a hand-curated sector value that's already there.
    (!row.raw_sector && c.rawSector);

  if (changed) {
    moves.push({
      symbol: row.symbol,
      company_name: row.company_name,
      from_mcap: prevMcap,
      to_mcap: c.bucket,
      from_idx: prevIdx,
      to_idx: c.indexMembership || null,
      sector_before: row.raw_sector || null,
      sector_after: c.rawSector || row.raw_sector || null,
    });
    updates.push({
      isin: row.isin,
      mcap: c.bucket,
      indexMembership: c.indexMembership,
      // Preserve any existing sector unless it's empty.
      sector: row.raw_sector || c.rawSector,
    });
  }
}

console.log(`\nTarget distribution:`);
for (const [k, v] of Object.entries(byBucket)) console.log(`  ${k}: ${v}`);
console.log(`By index_membership:`);
for (const [k, v] of Object.entries(byIndex))
  console.log(`  ${k || "(not indexed)"}: ${v}`);

console.log(`\nRows to update: ${updates.length}`);
console.log(`First 15 moves:`);
for (const m of moves.slice(0, 15)) {
  console.log(
    `  ${(m.symbol ?? "").padEnd(10)} ${(m.from_mcap ?? "—").padEnd(8)} → ${m.to_mcap.padEnd(4)} · idx: ${(m.from_idx ?? "—").padEnd(16)} → ${m.to_idx ?? "—"}`
  );
}

// Surface any rows that fall outside both target indices — the user
// asked for SP500 + Nasdaq 100 only, so anything else is worth flagging
// but is not a bug (just held via a broader international MF).
const notIndexed = moves.filter((x) => !x.to_idx);
if (notIndexed.length > 0) {
  console.log(`\nStocks not in SP500 or Nasdaq 100 (mcap="US", index=""):`);
  for (const m of notIndexed) {
    console.log(`  ${(m.symbol ?? "").padEnd(10)} ${m.company_name}`);
  }
}

if (!APPLY) {
  console.log("\n[DRY RUN] Nothing written. Re-run with --apply to update.");
  process.exit(0);
}

if (updates.length === 0) {
  console.log("\nNothing to update.");
  process.exit(0);
}

// ── Apply — group by (mcap, indexMembership) so we can batch PATCH ──
//
// Supabase PostgREST supports .in('isin', [...]) with a single value in
// the SET clause. So we bucket updates by their (mcap, indexMembership)
// pair, then issue one PATCH per bucket with the ISIN list. For 520
// rows this collapses to typically ≤4 network calls.
const today = new Date().toISOString().slice(0, 10);
const buckets = new Map();
for (const u of updates) {
  const key = `${u.mcap}|${u.indexMembership}`;
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key).push(u);
}

console.log(`\nApplying ${buckets.size} PATCH batches…`);
for (const [key, group] of buckets) {
  const [mcap, indexMembership] = key.split("|");
  const isinList = group.map((g) => `"${g.isin}"`).join(",");
  const payload = {
    mcap_classification: mcap,
    index_membership: indexMembership || "",
    source: indexMembership
      ? "iShares (IVV + Nasdaq 100)"
      : "iShares (not in target indices)",
    confidence: "ishares-derived",
    last_updated: today,
  };
  try {
    execSync(
      `curl -sfS -X PATCH "${SB_URL}/rest/v1/master_security_classification?isin=in.(${isinList})" ` +
        `-H "apikey: ${SB_KEY}" -H "Authorization: Bearer ${SB_KEY}" ` +
        `-H "Content-Type: application/json" ` +
        `-H "Prefer: return=minimal" ` +
        `-d '${JSON.stringify(payload).replace(/'/g, "'\\''")}'`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    console.log(
      `  ✓ ${group.length.toString().padStart(3)} rows → mcap=${mcap} · index=${indexMembership || "(none)"}`
    );
  } catch (err) {
    console.error(
      `  ✗ Batch ${key} failed:`,
      err.stderr?.toString() ?? err.message
    );
    process.exit(1);
  }
}

console.log("\nDone!");
