/**
 * POST /api/sync-groww
 *
 * Accepts the raw Groww /v1/api/mf/portfolio JSON in the request body, maps
 * each holding's schemeCode → our fund_code, upserts fund_holdings rows, and
 * then recomputes today's nw_daily via the shared helper.
 *
 * Port of scripts/sync_groww.py (Python, Streamlit era). Same schema, same
 * upsert semantics, same SCHEME_TO_CODE mapping — kept aligned so a Python
 * fallback still works if this route is ever unavailable.
 */
import { NextRequest, NextResponse } from "next/server";
import { sbServer } from "@/lib/supabase";
import { recomputeNwDaily } from "@/lib/recomputeNwDaily";
import { SCHEME_CODE_TO_FUND as SCHEME_TO_CODE } from "@/lib/fundIsin";

type GrowwHolding = {
  schemeCode?: string | number;
  units?: string | number;
  currentNav?: string | number;
  currentNavDate?: string;
  amountInvested?: string | number;
  currentValue?: string | number;
  folioNumber?: string;
  // Per-holding 1D change fields from Groww's JSON. Optional because we
  // don't want to hard-fail on older/partial responses, and defensive
  // because Groww ships numbers as strings in some fields.
  dayChange?: {
    oneDayReturn?: string | number;
    percentage?: string | number;
  };
};

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function POST(req: NextRequest) {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Body is not valid JSON" },
      { status: 400 }
    );
  }

  const holdings = (payload as { holdings?: GrowwHolding[] })?.holdings;
  if (!Array.isArray(holdings)) {
    return NextResponse.json(
      { error: "Expected top-level `holdings` array" },
      { status: 400 }
    );
  }

  // Groww exposes its own daily-change numbers at the top level of the JSON.
  // Persist them verbatim (see lib/recomputeNwDaily.ts docstring for why we
  // prefer these over snapshot-diff). Cast defensively — a missing or
  // malformed field just becomes null and the recompute helper preserves
  // whatever was previously stored.
  const growwTop = payload as {
    oneDayReturnValue?: unknown;
    oneDayReturn?: unknown;
  };
  const oneDayReturnValueRaw = Number(growwTop.oneDayReturnValue);
  const oneDayReturnRaw = Number(growwTop.oneDayReturn);
  const oneDayReturnValue = Number.isFinite(oneDayReturnValueRaw)
    ? oneDayReturnValueRaw
    : null;
  const oneDayReturn = Number.isFinite(oneDayReturnRaw)
    ? oneDayReturnRaw
    : null;

  const synced: string[] = [];
  const skipped: string[] = [];
  const errors: { scheme_code: string; error: string }[] = [];

  for (const h of holdings) {
    const schemeCode = String(h.schemeCode ?? "");
    const fundCode = SCHEME_TO_CODE[schemeCode];
    if (!fundCode) {
      skipped.push(schemeCode);
      continue;
    }
    const navDate =
      typeof h.currentNavDate === "string" && h.currentNavDate.length >= 10
        ? h.currentNavDate.slice(0, 10)
        : null;

    // Per-holding 1D change from Groww's dayChange block. Compute absolute
    // ₹ once at sync time (units × per-unit NAV move) so the UI doesn't
    // need to multiply on every render. Both fields default to null when
    // Groww omits them — the Portfolio table falls back to "—" gracefully.
    const perUnitChangeRaw = h.dayChange?.oneDayReturn;
    const pctChangeRaw = h.dayChange?.percentage;
    const unitsForCalc = num(h.units);
    const oneDayChangeInr =
      perUnitChangeRaw != null && Number.isFinite(num(perUnitChangeRaw))
        ? Number((num(perUnitChangeRaw) * unitsForCalc).toFixed(2))
        : null;
    const oneDayChangePct =
      pctChangeRaw != null && Number.isFinite(num(pctChangeRaw))
        ? Number(num(pctChangeRaw).toFixed(4))
        : null;

    // Fetch existing nav so we can rotate it into nav_prev — Groww paste
    // gives us "today's NAV" without a previous-day pair, so we need to
    // read the DB row to preserve the anchor for tomorrow's 1D delta
    // computation. Only rotate when navDate actually advances (matches
    // the refresh-mf-nav idempotency guard so repeated pastes within a
    // NAV cycle don't clobber nav_prev).
    const { data: existing } = await sbServer
      .from("fund_holdings")
      .select("nav, nav_date")
      .eq("fund_code", fundCode)
      .maybeSingle();

    // navPrev semantics:
    //   • First-ever sync: no existing row → nav_prev stays null.
    //   • Repeat sync on same nav_date (idempotent): keep whatever nav_prev
    //     the DB already has (don't collapse it to today's NAV).
    //   • Advancing nav_date: rotate existing.nav into nav_prev so
    //     tomorrow's mfapi refresh (or next paste) has an accurate anchor.
    const currentNav = num(h.currentNav);
    const shouldRotate =
      existing?.nav_date != null &&
      navDate != null &&
      navDate > existing.nav_date &&
      existing.nav != null;
    const navPrev = shouldRotate ? Number(existing.nav) : undefined;

    const nowIso = new Date().toISOString();
    const upsertPayload: Record<string, unknown> = {
      fund_code: fundCode,
      units: num(h.units),
      nav: currentNav,
      nav_date: navDate,
      invested_inr: num(h.amountInvested),
      current_value_inr: num(h.currentValue),
      folio_number: h.folioNumber ?? "",
      data_source: "groww_sync",
      one_day_change_inr: oneDayChangeInr,
      one_day_change_pct: oneDayChangePct,
      // nav_source stamps the row so the Sync page badge shows "from
      // Groww" for funds last touched by a paste and "from mfapi" for
      // funds last touched by the daily automated refresh. Setting on
      // every path guarantees the badge is always current.
      nav_source: "groww",
      nav_updated_at: nowIso,
      updated_at: nowIso,
    };
    if (navPrev !== undefined) {
      upsertPayload.nav_prev = navPrev;
    }

    const { error } = await sbServer
      .from("fund_holdings")
      .upsert(upsertPayload, { onConflict: "fund_code" });
    if (error) {
      errors.push({ scheme_code: schemeCode, error: error.message });
      continue;
    }
    synced.push(fundCode);
  }

  if (synced.length === 0) {
    return NextResponse.json(
      {
        error:
          "No holdings synced. Check that the JSON's schemeCodes match SCHEME_TO_CODE in this route.",
        skipped,
        errors,
      },
      { status: 400 }
    );
  }

  try {
    await recomputeNwDaily({
      mf_1d_change_inr: oneDayReturnValue,
      mf_1d_change_pct: oneDayReturn,
    });
  } catch (e) {
    return NextResponse.json(
      {
        message: `Synced ${synced.length} funds but nw_daily recompute failed: ${
          e instanceof Error ? e.message : String(e)
        }. Fund values are updated; overview headline will fix itself on next NPS/EPF update or 2 AM cron.`,
        synced,
        skipped,
      },
      { status: 207 }
    );
  }

  return NextResponse.json({
    message: `Synced ${synced.length} funds and refreshed nw_daily.`,
    synced,
    skipped,
    errors,
  });
}
