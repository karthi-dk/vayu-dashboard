import { NextResponse } from "next/server";
import type { PostgrestError } from "@supabase/supabase-js";
import { sbServer } from "@/lib/supabase";
import {
  classifyIsinDetailed,
  fetchCapClassificationSource,
  sourceTagFor,
  type CapBucket,
  type CapSubBucket,
} from "@/lib/nseCapClassification";

// Local copy of the pagination helper — see lib/queries.ts for the
// canonical version and full explanation. Duplicated here to keep the
// API route self-contained (no circular queries.ts → route.ts pull).
async function fetchAllPages<T>(
  buildQuery: (
    from: number,
    to: number
  ) => PromiseLike<{ data: T[] | null; error: PostgrestError | null }>
): Promise<T[]> {
  const PAGE = 1000;
  const all: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await buildQuery(offset, offset + PAGE - 1);
    if (error) throw error;
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}

/**
 * NSE cap-classification refresh
 * ==============================
 *
 * Manual trigger from the Sync page. Rebuilds every India-equity
 * mcap_classification value from the current NSE index constituents:
 *
 *   Nifty 100         → Large
 *   Nifty Midcap 150  → Mid
 *   Nifty Smallcap 250→ Small
 *   Nifty Microcap 250→ Micro
 *   Rest of EQUITY_L  → Nano
 *   Not on NSE at all → row left untouched (BSE-only, delisted, foreign)
 *
 * The button is manual (not cron) because rebalances are semi-annual —
 * you only want to refresh after a scheduled or ad-hoc index review,
 * not silently every day. It also means the user can see the diff in
 * one shot instead of finding out later why Reliance suddenly showed
 * up under Mid.
 *
 * Scope
 * -----
 * We only touch rows where:
 *   region        = 'India'
 *   security_type = 'Equity'
 *   holding_level = 'Individual'
 *
 * That deliberately excludes:
 *   • US stocks    — they have no NSE cap classification
 *   • REITs / InvITs — 'Managed' holding_level
 *   • Debt / Gold  — non-Equity security_type
 *
 * Update strategy
 * ---------------
 * Group target ISINs by destination bucket → 5 batch PATCHes (one per
 * bucket). Faster than 700 individual calls, and works fine with the
 * URL-length limit since IN-clauses are only a few KB even for the
 * biggest bucket.
 *
 * Response
 * --------
 * Full diff summary:
 *   {
 *     ok: true,
 *     fetchedAt, sourceCounts: {…},   ← what NSE actually returned
 *     counts: { Large, Mid, Small, Micro, Nano },  ← new distribution
 *     moves: [{isin, symbol, from, to}]           ← changed rows only
 *     movesCount,
 *     outsideCount,                                ← rows not on NSE
 *   }
 */
