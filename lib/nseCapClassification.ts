/**
 * NSE cap-classification source
 * ==============================
 *
 * Fetches the Nifty cap-segment index CSVs plus the full NSE equity
 * master, and turns each into an ISIN Set so we can classify any
 * Indian equity ISIN into Large / Mid / Small / Micro / Nano.
 *
 * Large is *further* split into a sub-bucket:
 *   • Nifty 50      → sub-bucket `N50`   ("mega-caps", ranks 1–50)
 *   • Nifty Next 50 → sub-bucket `NN50`  (ranks 51–100)
 * Both roll up to `mcap_classification = "Large"` and both count as
 * 100 % Large in the look-through cap allocation (see the NN50
 * convention note on getPortfolioData()). The sub-tag is persisted
 * in the DB `source` column purely so the classification card can
 * display N50 vs NN50 counts as separate tiles — no downstream
 * weighting depends on it as of 2026-07-27.
 *
 * Data flow
 * ---------
 *   ind_nifty50list.csv           → Large / N50   (top 50 by market cap)
 *   ind_niftynext50list.csv       → Large / NN50  (rank 51–100)
 *   ind_niftymidcap150list.csv    → Mid           (rank 101–250)
 *   ind_niftysmallcap250list.csv  → Small         (rank 251–500)
 *   ind_niftymicrocap250_list.csv → Micro         (rank 501–750)
 *   EQUITY_L.csv (NSE archives)   → Nano          (anything else that's still
 *                                                  EQ-series listed on NSE)
 *
 * We used to fetch ind_nifty100list.csv (the union of N50 + NN50). It's
 * kept out of the fetch list now — the union is reconstructed from the
 * two sub-index sets, which is cheaper (2 CSVs instead of 3) and gives
 * us the sub-bucket for free.
 *
 * ISIN as identifier
 * ------------------
 * Every one of these CSVs carries the ISIN column. We deliberately do
 * NOT use trading symbol because symbols change (IDEA→VODAFONE→IDEA
 * round-trip is a real example) while ISINs are stable. This module is
 * the single source of truth for "given an ISIN, what cap bucket?".
 *
 * Freshness
 * ---------
 * NIFTY Indices publishes updated CSVs after each rebalance (Mar/Sep
 * formally, plus ad-hoc mid-cycle changes ~3-5x/year). The API is
 * public, no auth, needs a browser-ish User-Agent to pass the CDN
 * bot check.
 *
 * Failure surface
 * ---------------
 * We deliberately fetch all CSVs in parallel with Promise.all — one
 * failure = whole refresh fails. That's intentional: a partial
 * classification (e.g., N50 map is empty) would silently miscategorise
 * every mega-cap holding as either NN50 or Nano, which is far worse
 * than "refresh unavailable, keep existing values".
 */

const INDEX_URLS = {
  n50: "https://www.niftyindices.com/IndexConstituent/ind_nifty50list.csv",
  nn50:
    "https://www.niftyindices.com/IndexConstituent/ind_niftynext50list.csv",
  mid: "https://www.niftyindices.com/IndexConstituent/ind_niftymidcap150list.csv",
  small:
    "https://www.niftyindices.com/IndexConstituent/ind_niftysmallcap250list.csv",
  micro:
    "https://www.niftyindices.com/IndexConstituent/ind_niftymicrocap250_list.csv",
} as const;

const UNIVERSE_URL =
  "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv";

// niftyindices.com's CDN inspects the User-Agent; a bare "node-fetch"
// gets 403'd. Same trick works for nsearchives.
const CSV_HEADERS: HeadersInit = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "text/csv,*/*;q=0.9",
};

// ─── Types ────────────────────────────────────────────────────────────────

export type CapBucket = "Large" | "Mid" | "Small" | "Micro" | "Nano";

/** Sub-bucket within Large. Null for non-Large buckets (Mid/Small/Micro/Nano). */
export type CapSubBucket = "N50" | "NN50" | null;

