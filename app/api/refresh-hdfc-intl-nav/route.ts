import { NextResponse } from "next/server";
import { sbServer } from "@/lib/supabase";
import { recomputeNwDaily } from "@/lib/recomputeNwDaily";
import {
  HDFC_INTL_FUNDS,
  fetchHdfcIntlFull,
  latestHdfcIntlNav,
} from "@/lib/mf/hdfcIntlClient";
import { fetchUsdInrLive } from "@/lib/fx";
import { storeUsdInr } from "@/lib/fxStore";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * HDFC International (USD GIFT City funds) NAV refresh
 * ===================================================
 *
 * Marks the USD-denominated International holdings in INR each day.
 * Structurally mirrors refresh-nps-nav / refresh-mf-nav (rotate nav_prev,
 * monotonicity guard, recomputeNwDaily at the end) but with a currency
 * twist: the published NAV is USD, so the INR mark is
 *
 *   nav_inr = purchase_nav(USD) × live USD→INR
 *
 * OPTION A (live FX)
 * ------------------
 * The INR value floats with the live market USD→INR every day — the
 * honest "what I'd get back today" number, which surfaces the rupee's
 * drift against the ~₹96 purchase rate. We therefore re-mark FX even on
 * days the fund hasn't published a new USD NAV (weekends aside, when FX
 * is also closed). Storing nav_usd / fx_usd_inr and their _prev lets the
 * UI split the INR move into NAV% vs FX%.
 *
 * WHICH NAV
 * ---------
 * We mark at purchase_nav — the fund's headline/subscription NAV, which is
 * also the price your units were allotted at (so invested_usd = units ×
 * purchase), so the USD return reads as pure NAV performance with no
 * bid/offer-spread artifact and ties to the platform's holding value. The
 * redemption_nav_short_term ("exit today") value is stored separately for a
 * UI liquidation line — what you'd realise now, embedding the ≤2% exit load.
 * See lib/mf/hdfcIntlClient.ts.
 *
 * OUTCOMES (per fund)
 * -------------------
 *   • rotated       — a fresher USD NAV date than DB: prev←current,
 *                     new USD NAV + live FX marked, 1D computed.
 *   • remarked_fx   — same USD NAV date, but re-marked at today's live FX
 *                     (value moves, prev + 1D untouched).
 *   • skipped_stale — source date older than DB (monotonicity guard).
 *   • failed        — history fetch returned nothing.
 *
 * GET and POST both run it (Vercel Cron GET + Sync-page POST).
 */

