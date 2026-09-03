/**
 * lib/mf/amfiClient.ts
 *
 * Client for AMFI's daily NAV bhavcopy — a single ~1.6 MB text file
 * that we download and parse in one shot. AMFI (Association of Mutual
 * Funds in India) is the industry body every AMC reports NAVs to;
 * NAVAll.txt is the authoritative source for every open-ended MF NAV
 * in the country.
 *
 * WHY THIS OVER mfapiClient
 * -------------------------
 * mfapi.in mirrors this exact file, but on a 6/day schedule (roughly
 * 10:05, 14:05, 18:05, 21:05 IST, then 03:09 and 05:05 the next
 * morning). Between the 21:05 refresh and the 03:09 next-day refresh
 * there is a hard ~6-hour dead window where AMFI has already published
 * today's NAVs but mfapi hasn't scheduled its next mirror pull yet.
 *
 * Diagnosed 2026-07-22 23:55 IST: AMFI carried 22-Jul NAVs for 8/10 of
 * the user's holdings while mfapi still returned 21-Jul across the
 * board. A user opening the dashboard around midnight was seeing
 * yesterday's numbers when today's were published upstream. Fetching
 * AMFI directly as the primary source closes that window; mfapi stays
 * as a fallback for the schemes AMFI hasn't posted yet (see OVERSEAS
 * FUNDS below) and for full-history backfills (see
 * scripts/backfill-mf-reconstruction.mjs — AMFI's historical endpoint
 * is 90-day-max per call, so mfapi wins for that use case).
 *
 * TRADE-OFFS
 * ----------
 *   • ONE fetch pulls every scheme in India (~14k data rows). Wasteful
 *     in absolute terms, but at ~1.6 MB / ~200-400ms wall-clock it
 *     comes out cheaper than mfapi's 10 sequential per-scheme JSON
 *     calls in practice, and it's the same amortized cost regardless
 *     of how many funds the user holds.
 *   • Closed / merged schemes stay in the file with old dates
 *     indefinitely (observed: a plan last valued 14-Jun-2017 still
 *     shipping in the 2026-07-22 file). We defensively drop rows more
 *     than MAX_STALE_DAYS old. A scheme we care about that only
 *     appears with a stale date is treated as "AMFI has nothing fresh
 *     for this fund" and routed to mfapi fallback.
 *   • fund_house and category are NOT populated per row — AMFI's file
 *     puts AMC context in interspersed separator rows (e.g., an
 *     "HDFC Mutual Fund" line preceding all HDFC schemes) rather than
 *     on each data row. Reliably associating them would roughly
 *     double the parser complexity for zero benefit to the daily
 *     refresh, which never reads those fields. Left as "" and
 *     documented on the type.
 *
 * FILE FORMAT (as of 2026-07-22)
 * ------------------------------
 * Plain text, semicolon-delimited, 6 columns per data row:
 *
 *   Scheme Code ; ISIN Growth ; ISIN Div-Reinvest ; Scheme Name ; NAV ; Date
 *
 * The first line is the column header ("Scheme Code;ISIN Div Payout/...").
 * Interspersed between data rows:
 *   • Category headers (e.g. "Open Ended Schemes(Debt Scheme - Banking...)")
 *   • AMC name lines (e.g. "HDFC Mutual Fund")
 *   • Blank / whitespace-only separator lines
 *
 * Robust data-row filter: the line matches /^\d+;/ AND split(";")
 * gives exactly 6 non-empty parts after trimming. Everything else is
 * silently skipped. This filter is stable across all the file
 * variations we've observed and doesn't need to know the taxonomy of
 * category / AMC lines.
 *
 * DATE FORMAT
 * -----------
 * "DD-Mon-YYYY" (e.g. "22-Jul-2026") with English 3-letter month
 * abbreviations. Normalized to ISO "YYYY-MM-DD" here so the refresh
 * route can compare against fund_holdings.nav_date directly.
 *
 * ERROR PHILOSOPHY
 * ----------------
 * fetchAmfiSnapshot() throws on ANY failure (network, non-200, absurdly
 * small body, zero data rows parsed). The caller (refresh-mf-nav
 * route) catches at the top level and falls through to mfapi as if
 * AMFI wasn't wired in — no user-visible degradation, just a warning
 * in the server log. Per-fund misses inside a successful snapshot are
 * a different failure mode: they don't throw, they just leave that
 * fund out of the returned Map so the caller can route it to mfapi.
 *
 * OVERSEAS FUNDS
 * --------------
 * SEBI regulation lets funds with ≥20% overseas holdings publish by
 * 10 AM T+1 IST (user's affected funds: ICICI Nasdaq / scheme 149219,
 * PPFAS Flexi Cap / scheme 122639). Until that mid-morning cutoff,
 * AMFI legitimately carries yesterday's date for these — that's not a
 * failure. The refresh route treats them the same as any other
 * "AMFI's date is older than DB" case, which routes to mfapi fallback
 * (which, feeding off the same AMFI file, will also return T-1).
 * Consistent behavior across both sources.
 */