export type CapClassificationSource = {
  n50: Set<string>;
  nn50: Set<string>;
  mid: Set<string>;
  small: Set<string>;
  micro: Set<string>;
  /** Full NSE EQ-series universe. Superset of the sub-cap sets. */
  universe: Set<string>;
  /** Raw counts from each CSV — useful for logging & UI feedback. */
  sourceCounts: {
    n50: number;
    nn50: number;
    /** Convenience: n50 + nn50 for callers that only care about the union. */
    large: number;
    mid: number;
    small: number;
    micro: number;
    universe: number;
  };
  /** When the fetches completed (server clock). */
  fetchedAt: string;
};

/**
 * Full classification result — top-level bucket plus optional sub-bucket.
 * Non-Large buckets always have `subBucket: null`.
 */
export type CapClassification = {
  bucket: CapBucket;
  subBucket: CapSubBucket;
};

// ─── CSV parsing ──────────────────────────────────────────────────────────

/**
 * NIFTY index CSVs use the schema:
 *   Company Name, Industry, Symbol, Series, ISIN Code
 *
 * ISIN is column index 4. All values are plain (no quotes) — company
 * names never contain commas in these files (they'd break the format
 * upstream too, so NIFTY sanitises them).
 */
function parseIsinsFromNiftyCsv(csv: string): Set<string> {
  const set = new Set<string>();
  const lines = csv.split(/\r?\n/);
  // i=1 skips header row. Empty trailing lines silently ignored.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cols = line.split(",");
    const isin = cols[4]?.trim();
    if (isValidIsin(isin)) set.add(isin);
  }
  return set;
}

/**
 * NSE's EQUITY_L.csv schema (note leading spaces in header names):
 *   SYMBOL, NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE,
 *   MARKET LOT, ISIN NUMBER, FACE VALUE
 *
 * SERIES is column index 2, ISIN is column index 6. We filter to only
 * SERIES == 'EQ' — this excludes BE (trade-to-trade), BZ (surveillance),
 * SM (SME), etc. that we don't want in the cap universe.
 */
function parseIsinsFromEquityL(csv: string): Set<string> {
  const set = new Set<string>();
  const lines = csv.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cols = line.split(",");
    if (cols[2]?.trim() !== "EQ") continue;
    const isin = cols[6]?.trim();
    if (isValidIsin(isin)) set.add(isin);
  }
  return set;
}

/**
 * Cheap format check. An ISIN is 12 chars: 2-letter country code +
 * 9 alphanumeric + 1 check digit. We don't validate the checksum
 * because sources are trusted, but we do sanity-check the length so
 * a malformed line (partial CSV row, corrupt bytes) doesn't sneak an
 * empty string into our sets.
 */
function isValidIsin(v: string | undefined): v is string {
  return !!v && v.length === 12 && /^[A-Z0-9]+$/.test(v);
}

// ─── Fetch ────────────────────────────────────────────────────────────────

