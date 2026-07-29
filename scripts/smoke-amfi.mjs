// Live smoke test for the AMFI NAV client.
//
// Not part of production. Reads the plain-JS-equivalent of what the
// route does at runtime: fetch NAVAll.txt, parse it with the same
// regex + split filter, and report freshness for the user's 10 fund
// codes. Also SELECT-only compares AMFI's nav/nav_date against the
// current DB values so we can see how much fresher AMFI is right now.
// Read-only — never writes to fund_holdings; the actual refresh
// route is the only thing that mutates NAVs.
//
// Exits non-zero if the sanity bar isn't met: >=5 funds with dates
// within 2 days of today IST.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const AMFI_URL = "https://portal.amfiindia.com/spages/NAVAll.txt";

/**
 * Load .env.local (only NEXT_PUBLIC_SUPABASE_URL and
 * SUPABASE_SERVICE_KEY). Node doesn't auto-load .env files outside
 * Next.js's runtime, and pulling in dotenv for a smoke script is
 * overkill.
 */
function loadEnvLocal() {
  try {
    const raw = readFileSync(
      new URL("../.env.local", import.meta.url),
      "utf8"
    );
    for (const line of raw.split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2].trim();
      if (
        (val.startsWith(`"`) && val.endsWith(`"`)) ||
        (val.startsWith(`'`) && val.endsWith(`'`))
      ) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch (e) {
    console.warn(`[env] could not read .env.local: ${e.message}`);
  }
}
loadEnvLocal();

// Match refresh-mf-nav's FUND_TO_SCHEME. Duplicated here to keep this
// script standalone — a smoke test importing app internals feels
// heavier than it needs to be.
const FUND_TO_SCHEME = {
  HDFC_STD: "119016",
  PPFAS_CH: "148958",
  PPFAS_FC: "122639",
  NIPPON_MID: "118668",
  UTI_NN50: "143341",
  UTI_N50: "120716",
  ICICI_NASDAQ: "149219",
  HDFC_SC: "130503",
  EDEL_MID: "140228",
  HDFC_FC: "118955",
};

const MONTHS = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

function parseAmfiDate(raw) {
  const m = raw.trim().match(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${month}-${m[1]}`;
}

function istToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function daysBetween(a, b) {
  const t = Date.parse(`${a}T00:00:00Z`);
  const d = Date.parse(`${b}T00:00:00Z`);
  return (t - d) / 86_400_000;
}

async function main() {
  const t0 = Date.now();
  const res = await fetch(AMFI_URL, {
    headers: { "User-Agent": "vayu-dashboard/1.0" },
    cache: "no-store",
  });
  const body = await res.text();
  const fetchMs = Date.now() - t0;

  console.log(
    `[fetch] HTTP ${res.status} · ${(body.length / 1024).toFixed(0)} KB · ${fetchMs} ms`
  );

  const today = istToday();
  const map = new Map();
  let totalDataRows = 0;
  let staleDropped = 0;

  for (const raw of body.split("\n")) {
    if (!/^\d+;/.test(raw)) continue;
    const parts = raw.split(";");
    if (parts.length !== 6) continue;
    totalDataRows++;

    const schemeCode = parts[0].trim();
    const schemeName = parts[3].trim();
    const navStr = parts[4].trim();
    const dateStr = parts[5].trim();
    if (!schemeCode || !schemeName || !navStr || !dateStr) continue;

    const nav = Number(navStr);
    if (!Number.isFinite(nav) || nav <= 0) continue;

    const navDate = parseAmfiDate(dateStr);
    if (!navDate) continue;

    if (daysBetween(today, navDate) > 7) {
      staleDropped++;
      continue;
    }
    map.set(schemeCode, { nav, navDate, schemeName });
  }

  console.log(
    `[parse] today (IST)=${today} · total data rows=${totalDataRows} · stale dropped=${staleDropped} · fresh Map size=${map.size}`
  );

  // Pull DB state for a side-by-side comparison. Best-effort — if the
  // env isn't set we still show AMFI freshness, we just skip the diff.
  //
  // Shells out to curl instead of Node's fetch: the user's local dev
  // environment sits behind a corporate proxy with a self-signed root
  // CA (SELF_SIGNED_CERT_IN_CHAIN when Node tries the same URL).
  // package.json's dev/start scripts already export
  // NODE_TLS_REJECT_UNAUTHORIZED=0 to work around this in Next.js —
  // this smoke script gets the same practical outcome without having
  // to touch process-wide TLS settings.
  let dbByFundCode = new Map();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (url && key) {
    try {
      const restUrl = `${url}/rest/v1/fund_holdings?select=fund_code,nav,nav_date,nav_source,units`;
      const buf = execFileSync(
        "curl",
        [
          "-sS",
          "--max-time", "10",
          "-H", `apikey: ${key}`,
          "-H", `Authorization: Bearer ${key}`,
          "-H", "Accept: application/json",
          restUrl,
        ],
        { encoding: "utf8" }
      );
      const rows = JSON.parse(buf);
      if (!Array.isArray(rows)) throw new Error(`unexpected shape: ${buf.slice(0, 120)}`);
      for (const row of rows) dbByFundCode.set(row.fund_code, row);
      console.log(`[db] pulled ${rows.length} fund_holdings rows`);
    } catch (e) {
      console.warn(`[db] read failed, skipping compare: ${e.message}`);
    }
  } else {
    console.warn(`[db] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_KEY missing`);
  }

  // Per-fund lookup for the user's 10 codes, joined with DB.
  console.log("");
  console.log(
    "fund_code       code    amfi_date    amfi_nav      db_date      db_nav       db_source  Δdays  Δnav          notional_1D"
  );
  console.log(
    "──────────────  ──────  ───────────  ───────────  ───────────  ───────────  ─────────  ─────  ────────────  ───────────"
  );

  let fresh2d = 0;
  let missing = 0;
  let amfiAheadCount = 0;
  let notional1DTotal = 0;
  for (const [fundCode, schemeCode] of Object.entries(FUND_TO_SCHEME)) {
    const hit = map.get(schemeCode);
    const db = dbByFundCode.get(fundCode);
    if (!hit) {
      missing++;
      console.log(
        `${fundCode.padEnd(15)} ${schemeCode.padEnd(7)} ${"MISSING".padEnd(12)} ${"–".padEnd(12)} ${(db?.nav_date ?? "–").padEnd(12)} ${(db?.nav?.toFixed(4) ?? "–").padEnd(12)} ${(db?.nav_source ?? "–").padEnd(10)} –      –             –`
      );
      continue;
    }
    const daysAgo = daysBetween(today, hit.navDate);
    if (daysAgo <= 2) fresh2d++;

    const dbNav = db?.nav ?? null;
    const dbDate = db?.nav_date ?? null;
    const dbSource = db?.nav_source ?? null;
    const units = Number(db?.units ?? 0);

    // Delta in days: positive = AMFI newer, negative = DB newer.
    const deltaDays = dbDate ? daysBetween(hit.navDate, dbDate) : null;
    const deltaNav = dbNav != null ? hit.nav - dbNav : null;
    const notional = deltaNav != null ? units * deltaNav : 0;
    if (deltaDays != null && deltaDays > 0) amfiAheadCount++;
    if (deltaDays != null && deltaDays > 0) notional1DTotal += notional;

    const dNavStr =
      deltaNav != null ? (deltaNav >= 0 ? "+" : "") + deltaNav.toFixed(4) : "–";
    const notionalStr =
      deltaNav != null
        ? (notional >= 0 ? "+₹" : "-₹") +
          Math.abs(notional).toLocaleString("en-IN", {
            maximumFractionDigits: 0,
          })
        : "–";

    console.log(
      `${fundCode.padEnd(15)} ${schemeCode.padEnd(7)} ${hit.navDate.padEnd(12)} ${hit.nav.toFixed(4).padEnd(12)} ${(dbDate ?? "–").padEnd(12)} ${(dbNav?.toFixed(4) ?? "–").padEnd(12)} ${(dbSource ?? "–").padEnd(10)} ${(deltaDays != null ? (deltaDays >= 0 ? "+" : "") + deltaDays : "–").padEnd(6)} ${dNavStr.padEnd(13)} ${notionalStr}`
    );
  }

  console.log("");
  console.log(
    `[verdict] ${fresh2d}/10 funds ≤2d fresh · ${missing}/10 missing · ${amfiAheadCount}/10 AMFI ahead of DB · notional 1D swing if we rotated now: ${notional1DTotal >= 0 ? "+₹" : "-₹"}${Math.abs(notional1DTotal).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`
  );
  if (fresh2d < 5) {
    console.error(
      `[FAIL] expected at least 5/10 funds with dates ≤2 days old, got ${fresh2d}.`
    );
    process.exit(1);
  }
  console.log("[PASS] smoke bar met.");
}

main().catch((err) => {
  console.error("[error]", err);
  process.exit(1);
});
