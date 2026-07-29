// One-shot MF Daily Reconstruction Backfill
// ==========================================
//
// Rebuilds the pre-tracking segment of your MF timeline (Jan 7 → Jul 11
// approximately) from two sources:
//
//   • mf_transactions — CAS-sourced lot-level history (units, amounts,
//     types). Already in the DB.
//   • mfapi.in — daily NAV history per AMFI scheme code (fetched here).
//
// For each date in the reconstruction range, we cumsum units held per
// fund, look up that day's NAV (carry-forward for weekends/holidays),
// and roll up to a portfolio-total MF value. The result lands in three
// tables that the Overview page's MF Growth chart reads alongside
// nw_daily:
//
//   • mf_nav_history                    — raw NAV cache (~2000 rows)
//   • mf_daily_reconstructed            — portfolio-total per date (~200 rows)
//   • mf_daily_reconstructed_by_fund    — per-fund detail (~2000 rows)
//
// WHY ONE-SHOT (not periodic)
// ───────────────────────────
// Historical NAVs are immutable — AMFI publishes once per day and never
// revises. Historical transactions are equally fixed. The only reason to
// re-run this script is if you later ingest a CAS covering dates BEFORE
// your current earliest transaction. Rare.
//
// SAFETY
// ──────
// Dry-run by default. Nothing is written to Supabase without --apply.
// Idempotent when applied (upserts on natural keys), so re-running is
// safe. If you truncate any of the three tables and rerun, you get
// back to the same state.
//
// Usage
// -----
//   node scripts/backfill-mf-reconstruction.mjs           # dry-run
//   node scripts/backfill-mf-reconstruction.mjs --apply   # write

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const APPLY = process.argv.includes("--apply");

// ── Env ──────────────────────────────────────────────────────────
// Same pattern as scripts/backfill-nse-stocks.mjs — direct .env.local
// parse so we don't need dotenv as a dev dep.
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

// ── AMFI scheme codes ────────────────────────────────────────────
// Duplicated from lib/fundIsin.ts because this is a plain .mjs script
// and doesn't compile TS. Keep in sync manually — same fund list.
const SCHEME_CODE_TO_FUND = {
  "119016": "HDFC_STD",
  "148958": "PPFAS_CH",
  "122639": "PPFAS_FC",
  "118668": "NIPPON_MID",
  "143341": "UTI_NN50",
  "120716": "UTI_N50",
  "149219": "ICICI_NASDAQ",
  "130503": "HDFC_SC",
  "140228": "EDEL_MID",
  "118955": "HDFC_FC",
};
const FUND_TO_SCHEME_CODE = Object.fromEntries(
  Object.entries(SCHEME_CODE_TO_FUND).map(([code, fund]) => [fund, code])
);

// ── Curl helpers ─────────────────────────────────────────────────
// Same reasoning as other scripts: Node's fetch trips on some
// corporate TLS chains, so we shell out to curl.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function curlGet(url, headers = "") {
  return execSync(`curl -sf -H "User-Agent: ${UA}" ${headers} "${url}"`, {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
}

// Wrapper around curlGet with exponential backoff. mfapi.in appears to
// rate-limit bursts (10 sequential requests can lose 7/10 to transient
// failures), so we retry each fetch up to 3 times with 1s → 3s → 9s
// backoff. Between distinct fund fetches we also sleep for a small
// interval to spread the load — see fetchAllNavs below.
function curlGetWithRetry(url, headers = "", attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return curlGet(url, headers);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        const waitMs = 1000 * Math.pow(3, i);
        execSync(`sleep ${waitMs / 1000}`);
      }
    }
  }
  throw lastErr;
}

function sleepMs(ms) {
  execSync(`sleep ${(ms / 1000).toFixed(2)}`);
}

function sbGet(path) {
  const raw = execSync(
    `curl -sf "${SB_URL}/rest/v1/${path}" ` +
      `-H "apikey: ${SB_KEY}" -H "Authorization: Bearer ${SB_KEY}"`,
    { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }
  );
  return JSON.parse(raw);
}

