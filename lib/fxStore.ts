/**
 * lib/fxStore.ts
 *
 * Persistence for daily FX reference rates (see migrations/2026-09-02-fx-rates.sql).
 * Kept separate from lib/fx.ts (which is pure external-API fetch helpers) so
 * the Supabase dependency stays out of that module.
 *
 * The International mark uses the live open.er-api rate; storing it each day
 * lets the per-fund NAV-vs-FX chart read the SAME source as the card, instead
 * of Yahoo. Both functions are best-effort: they never throw and degrade to a
 * no-op / empty map if the fx_rates table hasn't been migrated yet, so callers
 * fall back to a live source.
 */

import { sbServer } from "@/lib/supabase";
import { istDate } from "@/lib/istDate";

const PAIR = "USDINR";

/** Upsert today's (IST) USD→INR rate. Never throws — a NAV refresh must not
 *  fail because this table is missing or unwritable. */
export async function storeUsdInr(
  rate: number,
  source = "open.er-api"
): Promise<void> {
  if (!Number.isFinite(rate) || rate <= 0) return;
  try {
    const { error } = await sbServer
      .from("fx_rates")
      .upsert(
        { pair: PAIR, rate_date: istDate(), rate, source },
        { onConflict: "pair,rate_date" }
      );
    if (error) console.warn(`[fxStore] store USDINR skipped: ${error.message}`);
  } catch (err) {
    console.warn(
      `[fxStore] store USDINR failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Stored USD→INR daily rates in [from, to] as Map<YYYY-MM-DD, rate>. Returns
 *  an empty map if the table is missing (pre-migration) or on error. */
export async function fetchStoredUsdInr(
  from: string,
  to: string
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const { data, error } = await sbServer
      .from("fx_rates")
      .select("rate_date, rate")
      .eq("pair", PAIR)
      .gte("rate_date", from)
      .lte("rate_date", to);
    if (error) {
      console.warn(`[fxStore] read USDINR skipped: ${error.message}`);
      return out;
    }
    for (const r of (data ?? []) as Array<{ rate_date: string; rate: number }>) {
      const d = String(r.rate_date).slice(0, 10);
      const v = Number(r.rate);
      if (Number.isFinite(v) && v > 0) out.set(d, v);
    }
  } catch (err) {
    console.warn(
      `[fxStore] read USDINR failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return out;
}
