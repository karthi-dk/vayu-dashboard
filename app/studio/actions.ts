"use server";

import { sbServer as sb } from "@/lib/supabase";
import { schemeCodeForFund, fetchNavForDate } from "@/lib/mf/logMfTx";

/**
 * app/studio/actions.ts
 *
 * Server actions specific to the /studio page. Currently exposes:
 *
 *   • lookupNavForFundOnDate(fund_code, target_date)
 *     Auto-populate helper for the OrderEntryLanding form. Called
 *     when the user picks a fund + NAV date so the NAV value field
 *     can pre-fill without a page reload.
 *
 * Kept in a dedicated file (rather than piled into app/actions.ts)
 * because the Studio surface is intentionally isolated during phase-1
 * testing — smaller blast radius when we tweak the form's behaviour.
 * Everything write-side still funnels through the existing
 * logMfTransaction (app/actions.ts) for consistency; only the
 * auto-populate helper is new.
 */

export type NavLookupPayload =
  | { ok: true; nav: number; nav_date: string; source: "history" | "mfapi" }
  | { ok: false; error: string };

/**
 * Look up the NAV for `fund_code` that would have applied on
 * `target_date`. Two-tier lookup:
 *
 *   1. mf_nav_history table — our authoritative store, fed daily by
 *      the AMFI cron. Fast (Supabase index lookup, sub-100ms) and
 *      always agrees with the numbers that seed fund_holdings. If
 *      the exact target_date is missing (holiday, weekend), we walk
 *      back to the nearest earlier NAV — same behaviour as CAS /
 *      AMC systems ("NAV applied to a weekend-dated SIP is the
 *      previous trading day's NAV").
 *
 *   2. mfapi.in fallback — only if history has nothing at or before
 *      target_date (fund not yet backfilled, or ingestion lagging).
 *      Slower and less reliable (mfapi has intermittent T+1 lag),
 *      but keeps the Studio form usable when the primary source is
 *      cold.
 *
 * The `source` field on the returned payload tells the UI which
 * tier answered — useful for tuning trust indicators later (e.g., a
 * subtle amber tag if mfapi fed the number, since it's a fallback).
 *
 * Errors are structured, not thrown, so the form can render a
 * friendly message rather than a stack trace.
 */
export async function lookupNavForFundOnDate(
  fund_code: string,
  target_date: string
): Promise<NavLookupPayload> {
  if (!fund_code || !target_date) {
    return { ok: false, error: "Fund and date are both required." };
  }

  // ── Tier 1: mf_nav_history ────────────────────────────────────
  // Grab the latest row on or before target_date. Ordered DESC on
  // nav_date so limit(1) gives the "walk back to the nearest
  // earlier NAV" behaviour without pulling the whole history.
  const histRes = await sb
    .from("mf_nav_history")
    .select("nav, nav_date")
    .eq("fund_code", fund_code)
    .lte("nav_date", target_date)
    .order("nav_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (histRes.error) {
    // Non-fatal: fall through to mfapi. Log so we notice recurring
    // history-read failures (usually means service_key is misconfigured
    // in local dev).
    console.warn(
      `[studio.lookupNav] mf_nav_history read failed for ${fund_code}: ${histRes.error.message}`
    );
  }

  if (histRes.data) {
    const nav = Number(histRes.data.nav);
    const navDate = String(histRes.data.nav_date);
    if (Number.isFinite(nav) && nav > 0 && navDate) {
      return { ok: true, nav, nav_date: navDate, source: "history" };
    }
  }

  // ── Tier 2: mfapi.in fallback ─────────────────────────────────
  // Only reached when history has literally no row on or before
  // target_date — usually a fund we haven't backfilled yet.
  const schemeCode = schemeCodeForFund(fund_code);
  if (!schemeCode) {
    return {
      ok: false,
      error: `No mf_nav_history for ${fund_code} on or before ${target_date}, and fund_code has no AMFI scheme code mapping to fall back on.`,
    };
  }

  const mfapiRes = await fetchNavForDate(schemeCode, target_date);
  if (!mfapiRes.ok) {
    return {
      ok: false,
      error: `mf_nav_history had no NAV for ${fund_code} on or before ${target_date}, and mfapi fallback failed: ${mfapiRes.error}`,
    };
  }

  return {
    ok: true,
    nav: mfapiRes.nav,
    nav_date: mfapiRes.nav_date,
    source: "mfapi",
  };
}