import type { BatchResult } from "@/lib/mf/mfapiClient";

// Re-export so callers can import both types from one place — keeps
// the "AMFI-first, mfapi-fallback" call sites legible without having
// to reach into two modules for the same shape.
export type { BatchResult };

// ── Types ────────────────────────────────────────────────────────────────

/**
 * Same shape as mfapiClient's LatestNav so the refresh route can treat
 * both sources uniformly (a single per-fund pipeline for rotate /
 * already_fresh / skipped_stale logic, regardless of provenance).
 *
 * fundHouse and category are always empty strings — see file header
 * for why we don't populate them from the AMFI file.
 */
export type AmfiLatestNav = {
  schemeCode: string;
  nav: number;
  /** ISO YYYY-MM-DD */
  navDate: string;
  schemeName: string;
  /** null when AMFI reports "-" (schemes without a growth plan variant). */
  isinGrowth: string | null;
  /** Always "" — AMFI's per-row data doesn't include AMC. */
  fundHouse: string;
  /** Always "" — same reason as fundHouse. */
  category: string;
};

// ── Config ───────────────────────────────────────────────────────────────

/**
 * Portal subdomain is measurably faster than www.amfiindia.com/spages/
 * (Cloudfront-fronted vs. origin, empirically ~120ms vs. ~400ms from
 * India). The www URL works as a mirror if this ever 5xxs — swap the
 * host and everything else stays the same.
 */
const AMFI_URL = "https://portal.amfiindia.com/spages/NAVAll.txt";

/**
 * 15s — 1.6 MB over residential Indian downlinks can legitimately take
 * several seconds, and the portal itself is sometimes slow around the
 * moment it's regenerating the file. mfapi's 10s timeout is per-call
 * for ~2 KB JSON responses, so the two thresholds aren't directly
 * comparable.
 */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Reject rows whose parsed date is more than this many days older
 * than today's IST date. AMFI keeps stale rows in the file for
 * delisted / merged schemes indefinitely — the caller shouldn't see
 * them as if they were current data.
 *
 * 7 days is comfortably wider than any weekend + T+1 overseas delay,
 * so real market-open NAVs still pass through even if the user opens
 * the app on a Monday morning after a long weekend.
 */
const MAX_STALE_DAYS = 7;

/**
 * Minimum body size we accept from AMFI before parsing. Real file is
 * ~1.6 MB; anything dramatically smaller is almost certainly an error
 * page (portal maintenance HTML) or a truncated response. Failing
 * loud is better than silently parsing noise into a Map.
 */
const MIN_BODY_BYTES = 100_000;

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Map "Jan".."Dec" (lowercased) to their two-digit month numbers.
 * Object lookup is ~10x faster than a switch/regex per row at this
 * volume; matters slightly given we iterate 17k+ lines per snapshot.
 */
const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/**
 * Normalize AMFI's "DD-Mon-YYYY" to ISO "YYYY-MM-DD".
 *
 * Returns null on any malformed input — caller drops the row. That's
 * safer than defaulting to today's date; an unparseable date usually
 * means the file format has drifted and we shouldn't silently trust
 * whatever NAV appeared next to it.
 */
