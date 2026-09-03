import { NextResponse } from "next/server";
import { sbServer } from "@/lib/supabase";
import { HDFC_INTL_FUNDS, fetchHdfcIntlFull } from "@/lib/mf/hdfcIntlClient";
import { fetchUsdInrHistory } from "@/lib/fx";
import { fetchStoredUsdInr } from "@/lib/fxStore";
import { istDate } from "@/lib/istDate";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Per-fund NAV × FX series for an International (USD GIFT City) fund.
 *
 * Combines the fund's published USD NAV series (getHistoricalNavs) with
 * daily USD→INR closes (Yahoo) so the UI can plot the INR value and
 * decompose it into the NAV (USD) move vs the FX move. Each series is
 * also rebased to 100 at the first published day for an apples-to-apples
 * overlay. Fetched client-side by IntlFundGrowthChart so the SSR pages
 * stay off these two external calls.
 */
export async function GET(req: Request) {
  try {
    const fundCode =
      new URL(req.url).searchParams.get("fund") ?? "HDFC_INTL_DM";
    const fund = HDFC_INTL_FUNDS[fundCode];
    if (!fund) {
      return NextResponse.json(
        { ok: false, error: `Unknown international fund '${fundCode}'` },
        { status: 400 }
      );
    }

    const { data: row, error: readErr } = await sbServer
      .from("fund_holdings")
      .select("units, fund_name")
      .eq("fund_code", fundCode)
      .maybeSingle();
    if (readErr) throw readErr;
    const units = Number(row?.units ?? 0);

    const navs = await fetchHdfcIntlFull(fund);
    if (navs.length === 0) {
      return NextResponse.json({ ok: true, fund_code: fundCode, count: 0, points: [] });
    }

    // FX publishes daily even when the fund's USD NAV doesn't (HDFC posts
    // sparsely). Build on the daily FX grid inception→today and carry the
    // last known NAV forward — mirroring option A, where the INR mark
    // re-floats on live FX every day. So the curve gains a point each
    // trading day (FX-driven between publishes, NAV-driven on publish days).
    const today = istDate();
    // Prefer stored open.er-api rates (same source as the live card mark);
    // fall back to Yahoo USDINR=X for dates predating the store (bootstrap).
    const [storedFx, yahooFx] = await Promise.all([
      fetchStoredUsdInr(fund.inceptionDate, today),
      fetchUsdInrHistory(fund.inceptionDate, today),
    ]);
    const fxMap = new Map<string, number>(yahooFx);
    for (const [d, r] of storedFx) fxMap.set(d, r);

    // navs is sorted ascending; carry the most recent NAV on/before a date.
    const navOnOrBefore = (d: string): number | null => {
      let ans: number | null = null;
      for (const n of navs) {
        if (n.navDate <= d) ans = n.purchaseUsd;
        else break;
      }
      return ans;
    };

    const clean = [...fxMap.keys()]
      .filter((d) => d >= fund.inceptionDate && d <= today)
      .sort()
      .map((d) => {
        const navUsd = navOnOrBefore(d);
        const fx = fxMap.get(d)!;
        return navUsd == null
          ? null
          : {
              date: d,
              navUsd,
              fx,
              valueInr: Number((navUsd * fx * units).toFixed(2)),
            };
      })
      .filter(
        (p): p is { date: string; navUsd: number; fx: number; valueInr: number } =>
          p != null
      );

    if (clean.length === 0) {
      return NextResponse.json({ ok: true, fund_code: fundCode, count: 0, points: [] });
    }

    const nav0 = clean[0].navUsd;
    const fx0 = clean[0].fx;
    const val0 = clean[0].valueInr;
    const points = clean.map((p) => ({
      ...p,
      navIdx: (p.navUsd / nav0) * 100,
      fxIdx: (p.fx / fx0) * 100,
      valueIdx: val0 > 0 ? (p.valueInr / val0) * 100 : 100,
    }));

    return NextResponse.json({
      ok: true,
      fund_code: fundCode,
      fund_name: row?.fund_name ?? fund.apiFundName,
      entry_date: clean[0].date,
      units,
      count: points.length,
      points,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