// Batched upsert with `resolution=merge-duplicates` — safe for repeat
// runs. Uses stdin for the body to avoid argv-length issues on the
// larger by_fund inserts.
function sbUpsert(path, rows, onConflict) {
  if (rows.length === 0) return { inserted: 0 };
  const bodyFile = `/tmp/mfrec_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2)}.json`;
  execSync(
    `cat > "${bodyFile}" << 'EOF'\n${JSON.stringify(rows)}\nEOF`,
    { shell: "/bin/bash" }
  );
  try {
    const out = execSync(
      `curl -sf -X POST "${SB_URL}/rest/v1/${path}?on_conflict=${onConflict}" ` +
        `-H "apikey: ${SB_KEY}" -H "Authorization: Bearer ${SB_KEY}" ` +
        `-H "Content-Type: application/json" ` +
        `-H "Prefer: resolution=merge-duplicates,return=representation" ` +
        `--data @${bodyFile}`,
      { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }
    );
    return { inserted: JSON.parse(out).length };
  } finally {
    try {
      execSync(`rm -f "${bodyFile}"`);
    } catch {
      // Best-effort cleanup — if the /tmp file couldn't be removed it's
      // harmless (system will reap eventually).
    }
  }
}

// ── Date helpers ─────────────────────────────────────────────────
// mfapi.in returns dates as DD-MM-YYYY. Everything internal is ISO
// YYYY-MM-DD.
function parseMfApiDate(s) {
  const [d, m, y] = s.split("-");
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

// Iterate every calendar date in [from, to] inclusive.
function* eachDate(from, to) {
  const start = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  const cur = new Date(start);
  while (cur.getTime() <= end.getTime()) {
    yield cur.toISOString().slice(0, 10);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
}

function fmtInr(n) {
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

// ── Phase 1: read ledger + fund_holdings ─────────────────────────
// Runs BEFORE the NAV fetch so we know exactly which date window to
// request. mfapi.in's `?startDate=&endDate=` params keep the response
// (and our mf_nav_history cache) trim — no point pulling 2013-onwards
// data when the reconstruction window is Jan–Jul 2026.
async function loadLedger() {
  console.log("── Phase 1: loading ledger from Supabase ───────────────────");
  const txs = sbGet(
    "mf_transactions?select=tx_date,fund_code,tx_type,amount,units&order=tx_date.asc"
  );
  console.log(`  mf_transactions: ${txs.length} rows`);
  const holdings = sbGet(
    "fund_holdings?select=fund_code,cap_type"
  );
  const capByFund = new Map(holdings.map((f) => [f.fund_code, f.cap_type]));
  console.log(`  fund_holdings:   ${holdings.length} funds`);
  // Determine reconstruction date range.
  //   from = earliest tx_date across all funds
  //   to   = day BEFORE nw_daily starts, or today if nw_daily is empty
  const firstTx = txs.reduce(
    (min, t) => (min === null || t.tx_date < min ? t.tx_date : min),
    null
  );
  const nwFirst = sbGet(
    "nw_daily?select=date&order=date.asc&limit=1"
  );
  let to;
  if (nwFirst.length > 0) {
    const nwStart = new Date(nwFirst[0].date + "T00:00:00Z");
    nwStart.setUTCDate(nwStart.getUTCDate() - 1);
    to = nwStart.toISOString().slice(0, 10);
  } else {
    to = new Date().toISOString().slice(0, 10);
  }
  console.log(`  reconstruction range: ${firstTx} → ${to}`);
  return { txs, capByFund, from: firstTx, to };
}

// 30-day leading buffer so carry-forward can find a NAV even if the
// reconstruction starts the day after a long holiday cluster (Diwali
// spans up to 5 consecutive market-closed days, plus weekends).
// No trailing buffer — carry-forward only walks backward.
const NAV_LEADING_BUFFER_DAYS = 30;

function shiftDate(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Phase 2: fetch NAV history from mfapi.in ─────────────────────
// Uses mfapi.in's `?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD` filter to
// pull ONLY the window we need for reconstruction, keeping the
// mf_nav_history cache lean. Rate-limits (bursts of 10 back-to-back
// can lose most requests) are mitigated by 1.5s spacing + 5-attempt
// exponential backoff. All-or-nothing: if any fund fails, we throw
// rather than persist a partial view.
async function fetchNavsForWindow(from, to) {
  console.log(`\n── Phase 2: fetching NAVs for ${from} → ${to} ──`);
  const navsByFund = new Map(); // fund_code → Map<date, nav>
  const failed = [];
  const entries = Object.entries(SCHEME_CODE_TO_FUND);
  for (let idx = 0; idx < entries.length; idx++) {
    const [schemeCode, fundCode] = entries[idx];
    process.stdout.write(`  ${fundCode.padEnd(14)} scheme=${schemeCode} ... `);
    // NOTE: mfapi expects YYYY-MM-DD despite RETURNING DD-MM-YYYY.
    // Passing DD-MM-YYYY is silently ignored (returns full history).
    // See migrations/2026-07-18-mf-daily-reconstruction.sql commentary
    // for the rationale on picking mfapi.in over alternatives.
    const url = `https://api.mfapi.in/mf/${schemeCode}?startDate=${from}&endDate=${to}`;
    let payload;
    try {
      payload = JSON.parse(curlGetWithRetry(url, "", 5));
    } catch (err) {
      console.log(`FAILED after retries (${err.message.slice(0, 60)}...)`);
      failed.push(fundCode);
      continue;
    }
    if (!payload.data || !Array.isArray(payload.data)) {
      console.log("empty payload");
      failed.push(fundCode);
      continue;
    }
    // mfapi.in returns newest-first; we want ascending for our loop.
    const rows = payload.data
      .map((r) => ({
        date: parseMfApiDate(r.date),
        nav: Number(r.nav),
      }))
      .filter((r) => Number.isFinite(r.nav) && r.nav > 0)
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    const m = new Map();
    for (const r of rows) m.set(r.date, r.nav);
    navsByFund.set(fundCode, m);
    console.log(
      rows.length === 0
        ? "0 rows (window may predate fund inception)"
        : `${rows.length} rows, ${rows[0].date} → ${rows[rows.length - 1].date}`
    );
    // Space subsequent requests — no delay after the last one.
    // 1500ms is the empirically-comfortable spacing for mfapi.in;
    // shorter values (500ms) reliably lose 1-2 funds to burst
    // throttling, longer (3s+) is unnecessarily slow.
    if (idx < entries.length - 1) sleepMs(1500);
  }
  if (failed.length > 0) {
    throw new Error(
      `mfapi.in failed for ${failed.length} fund(s) after retries: ${failed.join(", ")}. ` +
        `Refusing to proceed — partial NAV coverage would produce misleading reconstruction values. ` +
        `Try again in a few minutes (mfapi.in rate limit typically clears within 60s).`
    );
  }
  return navsByFund;
}

// ── Phase 3: compute per-date rows ───────────────────────────────
function computeReconstruction({ txs, capByFund, from, to, navsByFund }) {
  console.log("\n── Phase 3: computing reconstruction rows ──────────────────");

  // Group transactions by date for O(1) per-date access.
  const txByDate = new Map();
  for (const t of txs) {
    const arr = txByDate.get(t.tx_date) ?? [];
    arr.push(t);
    txByDate.set(t.tx_date, arr);
  }

  // Running state: units held per fund + cumulative cost basis per fund
  // + cumulative net deposits (portfolio total).
  const unitsByFund = new Map();
  const costBasisByFund = new Map();
  let cumNetDeposits = 0; // portfolio-total: purchase − redemption only

  const aggregateRows = [];
  const perFundRows = [];
  let prevMfValue = null;

  // Carry-forward NAV lookup: if exact date not present, walk backward
  // up to 10 days. Handles weekends + AMFI holidays. Beyond 10 days is
  // symptomatic of a stale NAV fetch — we return null and skip the row.
  function navFor(fundCode, date) {
    const m = navsByFund.get(fundCode);
    if (!m) return null;
    if (m.has(date)) return m.get(date);
    const d = new Date(date + "T00:00:00Z");
    for (let i = 0; i < 10; i++) {
      d.setUTCDate(d.getUTCDate() - 1);
      const iso = d.toISOString().slice(0, 10);
      if (m.has(iso)) return m.get(iso);
    }
    return null;
  }

  // Yesterday's snapshot in ISO form. Same "walk back skipping missing
  // days" trick — if yesterday has no NAV (e.g., today = Monday), we
  // use Friday's NAV as the baseline so the market-move computation
  // treats the Friday → Monday jump as a single trading step (which is
  // exactly what Groww's oneDayReturnValue does).
  function prevNavDate(date) {
    const d = new Date(date + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  for (const date of eachDate(from, to)) {
    // 1. Compute the day's MARKET-ONLY move BEFORE applying today's
    //    transactions. Groww's `oneDayReturnValue` (which populates
    //    nw_daily.mf_1d_change_inr on live days) is a pure NAV-pair
    //    delta; we mirror that convention here so reconstructed and
    //    observed rows are semantically identical.
    //
    //    market_1d = Σ (yesterday_units × (today_nav − yesterday_nav))
    //
    //    Any deposit that lands today gets applied AFTER this
    //    calculation, so it doesn't inflate the market-move number.
    let market1dInr = 0;
    const prevDate = prevNavDate(date);
    if (prevMfValue !== null) {
      for (const [fundCode, units] of unitsByFund.entries()) {
        if (Math.abs(units) < 0.001) continue;
        const navToday = navFor(fundCode, date);
        const navPrev = navFor(fundCode, prevDate);
        if (navToday === null || navPrev === null) continue;
        market1dInr += units * (navToday - navPrev);
      }
    }

    // 2. Now apply today's transactions to running state — an SIP that
    //    lands on Apr 15 shows in the Apr 15 valuation, matching how
    //    CAS records "as of" the tx_date.
    const dayTxs = txByDate.get(date) ?? [];
    for (const t of dayTxs) {
      const units = Number(t.units ?? 0);
      const amount = Number(t.amount ?? 0);
      unitsByFund.set(
        t.fund_code,
        (unitsByFund.get(t.fund_code) ?? 0) + units
      );
      // Per-fund cost basis: switch_in counts as fresh money INTO this
      // fund (even though at portfolio level it's just a transfer).
      // Redemption / switch_out remove basis.
      if (t.tx_type === "purchase" || t.tx_type === "switch_in") {
        costBasisByFund.set(
          t.fund_code,
          (costBasisByFund.get(t.fund_code) ?? 0) + amount
        );
      } else if (t.tx_type === "redemption" || t.tx_type === "switch_out") {
        costBasisByFund.set(
          t.fund_code,
          (costBasisByFund.get(t.fund_code) ?? 0) - amount
        );
      }
      // Portfolio-total net deposits: only external cash flows count.
      // Switches are internal — they don't shift the money-at-risk
      // baseline for market-attribution purposes.
      if (t.tx_type === "purchase") cumNetDeposits += amount;
      else if (t.tx_type === "redemption") cumNetDeposits -= amount;
    }

    // 3. Snapshot: for each fund with non-zero units, look up NAV and
    //    compute market value.
    let mfValue = 0;
    let mfEquity = 0;
    let mfDebt = 0;
    let fundCount = 0;
    for (const [fundCode, units] of unitsByFund.entries()) {
      if (Math.abs(units) < 0.001) continue; // rounding tolerance
      const nav = navFor(fundCode, date);
      if (nav === null) {
        // Skip this fund on this date but don't fail the whole run —
        // if we're missing NAV for e.g. Jan 3 (fund launched later),
        // reconstruction just doesn't include that fund on that day.
        continue;
      }
      const value = units * nav;
      mfValue += value;
      // Equity/Debt classification: cap_type='debt' → Debt bucket.
      // Everything else (large/mid/small/intl/large_n50/large_nn50) →
      // Equity. Matches the classification in getOverviewData.
      const cap = capByFund.get(fundCode);
      if (cap === "debt") mfDebt += value;
      else mfEquity += value;
      fundCount++;

      perFundRows.push({
        date,
        fund_code: fundCode,
        units: Number(units.toFixed(4)),
        nav: Number(nav.toFixed(4)),
        value_inr: Number(value.toFixed(2)),
        cost_basis_inr: Number(
          (costBasisByFund.get(fundCode) ?? 0).toFixed(2)
        ),
      });
    }

    if (fundCount === 0) {
      // No units held yet on this date (typical for the first few
      // days of Jan before the earliest CAS transaction). Don't emit
      // an aggregate row — a "day 0 with zero value" would drag the
      // chart's Y-axis pointlessly.
      continue;
    }

    // 1D change: market-only. Percentage is normalized against the
    // previous day's value (pre-deposits). First emitted day has no
    // prev-day baseline, so both fields are null there.
    const day1dInr = prevMfValue === null ? null : market1dInr;
    const day1dPct =
      prevMfValue === null || prevMfValue === 0
        ? null
        : (market1dInr / prevMfValue) * 100;
    const gainPct =
      cumNetDeposits > 0
        ? ((mfValue - cumNetDeposits) / cumNetDeposits) * 100
        : null;

    aggregateRows.push({
      date,
      mf_value_inr: Number(mfValue.toFixed(2)),
      mf_invested_inr: Number(cumNetDeposits.toFixed(2)),
      mf_equity_inr: Number(mfEquity.toFixed(2)),
      mf_debt_inr: Number(mfDebt.toFixed(2)),
      mf_1d_change_inr: day1dInr === null ? null : Number(day1dInr.toFixed(2)),
      mf_1d_change_pct: day1dPct === null ? null : Number(day1dPct.toFixed(4)),
      mf_gain_pct: gainPct === null ? null : Number(gainPct.toFixed(4)),
      fund_count: fundCount,
    });
    prevMfValue = mfValue;
  }

  console.log(`  aggregate rows: ${aggregateRows.length}`);
  console.log(`  per-fund rows:  ${perFundRows.length}`);
  return { aggregateRows, perFundRows };
}

// ── Phase 4: preview ─────────────────────────────────────────────
function preview(aggregateRows) {
  console.log("\n── Preview: monthly checkpoints ────────────────────────────");
  const firstOfMonth = new Map();
  for (const r of aggregateRows) {
    const key = r.date.slice(0, 7);
    if (!firstOfMonth.has(key)) firstOfMonth.set(key, r);
  }
  // Also include the last row so the user sees the end state.
  const last = aggregateRows[aggregateRows.length - 1];
  if (last) firstOfMonth.set("~last", last);
  console.log(
    "  " +
      "date".padEnd(12) +
      "value".padStart(12) +
      "invested".padStart(14) +
      "gain%".padStart(9) +
      "1D".padStart(11) +
      "  funds"
  );
  for (const r of firstOfMonth.values()) {
    console.log(
      "  " +
        r.date.padEnd(12) +
        fmtInr(r.mf_value_inr).padStart(12) +
        fmtInr(r.mf_invested_inr).padStart(14) +
        (r.mf_gain_pct === null ? "—" : r.mf_gain_pct.toFixed(2)).padStart(9) +
        (r.mf_1d_change_inr === null
          ? "—"
          : fmtInr(r.mf_1d_change_inr)
        ).padStart(11) +
        "  " +
        r.fund_count
    );
  }
}

// ── Phase 5: fetch NAV → mf_nav_history rows ─────────────────────
function buildNavHistoryRows(navsByFund) {
  const rows = [];
  for (const [fundCode, m] of navsByFund.entries()) {
    const schemeCode = FUND_TO_SCHEME_CODE[fundCode];
    for (const [date, nav] of m.entries()) {
      rows.push({
        fund_code: fundCode,
        scheme_code: schemeCode,
        nav_date: date,
        nav,
      });
    }
  }
  return rows;
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log(`Mode: ${APPLY ? "APPLY (writing to Supabase)" : "DRY RUN"}\n`);
  const { txs, capByFund, from, to } = await loadLedger();
  // Fetch a slightly wider NAV window than the reconstruction range —
  // the extra leading days are consumed by carry-forward when the
  // reconstruction's first day falls right after a holiday cluster.
  const fetchFrom = shiftDate(from, -NAV_LEADING_BUFFER_DAYS);
  const navsByFund = await fetchNavsForWindow(fetchFrom, to);
  const { aggregateRows, perFundRows } = computeReconstruction({
    txs,
    capByFund,
    from,
    to,
    navsByFund,
  });
  preview(aggregateRows);
  const navRows = buildNavHistoryRows(navsByFund);
  console.log(`\n  mf_nav_history rows to write: ${navRows.length}`);

  if (!APPLY) {
    console.log(
      "\nDry run complete. Re-run with --apply to write to Supabase."
    );
    return;
  }

  // Real writes. Chunked because PostgREST caps request body at ~2MB.
  console.log("\n── Applying to Supabase ────────────────────────────────────");
  const CHUNK = 500;
  function chunked(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  let total;

  total = 0;
  for (const c of chunked(navRows, CHUNK)) {
    const r = sbUpsert("mf_nav_history", c, "fund_code,nav_date");
    total += r.inserted;
  }
  console.log(`  mf_nav_history:              ${total} rows written`);

  total = 0;
  for (const c of chunked(aggregateRows, CHUNK)) {
    const r = sbUpsert("mf_daily_reconstructed", c, "date");
    total += r.inserted;
  }
  console.log(`  mf_daily_reconstructed:      ${total} rows written`);

  total = 0;
  for (const c of chunked(perFundRows, CHUNK)) {
    const r = sbUpsert(
      "mf_daily_reconstructed_by_fund",
      c,
      "date,fund_code"
    );
    total += r.inserted;
  }
  console.log(`  mf_daily_reconstructed_by_fund: ${total} rows written`);
  console.log("\nDone. Refresh the Overview page to see the extended chart.");
}

main().catch((err) => {
  console.error("\n✗ Backfill failed:", err.message);
  process.exit(1);
});