function parseAmfiDate(raw: string): string | null {
  const m = raw.trim().match(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${month}-${m[1]}`;
}

/**
 * Today's IST calendar date as YYYY-MM-DD.
 *
 * Duplicated from lib/istDate.ts on purpose — keeps amfiClient's
 * project-internal import graph limited to the mfapiClient type
 * re-export. Same DST-safe Intl.DateTimeFormat approach; see
 * lib/istDate.ts's header for the reasoning behind this pattern
 * over manual UTC-offset arithmetic.
 */
function istToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * True if `isoDate` is within MAX_STALE_DAYS of `todayIso`. Both dates
 * are constructed with the same "T00:00:00Z" pattern so the
 * subtraction is an exact multiple of 86_400_000, regardless of the
 * running process's timezone.
 */
function isFresh(isoDate: string, todayIso: string): boolean {
  const t = Date.parse(`${todayIso}T00:00:00Z`);
  const d = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(t) || !Number.isFinite(d)) return false;
  const daysAgo = (t - d) / 86_400_000;
  return daysAgo <= MAX_STALE_DAYS;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Fetch AMFI's NAVAll.txt once and parse it into a Map keyed by
 * scheme code (as a string, matching mfapiClient's convention).
 *
 * Throws on network / HTTP / parse-catastrophe failure. Individual
 * malformed rows are silently skipped — one broken row shouldn't
 * poison the other 14k. Stale rows (older than MAX_STALE_DAYS from
 * today's IST date) are also skipped, so the returned Map contains
 * only rows the caller would actually want to trust as "today's NAV".
 *
 * Memory: ~14k Map entries at ~200 bytes each ≈ 3 MB peak. Negligible
 * on Vercel or in `next dev`.
 */
export async function fetchAmfiSnapshot(): Promise<Map<string, AmfiLatestNav>> {
  const res = await fetch(AMFI_URL, {
    headers: {
      // Same UA convention as mfapiClient / npsnav.in calls — polite
      // identification even though AMFI hasn't been observed to
      // rate-limit or fingerprint clients.
      "User-Agent": "vayu-dashboard/1.0",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`amfi NAVAll.txt: HTTP ${res.status}`);
  }

  const body = await res.text();
  if (body.length < MIN_BODY_BYTES) {
    throw new Error(
      `amfi NAVAll.txt: implausibly small body (${body.length} bytes, expected ~1.6M)`
    );
  }

  const today = istToday();
  const map = new Map<string, AmfiLatestNav>();

  // Line-by-line parse. String.split("\n") on 1.6 MB is fine —
  // ~17k lines, tens of milliseconds. No need for a streaming
  // reader given the file has a hard upper bound (~2 MB) and we
  // process it once per refresh cycle.
  for (const raw of body.split("\n")) {
    // Fast reject: real data rows always start with digits +
    // semicolon (the scheme code). Category headers, AMC name
    // lines, and blank separators all fail this test. Cheaper than
    // splitting every line and inspecting parts.
    if (!/^\d+;/.test(raw)) continue;

    const parts = raw.split(";");
    // AMFI now emits Plan and Option as their own semicolon fields
    // (8 cols: code;isin;isin;name;plan;option;nav;date); older files
    // used 6 (…;name;nav;date). NAV and date are always the LAST two
    // columns, so index from the end — a fixed parts[4]/[5] read silently
    // parsed 0 rows on the new format and forced the (day-lagging) mfapi
    // fallback. Require ≥6 cols so header/category lines still skip.
    if (parts.length < 6) continue;

    const schemeCode = parts[0].trim();
    const isinGrowth = parts[1].trim();
    const dateStr = parts[parts.length - 1].trim();
    const navStr = parts[parts.length - 2].trim();
    const schemeName = parts
      .slice(3, parts.length - 2)
      .map((s) => s.trim())
      .filter(Boolean)
      .join(" ");

    if (!schemeCode || !schemeName || !navStr || !dateStr) continue;

    const nav = Number(navStr);
    if (!Number.isFinite(nav) || nav <= 0) continue;

    const navDate = parseAmfiDate(dateStr);
    if (!navDate) continue;

    if (!isFresh(navDate, today)) continue;

    map.set(schemeCode, {
      schemeCode,
      nav,
      navDate,
      schemeName,
      // ISIN column is literally "-" for schemes without a growth
      // plan variant — normalize to null so consumers don't need to
      // special-case a dash string.
      isinGrowth: isinGrowth && isinGrowth !== "-" ? isinGrowth : null,
      fundHouse: "",
      category: "",
    });
  }

  if (map.size === 0) {
    // We downloaded 1.6 MB and matched zero data rows. Either the
    // file format has shifted upstream or MAX_STALE_DAYS filtered
    // everything (e.g. a very long weekend combined with a wrong
    // system clock). Fail loud so we notice instead of silently
    // returning an empty Map that looks like "AMFI has no data for
    // any of your funds".
    throw new Error("amfi NAVAll.txt: parsed 0 data rows (format drift?)");
  }

  return map;
}

/**
 * Convenience wrapper matching mfapiClient's fetchBatch shape.
 *
 * Fetches the full snapshot ONCE (do NOT call this in a per-fund loop
 * — that would download 1.6 MB × N funds) and filters to the
 * requested codes. Missing / stale codes come back as { ok: false }
 * so callers can trigger a per-fund fallback path without having to
 * distinguish between "network died" and "AMFI just doesn't have
 * this one fresh".
 *
 * The refresh-mf-nav route currently calls fetchAmfiSnapshot directly
 * — it wants finer-grained control (one snapshot, per-fund lookup,
 * then a single batched mfapi call for the misses). This wrapper is
 * here for potential future callers (one-off scripts, alternative
 * refresh entry points) that just want "gimme the latest NAVs for
 * these codes, uniformly shaped alongside mfapi results".
 */
export async function fetchBatchAmfi(
  schemeCodes: string[]
): Promise<BatchResult[]> {
  const snapshot = await fetchAmfiSnapshot();
  return schemeCodes.map((code) => {
    const hit = snapshot.get(code);
    if (hit) {
      // AmfiLatestNav is structurally identical to mfapiClient's
      // LatestNav, so this assignment is type-safe without a cast.
      return { ok: true, schemeCode: code, nav: hit };
    }
    return {
      ok: false,
      schemeCode: code,
      error: "amfi: no fresh row for scheme code",
    };
  });
}
