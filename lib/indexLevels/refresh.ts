import { sbServer } from "@/lib/supabase";
import {
  fetchAllIndexLevels,
  type IndexLevelOutcome,
} from "./yahooClient";

/**
 * Shared refresh core for `index_levels`.
 * =========================================
 *
 * Extracted from app/api/refresh-index-levels/route.ts so the same code
 * powers BOTH refresh paths:
 *
 *   1. Manual click — /sync page's RefreshIndexLevelsCard hitting the
 *      /api/refresh-index-levels route (thin wrapper around this).
 *   2. Auto refresh on page load — fetchIndexLevels() in lib/queries.ts
 *      calls this directly (no self-HTTP round-trip) when the cached
 *      snapshot is older than the staleness threshold. See INDEX_LEVELS_
 *      STALE_MS below.
 *
 * Both paths need identical Yahoo-fetch + upsert semantics, so the core
 * lives here and both callers wrap it.
 */

/**
 * Auto-refresh staleness threshold — how long the cached snapshot is
 * considered "fresh enough" to skip a refresh.
 *
 * 60 seconds is deliberately small: a personal dashboard user expects
 * "reload the page" to mean "show me the latest numbers", not "show me
 * whatever was cached in the last 15 minutes" (the prior threshold —
 * which felt broken because a reload 5-10 min after a manual refresh
 * showed byte-identical data, hiding all intraday movement).
 *
 * 60s is short enough that:
 *   • Any real reload (F5 after being on another tab for a bit) gets
 *     fresh data — the eye sees the "Updated" HH:mm timestamp bump and
 *     the numbers move.
 *   • F5-mashing (five reloads in ten seconds while debugging a UI
 *     issue) still shares a single Yahoo hit, protecting the endpoint
 *     from pointless spray.
 *
 * Cost side is a non-issue for Vayu's scale:
 *   • Single-user tool. A refresh means 6 parallel Yahoo chart-API
 *     calls (~1-2s p95, Promise.allSettled-isolated) and 1 Supabase
 *     upsert. Off-hours those calls re-write identical numbers —
 *     harmless.
 *   • Yahoo has never rate-limited this endpoint in months of use;
 *     even at 60s cadence a full trading day is ≤ 400 refreshes,
 *     nowhere near any plausible unofficial-endpoint threshold.
 */
export const INDEX_LEVELS_STALE_MS = 60 * 1000;

export type RefreshIndexLevelsResult = {
  outcomes: IndexLevelOutcome[];
  succeeded: number;
  failed: number;
  failedDetail: Array<{ code: string; error: string }>;
};

/**
 * Fetch fresh index-levels data from Yahoo and upsert into Supabase.
 * Isolates each ticker via Promise.allSettled so one bad ticker doesn't
 * kill the whole batch — mirrors app/api/refresh-mf-nav/route.ts.
 *
 * Throws only on the upsert failure. Per-ticker Yahoo failures are
 * surfaced in the return value's `failedDetail` for the caller to
 * decide how to present them.
 */
export async function refreshIndexLevels(): Promise<RefreshIndexLevelsResult> {
  const outcomes = await fetchAllIndexLevels();

  const succeeded = outcomes.filter(
    (
      o
    ): o is {
      code: typeof o.code;
      ok: true;
      data: NonNullable<Extract<typeof o, { ok: true }>["data"]>;
    } => o.ok
  );
  const failed = outcomes.filter((o) => !o.ok);

  if (succeeded.length > 0) {
    const rows = succeeded.map((o) => ({
      index_code: o.data.code,
      display_name: o.data.displayName,
      currency: o.data.currency,
      current_level: o.data.currentLevel,
      as_of_date: o.data.currentDate,
      // New in 2026-07-24-index-levels-previous-close.sql — null-safe
      // upsert works because both columns are nullable in the schema.
      previous_close: o.data.previousLevel,
      previous_close_date: o.data.previousDate,
      ath_level: o.data.athLevel,
      ath_date: o.data.athDate,
      high_52w_level: o.data.high52wLevel,
      high_52w_date: o.data.high52wDate,
      high_3m_level: o.data.high3mLevel,
      high_3m_date: o.data.high3mDate,
      updated_at: new Date().toISOString(),
    }));

    const { error: upsertErr } = await sbServer
      .from("index_levels")
      .upsert(rows, { onConflict: "index_code" });
    if (upsertErr) {
      // Supabase's PostgrestError is a plain object, not an Error
      // instance. Wrap it so the caller (API route or auto-refresh
      // path) gets a proper Error to serialize instead of the
      // unhelpful [object Object].
      const msg =
        typeof upsertErr === "object" &&
        upsertErr !== null &&
        "message" in upsertErr
          ? String((upsertErr as { message: unknown }).message)
          : String(upsertErr);
      throw new Error(`index_levels upsert failed: ${msg}`);
    }
  }

  const failedDetail = failed.map((o) => ({
    code: o.code,
    // TypeScript can't narrow o.error through the ok-discriminant here
    // since `failed` was filtered with a plain !o.ok check — cast is
    // safe, this branch only ever holds { ok: false } members.
    error: (o as { ok: false; error: string }).error,
  }));

  return {
    outcomes,
    succeeded: succeeded.length,
    failed: failed.length,
    failedDetail,
  };
}
