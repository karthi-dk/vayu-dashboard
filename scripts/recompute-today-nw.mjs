// One-shot: recompute today's nw_daily row from live fund_holdings.
//
// PURPOSE
// -------
// After the 2026-07-27 fixes that make recomputeNwDaily auto-derive:
//   • mf_1d_change_inr from fund_holdings.one_day_change_inr
//   • nps_1d_change_inr from nps_state (Σ units × ΔNAV per scheme)
// this script pulls the trigger once so today's already-written row
// picks up the corrected 1D values without waiting for the next NAV
// refresh or the next transaction log.
//
// It's a NARROW port of lib/recomputeNwDaily.ts's payload builder —
// same formulas, same guards — talking to the Supabase REST API
// directly so it can run as a plain .mjs (no TypeScript build step,
// no next-server bootstrap).
//
// Usage
// -----
//   node scripts/recompute-today-nw.mjs           # dry-run (preview payload)
//   node scripts/recompute-today-nw.mjs --apply   # actually upsert

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
        l.slice(i + 1).trim().replace(/^"|"$/g, ""),
      ];
    })
);
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_KEY;
if (!SB_URL || !SB_KEY) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_KEY");
}

function sbGet(path) {
  const raw = execSync(
    `curl -sf "${SB_URL}/rest/v1/${path}" ` +
      `-H "apikey: ${SB_KEY}" -H "Authorization: Bearer ${SB_KEY}"`,
    { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }
  );
  return JSON.parse(raw);
}

function sbUpsert(path, row, onConflict) {
  const bodyFile = `/tmp/nwrec_${Date.now()}.json`;
  execSync(`cat > "${bodyFile}" << 'EOF'\n${JSON.stringify(row)}\nEOF`, {
    shell: "/bin/bash",
  });
  try {
    const raw = execSync(
      `curl -sf -X POST "${SB_URL}/rest/v1/${path}?on_conflict=${onConflict}" ` +
        `-H "apikey: ${SB_KEY}" -H "Authorization: Bearer ${SB_KEY}" ` +
        `-H "Content-Type: application/json" ` +
        `-H "Prefer: resolution=merge-duplicates,return=representation" ` +
        `--data @${bodyFile}`,
      { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }
    );
    return JSON.parse(raw);
  } finally {
    try {
      execSync(`rm -f "${bodyFile}"`);
    } catch {
      // best-effort cleanup
    }
  }
}

function istDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  const d = parts.find((p) => p.type === "day").value;
  return `${y}-${m}-${d}`;
}

