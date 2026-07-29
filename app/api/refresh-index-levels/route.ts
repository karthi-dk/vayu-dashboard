import { NextResponse } from "next/server";
import { refreshIndexLevels } from "@/lib/indexLevels/refresh";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Index levels refresh — All-Time High / 52-week high / 3-month high
 * =====================================================================
 *
 * Manual-trigger route (button on /sync) that fetches full daily-close
 * history for the six tracked indices (Nifty 50, Nifty Next 50, Nifty
 * Midcap 150, Nifty Smallcap 250, Nasdaq 100, S&P 500) from Yahoo
 * Finance, derives current/previous/ATH/52w-high/3m-high from each, and
 * upserts one row per index into `index_levels`.
 *
 * Thin wrapper around lib/indexLevels/refresh.ts's `refreshIndexLevels`,
 * which is ALSO invoked directly (no HTTP round-trip) by the page-load
 * auto-refresh path in lib/queries.ts. Keeps both paths byte-identical
 * in their Yahoo-fetch + Supabase-upsert semantics.
 *
 * See lib/indexLevels/yahooClient.ts for the ticker map (with real
 * gotchas documented — Nifty Next 50's non-obvious ^NSMIDCP ticker and
 * the dead NIFTY_NEXT_50.NS trap) and the daily-resolution fetch
 * mechanics.
 *
 * This table isn't a time series — each refresh OVERWRITES the row for
 * an index with freshly-recomputed values. No idempotency key needed;
 * re-running with the same day's data just re-writes the same numbers.
 *
 * GET and POST both work — GET for a future cron wire-up, POST for the
 * manual button (matches refresh-mf-nav / refresh-nps-nav convention).
 */
async function handler() {
  try {
    const { outcomes, succeeded, failed, failedDetail } =
      await refreshIndexLevels();

    return NextResponse.json({
      ok: true,
      refreshed: succeeded,
      failed,
      total: outcomes.length,
      failed_detail: failedDetail,
      message:
        failed === 0
          ? `Refreshed all ${succeeded} indices`
          : `Refreshed ${succeeded}/${outcomes.length} indices · ${failed} failed (${failedDetail
              .map((f) => f.code)
              .join(", ")})`,
    });
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.message
        : typeof err === "object" && err !== null && "message" in err
          ? String((err as { message: unknown }).message)
          : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export const GET = handler;
export const POST = handler;
