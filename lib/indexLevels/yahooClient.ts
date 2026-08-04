// Yahoo Finance chart API client for index levels
// ==================================================
//
// Unofficial, no-auth, no-key endpoint (query1.finance.yahoo.com/v8/
// finance/chart/{ticker}) that Yahoo's own web/mobile clients use. No
// official SLA, but it's the same endpoint countless trading tools
// scrape, and it has been stable in practice. If it ever breaks, the
// fallback is scraping niftyindices.com's historical-data CSVs (already
// used for constituent lists in lib/nseCapClassification.ts) for the
// Nifty-family indices, plus stooq.com for Nasdaq100/S&P500.
//
// TICKER MAP — verified by hand on 2026-07-23, do not "fix" without
// re-verifying against a live price you can cross-check elsewhere
// ------------------------------------------------------------------
// Yahoo's symbol naming for the NSE sectoral/breadth indices is
// inconsistent and has real traps:
//
//   • Nifty Next 50 is NOT "NIFTY_NEXT_50.NS" — that symbol exists on
//     Yahoo but is DEAD: its 52-week low/high/current all equal the same
//     frozen value (31,893.2) and its last trade timestamp is Dec 2020.
//     It resolves and returns 200 OK with a well-formed payload, so a
//     naive integration would silently ingest 5-year-stale data forever.
//     The correct, live ticker is the oddly-named "^NSMIDCP" — confirmed
//     genuine (not a Nifty-50 alias) by its price level (~₹71,840, in
//     Next-50's real range) diverging sharply from Nifty 50's (~₹23,870)
//     despite sharing some unrelated metadata fields.
//
//   • Nifty Midcap 150 and Nifty Smallcap 250 use the ".NS" suffix
//     convention instead: "NIFTYMIDCAP150.NS" / "NIFTYSMLCAP250.NS".
//     The underscored variant ("NIFTY_SMALLCAP_250.NS") 404s.
//
//   • Nasdaq 100 and S&P 500 use standard, well-known Yahoo index
//     tickers: ^NDX and ^GSPC respectively.
export const INDEX_DEFS = [
  { code: "N50", displayName: "Nifty 50", ticker: "^NSEI", currency: "INR" },
  {
    code: "NN50",
    displayName: "Nifty Next 50",
    ticker: "^NSMIDCP",
    currency: "INR",
  },
  {
    code: "MID150",
    displayName: "Nifty Midcap 150",
    ticker: "NIFTYMIDCAP150.NS",
    currency: "INR",
  },
  {
    code: "SMALL250",
    displayName: "Nifty Smallcap 250",
    ticker: "NIFTYSMLCAP250.NS",
    currency: "INR",
  },
  { code: "NASDAQ100", displayName: "Nasdaq 100", ticker: "^NDX", currency: "USD" },
  { code: "SP500", displayName: "S&P 500", ticker: "^GSPC", currency: "USD" },
] as const;

export type IndexCode = (typeof INDEX_DEFS)[number]["code"];
export type IndexCurrency = (typeof INDEX_DEFS)[number]["currency"];

export type IndexLevelResult = {
  code: IndexCode;
  displayName: string;
  currency: IndexCurrency;
  currentLevel: number;
  currentDate: string; // YYYY-MM-DD
  // Previous trading day's close — powers the "Today" % column on the
  // Overview page. Null only if the daily series is shorter than 2
  // points (impossible in practice for a decades-old index, but
  // defensive against a data-gap on a listing debut / first bar).
  previousLevel: number | null;
  previousDate: string | null;
  athLevel: number;
  athDate: string;
  high52wLevel: number;
  high52wDate: string;
  high3mLevel: number;
  high3mDate: string;
};

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const DAY_SECONDS = 86_400;

/**
 * Recover a single trading day's close from Yahoo's INTRADAY feed.
 * =================================================================
 *
 * Yahoo's *daily* bars occasionally carry a fully-null OHLC row for a
 * genuine trading day (timestamp present, open/high/low/close/adjclose
 * all null) — observed live for the NSE indices on 2026-08-03, where
 * that Monday session was blank in the 1d series for every Nifty ticker
 * while US indices were unaffected. When the null day is the session
 * IMMEDIATELY before "today", the daily-series "previous close" silently
 * skips back to the prior good bar (e.g. Friday), so "today's move"
 * quietly becomes a multi-session move — and can even flip sign.
 *
 * The intraday feed (`range=5d&interval=1h`) still carries that day, so
 * we reconstruct the missing session's close as its last usable intraday
 * bar. Returns null on any failure (network / shape / day-not-present)
 * so the caller can fall back to the daily-series previous close.
 */
