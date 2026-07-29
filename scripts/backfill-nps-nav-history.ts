// Backfill daily NAV history for the three Kotak Tier I POP schemes
// (E / C / G) into `nps_nav_history`. One-shot; safe to re-run
// (upserts on (scheme_code, nav_date) — same NAV overwrites itself
// with an updated fetched_at).
//
// Usage
// -----
//   npx tsx scripts/backfill-nps-nav-history.ts [--dry-run] [--verify]
//
// Flags
//   --dry-run   Parse & summarize; skip the DB write. Use to sanity-check
//               a fresh npsnav.in response before committing.
//   --verify    After writing, compare NAVs on transaction dates in
//               nps_transactions against the freshly-inserted npsnav.in
//               NAVs. Emits per-date drift so you can catch the "wrong
//               scheme variant" case if npsnav.in ever re-aliases codes.
//
// Data source
// -----------
// GET https://npsnav.in/api/historical/{code} — returns the full published
// series in one shot as JSON: { data: [{ date: "DD-MM-YYYY", nav: n }, ...] }.
// The three POP-variant codes are the same ones used by /api/refresh-nps-nav's
// fallback path, so this backfill is guaranteed consistent with the daily
// refresh — no risk of one path using DIRECT while the other uses POP.
//
// Auth
// ----
// Uses SUPABASE_SERVICE_KEY from .env.local — bypasses RLS. Same pattern
// as ingest-nps-cra-sot.ts.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const verify = args.includes("--verify");

  // ── env loader (mirrors ingest-nps-cra-sot.ts) ─────────────────────
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
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_KEY in .env.local"
    );
  }

  // POP-variant codes on npsnav.in — same as /api/refresh-nps-nav's fallback.
  const SCHEMES: Array<{ scheme: "E" | "C" | "G"; code: string }> = [
    { scheme: "E", code: "SM005001" },
    { scheme: "C", code: "SM005002" },
    { scheme: "G", code: "SM005003" },
  ];

  type NpsNavHistoricalRow = { date: string; nav: number };
  type NpsNavHistoricalResp = { data?: NpsNavHistoricalRow[] };

  // ── Fetch all three schemes in parallel ────────────────────────────
  console.log("Fetching daily NAV history from npsnav.in for E/C/G Tier I POP…");
  const fetched = await Promise.all(
    SCHEMES.map(async ({ scheme, code }) => {
      const url = `https://npsnav.in/api/historical/${code}`;
      const res = await fetch(url, {
        headers: { "User-Agent": "vayu-dashboard/1.0" },
      });
      if (!res.ok) {
        throw new Error(`npsnav.in ${code}: HTTP ${res.status}`);
      }
      const body = (await res.json()) as NpsNavHistoricalResp;
      const rows = body.data ?? [];
      if (rows.length === 0) {
        throw new Error(`npsnav.in ${code}: empty data array`);
      }
      return { scheme, code, rows };
    })
  );

  for (const f of fetched) {
    const first = f.rows[f.rows.length - 1]; // API returns newest-first
    const last = f.rows[0];
    console.log(
      `  ${f.scheme} (${f.code}): ${f.rows.length} rows  ` +
        `[${first.date} → ${last.date}]  ` +
        `latest NAV ${last.nav.toFixed(4)}`
    );
  }

  // ── Normalise & flatten ─────────────────────────────────────────────
  // npsnav.in gives DD-MM-YYYY; the DB expects ISO YYYY-MM-DD.
  const toIso = (d: string): string => {
    const m = d.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (!m) throw new Error(`Unexpected date format from npsnav.in: ${d}`);
    return `${m[3]}-${m[2]}-${m[1]}`;
  };

  type NavRow = {
    scheme_code: string;
    scheme: "E" | "C" | "G";
    nav_date: string;
    nav: number;
    source: string;
  };
  const rows: NavRow[] = [];
  for (const f of fetched) {
    for (const r of f.rows) {
      const nav = Number(r.nav);
      if (!Number.isFinite(nav) || nav <= 0) continue;
      rows.push({
        scheme_code: f.code,
        scheme: f.scheme,
        nav_date: toIso(r.date),
        nav,
        source: "npsnav.in",
      });
    }
  }
  console.log(`\nTotal rows to upsert: ${rows.length}`);

  if (dryRun) {
    console.log("\n[dry-run] Skipping DB write.");
    return;
  }

  // ── Upsert in batches (PostgREST body-size safe) ────────────────────
  // ~12000 rows total (~4000/scheme × 3). Chunk at 1000 to stay well
  // under Supabase's default 8MB request body cap.
  const BATCH = 1000;
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const res = await fetch(
      `${SB_URL}/rest/v1/nps_nav_history?on_conflict=scheme_code,nav_date`,
      {
        method: "POST",
        headers: {
          apikey: SB_KEY,
          Authorization: `Bearer ${SB_KEY}`,
          "Content-Type": "application/json",
          // resolution=merge-duplicates so a re-run refreshes fetched_at
          // and any corrected NAVs (npsnav.in has been known to
          // republish revised values within a day of first publish).
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(chunk),
      }
    );
    if (!res.ok) {
      console.error(`Upsert batch ${i}-${i + chunk.length}: HTTP ${res.status}`);
      console.error(await res.text());
      process.exit(1);
    }
    written += chunk.length;
    process.stdout.write(`  wrote ${written} / ${rows.length}\r`);
  }
  console.log(`\n✓ Wrote ${written} NAV rows.`);

  // ── Verification pass ───────────────────────────────────────────────
  // Sanity-check the freshly-written NAVs against the per-row NAVs
  // captured in nps_transactions during CRA SOT ingest. Both should
  // reflect the POP variant on the same trading day; drift > 0.5% means
  // either (a) npsnav.in re-aliased its SM codes to DIRECT, or (b) our
  // classifier mis-parsed tx NAVs. Either way, worth surfacing.
  if (verify) {
    console.log("\nVerifying vs nps_transactions.nav on tx dates…");
    const txRes = await fetch(
      `${SB_URL}/rest/v1/nps_transactions?select=tx_date,scheme,nav&tier=eq.I`,
      {
        headers: {
          apikey: SB_KEY,
          Authorization: `Bearer ${SB_KEY}`,
        },
      }
    );
    if (!txRes.ok) {
      console.error(`Failed to fetch nps_transactions: HTTP ${txRes.status}`);
      return;
    }
    const txRows = (await txRes.json()) as Array<{
      tx_date: string;
      scheme: string;
      nav: number | null;
    }>;

    // Dedup (tx_date, scheme) — multiple tx per day per scheme share
    // the same NAV so comparing them all is redundant.
    type Key = string;
    const seen = new Map<Key, number>();
    for (const t of txRows) {
      if (t.nav == null) continue;
      seen.set(`${t.tx_date}|${t.scheme}`, Number(t.nav));
    }

    // Fetch matching NAV history rows in a single query.
    const dates = [...new Set(txRows.map((t) => t.tx_date))].sort();
    if (dates.length === 0) {
      console.log("  No tx rows to verify against.");
      return;
    }
    // .in.() takes at most ~2000 items in a URL — chunk defensively.
    const navMap = new Map<Key, number>();
    for (let i = 0; i < dates.length; i += 500) {
      const chunk = dates.slice(i, i + 500);
      const listParam = `(${chunk.map((d) => `"${d}"`).join(",")})`;
      const url =
        `${SB_URL}/rest/v1/nps_nav_history?select=nav_date,scheme,nav&` +
        `nav_date=in.${encodeURIComponent(listParam)}`;
      const r = await fetch(url, {
        headers: {
          apikey: SB_KEY,
          Authorization: `Bearer ${SB_KEY}`,
        },
      });
      if (!r.ok) {
        console.error(`  fetch chunk failed: HTTP ${r.status}`);
        continue;
      }
      const rows = (await r.json()) as Array<{
        nav_date: string;
        scheme: string;
        nav: number;
      }>;
      for (const row of rows) {
        navMap.set(`${row.nav_date}|${row.scheme}`, Number(row.nav));
      }
    }

    let ok = 0;
    let mismatch = 0;
    let missing = 0;
    let worstDriftPct = 0;
    let worstKey = "";
    for (const [key, txNav] of seen) {
      const dbNav = navMap.get(key);
      if (dbNav === undefined) {
        missing++;
        continue;
      }
      const driftPct = Math.abs((txNav - dbNav) / txNav) * 100;
      if (driftPct < 0.5) {
        ok++;
      } else {
        mismatch++;
        if (driftPct > worstDriftPct) {
          worstDriftPct = driftPct;
          worstKey = key;
        }
      }
    }
    console.log(
      `  matched: ${ok}  mismatch (>0.5%): ${mismatch}  missing: ${missing}`
    );
    if (mismatch > 0) {
      const [d, s] = worstKey.split("|");
      console.log(
        `  worst drift: ${worstKey}  ` +
          `tx.nav=${seen.get(worstKey)?.toFixed(4)}  ` +
          `npsnav.nav=${navMap.get(worstKey)?.toFixed(4)}  ` +
          `(${worstDriftPct.toFixed(3)}%) — check scheme ${s} on ${d}`
      );
    }
    if (missing > 0 && ok > 0) {
      console.log(
        `  ${missing} tx dates have no NAV in nps_nav_history — probably ` +
          `holidays / pre-inception. Not necessarily a bug.`
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