async function handler() {
  try {
    const codes = Object.keys(HDFC_INTL_FUNDS);
    const { data: rows, error: readErr } = await sbServer
      .from("fund_holdings")
      .select("fund_code, units, nav, nav_date, nav_usd, fx_usd_inr")
      .in("fund_code", codes);
    if (readErr) throw readErr;
    if (!rows || rows.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "No HDFC International rows in fund_holdings. Apply migrations/2026-09-02-international-asset-class.sql first.",
        },
        { status: 400 }
      );
    }

    // One FX read for the whole batch.
    let fx: number;
    try {
      fx = await fetchUsdInrLive();
    } catch (err) {
      return NextResponse.json(
        {
          ok: false,
          error: `USD→INR fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        },
        { status: 502 }
      );
    }

    // Persist today's rate (same source as the mark) so the growth chart can
    // read open.er-api instead of Yahoo. Best-effort — never blocks the refresh.
    await storeUsdInr(fx);

    const now = new Date().toISOString();
    const outcomes: Array<Record<string, unknown>> = [];
    let anyWrite = false;

    for (const row of rows as Array<{
      fund_code: string;
      units: number | null;
      nav: number | null;
      nav_date: string | null;
      nav_usd: number | null;
      fx_usd_inr: number | null;
    }>) {
      const fund = HDFC_INTL_FUNDS[row.fund_code];

      let series;
      try {
        series = await fetchHdfcIntlFull(fund);
      } catch (err) {
        outcomes.push({
          fund_code: row.fund_code,
          state: "failed",
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        });
        continue;
      }
      const latest = latestHdfcIntlNav(series);
      if (!latest) {
        outcomes.push({
          fund_code: row.fund_code,
          state: "failed",
          error: "getHistoricalNavs returned no rows",
        });
        continue;
      }

      const units = Number(row.units ?? 0);
      const dbNavDate = row.nav_date;
      const navInr = latest.purchaseUsd * fx;
      const curValue = units * navInr;

      // Monotonicity — never rotate an older USD NAV date over a newer one.
      if (dbNavDate && latest.navDate < dbNavDate) {
        await sbServer
          .from("fund_holdings")
          .update({ nav_updated_at: now })
          .eq("fund_code", row.fund_code);
        outcomes.push({
          fund_code: row.fund_code,
          state: "skipped_stale",
          nav_date: latest.navDate,
          current_nav_date: dbNavDate,
        });
        continue;
      }

      // Same USD NAV date — no new NAV, but FX may have moved. Re-mark the
      // INR value at today's live rate (option A); leave prev + 1D alone.
      if (dbNavDate && latest.navDate === dbNavDate) {
        await sbServer
          .from("fund_holdings")
          .update({
            fx_usd_inr: fx,
            nav: navInr,
            current_value_inr: Number(curValue.toFixed(2)),
            redeem_nav_short_usd: latest.redeemShortUsd,
            nav_updated_at: now,
          })
          .eq("fund_code", row.fund_code);
        outcomes.push({
          fund_code: row.fund_code,
          state: "remarked_fx",
          nav_date: latest.navDate,
          nav_usd: latest.purchaseUsd,
          fx,
          value_inr: Number(curValue.toFixed(2)),
        });
        anyWrite = true;
        continue;
      }

      // Fresh USD NAV date — rotate. 1D INR is the total move since the
      // prior mark (NAV + FX combined); the stored _prev fields let the UI
      // decompose it.
      const prevNavInr = Number(row.nav ?? 0);
      const oneDayInr = prevNavInr > 0 ? units * (navInr - prevNavInr) : 0;
      const oneDayPct =
        prevNavInr > 0 ? ((navInr - prevNavInr) / prevNavInr) * 100 : 0;

      const { error: updErr } = await sbServer
        .from("fund_holdings")
        .update({
          nav_usd_prev: row.nav_usd ?? null,
          fx_usd_inr_prev: row.fx_usd_inr ?? null,
          nav_prev: row.nav ?? null,
          nav_usd: latest.purchaseUsd,
          fx_usd_inr: fx,
          redeem_nav_short_usd: latest.redeemShortUsd,
          nav: navInr,
          current_value_inr: Number(curValue.toFixed(2)),
          one_day_change_inr: Number(oneDayInr.toFixed(2)),
          one_day_change_pct: Number(oneDayPct.toFixed(4)),
          nav_date: latest.navDate,
          nav_updated_at: now,
          nav_source: "hdfc-intl",
        })
        .eq("fund_code", row.fund_code);
      if (updErr) throw updErr;

      outcomes.push({
        fund_code: row.fund_code,
        state: "rotated",
        nav_date: latest.navDate,
        nav_usd: latest.purchaseUsd,
        redeem_short_usd: latest.redeemShortUsd,
        fx,
        value_inr: Number(curValue.toFixed(2)),
        delta_inr: Number(oneDayInr.toFixed(2)),
      });
      anyWrite = true;
    }

    // Refresh today's nw_daily so the International slice + total_nw reflect
    // the new marks. recomputeNwDaily derives the intl 1D from
    // Σ fund_holdings.one_day_change_inr over asset_class='intl'.
    if (anyWrite) await recomputeNwDaily();

    return NextResponse.json({
      ok: true,
      fx_usd_inr: fx,
      outcomes,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export const GET = handler;
export const POST = handler;