export async function POST() {
  const startedAt = Date.now();
  const sb = sbServer;

  // ── Step 1: Fetch all 5 NSE CSVs. Throws on any failure.
  let src;
  try {
    src = await fetchCapClassificationSource();
  } catch (err) {
    return NextResponse.json(
      { ok: false, stage: "fetch", error: (err as Error).message },
      { status: 502 }
    );
  }

  // ── Step 2: Load current master state (India equities only).
  //
  // Must paginate — this project's PostgREST is capped at 1000 rows
  // per response (db-max-rows). Post-EQUITY_L backfill there are
  // ~2,400 India-equity rows, so a single query would silently
  // classify only the first 1,000 by ISIN alphabetically and leave
  // ~1,400 untouched.
  //
  // We also fetch `confidence` because rows tagged with a manual-*
  // confidence value are treated as sticky overrides: they're
  // counted under their current bucket but never PATCHed by this
  // refresh. See "manual override contract" below.
  type MasterRow = {
    isin: string;
    mcap_classification: string | null;
    symbol: string | null;
    company_name: string | null;
    source: string | null;
    confidence: string | null;
  };
  let rows: MasterRow[];
  try {
    rows = await fetchAllPages<MasterRow>((from, to) =>
      sb
        .from("master_security_classification")
        .select("isin, mcap_classification, symbol, company_name, source, confidence")
        .eq("region", "India")
        .eq("security_type", "Equity")
        .eq("holding_level", "Individual")
        .range(from, to)
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, stage: "load", error: (err as Error).message },
      { status: 500 }
    );
  }

  /**
   * Manual override contract
   * -----------------------
   * A row is a manual override if its `confidence` column contains
   * the substring "manual" (case-insensitive). Existing conventions
   * on this project use two values:
   *   • "manual-verified"                — fully manual entry
   *   • "isin-verified-manual-override"  — ISIN was verified, but
   *                                        classification is manual
   *
   * Manual rows escape the refresh entirely:
   *   • they are NOT reclassified from NSE CSVs
   *   • their `source` string is NOT canonicalised
   *   • they DO contribute to bucket counts so post-refresh totals
   *     are complete
   *   • the response reports how many were preserved so the UI can
   *     surface the count
   *
   * Rationale: covers the "demerger / spin-off / new IPO not yet in
   * NSE index CSVs" case without a schema migration. Any row you
   * want to pin can be flipped by setting confidence — see
   * scripts/set-cap-override.mjs for the CLI helper.
   */
  const isManualOverride = (row: MasterRow): boolean =>
    !!row.confidence && row.confidence.toLowerCase().includes("manual");

  // ── Step 3: Compute diff.
  //
  // moves[]    — rows whose bucket OR sub-bucket changed (drives the
  //              UI summary). We compare against the DB's current
  //              `source` string for sub-bucket, since sub is stored
  //              there (see sourceTagFor for the exact strings).
  // outside[]  — ISINs in master but not on NSE (delisted / BSE-only /
  //              foreign listed here for legacy reasons); we leave
  //              these untouched but log them so the user can spot
  //              stale rows to clean up manually.
  // updatesByTag — ISIN grouped by (bucket, source-tag) so each
  //              PATCH batch writes exactly one mcap_classification +
  //              one source value. 6 target tags (nse-nifty50,
  //              nse-niftynext50, nse-midcap150, nse-smallcap250,
  //              nse-microcap250, nse-equity-l) → up to 6 PATCHes.
  type PatchKey = string; // `${bucket}|${sourceTag}`
  const moves: {
    isin: string;
    symbol: string | null;
    from: string | null;
    to: CapBucket;
    fromSub: CapSubBucket;
    toSub: CapSubBucket;
  }[] = [];
  const outside: { isin: string; symbol: string | null }[] = [];
  const updatesByTag = new Map<
    PatchKey,
    { bucket: CapBucket; source: string; isins: string[] }
  >();
  const newCounts: Record<CapBucket, number> = {
    Large: 0,
    Mid: 0,
    Small: 0,
    Micro: 0,
    Nano: 0,
  };
  // Sub-tally for Large — surfaces the N50 / NN50 / Override split in
  // the response so the card can render all three Large tiles without
  // a follow-up query. `Override` catches Large-tagged rows whose
  // `source` doesn't match either NSE index CSV — almost always
  // manual overrides via scripts/set-cap-override.mjs.
  //
  // Invariant: N50 + NN50 + Override == counts.Large.
  const newSubCounts = { N50: 0, NN50: 0, Override: 0 };
  // Manual override tally — rows we skipped because their confidence
  // marks them as sticky. Surfaced in the response so the UI can
  // render "N manual overrides preserved" in the refresh summary.
  let manualOverridesPreserved = 0;
  // Auto-cleared overrides: manual pins whose ISIN is NOW present in
  // an NSE index CSV AND whose classifier tier + sub-bucket match the
  // row's declared classification. In that state the pin no longer
  // changes classification (both agree today) but silently blocks
  // any future NSE reclassification (e.g. if NSE later demotes VAML
  // from NN50 to Mid, we'd freeze at NN50 forever). We drop the
  // manual flag in-place — `mcap_classification` and `source` stay
  // exactly as they are (they already match the classifier), only
  // `confidence` moves from "isin-verified-manual-override" back to
  // "isin-verified", which is what makes the row eligible for future
  // refresh sweeps.
  //
  // Auto-clear is safe here because the trigger condition is strictly
  // "NSE agrees with the pin RIGHT NOW". A one-off transient CSV
  // glitch that briefly stops matching wouldn't clear anything;
  // the pin only lifts when NSE has authoritatively caught up.
  const autoClearedOverrides: {
    isin: string;
    symbol: string | null;
    bucket: CapBucket;
    subBucket: CapSubBucket;
  }[] = [];

  for (const row of rows) {
    // Sticky manual overrides: count under current bucket, skip the
    // classify → diff → patch pipeline. This is the entire mechanism
    // that lets a demerged/newly-listed ISIN survive a refresh.
    if (isManualOverride(row)) {
      const prev = normaliseCap(row.mcap_classification);

      // Redundancy check first — decides whether this row survives
      // as a manual override (counts under manualOverridesPreserved)
      // or gets auto-cleared this sweep (counts under
      // autoClearedOverrides). Bucket + sub-bucket accounting is
      // identical either way — the classifier and pin agree — so
      // the difference is purely which follow-up write we queue.
      const cls = classifyIsinDetailed(row.isin, src);
      let isRedundant = false;
      if (cls !== null && prev !== null && cls.bucket === prev) {
        const declaredSub =
          prev === "Large"
            ? row.source === "nse-nifty50"
              ? "N50"
              : row.source === "nse-niftynext50"
                ? "NN50"
                : null
            : null;
        // Non-Large rows have no sub-bucket, so tier match alone is
        // enough. Large rows must ALSO agree on N50 vs NN50 —
        // otherwise the pin is still contributing information (e.g.
        // classifier says NN50 but user pinned N50 for a stock they
        // believe is mega-cap in reality).
        if (prev !== "Large" || cls.subBucket === declaredSub) {
          isRedundant = true;
          autoClearedOverrides.push({
            isin: row.isin,
            symbol: row.symbol,
            bucket: cls.bucket,
            subBucket: cls.subBucket,
          });
        }
      }
      if (!isRedundant) {
        manualOverridesPreserved++;
      }

      if (prev === "Large") {
        newCounts.Large++;
        if (row.source === "nse-nifty50") newSubCounts.N50++;
        else if (row.source === "nse-niftynext50") newSubCounts.NN50++;
        // Manual override in Large with a non-canonical source
        // (`manual`, empty, `nse-nifty100` legacy, etc.) — lands in
        // the LargeOverride tile so N50/NN50 stay exactly equal to
        // their NSE-index-CSV counts plus any user-asserted tier.
        else newSubCounts.Override++;
      } else if (prev === "Mid") newCounts.Mid++;
      else if (prev === "Small") newCounts.Small++;
      else if (prev === "Micro") newCounts.Micro++;
      else if (prev === "Nano") newCounts.Nano++;
      // Manual overrides with empty mcap (e.g. REITs pinned for
      // reference) don't land in any equity bucket — that's fine.
      continue;
    }

    const cls = classifyIsinDetailed(row.isin, src);
    if (cls === null) {
      outside.push({ isin: row.isin, symbol: row.symbol });
      // Outside rows keep their prior mcap_classification (BSE-only /
      // delisted / foreign — nothing in NSE to reclassify against).
      // We STILL count them under their current bucket so post-refresh
      // tile totals reflect the full India distribution. Sub-bucket
      // is derived from the CURRENT source string, so a legacy row
      // tagged "nse-nifty50" keeps counting under N50 even if we
      // didn't touch it this run.
      const prev = normaliseCap(row.mcap_classification);
      if (prev === "Large") {
        newCounts.Large++;
        if (row.source === "nse-nifty50") newSubCounts.N50++;
        else if (row.source === "nse-niftynext50") newSubCounts.NN50++;
        // Legacy "nse-nifty100" or empty source → LargeOverride so
        // the row stays visible and clickable in the UI without
        // polluting either NSE-index-defined sub-tile.
        else newSubCounts.Override++;
      } else if (prev === "Mid") newCounts.Mid++;
      else if (prev === "Small") newCounts.Small++;
      else if (prev === "Micro") newCounts.Micro++;
      else if (prev === "Nano") newCounts.Nano++;
      continue;
    }
    newCounts[cls.bucket]++;
    if (cls.subBucket === "N50") newSubCounts.N50++;
    else if (cls.subBucket === "NN50") newSubCounts.NN50++;

    const prev = normaliseCap(row.mcap_classification);
    const prevSub = subFromSource(row.source);
    const targetTag = sourceTagFor(cls);

    // Two independent conditions:
    //
    //   tierChanged  — the top-level bucket OR sub-bucket actually
    //                  moved. This is what the user cares about: a
    //                  stock reclassified from Small → Nano, or
    //                  Large/NN50 → Large/N50. These are the "moves"
    //                  the UI surfaces.
    //
    //   sourceStale  — the source string doesn't match the canonical
    //                  tag for its current classification. Examples:
    //                    Large row with source="NIFTY 50" (legacy
    //                    uppercase) → needs update to "nse-nifty50".
    //                    Large row with source="nse-nifty100" (old
    //                    canonical) → same.
    //                  Cosmetic to the user but critical for the
    //                  cross-tool source-string invariant, so we
    //                  still write the PATCH.
    //
    // Any row satisfying EITHER needs a PATCH. Only tierChanged
    // rows are surfaced in moves[] — otherwise a one-time source
    // normalisation would light up as "2000 stocks moved" which is
    // both wrong and terrifying to see.
    const tierChanged = prev !== cls.bucket || prevSub !== cls.subBucket;
    const sourceStale = row.source !== targetTag;

    if (tierChanged) {
      moves.push({
        isin: row.isin,
        symbol: row.symbol,
        from: prev,
        to: cls.bucket,
        fromSub: prevSub,
        toSub: cls.subBucket,
      });
    }

    if (tierChanged || sourceStale) {
      const key: PatchKey = `${cls.bucket}|${targetTag}`;
      const bucket_entry = updatesByTag.get(key);
      if (bucket_entry) bucket_entry.isins.push(row.isin);
      else
        updatesByTag.set(key, {
          bucket: cls.bucket,
          source: targetTag,
          isins: [row.isin],
        });
    }
  }

  // ── Step 4: Apply — one PATCH per (bucket, source) pair.
  //
  // `last_updated` gets bumped to today too so downstream consumers
  // (Portfolio page, Overview cap tiles) can tell these values came
  // from a fresh authoritative sync.
  const today = new Date().toISOString().slice(0, 10);
  for (const [, group] of updatesByTag) {
    if (group.isins.length === 0) continue;
    const { error: upErr } = await sb
      .from("master_security_classification")
      .update({
        mcap_classification: group.bucket,
        source: group.source,
        last_updated: today,
      })
      .in("isin", group.isins);
    if (upErr) {
      return NextResponse.json(
        {
          ok: false,
          stage: "update",
          bucket: group.bucket,
          source: group.source,
          error: upErr.message,
        },
        { status: 500 }
      );
    }
  }

  // ── Step 4b: Auto-clear redundant manual overrides.
  //
  // ISINs where NSE has caught up with the pin. Drop the manual flag
  // in one batch PATCH so future rebalances flow through the row.
  // `mcap_classification` and `source` intentionally stay untouched —
  // they already match what the classifier would set them to (that's
  // the definition of "redundant"), so rewriting them would just
  // burn a DB round-trip. `last_updated` gets bumped so downstream
  // consumers can tell the row was re-attested this sweep.
  if (autoClearedOverrides.length > 0) {
    const isinsToClear = autoClearedOverrides.map((o) => o.isin);
    const { error: clearErr } = await sb
      .from("master_security_classification")
      .update({ confidence: "isin-verified", last_updated: today })
      .in("isin", isinsToClear);
    if (clearErr) {
      return NextResponse.json(
        {
          ok: false,
          stage: "auto-clear",
          error: clearErr.message,
        },
        { status: 500 }
      );
    }
  }

  // ── Step 5: Persist last-synced timestamp for the Sync page display.
  //
  // portfolio_config is a KV table already used for a handful of
  // dashboard-wide flags. Cheaper than a dedicated sync-log table.
  await sb.from("portfolio_config").upsert(
    {
      key: "cap_classification_last_synced_at",
      value: src.fetchedAt,
      description:
        "Last NSE cap-classification refresh (Large/Mid/Small/Micro/Nano)",
    },
    { onConflict: "key" }
  );

  // Total rows PATCHed = union of tier-changed + source-normalized.
  // Subtract moves.length to get "just normalization" so the UI can
  // separate real reclassifications from string-canonicalisation work.
  const patchedRowCount = [...updatesByTag.values()].reduce(
    (n, g) => n + g.isins.length,
    0
  );
  const sourceNormalizedCount = patchedRowCount - moves.length;

  return NextResponse.json({
    ok: true,
    fetchedAt: src.fetchedAt,
    elapsedMs: Date.now() - startedAt,
    sourceCounts: src.sourceCounts,
    counts: newCounts,
    // Sub-tally lives alongside `counts` so the card can render the
    // three Large tiles (N50, NN50, Override) without a follow-up
    // query. N50 + NN50 + Override == counts.Large (barring the tiny
    // window before a legacy row's first sync).
    subCounts: newSubCounts,
    // Cap the response payload so a first-time sync that reshuffles
    // hundreds of rows doesn't dump a 50 KB JSON blob. Full move list
    // isn't useful in the UI anyway — a summary + top ~50 is plenty.
    moves: moves.slice(0, 50),
    movesCount: moves.length,
    /**
     * Rows whose tier didn't change but whose `source` column was
     * migrated to the current canonical value (`nse-nifty50` etc.).
     * Almost always zero after the first Refresh post-schema change.
     * Rendered as a quiet footer in the UI so it doesn't compete
     * with the movesCount headline.
     */
    sourceNormalizedCount,
    /**
     * Rows skipped because their `confidence` column marked them as a
     * manual override. Counted under their current bucket but never
     * touched by the reclassification. Rendered as a quiet footer so
     * a user who's set up 5 demerger overrides can confirm they
     * survived the refresh.
     */
    manualOverridesPreserved,
    /**
     * Manual overrides that were auto-cleared during this sweep
     * because NSE has caught up (classifier's tier + sub-bucket
     * matched the pin's declared classification). The rows kept
     * their mcap/source, but `confidence` was reset from
     * "isin-verified-manual-override" to "isin-verified" so future
     * NSE reclassifications flow through normally.
     *
     * Empty in the common case (e.g. VAML remains outside the NN50
     * CSV) — the array populates once NSE formally admits the ISIN.
     */
    autoClearedOverrides: autoClearedOverrides.slice(0, 20),
    autoClearedOverridesCount: autoClearedOverrides.length,
    outside: outside.slice(0, 20),
    outsideCount: outside.length,
  });
}

/**
 * Normalise the DB's mcap_classification value for diff purposes.
 * Empty string ("") shows up in the DB when a row was created without
 * classification but hasn't been touched by any classifier yet — we
 * treat that as "no previous value" so the diff surfaces it as a
 * genuine change, not "empty → empty".
 */
function normaliseCap(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

/**
 * Reverse-map a `source` string to its sub-bucket (N50 or NN50, or
 * null for non-Large sources). Used by the diff loop to detect
 * intra-Large moves — e.g., a stock promoted from NN50 to N50 in
 * an ad-hoc rebalance still deserves a `moves[]` entry even though
 * the top-level bucket didn't change.
 *
 * We recognise both the canonical current tags and a couple of
 * legacy variants that showed up in DB from older classifier states
 * (uppercase, non-nse-prefixed). Anything else → null, meaning the
 * next refresh will pick a canonical value and update it.
 */
function subFromSource(v: string | null | undefined): CapSubBucket {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  if (s === "nse-nifty50" || s === "nifty 50") return "N50";
  if (s === "nse-niftynext50" || s === "nifty next 50") return "NN50";
  return null;
}
