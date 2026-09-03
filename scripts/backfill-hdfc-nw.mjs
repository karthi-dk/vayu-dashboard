// scripts/backfill-hdfc-nw.mjs
//
// One-time: fold HDFC_INTL_DM's daily value into historical nw_daily rows from
// its 27-Aug allotment through the day before it entered nw_daily (its seed
// landed 2026-09-02). Fixes the artificial ~₹4.8L jump on 02-Sep by moving that
// step back to the allotment date, where it belongs (a deposit on 27-Aug).
//
//   new intl_value    = old + HDFC daily value
//   new intl_invested = old + HDFC invested (constant)
//   new total_nw      = old + HDFC daily value
//   new intl_gain_pct = (intl_value - intl_invested) / intl_invested
//
// Idempotent: skips any row whose intl_invested already includes HDFC.
// Dry-run by default; pass --apply to write. NEEDS the dev server running
// (uses /api/intl-nav-series for HDFC's exact daily value = 50 × purchase NAV ×
// FX, so the backfill matches the chart). Run:
//   NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/backfill-hdfc-nw.mjs           (dry-run)
//   NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/backfill-hdfc-nw.mjs --apply
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";

const APPLY = process.argv.includes("--apply");
const FUND = "HDFC_INTL_DM";
const GAP_FROM = "2026-08-27"; // allotment / first NAV
const GAP_TO = "2026-09-01"; // last day before HDFC entered nw_daily (02-Sep seed)
const APP = "http://127.0.0.1:5000";
const HDFC_MARKER = 500000; // intl_invested >= this ⇒ HDFC already folded in

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" };

const pl = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
const sig = createHmac("sha256", env.APP_SESSION_SECRET).update(pl).digest().toString("base64url");
const cookie = `vayu-session=${pl}.${sig}`;

// 1) HDFC daily value (50 × purchase NAV × FX) per date, from the chart's API.
const series = await (await fetch(`${APP}/api/intl-nav-series?fund=${FUND}`, { headers: { cookie } })).json();
if (!series.ok) throw new Error("intl-nav-series failed: " + JSON.stringify(series));
const pts = series.points || [];
const dates = pts.map((p) => p.date).sort();
const valByDate = new Map(pts.map((p) => [p.date, p.valueInr]));
const hdfcOnOrBefore = (d) => {
  let ans = null;
  for (const k of dates) {
    if (k <= d) ans = valByDate.get(k);
    else break;
  }
  return ans;
};

// 2) HDFC invested (constant) from fund_holdings.
const fh = await (await fetch(`${url}/rest/v1/fund_holdings?select=invested_inr&fund_code=eq.${FUND}`, { headers: H })).json();
const HDFC_INVESTED = Number(fh?.[0]?.invested_inr ?? 0);
if (!(HDFC_INVESTED > 0)) throw new Error("could not read HDFC invested_inr");

// 3) nw_daily gap rows.
const rows = await (
  await fetch(
    `${url}/rest/v1/nw_daily?select=date,intl_value,intl_invested,total_nw&date=gte.${GAP_FROM}&date=lte.${GAP_TO}&order=date.asc`,
    { headers: H }
  )
).json();

console.log(`HDFC invested ₹${HDFC_INVESTED.toLocaleString("en-IN")} · ${rows.length} nw_daily rows in [${GAP_FROM}, ${GAP_TO}]\n`);
console.log("date        +hdfc     intl_value old→new        total_nw old→new");
const toApply = [];
for (const r of rows) {
  if (Number(r.intl_invested) >= HDFC_MARKER) {
    console.log(`${r.date}  (already has HDFC — skip)`);
    continue;
  }
  const hv = hdfcOnOrBefore(r.date);
  if (hv == null) {
    console.log(`${r.date}  (no HDFC value ≤ date — skip)`);
    continue;
  }
  const newIntlVal = Number(r.intl_value) + hv;
  const newIntlInv = Number(r.intl_invested) + HDFC_INVESTED;
  const newTotal = Number(r.total_nw) + hv;
  const gainPct = newIntlInv > 0 ? ((newIntlVal - newIntlInv) / newIntlInv) * 100 : 0;
  console.log(
    `${r.date}  ${hv.toFixed(0).padStart(7)}   ${Number(r.intl_value).toFixed(0)} → ${newIntlVal.toFixed(0)}      ${Number(r.total_nw).toFixed(0)} → ${newTotal.toFixed(0)}`
  );
  toApply.push({
    date: r.date,
    intl_value: Number(newIntlVal.toFixed(2)),
    intl_invested: Number(newIntlInv.toFixed(2)),
    total_nw: Number(newTotal.toFixed(2)),
    intl_gain_pct: Number(gainPct.toFixed(2)),
  });
}

if (!APPLY) {
  console.log(`\nDRY-RUN — ${toApply.length} rows would change. Re-run with --apply to write.`);
  process.exit(0);
}
for (const u of toApply) {
  const res = await fetch(`${url}/rest/v1/nw_daily?date=eq.${u.date}`, {
    method: "PATCH",
    headers: { ...H, prefer: "return=minimal" },
    body: JSON.stringify({
      intl_value: u.intl_value,
      intl_invested: u.intl_invested,
      total_nw: u.total_nw,
      intl_gain_pct: u.intl_gain_pct,
    }),
  });
  console.log(`PATCH ${u.date}: ${res.status}`);
}
console.log(`\nApplied ${toApply.length} rows.`);
