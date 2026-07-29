// Reconcile nps_transactions in Supabase against the CRA header
// totals. Read-only. Runs a set of PostgREST aggregate queries and
// prints a per-FY / per-scheme summary alongside expected values.
//
// Usage
// -----
//   npx tsx scripts/verify-nps-transactions.ts [--fy 2024-25]
//
// Expected values are pulled from the CRA "Investment Summary" +
// "Investment Details - Scheme Wise Summary" blocks, hard-coded here
// because they're not in the DB (they're header aggregates, not
// per-transaction data).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

async function main() {
  const args = process.argv.slice(2);
  const fyArg = args[args.indexOf("--fy") + 1];

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
  const SB_KEY = env.SUPABASE_SERVICE_KEY;
  if (!SB_URL || !SB_KEY) throw new Error("Missing Supabase env");

  const headers = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

  // Baselines from the CRA statement headers. Add rows here as new FY
  // HTMLs get ingested — the reconciliation grid grows automatically.
  //
  // `contributions` is FY-only (regular + voluntary; excludes switches).
  // `units` are cumulative closing balances as of the CRA statement's
  //   period-end (CRA reports lifetime-to-date, so we sum every FY ≤ this
  //   one in the reconciliation).
  // `cumContributions` is optional and used only in the last FY to sanity-
  //   check the CRA "Total Contribution as on <date>" header (the running
  //   total across all FYs including this one).
  // `switchBalance` marks an FY that contains a subscriber-initiated
  //   scheme-preference change; switch_in + switch_out should net to zero.
  const expected: Record<
    string,
    {
      contributions: number;
      billing: number;
      units: { E: number; C: number; G: number };
      cumContributions?: number;
      switchBalance?: boolean;
    }
  > = {
    "2024-25": {
      contributions: 321059.25,
      billing: 151.92,
      units: { E: 3905.1712, C: 841.2866, G: 1398.1632 },
    },
    "2025-26": {
      // Cumulative in CRA header: ₹4,94,961.33
      // = 3,21,059.25 (24-25) + 1,73,902.08 (25-26).
      contributions: 173902.08,
      billing: 145.14,
      units: { E: 5817.8395, C: 1249.9646, G: 2095.5532 },
    },
    "2026-27": {
      // Partial FY: statement period 2026-04-01 → 2026-07-18.
      // Includes a mid-FY scheme-preference change on 15-Jun-2026
      // (G → E + C rebalance of ₹57,708.72). Switch legs cancel out.
      // Cumulative in CRA header: ₹5,55,354.28
      // = 4,94,961.33 (through 25-26) + 60,392.95 (26-27 partial).
      contributions: 60392.95,
      billing: 88.5,
      units: { E: 6572.2886, C: 2611.0761, G: 765.2724 },
      cumContributions: 555354.28,
      switchBalance: true,
    },
  };

  const fys = fyArg ? [fyArg] : Object.keys(expected).sort();

  // Fetch everything once — we need cross-FY sums for the closing-units
  // check anyway, and the row count is tiny (~50/year).
  const allRes = await fetch(
    `${SB_URL}/rest/v1/nps_transactions?select=fy,scheme,tx_type,amount,units`,
    { headers }
  );
  if (!allRes.ok) throw new Error(await allRes.text());
  const allRows = (await allRes.json()) as Array<{
    fy: string;
    scheme: string;
    tx_type: string;
    amount: number;
    units: number;
  }>;

  for (const fy of fys) {
    console.log("=".repeat(70));
    console.log(`FY ${fy}`);
    console.log("=".repeat(70));

    const rows = allRows.filter((r) => r.fy === fy);
    console.log(`Rows in DB (this FY): ${rows.length}`);

    // Aggregate by tx_type (FY-scoped)
    const byType = rows.reduce<Record<string, { count: number; amt: number }>>(
      (acc, r) => {
        acc[r.tx_type] ??= { count: 0, amt: 0 };
        acc[r.tx_type].count += 1;
        acc[r.tx_type].amt += Number(r.amount);
        return acc;
      },
      {}
    );
    for (const [type, v] of Object.entries(byType)) {
      console.log(`  ${type.padEnd(14)} count=${v.count}  amt=₹${v.amt.toFixed(2)}`);
    }

    const totalContribution = byType.contribution?.amt ?? 0;
    const totalBillingAbs = Math.abs(byType.billing?.amt ?? 0);

    const expE = expected[fy];
    if (!expE) {
      console.log("  (no expected values recorded for this FY, skipping recon)");
      continue;
    }

    console.log("\nReconciliation vs CRA header:");
    const contribMatch =
      Math.abs(totalContribution - expE.contributions) < 0.01;
    console.log(
      `  Contribution: parsed=₹${totalContribution.toFixed(2)}  ` +
        `CRA=₹${expE.contributions.toFixed(2)}  ` +
        (contribMatch ? "✓" : "✗")
    );
    const billingMatch = Math.abs(totalBillingAbs - expE.billing) < 0.01;
    console.log(
      `  Billing:      parsed=₹${totalBillingAbs.toFixed(2)}  ` +
        `CRA=₹${expE.billing.toFixed(2)}  ` +
        (billingMatch ? "✓" : "✗")
    );

    // Per-scheme closing-units check — CRA reports cumulative closing
    // units as of end-of-FY, so we sum tx units across every FY up to
    // and including this one. The FY string sorts lexicographically
    // (2024-25 < 2025-26), which matches chronological order.
    const cumRows = allRows.filter((r) => r.fy <= fy);
    const bySchemeUnits = cumRows.reduce<Record<string, number>>((acc, r) => {
      acc[r.scheme] = (acc[r.scheme] ?? 0) + Number(r.units);
      return acc;
    }, {});
    for (const [scheme, expUnits] of Object.entries(expE.units)) {
      const got = bySchemeUnits[scheme] ?? 0;
      const drift = Math.abs(got - expUnits);
      const ok = drift < 0.001;
      console.log(
        `  Scheme ${scheme} (closing units): parsed=${got.toFixed(4)} u  ` +
          `CRA=${expUnits.toFixed(4)} u  drift=${drift.toFixed(4)} ${ok ? "✓" : "✗"}`
      );
    }

    // Switch-balance check — a scheme-preference change produces a
    // switch_out leg on one scheme (day N) and matching switch_in
    // legs on other schemes (day N+1..N+2). The signed sum must be
    // zero (up to rounding) or units/amount have leaked somewhere.
    if (expE.switchBalance) {
      const swIn = byType.switch_in?.amt ?? 0;
      const swOut = byType.switch_out?.amt ?? 0;
      const net = swIn + swOut;
      const ok = Math.abs(net) < 0.01;
      console.log(
        `  Switch balance: in=₹${swIn.toFixed(2)}  out=₹${swOut.toFixed(2)}  ` +
          `net=₹${net.toFixed(2)} ${ok ? "✓" : "✗"}`
      );
    }

    // Cumulative-contribution check — the CRA statement header shows
    // lifetime total contributions as of the period end. Only meaningful
    // on the most recent FY, so it's opt-in.
    if (expE.cumContributions !== undefined) {
      const cumContrib = allRows
        .filter((r) => r.fy <= fy && r.tx_type === "contribution")
        .reduce((s, r) => s + Number(r.amount), 0);
      const drift = Math.abs(cumContrib - expE.cumContributions);
      const ok = drift < 0.01;
      console.log(
        `  Cumulative contribution: parsed=₹${cumContrib.toFixed(2)}  ` +
          `CRA=₹${expE.cumContributions.toFixed(2)}  ` +
          `drift=₹${drift.toFixed(2)} ${ok ? "✓" : "✗"}`
      );
    }

    console.log();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
