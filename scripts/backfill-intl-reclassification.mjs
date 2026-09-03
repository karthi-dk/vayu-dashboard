// One-shot International reclassification backfill
// ================================================
//
// Retroactively moves ICICI Nasdaq-100 out of the MF slice and into the
// new International slice across the observed nw_daily window, so the MF
// and International period grids are continuous instead of stepping by
// ~₹1L on the switch date.
//
// WHAT IT DOES (per nw_daily row where intl_value IS NULL)
// -------------------------------------------------------
//   • Reconstructs ICICI's value that day = current units × ICICI NAV
//     (mfapi.in scheme 149219, carry-forward for weekends/holidays).
//   • intl_value    := ICICI value        (+ intl_invested := ICICI cost)
//   • mf_value      := mf_value − ICICI value   (it was counted in MF)
//   • mf_invested   := mf_invested − ICICI cost
//   • total_nw      UNCHANGED — this is a reclassification, not a new
//     deposit. Safe: the headline net worth never moves.
//
// HDFC GIFT City is intentionally NOT backfilled here — it's a days-old
// NFO (27-Aug), so its history is negligible; it enters from its seed +
// the forward recomputeNwDaily. Today's row is owned by recompute (its
// intl_value is already set), so the `intl_value IS NULL` filter skips it.
//
// NOTE ON UNITS
// -------------
// ICICI is a monthly SIP — units grow over time. We reconstruct units AND
// net cost AT EACH DATE from mf_transactions (signed cumsum), never a
// constant current-units snapshot (that overstated early rows). The split
// is rebuilt from the ORIGINAL MF total (current mf_value + current
// intl_value), so re-running self-corrects any prior write.
//
// SAFETY
// ------
// Dry-run by default; nothing is written without --apply. Idempotent
// (only touches rows where intl_value IS NULL), so re-running is safe.
//
// Usage (from the Mac dev box, behind the corporate proxy)
// --------------------------------------------------------
//   NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/backfill-intl-reclassification.mjs
//   NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/backfill-intl-reclassification.mjs --apply

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const APPLY = process.argv.includes("--apply");

const __dirname = dirname(fileURLToPath(import.meta.url));
const envRaw = readFileSync(join(__dirname, "..", ".env.local"), "utf8");
const env = Object.fromEntries(
  envRaw
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")];
    })
);
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY =
  env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_KEY;
if (!SB_URL || !SB_KEY) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_KEY");
}
const SB_HEADERS = {
  apikey: SB_KEY,
  authorization: `Bearer ${SB_KEY}`,
  "content-type": "application/json",
};

const ICICI_FUND_CODE = "ICICI_NASDAQ";
const ICICI_SCHEME = "149219";

// carry-forward: latest value with date <= target, from a date-sorted array
function carryForward(sorted, target) {
  let val = null;
  for (const [d, v] of sorted) {
    if (d <= target) val = v;
    else break;
  }
  return val;
}