async function fetchCsvOrThrow(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: CSV_HEADERS,
    // Cap classifications change semi-annually — no benefit from
    // caching between calls. `no-store` also side-steps Vercel's fetch
    // cache which would happily serve last week's Nifty Micro CSV.
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Fetch ${url} → HTTP ${res.status}`);
  }
  const text = await res.text();
  if (text.length < 200) {
    // Sanity: even the smallest of our CSVs (100 rows) is ~5 KB.
    // Anything shorter is probably a Cloudflare challenge page.
    throw new Error(`Fetch ${url} returned suspicious short body`);
  }
  return text;
}

/**
 * Fetch all 6 sources in parallel and return the classified sets.
 * Throws if any source fails — see the module header for why partial
 * success isn't acceptable here.
 */
export async function fetchCapClassificationSource(): Promise<CapClassificationSource> {
  const [n50Csv, nn50Csv, midCsv, smallCsv, microCsv, universeCsv] =
    await Promise.all([
      fetchCsvOrThrow(INDEX_URLS.n50),
      fetchCsvOrThrow(INDEX_URLS.nn50),
      fetchCsvOrThrow(INDEX_URLS.mid),
      fetchCsvOrThrow(INDEX_URLS.small),
      fetchCsvOrThrow(INDEX_URLS.micro),
      fetchCsvOrThrow(UNIVERSE_URL),
    ]);

  const n50 = parseIsinsFromNiftyCsv(n50Csv);
  const nn50 = parseIsinsFromNiftyCsv(nn50Csv);
  const mid = parseIsinsFromNiftyCsv(midCsv);
  const small = parseIsinsFromNiftyCsv(smallCsv);
  const micro = parseIsinsFromNiftyCsv(microCsv);
  const universe = parseIsinsFromEquityL(universeCsv);

  // Sanity: NSE's rebalance rules guarantee no overlap between the cap
  // indices (a stock in Nifty 100 cannot also be in Midcap 150; a
  // stock in Nifty 50 cannot also be in Nifty Next 50). But if they
  // ever ship a buggy CSV that violates this, classifyIsinDetailed()
  // falls through cleanly (first match wins) — so we don't need to
  // error out on overlap, just note it.
  return {
    n50,
    nn50,
    mid,
    small,
    micro,
    universe,
    sourceCounts: {
      n50: n50.size,
      nn50: nn50.size,
      large: n50.size + nn50.size,
      mid: mid.size,
      small: small.size,
      micro: micro.size,
      universe: universe.size,
    },
    fetchedAt: new Date().toISOString(),
  };
}

// ─── Classification ───────────────────────────────────────────────────────

/**
 * Look up an ISIN's cap bucket only (no sub-bucket detail). Kept as
 * a thin wrapper around classifyIsinDetailed() for callers that don't
 * care about N50 vs NN50 (e.g., legacy consumers, aggregations). New
 * code should generally reach for classifyIsinDetailed().
 */
export function classifyIsin(
  isin: string,
  src: CapClassificationSource
): CapBucket | null {
  return classifyIsinDetailed(isin, src)?.bucket ?? null;
}

/**
 * Look up an ISIN's full classification — top-level bucket plus sub-
 * bucket for the Large tier (N50 or NN50).
 *
 * Precedence: N50 → NN50 → Mid → Small → Micro → Nano. Anything not
 * on NSE at all (BSE-only, delisted, international) returns null and
 * the caller is expected to leave the DB row untouched.
 *
 * O(1) per call thanks to Set membership tests.
 */
export function classifyIsinDetailed(
  isin: string,
  src: CapClassificationSource
): CapClassification | null {
  if (src.n50.has(isin)) return { bucket: "Large", subBucket: "N50" };
  if (src.nn50.has(isin)) return { bucket: "Large", subBucket: "NN50" };
  if (src.mid.has(isin)) return { bucket: "Mid", subBucket: null };
  if (src.small.has(isin)) return { bucket: "Small", subBucket: null };
  if (src.micro.has(isin)) return { bucket: "Micro", subBucket: null };
  if (src.universe.has(isin)) return { bucket: "Nano", subBucket: null };
  return null;
}

/**
 * Canonical `source` column value for a given classification. Kept in
 * this module so the refresh route, the backfill script, and any
 * future writer can never drift on the exact string format. Every
 * caller writes the same value → cross-tool queries stay predictable
 * ("WHERE source = 'nse-nifty50'" is stable).
 */
export function sourceTagFor(cls: CapClassification): string {
  if (cls.bucket === "Large") {
    return cls.subBucket === "N50" ? "nse-nifty50" : "nse-niftynext50";
  }
  switch (cls.bucket) {
    case "Mid":
      return "nse-midcap150";
    case "Small":
      return "nse-smallcap250";
    case "Micro":
      return "nse-microcap250";
    case "Nano":
      return "nse-equity-l";
  }
}
