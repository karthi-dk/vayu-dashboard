// Backfill master_security_classification.country and re-region the non-US
// iShares MSCI World constituents from the region='US' bucket to
// region='International'. Run AFTER applying
// migrations/2026-09-02-master-country-region.sql.
//
//   node scripts/backfill-master-country.mjs           # dry run
//   node scripts/backfill-master-country.mjs --apply   # write
//
// Rules:
//   • India rows                          -> country = 'India' (region unchanged)
//   • pre-existing US (SP500/Nasdaq)      -> country = 'United States'
//   • iShares MSCI World rows             -> country parsed from notes "(X)";
//       region = 'US' if country is United States, else 'International'
import { readFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
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
const H = { apikey: KEY, authorization: `Bearer ${KEY}` };
const T = "master_security_classification";

// ── Fetch iShares constituents (isin + notes) to parse their country ──
const ishares = [];
for (let from = 0; ; from += 1000) {
  const page = await (
    await fetch(`${URL}/rest/v1/${T}?select=isin,notes&source=eq.ishares-msci-world`, {
      headers: { ...H, Range: `${from}-${from + 999}` },
    })
  ).json();
  if (!Array.isArray(page) || page.length === 0) break;
  ishares.push(...page);
  if (page.length < 1000) break;
}
const parseCountry = (notes) => {
  const m = /\(([^)]+)\)/.exec(notes || "");
  return m ? m[1].trim() : "Other";
};
// Group by (country, target region).
const groups = new Map();
for (const r of ishares) {
  const country = parseCountry(r.notes);
  const region = country === "United States" ? "US" : "International";
  const k = `${country}|${region}`;
  if (!groups.has(k)) groups.set(k, { country, region, isins: [] });
  groups.get(k).isins.push(r.isin);
}

const cnt = async (q) => {
  const r = await fetch(`${URL}/rest/v1/${T}?${q}`, {
    headers: { ...H, Prefer: "count=exact", Range: "0-0" },
  });
  return (r.headers.get("content-range") || "*/?").split("/")[1];
};
const indiaCount = await cnt("select=isin&region=eq.India");
const preUsCount = await cnt("select=isin&region=eq.US&source=not.eq.ishares-msci-world");

console.log(`iShares constituents: ${ishares.length} in ${groups.size} country groups`);
console.log(`India rows -> 'India': ${indiaCount}`);
console.log(`pre-existing US rows -> 'United States': ${preUsCount}`);
console.log("iShares groups:");
for (const g of [...groups.values()].sort((a, b) => b.isins.length - a.isins.length)) {
  console.log(`  ${g.country.padEnd(18)} region=${g.region.padEnd(14)} ${g.isins.length}`);
}

if (!APPLY) {
  console.log("\nDRY RUN — re-run with --apply to write.");
  process.exit(0);
}

async function patch(query, body) {
  const res = await fetch(`${URL}/rest/v1/${T}?${query}`, {
    method: "PATCH",
    headers: { ...H, "content-type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${query} -> ${res.status} ${await res.text()}`);
}

// 1) India (single filtered update).
await patch("region=eq.India", { country: "India" });
console.log(`India updated (${indiaCount})`);
// 2) Pre-existing US (single filtered update).
await patch("region=eq.US&source=not.eq.ishares-msci-world", { country: "United States" });
console.log(`pre-existing US updated (${preUsCount})`);
// 3) iShares — per country group, chunked by isin.
for (const g of groups.values()) {
  for (let i = 0; i < g.isins.length; i += 150) {
    const chunk = g.isins.slice(i, i + 150).map((x) => `"${x}"`).join(",");
    await patch(`isin=in.(${chunk})`, { country: g.country, region: g.region });
  }
  console.log(`  ${g.country} -> region=${g.region} (${g.isins.length})`);
}
console.log("DONE.");