async function recoverCloseFromIntraday(
  ticker: string,
  targetDay: number
): Promise<{ ts: number; close: number } | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    ticker
  )}?range=5d&interval=1h`;
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      cache: "no-store",
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as {
      chart?: {
        result?: Array<{
          timestamp?: number[];
          indicators?: { quote?: Array<{ close?: (number | null)[] }> };
        }>;
      };
    };
    const res = json.chart?.result?.[0];
    const timestamps = res?.timestamp ?? [];
    const closes = res?.indicators?.quote?.[0]?.close ?? [];
    let best: { ts: number; close: number } | null = null;
    for (let i = 0; i < timestamps.length; i++) {
      const c = closes[i];
      if (c == null || !Number.isFinite(c) || c <= 0) continue;
      if (
        Math.floor(timestamps[i] / DAY_SECONDS) === targetDay &&
        (best === null || timestamps[i] > best.ts)
      ) {
        best = { ts: timestamps[i], close: c };
      }
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * Fetch one index's full daily-close history and derive current / ATH /
 * 52w-high / 3m-high from it — all four numbers computed off the SAME
 * series so they're internally consistent.
 *
 * IMPORTANT: we pass explicit period1=0&period2=now rather than
 * range=max. Yahoo silently DOWNSAMPLES range=max to ~monthly
 * resolution (verified: ^NSEI range=max returned 227 points across 18
 * years — obviously not daily) regardless of the requested interval.
 * Explicit period1/period2 bypasses that downsampling and returns true
 * daily bars (verified: same ticker returned 4,623 daily points for the
 * same span). The response payload is bigger (a few hundred KB to ~1MB
 * for the longest series, Nasdaq100 back to 1985) but this endpoint only
 * runs on a manual /sync click, not on page load, so the extra weight is
 * a non-issue.
 */
export async function fetchIndexLevel(def: {
  code: IndexCode;
  displayName: string;
  ticker: string;
  currency: IndexCurrency;
}): Promise<IndexLevelResult> {
  const now = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    def.ticker
  )}?period1=0&period2=${now}&interval=1d`;

  const resp = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    // This is a manual-refresh server route, not a page render — no
    // Next.js fetch cache desired, we always want the live number.
    cache: "no-store",
  });
  if (!resp.ok) {
    throw new Error(
      `Yahoo chart fetch failed for ${def.ticker} (${def.code}): HTTP ${resp.status}`
    );
  }

  const json = (await resp.json()) as {
    chart?: {
      result?: Array<{
        timestamp?: number[];
        indicators?: { quote?: Array<{ close?: (number | null)[] }> };
        meta?: { regularMarketPrice?: number; regularMarketTime?: number };
      }>;
      error?: { code?: string; description?: string };
    };
  };

  const result = json.chart?.result?.[0];
  if (!result) {
    const errMsg = json.chart?.error?.description ?? "no result in response";
    throw new Error(`Yahoo chart error for ${def.ticker} (${def.code}): ${errMsg}`);
  }

  const timestamps = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];

  const points: { ts: number; close: number }[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const c = closes[i];
    if (c != null && Number.isFinite(c) && c > 0) {
      points.push({ ts: timestamps[i], close: c });
    }
  }
  if (points.length === 0) {
    throw new Error(`No usable daily bars returned for ${def.ticker} (${def.code})`);
  }

  // ── Today's-close backfill from meta ────────────────────────────
  // Confirmed live on 2026-07-23: Yahoo's daily-bars array frequently
  // carries a NULL close for the most recent trading day for a long
  // stretch after that session ends (still null 10+ hrs after NSE's
  // 3:30 PM close for ^NSEI/NIFTYMIDCAP150.NS/NIFTYSMLCAP250.NS; for
  // ^NSMIDCP it was null across FOUR consecutive sessions, Jul 20–23,
  // making the pre-fix "current" 6 calendar days stale). Meanwhile
  // `meta.regularMarketPrice` / `meta.regularMarketTime` are already
  // correct and current the whole time — confirmed against 5
  // independent news sources reporting Nifty 50's real Jul-23 close
  // of 23,869.60, which matched meta exactly while the daily-bars
  // array still had `null` for that day.
  //
  // Rule: only push a meta point when it's a genuinely different UTC
  // DAY than the latest daily-bar point. Not a timestamp comparison —
  // during a live NSE session (~09:15 IST bar timestamp, ~13:00 IST
  // meta timestamp) both are the SAME UTC day but different seconds.
  // A pre-fix "meta.ts > bar.ts" check would push a duplicate today-
  // point with a live intraday price, and then points[-2] (which the
  // "previous close" calculation reads) would pick TODAY's own daily
  // bar instead of yesterday's — collapsing today's % change to 0.0%.
  // Verified on 2026-07-24 mid-session: all six indices showed 0.0%
  // "Today" until this day-granularity fix.
  //
  // Under the day-granularity rule:
  //   • Yahoo emits today's bar as NULL (post-close stall) → meta day
  //     is strictly newer than latest usable bar day → meta gets
  //     pushed as a fresh today-point. previous = yesterday's bar.
  //   • Yahoo emits today's bar with a live intraday close → meta day
  //     equals bar day → meta skipped. current = today's bar
  //     (intraday-updated), previous = yesterday's bar. Not stale,
  //     not zero.
  //   • Same-day meta for a session-not-yet-published day (early
  //     morning before Yahoo posts the day's opening bar) →
  //     nothing to compare against, meta wins.
  const metaPrice = result.meta?.regularMarketPrice;
  const metaTime = result.meta?.regularMarketTime;
  const latestBar = points[points.length - 1];
  const SECONDS_PER_UTC_DAY = 86_400;
  if (
    metaPrice != null &&
    Number.isFinite(metaPrice) &&
    metaPrice > 0 &&
    metaTime != null &&
    Math.floor(metaTime / SECONDS_PER_UTC_DAY) >
      Math.floor(latestBar.ts / SECONDS_PER_UTC_DAY)
  ) {
    points.push({ ts: metaTime, close: metaPrice });
  }
  // Yahoo returns points in ascending timestamp order already, but sort
  // defensively — the downstream "last point = current" and window-
  // filter logic both assume ascending order.
  points.sort((a, b) => a.ts - b.ts);

  const toDateStr = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

  const current = points[points.length - 1];
  // Previous trading day's close — used for today's % change display.
  // Works regardless of whether the meta backfill above pushed a new
  // point: if it did, [len-2] is the most recent completed daily bar
  // (which IS the previous close); if it didn't, [len-2] is the trading
  // day before Yahoo's own latest bar. Either way, [len-2] is the last
  // USABLE daily bar before `current`.
  const seriesPrev = points.length >= 2 ? points[points.length - 2] : null;

  // Null-gap guard (see recoverCloseFromIntraday): Yahoo emits a
  // timestamp for EVERY trading day, including ones whose daily OHLC is
  // fully null. So the raw `timestamps` array — not the null-filtered
  // `points` — is the source of truth for "which day was the previous
  // session". If the most recent trading day strictly before `current`
  // is NEWER than the last usable daily bar, Yahoo dropped that
  // session's close and `seriesPrev` is a session (or more) too far
  // back — which both misstates today's move AND lets a dropped
  // record-high session go missing from the ATH/52w/3m windows. Recover
  // the dropped close from the intraday feed; fall back to `seriesPrev`
  // if recovery fails.
  const currentDay = Math.floor(current.ts / DAY_SECONDS);
  let prevTradingDay: number | null = null;
  for (const ts of timestamps) {
    const day = Math.floor(ts / DAY_SECONDS);
    if (day < currentDay && (prevTradingDay === null || day > prevTradingDay)) {
      prevTradingDay = day;
    }
  }
  const seriesPrevDay = seriesPrev ? Math.floor(seriesPrev.ts / DAY_SECONDS) : null;

  let previous: { ts: number; close: number } | null = seriesPrev;
  if (
    prevTradingDay !== null &&
    (seriesPrevDay === null || prevTradingDay > seriesPrevDay)
  ) {
    const recovered = await recoverCloseFromIntraday(def.ticker, prevTradingDay);
    if (recovered != null) {
      previous = recovered;
      // Feed the recovered close back into the series so the ATH / 52w /
      // 3m "% below high" columns don't skip it either: the dropped
      // session can itself BE the window high (NSE's 2026-08-03 close
      // was the real all-time high for Midcap 150), which would
      // otherwise show today wrongly sitting AT the peak (0.0%).
      points.push(recovered);
    }
  }

  let ath = points[0];
  for (const p of points) if (p.close > ath.close) ath = p;

  const cutoff52w = current.ts - 365 * DAY_SECONDS;
  let high52w = current;
  for (const p of points) {
    if (p.ts >= cutoff52w && p.close > high52w.close) high52w = p;
  }

  const cutoff3m = current.ts - 90 * DAY_SECONDS;
  let high3m = current;
  for (const p of points) {
    if (p.ts >= cutoff3m && p.close > high3m.close) high3m = p;
  }

  return {
    code: def.code,
    displayName: def.displayName,
    currency: def.currency,
    currentLevel: Number(current.close.toFixed(2)),
    currentDate: toDateStr(current.ts),
    previousLevel: previous ? Number(previous.close.toFixed(2)) : null,
    previousDate: previous ? toDateStr(previous.ts) : null,
    athLevel: Number(ath.close.toFixed(2)),
    athDate: toDateStr(ath.ts),
    high52wLevel: Number(high52w.close.toFixed(2)),
    high52wDate: toDateStr(high52w.ts),
    high3mLevel: Number(high3m.close.toFixed(2)),
    high3mDate: toDateStr(high3m.ts),
  };
}

export type IndexLevelOutcome =
  | { code: IndexCode; ok: true; data: IndexLevelResult }
  | { code: IndexCode; ok: false; error: string };

/**
 * Fetch all six tracked indices in parallel. Each index is isolated via
 * Promise.allSettled — one bad ticker (Yahoo hiccup, rate limit) doesn't
 * fail the whole batch. Sequential per-fund isolation mirrors the
 * per-fund outcome model in app/api/refresh-mf-nav/route.ts.
 */
export async function fetchAllIndexLevels(): Promise<IndexLevelOutcome[]> {
  const settled = await Promise.allSettled(
    INDEX_DEFS.map((def) => fetchIndexLevel(def))
  );
  return settled.map((s, i) => {
    const code = INDEX_DEFS[i].code;
    if (s.status === "fulfilled") {
      return { code, ok: true, data: s.value };
    }
    const err = s.reason;
    return {
      code,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  });
}