async function main() {
  // 1. ICICI unit + cost timeline from the transaction ledger (signed
  //    cumsum). ICICI is a monthly SIP, so units grow over time — we use
  //    units-AT-THE-DATE, not a constant current-units snapshot.
  const tx = await fetch(
    `${SB_URL}/rest/v1/mf_transactions?fund_code=eq.${ICICI_FUND_CODE}&select=tx_date,tx_type,units,amount,platform&order=tx_date.asc`,
    { headers: SB_HEADERS }
  ).then((r) => r.json());
  let cumU = 0, cumC = 0;
  const unitsAt = [], costAt = [];
  for (const t of tx) {
    if (t.platform === "test") continue; // test rows never touch holdings
    const sign = /redemption|sell|switch_out/i.test(t.tx_type) ? -1 : 1;
    cumU += sign * Number(t.units || 0);
    cumC += sign * Number(t.amount || 0);
    unitsAt.push([t.tx_date, cumU]);
    costAt.push([t.tx_date, cumC]);
  }
  console.log(`ICICI timeline: ${unitsAt.length} txns → ${cumU.toFixed(4)} units, cost ₹${Math.round(cumC).toLocaleString("en-IN")}`);

  // 2. ICICI NAV history from mfapi.in (DD-MM-YYYY → ISO).
  const navJson = await fetch(`https://api.mfapi.in/mf/${ICICI_SCHEME}`).then((r) => r.json());
  const navByDate = new Map();
  for (const r of navJson.data ?? []) {
    const m = String(r.date).match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (!m) continue;
    navByDate.set(`${m[3]}-${m[2]}-${m[1]}`, Number(r.nav));
  }
  const navSorted = [...navByDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  console.log(`ICICI NAV history: ${navSorted.length} points (${navSorted[0]?.[0]} → ${navSorted.at(-1)?.[0]})`);

  // 3. nw_daily rows before TODAY (IST) — today is owned by
  //    recomputeNwDaily (it sums both intl funds incl HDFC). We re-read
  //    intl_value too so the split can be rebuilt from the original MF
  //    total (self-correcting).
  const istToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const nwRes = await fetch(
    `${SB_URL}/rest/v1/nw_daily?date=lt.${istToday}&select=date,mf_value,mf_invested,intl_value,intl_invested,total_nw&order=date.asc`,
    { headers: SB_HEADERS }
  );
  const nwRows = await nwRes.json();
  if (!Array.isArray(nwRows)) throw new Error(`nw_daily read failed: ${JSON.stringify(nwRows)}`);
  console.log(`nw_daily rows (before ${istToday}): ${nwRows.length}\n`);

  let changed = 0, maxShift = 0;
  console.log("date        old intl → new intl       Δ       new mf");
  for (const row of nwRows) {
    const units = carryForward(unitsAt, row.date);
    const cost = carryForward(costAt, row.date);
    const nav = carryForward(navSorted, row.date);
    if (units == null || nav == null) continue; // before ICICI existed

    const iciciValue = Number((units * nav).toFixed(2));
    const iciciCost = Number((cost ?? 0).toFixed(2));
    // Self-correcting: rebuild the original MF total, then re-split.
    const originalMf = Number(row.mf_value || 0) + Number(row.intl_value || 0);
    const originalMfInv =
      Number(row.mf_invested || 0) + Number(row.intl_invested || 0);
    const newMf = Number(Math.max(0, originalMf - iciciValue).toFixed(2));
    const newMfInv = Number(Math.max(0, originalMfInv - iciciCost).toFixed(2));
    const intlGainPct =
      iciciCost > 0 ? Number((((iciciValue - iciciCost) / iciciCost) * 100).toFixed(2)) : 0;
    const mfGainPct =
      newMfInv > 0 ? Number((((newMf - newMfInv) / newMfInv) * 100).toFixed(2)) : 0;

    const shift = Math.abs(Number(row.intl_value || 0) - iciciValue);
    if (shift > maxShift) maxShift = shift;
    console.log(
      `${row.date}  ${String(Math.round(Number(row.intl_value || 0))).padStart(7)} → ${String(Math.round(iciciValue)).padStart(7)}  ${String(Math.round(iciciValue - Number(row.intl_value || 0))).padStart(7)}  ${String(Math.round(newMf)).padStart(9)}${shift > 1 ? " *" : ""}`
    );

    if (APPLY) {
      const patch = await fetch(`${SB_URL}/rest/v1/nw_daily?date=eq.${row.date}`, {
        method: "PATCH",
        headers: { ...SB_HEADERS, Prefer: "return=minimal" },
        body: JSON.stringify({
          intl_value: iciciValue,
          intl_invested: iciciCost,
          intl_gain_pct: intlGainPct,
          mf_value: newMf,
          mf_invested: newMfInv,
          mf_gain_pct: mfGainPct,
        }),
      });
      if (!patch.ok) {
        console.error(`  PATCH ${row.date} failed: ${patch.status} ${await patch.text()}`);
      } else {
        changed++;
      }
    }
  }

  console.log(`\nmax intl shift vs current: ₹${Math.round(maxShift).toLocaleString("en-IN")}`);
  console.log(
    APPLY ? `Applied ${changed} row updates.` : "Dry-run — no writes. Re-run with --apply to commit."
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
