// One-time (re-runnable) ingest of the iShares Core MSCI World UCITS ETF
// holdings as HDFC_INTL_DM's look-through. Foreign developed-markets names
// not already in master_security_classification get inserted (region tagged
// 'International' so the fund modal buckets them as Intl); the ETF constituents
// are then written as fund_holdings_detail for HDFC_INTL_DM.
//
// Source file: /tmp/msci_ucits.json (iShares get-product-data payload).
// Run from the repo root:  node scripts/ingest-hdfc-intl-lookthrough.mjs [--apply]
import { readFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const FUND_CODE = "HDFC_INTL_DM";
const AS_OF = "2026-08-31";
const SRC = "ishares-msci-world";
const SRC_FILE = "/tmp/msci_ucits.json";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, authorization: `Bearer ${KEY}`, "content-type": "application/json" };

// ── Parse iShares columnar payload ──
const j = JSON.parse(readFileSync(SRC_FILE, "utf8"));
const dp = j.componentsByNameMap.holdings.containersByNameMap.all.dataPointsByNameMap;
const col = (k) => dp[k]?.value ?? [];
const isin = col("isin"), name = col("issueName"), pct = col("holdingPercent"),
  sec = col("sectorName"), ctry = col("countryOfRisk"), tkr = col("ticker"), ac = col("assetClass");
const num = (v) => (typeof v === "object" && v != null ? Number(v.value ?? 0) : Number(v ?? 0));

const holdings = [];
for (let i = 0; i < isin.length; i++) {
  const id = String(isin[i] || "").trim();
  if (!id) continue; // skip cash / futures (no ISIN)
  if (String(ac[i] || "") !== "Equity") continue; // equities only
  const w = num(pct[i]);
  if (w <= 0) continue;
  holdings.push({
    isin: id,
    name: String(name[i] || "").trim(),
    wt: w,
    sec: String(sec[i] || "").trim(),
    ctry: String(ctry[i] || "").trim(),
    tkr: String(tkr[i] || "").trim(),
  });
}
const totalWt = holdings.reduce((s, h) => s + h.wt, 0);
console.log(`parsed ${holdings.length} equity holdings · total weight ${totalWt.toFixed(2)}%`);

// ── Which ISINs already exist in master ──
const uniqIsins = [...new Set(holdings.map((h) => h.isin))];
const have = new Set();
for (let i = 0; i < uniqIsins.length; i += 180) {
  const c = uniqIsins.slice(i, i + 180).map((x) => `"${x}"`).join(",");
  const m = await (await fetch(`${URL}/rest/v1/master_security_classification?select=isin&isin=in.(${c})`, { headers: H })).json();
  (Array.isArray(m) ? m : []).forEach((x) => have.add(x.isin));
}
// De-dupe new rows by ISIN (keep the highest-weight occurrence).
const newByIsin = new Map();
for (const h of holdings) {
  if (have.has(h.isin)) continue;
  const prev = newByIsin.get(h.isin);
  if (!prev || h.wt > prev.wt) newByIsin.set(h.isin, h);
}
const newRows = [...newByIsin.values()].map((h) => ({
  isin: h.isin,
  company_name: h.name,
  symbol: h.tkr || null,
  security_type: "Equity",
  holding_level: "Individual",
  // App models foreign equity via the region/mcap 'US' bucket (the fund modal
  // buckets Intl on region==='US' || mcap==='US'). True country is in notes;
  // these rows are excluded from the US cap-classification tile by source.
  mcap_classification: "US",
  region: h.ctry === "United States" ? "US" : "International",
  country: h.ctry || null,
  index_membership: "MSCI World",
  raw_sector: h.sec || null,
  macro_economic_sector: h.sec || null,
  morningstar_secid: "",
  groww_slugs: "",
  confidence: "ishares-derived",
  source: SRC,
  notes: `MSCI World UCITS constituent (${h.ctry}); asOf ${AS_OF}`,
  last_updated: "2026-09-02",
}));
console.log(`master: ${have.size} already exist · ${newRows.length} to insert`);

// ── fund_holdings_detail rows for HDFC ──
const detailRows = holdings.map((h) => ({
  fund_code: FUND_CODE,
  isin: h.isin,
  company_name: h.name,
  security_type: "Equity",
  weighting_pct: h.wt,
  portfolio_date: AS_OF,
  extracted_at: new Date().toISOString(),
}));
console.log(`fund_holdings_detail: ${detailRows.length} rows for ${FUND_CODE} (coverage ~${totalWt.toFixed(1)}%)`);

if (!APPLY) {
  console.log("\nDRY RUN — re-run with --apply to write. Sample new master row:");
  console.log(JSON.stringify(newRows[0], null, 1));
  process.exit(0);
}

async function post(path, body, prefer) {
  const res = await fetch(`${URL}/rest/v1/${path}`, {
    method: "POST",
    headers: { ...H, Prefer: prefer ?? "return=minimal" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
}

// 1) Insert new master rows (ignore-duplicates guards against races).
let ins = 0;
for (let i = 0; i < newRows.length; i += 200) {
  const batch = newRows.slice(i, i + 200);
  await post("master_security_classification", batch, "return=minimal,resolution=ignore-duplicates");
  ins += batch.length;
  process.stdout.write(`  master inserted ${ins}/${newRows.length}\r`);
}
console.log(`\nmaster inserted: ${ins}`);

// 2) Replace HDFC's fund_holdings_detail.
const del = await fetch(`${URL}/rest/v1/fund_holdings_detail?fund_code=eq.${FUND_CODE}`, { method: "DELETE", headers: H });
if (!del.ok) throw new Error(`delete detail -> ${del.status} ${await del.text()}`);
let dins = 0;
for (let i = 0; i < detailRows.length; i += 200) {
  const batch = detailRows.slice(i, i + 200);
  await post("fund_holdings_detail", batch, "return=minimal");
  dins += batch.length;
  process.stdout.write(`  detail inserted ${dins}/${detailRows.length}\r`);
}
console.log(`\ndetail inserted: ${dins}`);
console.log("DONE.");