function fmtInr(n) {
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

async function main() {
  console.log(
    `── Recompute today's nw_daily ${APPLY ? "(APPLY)" : "(dry-run)"} ──`
  );

  const today = istDate();
  console.log(`Target date (IST): ${today}`);

  const [funds, nps, epf, existing] = await Promise.all([
    sbGet(
      "fund_holdings?select=current_value_inr,invested_inr,cap_type,one_day_change_inr,asset_class"
    ),
    sbGet(
      "nps_state?select=scheme_e_units,scheme_c_units,scheme_g_units,scheme_e_nav,scheme_c_nav,scheme_g_nav,scheme_e_nav_prev,scheme_c_nav_prev,scheme_g_nav_prev&id=eq.1"
    ),
    sbGet(
      "epf_state?select=balance_inr,fy_interest_pending_inr&id=eq.1"
    ),
    sbGet(`nw_daily?select=*&date=eq.${today}`),
  ]);

  // International (asset_class='intl') is a separate top-level asset class —
  // split so mf_* and intl_* never double-count. Mirrors lib/recomputeNwDaily.ts.
  const mfRows = funds.filter((f) => f.asset_class !== "intl");
  const intlRows = funds.filter((f) => f.asset_class === "intl");
  const mfValue = mfRows.reduce(
    (s, f) => s + Number(f.current_value_inr ?? 0),
    0
  );
  const mfInvested = mfRows.reduce(
    (s, f) => s + Number(f.invested_inr ?? 0),
    0
  );
  const intlValue = intlRows.reduce(
    (s, f) => s + Number(f.current_value_inr ?? 0),
    0
  );
  const intlInvested = intlRows.reduce(
    (s, f) => s + Number(f.invested_inr ?? 0),
    0
  );
  const mfEquity = mfRows
    .filter((f) => (f.cap_type ?? "large") !== "debt")
    .reduce((s, f) => s + Number(f.current_value_inr ?? 0), 0);
  const mfDebt = mfRows
    .filter((f) => f.cap_type === "debt")
    .reduce((s, f) => s + Number(f.current_value_inr ?? 0), 0);

  const npsRow = nps[0];
  const npsValue = npsRow
    ? npsRow.scheme_e_units * npsRow.scheme_e_nav +
      npsRow.scheme_c_units * npsRow.scheme_c_nav +
      npsRow.scheme_g_units * npsRow.scheme_g_nav
    : 0;

  const epfRow = epf[0];
  const epfEstimate = epfRow
    ? Number(epfRow.balance_inr) + Number(epfRow.fy_interest_pending_inr ?? 0)
    : 0;

  const totalNw = mfValue + npsValue + epfEstimate + intlValue;
  const mfGainPct =
    mfInvested > 0 ? ((mfValue - mfInvested) / mfInvested) * 100 : 0;
  const intlGainPct =
    intlInvested > 0 ? ((intlValue - intlInvested) / intlInvested) * 100 : 0;

  // MF 1D derivation — same guards as lib/recomputeNwDaily.ts (MF rows only)
  const hasAnyFund1D = mfRows.some((f) => f.one_day_change_inr != null);
  const derivedMf1dInr = hasAnyFund1D
    ? mfRows.reduce((s, f) => s + Number(f.one_day_change_inr ?? 0), 0)
    : null;
  const derivedMf1dPct =
    derivedMf1dInr != null && mfValue - derivedMf1dInr > 0
      ? (derivedMf1dInr / (mfValue - derivedMf1dInr)) * 100
      : null;

  // International 1D — Σ one_day_change_inr over intl rows.
  const hasAnyIntl1D = intlRows.some((f) => f.one_day_change_inr != null);
  const derivedIntl1dInr = hasAnyIntl1D
    ? intlRows.reduce((s, f) => s + Number(f.one_day_change_inr ?? 0), 0)
    : null;
  const derivedIntl1dPct =
    derivedIntl1dInr != null && intlValue - derivedIntl1dInr > 0
      ? (derivedIntl1dInr / (intlValue - derivedIntl1dInr)) * 100
      : null;

  // NPS 1D derivation — same guards as lib/recomputeNwDaily.ts
  let derivedNps1dInr = null;
  if (npsRow) {
    const schemes = [
      [npsRow.scheme_e_units, npsRow.scheme_e_nav, npsRow.scheme_e_nav_prev],
      [npsRow.scheme_c_units, npsRow.scheme_c_nav, npsRow.scheme_c_nav_prev],
      [npsRow.scheme_g_units, npsRow.scheme_g_nav, npsRow.scheme_g_nav_prev],
    ];
    const usable = schemes.filter(
      ([u, , prev]) => u > 0 && prev != null && Number.isFinite(prev)
    );
    if (usable.length > 0) {
      derivedNps1dInr = usable.reduce(
        (sum, [u, nav, prev]) => sum + u * (nav - Number(prev)),
        0
      );
    }
  }
  const derivedNps1dPct =
    derivedNps1dInr != null && npsValue - derivedNps1dInr > 0
      ? (derivedNps1dInr / (npsValue - derivedNps1dInr)) * 100
      : null;

  const row = {
    date: today,
    mf_value: Number(mfValue.toFixed(2)),
    mf_invested: Number(mfInvested.toFixed(2)),
    mf_equity_inr: Number(mfEquity.toFixed(2)),
    mf_debt_inr: Number(mfDebt.toFixed(2)),
    nps_value: Number(npsValue.toFixed(2)),
    epf_estimate: Number(epfEstimate.toFixed(2)),
    intl_value: Number(intlValue.toFixed(2)),
    intl_invested: Number(intlInvested.toFixed(2)),
    intl_gain_pct: Number(intlGainPct.toFixed(2)),
    total_nw: Number(totalNw.toFixed(2)),
    mf_gain_pct: Number(mfGainPct.toFixed(2)),
  };
  if (derivedMf1dInr != null) row.mf_1d_change_inr = Number(derivedMf1dInr.toFixed(2));
  if (derivedMf1dPct != null) row.mf_1d_change_pct = Number(derivedMf1dPct.toFixed(4));
  if (derivedNps1dInr != null) row.nps_1d_change_inr = Number(derivedNps1dInr.toFixed(2));
  if (derivedNps1dPct != null) row.nps_1d_change_pct = Number(derivedNps1dPct.toFixed(4));
  if (derivedIntl1dInr != null) row.intl_1d_change_inr = Number(derivedIntl1dInr.toFixed(2));
  if (derivedIntl1dPct != null) row.intl_1d_change_pct = Number(derivedIntl1dPct.toFixed(4));

  const before = existing[0];
  console.log("\n── Existing today row (before) ──");
  if (!before) {
    console.log("  (no row for today — will be created)");
  } else {
    console.log(`  mf_value          ${fmtInr(Number(before.mf_value))}`);
    console.log(`  mf_invested       ${fmtInr(Number(before.mf_invested))}`);
    console.log(
      `  mf_1d_change_inr  ${before.mf_1d_change_inr == null ? "NULL" : fmtInr(Number(before.mf_1d_change_inr))}`
    );
    console.log(
      `  mf_1d_change_pct  ${before.mf_1d_change_pct == null ? "NULL" : Number(before.mf_1d_change_pct).toFixed(4) + "%"}`
    );
    console.log(`  nps_value         ${fmtInr(Number(before.nps_value))}`);
    console.log(
      `  nps_1d_change_inr ${before.nps_1d_change_inr == null ? "NULL" : fmtInr(Number(before.nps_1d_change_inr))}`
    );
    console.log(
      `  nps_1d_change_pct ${before.nps_1d_change_pct == null ? "NULL" : Number(before.nps_1d_change_pct).toFixed(4) + "%"}`
    );
  }

  console.log("\n── Proposed row (after) ──");
  console.log(`  mf_value          ${fmtInr(row.mf_value)}`);
  console.log(`  intl_value        ${fmtInr(row.intl_value)}`);
  console.log(`  total_nw          ${fmtInr(row.total_nw)}`);
  console.log(`  mf_invested       ${fmtInr(row.mf_invested)}`);
  console.log(
    `  mf_1d_change_inr  ${row.mf_1d_change_inr == null ? "(unchanged / not derived)" : fmtInr(row.mf_1d_change_inr)}`
  );
  console.log(
    `  mf_1d_change_pct  ${row.mf_1d_change_pct == null ? "(unchanged / not derived)" : row.mf_1d_change_pct.toFixed(4) + "%"}`
  );
  console.log(`  nps_value         ${fmtInr(row.nps_value)}`);
  console.log(
    `  nps_1d_change_inr ${row.nps_1d_change_inr == null ? "(unchanged / not derived)" : fmtInr(row.nps_1d_change_inr)}`
  );
  console.log(
    `  nps_1d_change_pct ${row.nps_1d_change_pct == null ? "(unchanged / not derived)" : row.nps_1d_change_pct.toFixed(4) + "%"}`
  );

  if (!APPLY) {
    console.log("\n[dry-run] Re-run with --apply to upsert.");
    return;
  }

  const result = sbUpsert("nw_daily", row, "date");
  console.log(`\n✔ Upserted ${result.length} row(s) for ${today}.`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
