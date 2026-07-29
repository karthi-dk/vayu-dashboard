import { NextResponse } from "next/server";
import { sbServer } from "@/lib/supabase";
import { recomputeNwDaily } from "@/lib/recomputeNwDaily";
import { fetchBatch, type BatchResult, type LatestNav } from "@/lib/mf/mfapiClient";
import { fetchAmfiSnapshot, type AmfiLatestNav } from "@/lib/mf/amfiClient";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * MF NAV refresh — AMFI primary + mfapi.in fallback
 * =================================================
 *
 * Daily NAV refresh for all funds in fund_holdings, structurally
 * mirroring app/api/refresh-nps-nav/route.ts (Kotak primary +
 * npsnav.in fallback). Same idempotency guarantees, same monotonicity
 * guards, same nav_prev rotation. Read that file's header first if
 * this one seems dense — the reasoning is shared.
 *
 * DATA SOURCES (in priority order)
 * --------------------------------
 * 1. AMFI NAVAll.txt — authoritative single-file bhavcopy for every
 *    open-ended MF NAV in India. See lib/mf/amfiClient.ts for the
 *    client-level notes on format, staleness filtering, and error
 *    philosophy. Fresher than mfapi at night — see WHY TWO SOURCES
 *    below.
 *
 * 2. mfapi.in — community JSON mirror of AMFI, per-scheme endpoint.
 *    See lib/mf/mfapiClient.ts for the retry / concurrency machinery
 *    that keeps its transient TLS flakes from failing the batch.
 *
 * WHY TWO SOURCES
 * ---------------
 * mfapi.in mirrors AMFI on a 6/day schedule (~10:05, 14:05, 18:05,
 * 21:05, then 03:09 and 05:05 the following morning, all IST).
 * Between the 21:05 refresh and the 03:09 next-day refresh there is
 * a hard ~6-hour dead window where AMFI has published today's NAVs
 * but mfapi hasn't yet mirrored them. Verified 2026-07-22 23:55 IST:
 * AMFI had 22-Jul NAVs for 8/10 user funds; mfapi still returned
 * 21-Jul across the board. Fetching AMFI directly as the primary
 * source closes that window; mfapi covers the (legitimately) T+1
 * overseas funds that AMFI hasn't posted yet, and covers everything
 * on the rare occasion AMFI itself is unreachable.
 *
 * FALLBACK BEHAVIOR
 * -----------------
 * The AMFI snapshot fetch is one HTTP call for the whole file. If it
 * fails (network, non-200, sub-100KB body, zero data rows parsed),
 * we log the reason and route ALL funds through mfapi — degrades
 * gracefully to pre-2026-07-22 behavior.
 *
 * If AMFI succeeds but a specific fund has no fresh row (missing
 * scheme code OR row older than the AMFI client's staleness cutoff),
 * that individual fund gets routed to mfapi. This is the expected
 * path for overseas funds until mid-morning IST — SEBI allows
 * ≥20%-overseas funds to publish T+1, so AMFI carries yesterday's
 * date for them. mfapi (feeding off the same file) will legitimately
 * also return T-1, and the route's monotonicity guard handles that
 * cleanly.
 *
 * The fallback selection is invisible to the UI — one button, one
 * outcome. The nav_source stamp on each rotated row records which
 * path served it ('amfi' vs 'mfapi'), so a later audit can attribute
 * data provenance without re-querying.
 *
 * PER-FUND RESULT MODEL
 * ---------------------
 * We resolve each fund independently. Each fund's result lands in one
 * of four buckets:
 *
 *   • ROTATED — the picked source returned a fresher NAV than DB.
 *     Old nav → nav_prev, new nav → nav. 1D chip computed from
 *     delta. nav_source stamped with the actual source used.
 *
 *   • ALREADY_FRESH — the picked source's date matches DB's nav_date
 *     exactly. Common case for repeat clicks within the same NAV
 *     cycle. Timestamp bumped so the UI shows "just now"; nav_source
 *     and nav are preserved so we don't accidentally regress or
 *     clobber Groww-paste provenance.
 *
 *   • SKIPPED_STALE — the picked source's date is OLDER than DB
 *     (rare — happens when a Groww paste with newer navDate landed
 *     since the last automated refresh, or when only mfapi could
 *     answer and it's mid-dead-window). Timestamp-only bump.
 *
 *   • FAILED — AMFI missed AND mfapi errored for this fund. No DB
 *     write; next cycle retries. Other funds still succeed.
 *
 * The response body enumerates each fund's bucket + delta + source so
 * the UI can compose an accurate summary without inferring anything.
 *
 * HANDLERS
 * --------
 * GET and POST both do the same thing so this endpoint works for:
 *   • Vercel Cron (hits with GET automatically at 06:00 IST daily)
 *   • Manual button on Sync page (fires POST via fetch)
 */

// ── Types ────────────────────────────────────────────────────────────────

type FundRow = {
  fund_code: string;
  units: number | null;
  nav: number | null;
  nav_date: string | null;
  invested_inr: number | null;
  scheme_code: string; // resolved via FUND_TO_SCHEME below
};

/**
 * Which upstream data source served a given fund's NAV. Written to
 * fund_holdings.nav_source on rotate; surfaced per-outcome in the
 * response so the UI (and any log-scraping audit) can attribute
 * provenance without re-querying.
 *
 * Kept as a route-local alias rather than importing MfNavSource from
 * lib/queries.ts — that type also carries the "groww" variant, which
 * this route never writes (groww provenance comes from
 * app/api/sync-groww/route.ts). Narrowing here catches a stray
 * `source: "groww"` at compile time.
 */
type NavSourceStamp = "amfi" | "mfapi";

type PerFundOutcome =
  | { fund_code: string; scheme_code: string; state: "rotated"; nav: number; nav_prev: number | null; nav_date: string; delta_inr: number; source: NavSourceStamp }
  | { fund_code: string; scheme_code: string; state: "already_fresh"; nav_date: string; source: NavSourceStamp }
  | { fund_code: string; scheme_code: string; state: "skipped_stale"; nav_date: string; db_nav_date: string; source: NavSourceStamp }
  | { fund_code: string; scheme_code: string; state: "failed"; error: string };

/**
 * Internal per-fund "we picked this NAV from this source" record —
 * built up front by the two-tier fetch below, then consumed by the
 * per-fund rotate loop. Split out so the picking logic (AMFI first,
 * fall back to mfapi per-fund) stays independent of the rotate
 * logic (idempotency guard, monotonicity guard, DB write).
 */
type PickedNav = { nav: LatestNav; source: NavSourceStamp };

// ── Fund → AMFI/mfapi scheme code ─────────────────────────────────────
// Reverse of SCHEME_TO_CODE in app/api/sync-groww/route.ts. AMFI and
// mfapi share the same code namespace (mfapi mirrors AMFI 1:1), so one
// mapping serves both sources.
//
// Kept in sync manually because there's no shared TypeScript enum for
// these — if we add a fund, update both places (and add a matching
// NAV_KEY here). The TypeScript compiler doesn't have a way to enforce
// the reverse mapping stays in sync with the forward one, so a code
// review checklist item is the pragmatic guard here.
const FUND_TO_SCHEME: Record<string, string> = {
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

// ── Handler ──────────────────────────────────────────────────────────────

async function handler() {
  try {
    // 1. Load current fund_holdings rows so we can rotate NAVs.
    //    We select only what we need — the recomputeNwDaily call at the
    //    end re-reads what it needs, no need to pass rich state around.
    const { data: fundsData, error: readErr } = await sbServer
      .from("fund_holdings")
      .select("fund_code, units, nav, nav_date, invested_inr");
    if (readErr) throw readErr;
    if (!fundsData || fundsData.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "fund_holdings is empty. Seed it via a Groww paste on the Sync page first.",
        },
        { status: 400 }
      );
    }

    const funds: FundRow[] = [];
    const unmapped: string[] = [];
    for (const f of fundsData as Array<{
      fund_code: string;
      units: number | null;
      nav: number | null;
      nav_date: string | null;
      invested_inr: number | null;
    }>) {
      const scheme = FUND_TO_SCHEME[f.fund_code];
      if (!scheme) {
        unmapped.push(f.fund_code);
        continue;
      }
      funds.push({ ...f, scheme_code: scheme });
    }

    if (funds.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error: `No fund_holdings rows have a NAV scheme code mapped. Unmapped: ${unmapped.join(", ")}`,
        },
        { status: 500 }
      );
    }

    // 2. Two-tier fetch: AMFI primary, mfapi per-fund fallback.
    //
    //    Tier 1 — AMFI: single HTTP call for the whole ~1.6 MB
    //    NAVAll.txt, parsed once, indexed by scheme code. On any
    //    failure we log the reason and fall through as if AMFI
    //    wasn't wired in (degrades to pre-2026-07-22 behavior of
    //    routing all funds through mfapi). See lib/mf/amfiClient.ts
    //    for the "throws on catastrophic parse failure, silently
    //    drops per-row malformations" error philosophy.
    //
    //    Tier 2 — mfapi: only for funds AMFI didn't cover (missing
    //    scheme code OR row older than the AMFI staleness cutoff,
    //    OR the whole AMFI snapshot failed). Kept as a single
    //    batch call so mfapiClient's bounded-concurrency + pool-
    //    reset retry logic still applies.
    let amfiSnapshot: Map<string, AmfiLatestNav> | null = null;
    let amfiFallbackReason: string | null = null;
    try {
      amfiSnapshot = await fetchAmfiSnapshot();
    } catch (err) {
      amfiFallbackReason =
        err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      // Log so it shows up in `next dev` terminal and Vercel function
      // logs. Client also sees it in the response payload
      // (amfi_fallback_reason) for DevTools inspection without server
      // access — same convention as refresh-nps-nav's
      // kotak_fallback_reason.
      console.warn(
        `[refresh-mf-nav] AMFI primary failed, routing all funds through mfapi. Reason: ${amfiFallbackReason}`
      );
    }

    // Bucket each fund into an "AMFI has it fresh" hit or an
    // "ask mfapi" miss. The picked map is what the rotate loop
    // below actually reads from — a uniform view over both sources.
    const pickedByCode = new Map<string, PickedNav>();
    const mfapiCodes: string[] = [];
    for (const fund of funds) {
      const amfiHit = amfiSnapshot?.get(fund.scheme_code);
      if (amfiHit) {
        pickedByCode.set(fund.scheme_code, { nav: amfiHit, source: "amfi" });
      } else {
        mfapiCodes.push(fund.scheme_code);
      }
    }

    // Fetch the fallback set from mfapi (if any). Skipping the call
    // entirely when AMFI covered everything shaves ~2-3s off the
    // wall-clock on nights where all 10 funds are on AMFI.
    const mfapiResults: BatchResult[] = mfapiCodes.length
      ? await fetchBatch(mfapiCodes)
      : [];
    const mfapiByCode = new Map<string, BatchResult>();
    for (const r of mfapiResults) mfapiByCode.set(r.schemeCode, r);
    for (const code of mfapiCodes) {
      const r = mfapiByCode.get(code);
      if (r && r.ok) {
        pickedByCode.set(code, { nav: r.nav, source: "mfapi" });
      }
      // Misses stay out of pickedByCode; the rotate loop below
      // surfaces them as { state: "failed" } with the mfapi error
      // message pulled back out of mfapiByCode.
    }

    // 3. Per-fund rotation. Each iteration is independent — one failure
    //    doesn't cascade. We collect outcomes for the response summary
    //    and only issue DB writes for the rotate + guard-bump paths.
    const outcomes: PerFundOutcome[] = [];
    let anyRotated = false;

    for (const fund of funds) {
      const picked = pickedByCode.get(fund.scheme_code);
      if (!picked) {
        // AMFI missed AND mfapi errored (or wasn't even asked because
        // this fund was in the AMFI-covered list — but then it'd be
        // in pickedByCode; getting here for a covered fund is a bug).
        // Compose the failure message with as much context as we
        // have: prefer the mfapi error, fall back to "no source
        // returned data".
        const mfapiFail = mfapiByCode.get(fund.scheme_code);
        const errMsg =
          mfapiFail && !mfapiFail.ok
            ? mfapiFail.error
            : "no result from any source";
        outcomes.push({
          fund_code: fund.fund_code,
          scheme_code: fund.scheme_code,
          state: "failed",
          error: errMsg,
        });
        continue;
      }

      const latest: LatestNav = picked.nav;
      const source = picked.source;
      const dbNav = Number(fund.nav ?? 0);
      const dbNavDate = fund.nav_date;

      // Idempotency guard — same NAV date as DB. Bump timestamp only,
      // don't touch nav, nav_prev, or nav_source. This preserves
      // Groww-paste provenance (and any earlier amfi/mfapi stamp)
      // across a subsequent refresh click that happens to run on the
      // same NAV cycle.
      if (dbNavDate && dbNavDate === latest.navDate) {
        await sbServer
          .from("fund_holdings")
          .update({ nav_updated_at: new Date().toISOString() })
          .eq("fund_code", fund.fund_code);
        outcomes.push({
          fund_code: fund.fund_code,
          scheme_code: fund.scheme_code,
          state: "already_fresh",
          nav_date: latest.navDate,
          source,
        });
        continue;
      }

      // Monotonicity guard — the source's date is older than what we
      // have. Two common paths here:
      //   (a) A Groww paste landed a fresher NAV since the last
      //       automated refresh — DB is ahead of both AMFI/mfapi.
      //   (b) An overseas fund fell to mfapi fallback mid-dead-window
      //       and mfapi returned yesterday's date, but DB was
      //       already updated by an earlier AMFI-served refresh
      //       today. Either way: refuse to rotate stale data into
      //       nav — that would produce a nonsense negative 1D. Bump
      //       the timestamp so the UI shows the click was processed,
      //       leave nav / nav_prev / nav_source alone.
      if (dbNavDate && latest.navDate < dbNavDate) {
        await sbServer
          .from("fund_holdings")
          .update({ nav_updated_at: new Date().toISOString() })
          .eq("fund_code", fund.fund_code);
        outcomes.push({
          fund_code: fund.fund_code,
          scheme_code: fund.scheme_code,
          state: "skipped_stale",
          nav_date: latest.navDate,
          db_nav_date: dbNavDate,
          source,
        });
        continue;
      }

      // ── Rotate ──
      // The interesting case: the picked source has a fresher NAV
      // than DB. Move current nav → nav_prev, write new nav, refresh
      // 1D fields, update current_value_inr, and stamp nav_source
      // with the actual source used ('amfi' or 'mfapi').
      //
      // 1D delta: units × (new NAV − old NAV). If old NAV is 0 (first
      // refresh ever for this fund), treat delta as 0 — the next
      // refresh cycle will produce a legit 1D.
      const units = Number(fund.units ?? 0);
      const newValue = Number((units * latest.nav).toFixed(2));
      const oneDayChangeInr =
        dbNav > 0 ? Number((units * (latest.nav - dbNav)).toFixed(2)) : 0;
      const oneDayChangePct =
        dbNav > 0 ? Number((((latest.nav - dbNav) / dbNav) * 100).toFixed(4)) : 0;

      const { error: updateErr } = await sbServer
        .from("fund_holdings")
        .update({
          nav_prev: dbNav > 0 ? dbNav : null,
          nav: latest.nav,
          nav_date: latest.navDate,
          nav_updated_at: new Date().toISOString(),
          nav_source: source,
          current_value_inr: newValue,
          // Overwrite 1D fields with the source-derived values.
          // These will match Groww's oneDayReturnValue to the paisa
          // on days where no deposits happened. On deposit days they
          // differ slightly — the source-derived number is the
          // "pure market move" (arguably more correct than Groww's,
          // which conflates NAV move with unit-count changes).
          one_day_change_inr: oneDayChangeInr,
          one_day_change_pct: oneDayChangePct,
        })
        .eq("fund_code", fund.fund_code);
      if (updateErr) {
        outcomes.push({
          fund_code: fund.fund_code,
          scheme_code: fund.scheme_code,
          state: "failed",
          error: `DB update: ${updateErr.message}`,
        });
        continue;
      }

      outcomes.push({
        fund_code: fund.fund_code,
        scheme_code: fund.scheme_code,
        state: "rotated",
        nav: latest.nav,
        nav_prev: dbNav > 0 ? dbNav : null,
        nav_date: latest.navDate,
        delta_inr: oneDayChangeInr,
        source,
      });
      anyRotated = true;
    }

    // 4. If any fund actually rotated, recompute nw_daily so the Overview
    //    headline reflects the new MF total value and 1D.
    //
    //    Compute the MF 1D as the sum of per-fund 1D changes on rotated
    //    funds. This matches Groww's oneDayReturnValue semantics exactly
    //    (Groww is also a per-fund sum) so the headline behaves the
    //    same regardless of whether the day's refresh came from mfapi
    //    or a Groww paste.
    //
    //    We DON'T recompute if nothing rotated — the previous MF 1D on
    //    nw_daily stays intact via the shared helper's "undefined =
    //    preserve" semantics.
    if (anyRotated) {
      // Portfolio 1D INR + %: match Groww's convention by summing each
      // fund's PERSISTENT one_day_change_inr from fund_holdings, not
      // just the funds that rotated on this specific refresh cycle.
      //
      // WHY THIS CONVENTION
      // -------------------
      // Groww's portfolio-returns page shows "sum of each fund's
      // most-recent 1D move", regardless of whether the underlying
      // NAV date is T-1 for some funds (overseas T+1 lag) and T-2 for
      // others. It's the industry-standard aggregation across every
      // Indian broker/tracker.
      //
      // Purely from an analytical standpoint, this mixes time periods
      // on mixed-rotation days (e.g. tonight 23-Jul 00:37 IST: 8
      // Indian funds' 1D reflects 22-vs-21 Jul while the 2 overseas
      // funds' stored 1D still reflects 21-vs-20 Jul). Prior
      // implementations tried to be analytically rigorous by
      // aggregating only the funds that rotated in the current cycle,
      // but that consistently disagreed with Groww by the overseas
      // funds' contribution — creating a distracting reconciliation
      // gap in the dashboard.
      //
      // Re-fetching fund_holdings post-rotation is deliberate: we want
      // the JUST-WRITTEN values for rotated funds (their outcome.delta_inr
      // was persisted a few lines above), plus the PRE-EXISTING values
      // for non-rotated funds (untouched by this cycle). One extra
      // 10-row read is a rounding error in a 30s-max endpoint.
      //
      // Denominator = sum of (current_value - 1D_delta) across funds.
      // Mathematically equivalent to Σ (units × yesterday_nav) with
      // "yesterday" defined per-fund by whatever cycle last set their
      // one_day_change_inr — exactly how Groww implicitly defines it.
      const { data: postFundsRaw } = await sbServer
        .from("fund_holdings")
        .select("current_value_inr, one_day_change_inr");
      const postFunds = postFundsRaw ?? [];

      const mf1dInr = postFunds.reduce(
        (s, f) => s + Number(f.one_day_change_inr ?? 0),
        0
      );
      const currentTotal = postFunds.reduce(
        (s, f) => s + Number(f.current_value_inr ?? 0),
        0
      );
      const prevValue = currentTotal - mf1dInr;
      const mf1dPct =
        prevValue > 0
          ? Number(((mf1dInr / prevValue) * 100).toFixed(4))
          : 0;

      await recomputeNwDaily({
        mf_1d_change_inr: Number(mf1dInr.toFixed(2)),
        mf_1d_change_pct: mf1dPct,
      });
    }

    // 5. Build response summary.
    const rotatedCount = outcomes.filter((o) => o.state === "rotated").length;
    const alreadyFreshCount = outcomes.filter(
      (o) => o.state === "already_fresh"
    ).length;
    const skippedStaleCount = outcomes.filter(
      (o) => o.state === "skipped_stale"
    ).length;
    const failedCount = outcomes.filter((o) => o.state === "failed").length;

    // Per-source counts across all non-failed outcomes. Rotated is the
    // interesting number for "did AMFI actually save us tonight?" —
    // it's the count of funds where the source actually advanced the
    // DB's NAV date. already_fresh + skipped_stale hit the source
    // but didn't change anything, so we track them separately for
    // debugging even if the UI ends up ignoring them.
    const refreshedFromAmfi = outcomes.filter(
      (o) => o.state === "rotated" && o.source === "amfi"
    ).length;
    const refreshedFromMfapi = outcomes.filter(
      (o) => o.state === "rotated" && o.source === "mfapi"
    ).length;
    const servedByAmfi = outcomes.filter(
      (o) => o.state !== "failed" && o.source === "amfi"
    ).length;
    const servedByMfapi = outcomes.filter(
      (o) => o.state !== "failed" && o.source === "mfapi"
    ).length;

    // Pick a headline "nav_date" for the batch — the most common one
    // across successful outcomes (rotated OR already_fresh). This is
    // what the UI shows in "NAVs as of X" — using the max would look
    // weird if a single T+2 outlier drags the whole batch's label.
    const successNavDates = outcomes
      .filter(
        (o): o is Extract<PerFundOutcome, { state: "rotated" | "already_fresh" }> =>
          o.state === "rotated" || o.state === "already_fresh"
      )
      .map((o) => o.nav_date);
    const dateCounts = new Map<string, number>();
    for (const d of successNavDates) dateCounts.set(d, (dateCounts.get(d) ?? 0) + 1);
    let headlineNavDate: string | null = null;
    let bestCount = 0;
    for (const [d, count] of dateCounts.entries()) {
      if (count > bestCount || (count === bestCount && (headlineNavDate === null || d > headlineNavDate))) {
        headlineNavDate = d;
        bestCount = count;
      }
    }

    // Batch-level source label for the top-level "source" field.
    //   • "amfi"  — everything came from AMFI
    //   • "mfapi" — everything came from mfapi (AMFI never picked up
    //               any fund; usually because the AMFI snapshot fetch
    //               itself failed and amfi_fallback_reason will be set)
    //   • "mixed" — some funds served by each (typical during the
    //               T+1 window for overseas funds)
    //   • "none"  — every fund failed; source is undefined
    const batchSource: "amfi" | "mfapi" | "mixed" | "none" =
      servedByAmfi > 0 && servedByMfapi > 0
        ? "mixed"
        : servedByAmfi > 0
          ? "amfi"
          : servedByMfapi > 0
            ? "mfapi"
            : "none";

    // 200 always — batch results with per-fund detail. The UI decides
    // how to render "9/10 refreshed, 1 failed" from the counts. HTTP
    // 500 is reserved for "the request itself failed" (DB down, both
    // AMFI and mfapi unreachable at DNS/TCP level, etc.).
    return NextResponse.json({
      ok: true,
      // Batch-level source label — legacy field, was always "mfapi"
      // pre-2026-07-22. Now reflects the two-tier reality. UI
      // currently ignores it but future consumers can key off it.
      source: batchSource,
      // Populated when AMFI's snapshot fetch itself failed and every
      // fund got routed through mfapi. Null when AMFI worked (even
      // if some funds still fell through to mfapi for per-fund
      // reasons like the T+1 overseas window). Mirrors
      // refresh-nps-nav's kotak_fallback_reason field name pattern
      // so the client-side handling can be symmetric.
      amfi_fallback_reason: amfiFallbackReason,
      nav_date: headlineNavDate,
      counts: {
        rotated: rotatedCount,
        already_fresh: alreadyFreshCount,
        skipped_stale: skippedStaleCount,
        failed: failedCount,
        total: outcomes.length,
      },
      // New: per-source rotate + served counts. "refreshed_from_*" is
      // the "AMFI actually beat mfapi tonight" signal; "served_by_*"
      // counts every fund the source contributed to (including
      // already_fresh and skipped_stale) for full attribution.
      refreshed_from_amfi: refreshedFromAmfi,
      refreshed_from_mfapi: refreshedFromMfapi,
      served_by_amfi: servedByAmfi,
      served_by_mfapi: servedByMfapi,
      // Full per-fund enumeration so the client can build a rich
      // diagnostic panel if it wants to (currently the card just uses
      // counts + a "click to see details" disclosure).
      outcomes,
      unmapped_fund_codes: unmapped,
      message:
        rotatedCount > 0
          ? refreshedFromAmfi > 0 && refreshedFromMfapi > 0
            ? `Refreshed ${rotatedCount}/${outcomes.length} funds (${refreshedFromAmfi} from AMFI, ${refreshedFromMfapi} from mfapi)`
            : refreshedFromMfapi > 0
              ? `Refreshed ${rotatedCount}/${outcomes.length} funds from mfapi.in`
              : `Refreshed ${rotatedCount}/${outcomes.length} funds from AMFI`
          : alreadyFreshCount === outcomes.length
            ? `All ${outcomes.length} funds already up to date`
            : failedCount === outcomes.length
              ? `All ${outcomes.length} funds failed to refresh`
              : `${rotatedCount} rotated · ${alreadyFreshCount} fresh · ${skippedStaleCount} stale · ${failedCount} failed`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export const GET = handler;
export const POST = handler;
